/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Requests and answers between two threads through shared memory, with no
 * message between them: the asking side writes a request into a slot and
 * rings, the serving side reads it in place, writes its answer into a slot
 * of its own and rings back, and the asking side reads the answer in place.
 *
 * A message is a structured clone of what is sent and a task in the other
 * thread's event loop: a copy of the data, made and let go, and a wait for a
 * thread that may be busy. Here the bytes are written once, where the other
 * side reads them, and the other side need not return to its event loop to
 * see them: a thread that runs something long looks between two steps of it,
 * and one with nothing to do sleeps on the word that is rung. What is large
 * is not sent at all: a request names where it lies (a body in the cache, a
 * range of a shared buffer) and only the name goes through the channel.
 *
 * One asking side and one serving side; answers come back in the order the
 * requests went. A request is answered in the slot of the same number, so
 * the asking side keeps no more requests out than there are slots and
 * neither side ever waits for room in the other's slots.
 *
 * The counters are counts of requests ever written and ever read, not
 * positions: their difference is what is waiting, and they wrap at 2^32,
 * which the arithmetic here does too. A slot's bytes and length are written
 * with plain stores and published by the atomic store of its counter after
 * them; the other side reads the counter atomically before the slot, so on a
 * host that reorders plain stores (arm64) it never reads a slot before its
 * bytes. A side rings only when the other said it sleeps: each wait adds
 * itself to a count before it looks a last time, so a request written
 * between that look and the wait is either seen by the look or rung for.
 */

/** The header, in 32-bit words. */
const HEADER_WORDS = 16;
/** Requests written. */
const ASKED = 0;
/** Requests read: their slots free again. */
const TAKEN = 1;
/** Answers written. */
const ANSWERED = 2;
/** Answers read. */
const READ = 3;
/** Waits of the serving side asleep on `ASKED`. */
const SERVER_SLEEPS = 4;
/** Waits of the asking side asleep on `ANSWERED`: a blocking ask and the pump of calls may both be. */
const CLIENT_SLEEPS = 5;
/** 1 once either side closed the channel. */
const CLOSED = 6;
const SLOTS = 7;
const SLOT_BYTES = 8;

/** How long a side looks before it sleeps, in ms: an answer often comes sooner. */
const SPIN_MS = 0.05;

/**
 * @typedef {Object} ChannelOptions
 * @property {number} [slots]  requests out at once, at most (16)
 * @property {number} [slotBytes]  bytes of a request or an answer, at most (4096)
 */

/**
 * The shared memory of a new channel: handed to both sides, each of which
 * opens its end over it (`openClient`, `openServer`).
 *
 * @param {ChannelOptions} [options]
 * @returns {SharedArrayBuffer}
 */
export function createChannel({ slots = 16, slotBytes = 4096 } = {}){
    if (!Number.isInteger(slots) || slots < 1 || !Number.isInteger(slotBytes) || slotBytes < 0)
    {
        throw new RangeError(`channel: ${slots} slots of ${slotBytes} bytes`);
    }
    const stride = slotStride(slotBytes);
    const memory = new SharedArrayBuffer(HEADER_WORDS * 4 + 2 * slots * stride);
    const words = new Int32Array(memory);
    words[SLOTS] = slots;
    words[SLOT_BYTES] = slotBytes;
    return memory;
}

/** A slot's bytes: its length word and its bytes, to a whole word. @param {number} slotBytes */
const slotStride = slotBytes=>4 + Math.ceil(slotBytes / 4) * 4;

/** Why a wait ended without what it waited for. */
export class ChannelClosed extends Error {
    constructor(){
        super('channel: closed');
        this.name = 'ChannelClosed';
    }
}

/**
 * What both ends share: the channel's words and slots, and the waits.
 *
 * @param {SharedArrayBuffer} memory @param {{ spinMs?: number }} options
 */
