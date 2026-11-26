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

import { createSpin, deadlineOf, publish as publishWord, waitFor as waitWord,
    waitForAsync as waitWordAsync } from './bell.js';
import { bytesOf } from './bytes.js';

/** The header, in 32-bit words. */
const HEADER_WORDS = 16;
/** Requests written, answers read, and the asking side's waits asleep on `ANSWERED`
 * (a blocking ask and the pump of calls may both be). */
const ASKED = 0;
const READ = 1;
const CLIENT_SLEEPS = 2;
/** Requests read (their slots free again), answers written, and the serving side's
 * waits asleep on `ASKED`. */
const TAKEN = 3;
const ANSWERED = 4;
const SERVER_SLEEPS = 5;
/** 1 once either side closed the channel; the slots and their bytes. */
const CLOSED = 6;
const SLOTS = 7;
const SLOT_BYTES = 8;
/**
 * The bells the two sides sleep on: the serving side's for requests, the
 * asking side's for answers. A side sleeps on its bell, not on the count it
 * waits for: a close moves the bells, and a count it may not move.
 */
const SERVER_BELL = 9;
const CLIENT_BELL = 10;
/** The four counts, for a test that starts them near their wrap. */
export const COUNTS = Object.freeze([ASKED, TAKEN, ANSWERED, READ]);
/** The two bells, for a test of the close. */
export const BELLS = Object.freeze([SERVER_BELL, CLIENT_BELL]);
/** @param {number} counter the bell of the side that waits for it */
const bellOf = counter=>(counter === ASKED ? SERVER_BELL : CLIENT_BELL);


/**
 * @typedef {Object} ChannelOptions
 * @property {number} [slots]  requests out at once, at most, a power of two (16)
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
    // A power of two: a request's slot is its count's low bits, which go on
    // in order across the count's wrap at 2^32; three slots would put the
    // requests counted 2^32 - 1 and 0 in one slot.
    if (!Number.isInteger(slots) || slots < 1 || (slots & (slots - 1)) !== 0
        || !Number.isInteger(slotBytes) || slotBytes < 0)
    {
        throw new RangeError(`channel: ${slots} slots of ${slotBytes} bytes (slots a power of two)`);
    }
    const stride = slotStride(slotBytes);
    const bytes = HEADER_WORDS * 4 + 2 * slots * stride;
    // A slot's place is found by 32-bit arithmetic: the whole within 1 GiB.
    if (bytes > 1 << 30)
    {
        throw new RangeError(`channel: ${slots} slots of ${slotBytes} bytes take more than 1 GiB`);
    }
    const memory = new SharedArrayBuffer(bytes);
    const words = new Int32Array(memory);
    words[SLOTS] = slots;
    words[SLOT_BYTES] = slotBytes;
    return memory;
}

/** A slot's bytes: its length word and its bytes, to a whole word. @param {number} slotBytes */
const slotStride = slotBytes=>4 + Math.ceil(slotBytes / 4) * 4;

/**
 * What a failure says of itself, as text: anything may be thrown, a thing
 * whose message is a getter that throws, or with no way to be a string.
 *
 * @param {unknown} failure
 */
const sayFailure = failure=>{
    try
    {
        return String(/** @type {any} */ (failure)?.message ?? failure);
    }
    catch {
        return 'a failure that says nothing of itself';
    }
};

/** Why a wait ended without what it waited for. */
export class ChannelClosed extends Error {
    constructor(){
        super('channel: closed');
        this.name = 'ChannelClosed';
    }
}

/** The answer to a request whose handler threw, or answered more than a slot holds. */
export class ChannelFailed extends Error {
    /** @param {string} message  what the serving side said of the failure */
    constructor(message){
        super(`channel: the serving side failed: ${message}`);
        this.name = 'ChannelFailed';
    }
}

/**
 * What both ends share: the channel's words and slots, and the waits.
 *
 * @param {SharedArrayBuffer} memory @param {{ spinMs?: number }} options
 */