function endOver(memory, { spinMs = SPIN_MS }){
    const words = new Int32Array(memory);
    const bytes = new Uint8Array(memory);
    const slots = words[SLOTS];
    const slotBytes = words[SLOT_BYTES];
    const stride = slotStride(slotBytes);
    const requests = HEADER_WORDS * 4;
    const answers = requests + slots * stride;
    const clock = globalThis.performance ?? Date;

    /**
     * The `n`th slot of a side, its bytes as written, read in place.
     *
     * @param {number} base @param {number} n
     */
    const slotAt = (base, n)=>{
        const at = base + ((n >>> 0) % slots) * stride;
        return bytes.subarray(at + 4, at + 4 + words[at >> 2]);
    };

    /**
     * Writes the `n`th slot of a side.
     *
     * @param {number} base @param {number} n @param {ArrayLike<number>} message
     */
    const writeSlot = (base, n, message)=>{
        if (message.length > slotBytes)
        {
            throw new RangeError(`channel: ${message.length} bytes, a slot holds ${slotBytes}`);
        }
        const at = base + ((n >>> 0) % slots) * stride;
        bytes.set(message, at + 4);
        words[at >> 2] = message.length;
    };

    /**
     * Publishes a count and rings the other side if it said it sleeps.
     *
     * @param {number} counter @param {number} value @param {number} sleeps
     */
    const publish = (counter, value, sleeps)=>{
        Atomics.store(words, counter, value | 0);
        if (Atomics.load(words, sleeps) !== 0)
        {
            Atomics.notify(words, counter);
        }
    };

    /** @param {number} counter @param {number} seen */
    const moved = (counter, seen)=>Atomics.load(words, counter) !== (seen | 0);

    /**
     * Blocks until `counter` is no longer `seen`, the channel closes or the
     * deadline passes: true when it moved.
     *
     * @param {number} counter @param {number} seen @param {number} sleeps @param {number} deadline
     */
    const waitFor = (counter, seen, sleeps, deadline)=>{
        const spinUntil = Math.min(deadline, clock.now() + spinMs);
        while (!moved(counter, seen))
        {
            if (Atomics.load(words, CLOSED) !== 0)
            {
                throw new ChannelClosed();
            }
            if (clock.now() >= spinUntil)
            {
                break;
            }
        }
        while (!moved(counter, seen))
        {
            const left = deadline - clock.now();
            if (left <= 0)
            {
                return false;
            }
            Atomics.add(words, sleeps, 1);
            if (!moved(counter, seen) && Atomics.load(words, CLOSED) === 0)
            {
                Atomics.wait(words, counter, seen | 0, left === Infinity ? undefined : left);
            }
            Atomics.sub(words, sleeps, 1);
            if (Atomics.load(words, CLOSED) !== 0 && !moved(counter, seen))
            {
                throw new ChannelClosed();
            }
        }
        return true;
    };

    /**
     * waitFor without blocking the thread: what a thread with an event loop
     * to keep, a page's own above all, waits with.
     *
     * @param {number} counter @param {number} seen @param {number} sleeps @param {number} deadline
     * @returns {Promise<boolean>}
     */
    const waitForAsync = async(counter, seen, sleeps, deadline)=>{
        while (!moved(counter, seen))
        {
            if (Atomics.load(words, CLOSED) !== 0)
            {
                throw new ChannelClosed();
            }
            const left = deadline - clock.now();
            if (left <= 0)
            {
                return false;
            }
            Atomics.add(words, sleeps, 1);
            if (!moved(counter, seen) && Atomics.load(words, CLOSED) === 0)
            {
                const waited = /** @type {any} */ (Atomics).waitAsync?.(words, counter,
                    seen | 0, left === Infinity ? undefined : left);
                if (waited?.async)
                {
                    // Node lets a thread whose loop has only this wait end:
                    // something of the loop's own keeps it while it waits.
                    const holding = setInterval(()=>{}, 1 << 30);
                    try
                    {
                        await waited.value;
                    }
                    finally
                    {
                        clearInterval(holding);
                    }
                }
                else if (!waited)
                {
                    // No waitAsync here: look again on the next turn of the loop.
                    await new Promise(resolve=>setTimeout(resolve, 1));
                }
            }
            Atomics.sub(words, sleeps, 1);
        }
        return true;
    };

    return {
        words, requests, answers, slots, slotAt, writeSlot, publish, waitFor, waitForAsync,
        /** Ends the channel for both sides: every wait on it ends with ChannelClosed. */
        close(){
            Atomics.store(words, CLOSED, 1);
            for (const counter of [ASKED, TAKEN, ANSWERED, READ])
            {
                Atomics.notify(words, counter);
            }
        },
        closed: ()=>Atomics.load(words, CLOSED) !== 0,
    };
}