function endOver(memory, { spinMs }){
    const words = new Int32Array(memory);
    /** The spin of this end's waits: `spinMs` where asked, else one that learns. */
    const spin = spinMs ?? createSpin();
    const bytes = new Uint8Array(memory);
    const slots = words[SLOTS];
    const slotBytes = words[SLOT_BYTES];
    const stride = slotStride(slotBytes);
    const requests = HEADER_WORDS * 4;
    const answers = requests + slots * stride;

    /**
     * The `n`th slot of a side, its bytes as written, read in place.
     *
     * @param {number} base @param {number} n
     */
    const slotAt = (base, n)=>{
        const slot = n & (slots - 1);
        const at = base + slot * stride;
        const length = words[at >> 2];
        // A view a slot, made again only when its length changes: a call
        // makes no garbage of its own on either side.
        const views = base === requests ? requestViews : answerViews;
        let view = views[slot];
        if (view === undefined || view.length !== length)
        {
            view = bytes.subarray(at + 4, at + 4 + length);
            views[slot] = view;
        }
        return view;
    };
    /** @type {Uint8Array[]} */
    const requestViews = [];
    /** @type {Uint8Array[]} */
    const answerViews = [];

    /**
     * Writes the `n`th slot of a side.
     *
     * @param {number} base @param {number} n @param {ArrayLike<number>} message
     */
    const writeSlot = (base, n, message)=>{
        // The bytes as long as they are now, which is what is copied.
        const taken = bytesOf(message, 'channel');
        const length = taken.length;
        if (length > slotBytes)
        {
            throw new RangeError(`channel: ${length} bytes, a slot holds ${slotBytes}`);
        }
        const at = base + (n & (slots - 1)) * stride;
        bytes.set(taken, at + 4);
        words[at >> 2] = length;
    };

    /**
     * Writes the `n`th answer as a failure: its length word is the
     * complement of the length of what is said of it, as much as a slot holds.
     *
     * @param {number} n @param {unknown} failure
     */
    const writeFailure = (n, failure)=>{
        const said = new TextEncoder().encode(sayFailure(failure)).subarray(0, slotBytes);
        const at = answers + (n & (slots - 1)) * stride;
        bytes.set(said, at + 4);
        words[at >> 2] = ~said.length;
    };

    /**
     * What is said of the failure the `n`th answer is, or null where it is an answer.
     *
     * @param {number} n
     */
    const failureAt = n=>{
        const at = answers + (n & (slots - 1)) * stride;
        const word = words[at >> 2];
        // Copied out: a decoder does not read shared memory.
        return word < 0 ? new TextDecoder().decode(bytes.slice(at + 4, at + 4 + ~word)) : null;
    };

    /**
     * Publishes a count and rings the other side if it said it sleeps.
     *
     * @param {number} counter @param {number} value @param {number} sleeps
     */
    const publish = (counter, value, sleeps)=>{
        publishWord(words, counter, value, sleeps, bellOf(counter));
    };

    /**
     * Blocks until `counter` is no longer `seen`, the channel closes or the
     * deadline passes: true when it moved.
     *
     * @param {number} counter @param {number} seen @param {number} sleeps @param {number} deadline
     */
    const waitFor = (counter, seen, sleeps, deadline)=>{
        const end = waitWord(words, counter, seen, sleeps, deadline, spin, CLOSED, bellOf(counter));
        if (end === 'closed')
        {
            throw new ChannelClosed();
        }
        return end !== 'timed-out';
    };

    /**
     * waitFor without blocking the thread: what a thread with an event loop
     * to keep, a page's own above all, waits with.
     *
     * @param {number} counter @param {number} seen @param {number} sleeps @param {number} deadline
     * @returns {Promise<boolean>}
     */
    const waitForAsync = async(counter, seen, sleeps, deadline)=>{
        const end = await waitWordAsync(words, counter, seen, sleeps, deadline, CLOSED,
            bellOf(counter));
        if (end === 'closed')
        {
            throw new ChannelClosed();
        }
        return end !== 'timed-out';
    };

    return {
        words, requests, answers, slots, slotAt, writeSlot, writeFailure, failureAt, publish,
        waitFor, waitForAsync,
        /** What this end's blocking waits learnt of their spin; null for a `spinMs` of its own. */
        spin: typeof spin === 'object' ? spin : null,
        /**
         * Ends the channel for both sides: every wait on it ends with
         * ChannelClosed. The bells are moved, not only notified: a wait that
         * looked at the closed word just before the close and sleeps just
         * after finds its bell moved and returns.
         */
        close(){
            Atomics.store(words, CLOSED, 1);
            for (const bell of BELLS)
            {
                Atomics.add(words, bell, 1);
                Atomics.notify(words, bell);
            }
        },
        closed: ()=>Atomics.load(words, CLOSED) !== 0,
    };
}

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

    /** An answer is being read: a request made from inside its reading would take its slot. */
    let reading = false;

    /**
     * Reads the next answer in place with `readAnswer` and frees its slot:
     * what `readAnswer` returned; throws what it threw, or `ChannelFailed`.
     *
     * @template T @param {ReadAnswer<T>} readAnswer @returns {T}
     */
    const readNext = readAnswer=>{
        reading = true;
        try
        {
            const failure = end.failureAt(read);
            if (failure !== null)
            {
                throw new ChannelFailed(failure);
            }
            return readAnswer(end.slotAt(end.answers, read));
        }
        finally
        {
            reading = false;
            read = (read + 1) | 0;
            Atomics.store(words, READ, read);
        }
    };

    /** Hands the next answer, read in place, to whoever asked for it. */
    const takeAnswer = ()=>{
        const taker = /** @type {(typeof waiting)[number]} */ (waiting.shift());
        let value;
        try
        {
            value = readNext(taker.read);
        }
        catch (e){
            taker.reject(e);
            return;
        }
        taker.resolve(value);
    };

    const notReading = ()=>{
        if (reading)
        {
            throw new Error('channel: asked from inside the reading of an answer');
        }
    };

    /**
     * An ask that ran out of time.
     *
     * @param {number | undefined} timeoutMs @returns {never}
     */
    const noAnswer = timeoutMs=>{
        throw new Error(`channel: no answer in ${timeoutMs} ms`);
    };

    /** @param {ArrayLike<number>} message */
    const send = message=>{
        // A closed channel takes no request: one published after the close
        // would still be read by the serving side, answered to nobody.
        if (end.closed())
        {
            throw new ChannelClosed();
        }
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
            notReading();
            const deadline = deadlineOf(timeoutMs);
            while ((asked - read) >>> 0 >= slots)
            {
                if (!end.waitFor(ANSWERED, read, CLIENT_SLEEPS, deadline))
                {
                    throw new Error(`channel: no room in ${timeoutMs} ms`);
                }
                takeAnswer();
            }
            // Sent before it waits: a request refused leaves nothing behind.
            send(message);
            try
            {
                // Calls out before it are answered first: hand them theirs.
                while (waiting.length > 0)
                {
                    if (Atomics.load(words, ANSWERED) === read
                        && !end.waitFor(ANSWERED, read, CLIENT_SLEEPS, deadline))
                    {
                        noAnswer(timeoutMs);
                    }
                    takeAnswer();
                }
                if (Atomics.load(words, ANSWERED) === read
                    && !end.waitFor(ANSWERED, read, CLIENT_SLEEPS, deadline))
                {
                    noAnswer(timeoutMs);
                }
            }
            catch (e){
                // Out of time, or a wait this thread may not make (a page's
                // own): the request is out, and its answer, when it comes,
                // goes to nobody.
                if (!(e instanceof ChannelClosed))
                {
                    waiting.push(DROPPED);
                }
                throw e;
            }
            return readNext(readAnswer);
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
            notReading();
            while ((asked - read) >>> 0 >= slots)
            {
                // A close fails the calls out and frees no slot: waiting on
                // would turn this loop for ever, the thread's timers with it.
                if (end.closed())
                {
                    throw new ChannelClosed();
                }
                // A slot frees with each answer: one is waited for, not all.
                if (Atomics.load(words, ANSWERED) === read)
                {
                    await end.waitForAsync(ANSWERED, read, CLIENT_SLEEPS, Infinity);
                }
                while (waiting.length > 0 && Atomics.load(words, ANSWERED) !== read)
                {
                    takeAnswer();
                }
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
        /** What this side's blocking waits learnt of their spin, for diagnostics. */
        spin: end.spin,
        close: end.close,
        closed: end.closed,
    };
}