/**
 * The deadline of a wait of `timeoutMs`.
 *
 * @param {number | undefined} timeoutMs
 */
const deadlineOf = timeoutMs=>(timeoutMs === undefined || timeoutMs === Infinity
    ? Infinity : (globalThis.performance ?? Date).now() + timeoutMs);

/**
 * @template T
 * @typedef {(answer: Uint8Array) => T} ReadAnswer
 *     reads an answer where it lies: the view is valid only inside the call
 */

/**
 * The asking side of a channel.
 *
 * @param {SharedArrayBuffer} memory @param {{ spinMs?: number }} [options]
 */
export function openClient(memory, options = {}){
    const end = endOver(memory, options);
    const { words, slots } = end;
    /** Requests this side wrote, and answers it read. */
    let asked = Atomics.load(words, ASKED);
    let read = Atomics.load(words, READ);
    /**
     * Who takes each answer still out, in the order the requests went.
     *
     * @type {{ read: ReadAnswer<any>, resolve: (value: any) => void,
     *     reject: (reason: any) => void }[]}
     */
    const waiting = [];
    /** @type {Promise<void> | null} */
    let pumping = null;

    /** Hands the next answer, read in place, to whoever asked for it. */
    const takeAnswer = ()=>{
        const taker = /** @type {(typeof waiting)[number]} */ (waiting.shift());
        let value;
        try
        {
            value = taker.read(end.slotAt(end.answers, read));
        }
        catch (e){
            read = (read + 1) | 0;
            Atomics.store(words, READ, read);
            taker.reject(e);
            return;
        }
        read = (read + 1) | 0;
        Atomics.store(words, READ, read);
        taker.resolve(value);
    };

    /** @param {ArrayLike<number>} message */
    const send = message=>{
        end.writeSlot(end.requests, asked, message);
        asked = (asked + 1) | 0;
        end.publish(ASKED, asked, SERVER_SLEEPS);
    };

    /** Answers already written, handed to their takers; then waits for more while any are out. */
    const pump = async()=>{
        while (waiting.length > 0)
        {
            while (waiting.length > 0 && Atomics.load(words, ANSWERED) !== read)
            {
                takeAnswer();
            }
            if (waiting.length > 0)
            {
                await end.waitForAsync(ANSWERED, read, CLIENT_SLEEPS, Infinity);
            }
        }
    };
    const startPump = ()=>{
        pumping ??= pump().catch(reason=>{
            for (const taker of waiting.splice(0))
            {
                taker.reject(reason);
            }
        }).finally(()=>{
            pumping = null;
            if (waiting.length > 0)
            {
                startPump();
            }
        });
    };

    return {
        /**
         * Asks and blocks for the answer, read in place by `readAnswer` (a
         * copy by default): for a thread that may block (a worker, never a
         * page's own thread). Answers to earlier `call`s reached on the way
         * are handed to them.
         *
         * @template [T=Uint8Array]
         * @param {ArrayLike<number>} message
         * @param {{ read?: ReadAnswer<T>, timeoutMs?: number }} [options]
         * @returns {T}
         */
        ask(message, { read: readAnswer = /** @type {any} */ (copy), timeoutMs } = {}){
            const deadline = deadlineOf(timeoutMs);
            while ((asked - read) >>> 0 >= slots)
            {
                if (!end.waitFor(ANSWERED, read, CLIENT_SLEEPS, deadline))
                {
                    throw new Error(`channel: no room in ${timeoutMs} ms`);
                }
                takeAnswer();
            }
            /** @type {{ done: boolean, value: any, failed: boolean }} */
            const outcome = { done: false, value: undefined, failed: false };
            const taker = {
                read: readAnswer,
                resolve: (/** @type {any} */ value)=>Object.assign(outcome, { done: true, value }),
                reject: (/** @type {any} */ reason)=>
                    Object.assign(outcome, { done: true, failed: true, value: reason }),
            };
            // Sent before it waits: a request refused leaves no taker behind
            // to take the next request's answer.
            send(message);
            waiting.push(taker);
            while (!outcome.done)
            {
                if (Atomics.load(words, ANSWERED) === read
                    && !end.waitFor(ANSWERED, read, CLIENT_SLEEPS, deadline))
                {
                    // Left in its place: the answer, when it comes, is dropped.
                    Object.assign(taker, { read: ()=>undefined, resolve: ()=>{}, reject: ()=>{} });
                    throw new Error(`channel: no answer in ${timeoutMs} ms`);
                }
                takeAnswer();
            }
            if (outcome.failed)
            {
                throw outcome.value;
            }
            return outcome.value;
        },

        /**
         * Asks without blocking: the answer, read in place by `readAnswer` (a
         * copy by default), when it comes. As many may be out at once as the
         * channel has slots; one more waits for room first.
         *
         * @template [T=Uint8Array]
         * @param {ArrayLike<number>} message
         * @param {{ read?: ReadAnswer<T> }} [options]
         * @returns {Promise<T>}
         */
        async call(message, { read: readAnswer = /** @type {any} */ (copy) } = {}){
            while ((asked - read) >>> 0 >= slots)
            {
                startPump();
                await pumping;
            }
            send(message);
            /** @type {Promise<T>} */
            const answered = new Promise((resolve, reject)=>{
                waiting.push({ read: readAnswer, resolve, reject });
            });
            startPump();
            return answered;
        },

        /** Requests out, not answered yet. */
        out: ()=>waiting.length,
        close: end.close,
        closed: end.closed,
    };
}

/** @param {Uint8Array} bytes */
const copy = bytes=>bytes.slice();

/**
 * @typedef {(request: Uint8Array) => ArrayLike<number> | undefined | void} Handler
 *     answers a request read in place (valid only inside the call); nothing is
 *     an empty answer
 */

/**
 * The serving side of a channel.
 *
 * @param {SharedArrayBuffer} memory @param {{ spinMs?: number }} [options]
 */
export function openServer(memory, options = {}){
    const end = endOver(memory, options);
    const { words } = end;
    let taken = Atomics.load(words, TAKEN);

    /** Answers every request written, in order: how many. @param {Handler} handler */
    const answerAll = handler=>{
        let answered = 0;
        while (Atomics.load(words, ASKED) !== taken)
        {
            const answer = handler(end.slotAt(end.requests, taken)) ?? EMPTY;
            end.writeSlot(end.answers, taken, answer);
            taken = (taken + 1) | 0;
            // The request's slot is free before its answer is seen: the asking
            // side writes its next request there only after reading the answer.
            Atomics.store(words, TAKEN, taken);
            end.publish(ANSWERED, taken, CLIENT_SLEEPS);
            answered++;
        }
        return answered;
    };

    return {
        /**
         * Answers every request waiting; with none, blocks for one first (up to
         * `timeoutMs`): for a thread that may block. How many it answered.
         *
         * @param {Handler} handler @param {{ timeoutMs?: number }} [options]
         */
        serve(handler, { timeoutMs } = {}){
            if (Atomics.load(words, ASKED) === taken
                && !end.waitFor(ASKED, taken, SERVER_SLEEPS, deadlineOf(timeoutMs)))
            {
                return 0;
            }
            return answerAll(handler);
        },

        /**
         * serve without blocking the thread: waits for a request on the event
         * loop.
         *
         * @param {Handler} handler @param {{ timeoutMs?: number }} [options]
         * @returns {Promise<number>}
         */
        async serveAsync(handler, { timeoutMs } = {}){
            if (Atomics.load(words, ASKED) === taken
                && !await end.waitForAsync(ASKED, taken, SERVER_SLEEPS, deadlineOf(timeoutMs)))
            {
                return 0;
            }
            return answerAll(handler);
        },

        /** Requests written and not answered yet. */
        waiting: ()=>(Atomics.load(words, ASKED) - taken) >>> 0,
        close: end.close,
        closed: end.closed,
    };
}

const EMPTY = new Uint8Array(0);