/** @param {Uint8Array} bytes */
const copy = bytes=>bytes.slice();

/** Who takes the answer of an ask that gave up waiting for it. */
const DROPPED = Object.freeze({ read: ()=>undefined, resolve: ()=>{}, reject: ()=>{} });

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
    /** A handler runs: a serve from inside it would answer its request twice. */
    let serving = false;

    /**
     * Answers every request written, in order: how many. A handler that
     * throws, or answers more than a slot holds, answers its request with
     * the failure (`ChannelFailed` on the asking side), and the next is
     * answered.
     *
     * @param {Handler} handler
     */
    const answerAll = handler=>{
        if (serving)
        {
            throw new Error('channel: served from inside its own handler');
        }
        serving = true;
        let answered = 0;
        try
        {
            while (Atomics.load(words, ASKED) !== taken)
            {
                try
                {
                    end.writeSlot(end.answers, taken, handler(end.slotAt(end.requests, taken)) ?? EMPTY);
                }
                catch (e){
                    end.writeFailure(taken, e);
                }
                taken = (taken + 1) | 0;
                // The request's slot is free before its answer is seen: the asking
                // side writes its next request there only after reading the answer.
                Atomics.store(words, TAKEN, taken);
                end.publish(ANSWERED, taken, CLIENT_SLEEPS);
                answered++;
            }
        }
        finally
        {
            serving = false;
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
        /** What this side's blocking waits learnt of their spin, for diagnostics. */
        spin: end.spin,
        close: end.close,
        closed: end.closed,
    };
}

const EMPTY = new Uint8Array(0);
