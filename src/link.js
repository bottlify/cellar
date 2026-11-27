/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Calls both ways between two threads: each side calls the other and answers
 * the other's calls, through a ring each way and a doorbell a side.
 *
 * A call is made two ways. A side that may block calls and waits (`ask`) - it
 * has nothing to do until the answer comes, and giving its thread back to its
 * event loop is what it is in a worker to avoid. A side that must not stop
 * calls and is handed a promise (`call`). A side waiting for an answer still
 * answers what it is asked meanwhile, at any depth: the other side often
 * cannot answer without asking back, and a waiting side that answered nothing
 * would hold both up for good. So everything sent to a side rings the one
 * doorbell it waits on, and a wait handles the calls that come before its answer.
 *
 * A call is a target, a method and values for arguments (`codec.js`); its
 * answer is a value, or the failure it threw, its message and what it says of
 * itself, thrown again on the side that called. A record is decoded where it
 * lies in the ring. A value longer than a record goes as parts, one after
 * another, and is decoded once the last is in. What is large is better not
 * sent at all: a call names where it lies (a body in the cache, a range of a
 * shared buffer).
 *
 * Beside the values, each side has one call of a few words at a time (`words`):
 * the request written into shared words in place, an atomic count published
 * after it, the answer the same way back, no record and no value made. It is
 * the path of a protocol that takes turns millions of times - a slice asked
 * for, a trap answered - for which the value path would be a record, a decode
 * and an object a turn. Word calls and value calls are not ordered with each
 * other; each is in order with itself.
 *
 * Both sides may be in one thread: a side that waits for an answer from a side
 * of this thread serves that side in place, which only it can do then.
 */

import { SPIN_MS } from './bell.js';
import { decodeValue, encodeValue } from './codec.js';
import { RingClosed, createRingMemory, openRing } from './ring.js';

/** The records on a link's rings: a call, an answer, a word call's failure. */
const CALL = 0;
const ANSWER = 1;
const WORDS_FAILED = 2;
/**
 * A part of a record too long for the ring: no value's first byte (`codec.js`),
 * then whether it is the last, then the whole record's length, then its bytes.
 */
const PART = 0xff;
const PART_HEAD = 8;

/** The words of a link's word calls: its layout, then the words of each call. */
const LAYOUT = 0;
const WORDS = 1;
const HEAD_WORDS = 2;
/** A word that no zeroed or foreign memory holds: "LNK" and the layout's version. */
const LINK_LAYOUT = 0x4c4e4b01;
/**
 * A side's word call: the calls it made and the answers the other side wrote,
 * counts that wrap at 2^32; whether the last answer is a failure (then sent
 * as a value before the answer's count); the request's words, the answer's.
 */
const ASKED = 0;
const ANSWERED = 1;
const FAILED = 2;
const CALL_HEAD = 3;

/** A link's rings, each way, by default: what a call and its values fit in, many times over. */
export const LINK_BYTES = 1 << 20;

/** Why a call ended without its answer: the link is closed, or closing, and nothing will answer it. */
export class LinkClosed extends Error {
    /** @param {string} what  the call */
    constructor(what){
        super(`link: ${what}: the link is closed`);
        this.name = 'LinkClosed';
        /** Tells it apart from the other side's own failure. */
        this.closed = true;
    }
}

/**
 * A failure as a value: its message and whatever it says of itself - a code
 * the caller tells failures apart by, what a read was missing - so the side
 * that called throws what the other side threw, not only its text.
 *
 * @param {unknown} e
 */
const failureOf = e=>{
    if (!(e instanceof Error))
    {
        return { message: String(e) };
    }
    /** @type {Record<string, unknown>} */
    const told = { message: e.message };
    for (const [name, value] of Object.entries(e))
    {
        try
        {
            encodeValue(value);
            told[name] = value;
        }
        catch {
            // What cannot cross is left behind: the message still does.
        }
    }
    return told;
};

/** The failure `failureOf` made, an Error again. @param {any} failure */
const errorOf = failure=>Object.assign(new Error(failure?.message ?? 'link: the call failed'),
    { ...failure, message: undefined }, { message: failure?.message });

/**
 * One side of a link's memory: the ring it writes, the ring it reads (its
 * doorbell this side's), and the words of both sides' word calls, with which
 * of their two calls is this side's.
 *
 * @typedef {Object} LinkEnd
 * @property {import('./ring.js').RingMemory} out
 * @property {import('./ring.js').RingMemory} in
 * @property {SharedArrayBuffer} words
 * @property {0 | 1} side
 */

/**
 * The memory of a new link, as each of its two sides opens it. A side's
 * doorbell is what it waits on; one handed in may be shared with whatever else
 * the same thread waits for, so one wait serves them all.
 *
 * @param {{ capacity?: number, words?: number,
 *     bellA?: import('./bell.js').DoorbellMemory, bellB?: import('./bell.js').DoorbellMemory }} [options]
 *     capacity: each ring's bytes (`LINK_BYTES`); words: of a word call's request, and of its
 *     answer (4)
 * @returns {{ a: LinkEnd, b: LinkEnd }}
 */
export function createLinkMemory({ capacity = LINK_BYTES, words = 4, bellA, bellB } = {}){
    if (!Number.isInteger(words) || words < 0 || words > 256)
    {
        throw new RangeError(`link: word calls of ${words} words`);
    }
    const toA = createRingMemory(capacity, bellA);
    const toB = createRingMemory(capacity, bellB);
    const shared = new SharedArrayBuffer((HEAD_WORDS + 2 * (CALL_HEAD + 2 * words)) * 4);
    const head = new Int32Array(shared);
    head[LAYOUT] = LINK_LAYOUT;
    head[WORDS] = words;
    return { a: { out: toB, in: toA, words: shared, side: 0 },
        b: { out: toA, in: toB, words: shared, side: 1 } };
}

/**
 * What a side answers the other's value calls with: a handler per target and
 * method, which may return a promise, its answer sent when it settles.
 *
 * @typedef {Record<string, Record<string, (...args: any[]) => any>>} Handlers
 */

/**
 * What answers the other side's word calls in `pump`: the request's words and
 * the answer's, both where they lie; it writes the answer before it returns. A
 * throw is the call's failure. Without one, this side takes word calls itself
 * (`takeWords`, `answerWords`).
 *
 * @typedef {(request: Int32Array, answer: Int32Array) => void} WordsHandler
 */

/**
 * The sides open in this thread, by the ring each reads: a side that waits for
 * an answer from one of them serves it in place, as nothing else would.
 *
 * @type {WeakMap<SharedArrayBuffer, { pump: () => number }>}
 */
const openHere = new WeakMap();

/**
 * One side of a link.
 *
 * @param {LinkEnd} end
 * @param {Handlers} [handlers]
 * @param {{ words?: WordsHandler, spinMs?: number | (() => number), afterSend?: () => void }}
 *     [options]  spinMs: how long a blocking wait looks before it sleeps, or what says so as
 *     each wait begins; by default as long as this side's waits learnt to (`createSpin`).
 *     afterSend: run after each send has rung the other side, where the other side must also
 *     be told another way (a word its running loop polls)
 */
export function openLink(end, handlers = {}, { words: wordsHandler, spinMs, afterSend } = {}){
    const outbound = openRing(end.out);
    const inbound = openRing(end.in);
    const bell = inbound.bell;
    const words = new Int32Array(end.words);
    const size = words[WORDS];
    if (words.length < HEAD_WORDS || words[LAYOUT] !== LINK_LAYOUT || !(size >= 0)
        || words.length < HEAD_WORDS + 2 * (CALL_HEAD + 2 * size) || (end.side !== 0 && end.side !== 1))
    {
        throw new Error('link: the memory is not a link of this layout');
    }
    const stride = CALL_HEAD + 2 * size;
    /** This side's word call, and the other side's. */
    const mine = HEAD_WORDS + end.side * stride;
    const theirs = HEAD_WORDS + (1 - end.side) * stride;
    /** Waits look this long, or as the side's waits learnt to (undefined). */
    const look = typeof spinMs === 'function' ? spinMs : ()=>spinMs;
    /**
     * What this side sent (records and word calls and their answers), the
     * word sends that woke the other side asleep, and this side's waits that slept.
     */
    const counts = { sent: 0, woke: 0, slept: 0 };
    /** A word send, and whether it woke the other side. @param {boolean} notified */
    const sent = notified=>{
        counts.sent++;
        if (notified)
        {
            counts.woke++;
        }
        afterSend?.();
    };

    let nextId = 1;
    /** Answers to calls a wait here is for, by id. @type {Map<number, { ok: boolean, value: any }>} */
    const arrived = new Map();
    /**
     * Calls this side was handed a promise for.
     *
     * @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void,
     *     what: string }>}
     */
    const promised = new Map();
    /** The ids of the calls a wait here is for: an answer to one goes to `arrived`. */
    const awaited = new Set();
    /** Whether this thread may block: never the page's own. */
    const canBlock = typeof Atomics.wait === 'function' && typeof globalThis.window === 'undefined';
    /** The step of a part: the record's room less the part's head. */
    const step = outbound.maxRecord - PART_HEAD;

    /**
     * Records not yet written whole, in order, and how far into the first its
     * parts went: the other side frees room as it reads, and it reads while it
     * waits. A thread that may block waits for room; one that may not keeps
     * the rest for its next pump.
     *
     * @type {Uint8Array[]}
     */
    const unsent = [];
    let unsentAt = 0;
    const partWords = new DataView(outbound.bytes.buffer);
    /** @param {boolean} block */
    const writeUnsent = block=>{
        while (unsent.length > 0)
        {
            const record = unsent[0];
            if (unsentAt === 0 && record.length <= outbound.maxRecord)
            {
                if (!outbound.write(record) && !(block && outbound.writeWaiting(record)))
                {
                    return;
                }
                counts.sent++;
            }
            else
            {
                while (unsentAt < record.length)
                {
                    const length = Math.min(step, record.length - unsentAt);
                    let at = outbound.reserve(PART_HEAD + length);
                    if (at < 0)
                    {
                        if (!block)
                        {
                            return;
                        }
                        at = outbound.reserveWaiting(PART_HEAD + length);
                    }
                    outbound.bytes[at] = PART;
                    outbound.bytes[at + 1] = unsentAt + length === record.length ? 1 : 0;
                    partWords.setUint32(at + 4, record.length, true);
                    outbound.bytes.set(record.subarray(unsentAt, unsentAt + length), at + PART_HEAD);
                    outbound.commit();
                    counts.sent++;
                    unsentAt += length;
                }
                unsentAt = 0;
            }
            unsent.shift();
        }
    };
    /**
     * Writes what waits to be written; a ring the other side closed takes
     * nothing more, and what waited goes to nobody.
     *
     * @param {boolean} block
     */
    const flush = block=>{
        try
        {
            writeUnsent(block);
        }
        catch (e){
            if (e instanceof RingClosed)
            {
                unsent.length = 0;
                unsentAt = 0;
            }
            throw e;
        }
    };
    /** @param {Uint8Array} record */
    const send = record=>{
        unsent.push(record);
        flush(canBlock && unsent.length === 1);
        afterSend?.();
    };
    /** Writes what goes to nobody once the other side closed the link. @param {() => void} write */
    const unlessClosed = write=>{
        try
        {
            write();
        }
        catch (e){
            if (!(e instanceof RingClosed))
            {
                throw e;
            }
        }
    };

    /**
     * An answer that cannot cross - a handler that returned what the codec
     * does not carry - goes as the failure it is: the caller is told, and the
     * side answering, which serves every call, goes on.
     *
     * @param {number} id @param {boolean} ok @param {any} value
     */
    const answer = (id, ok, value)=>{
        let record;
        try
        {
            record = encodeValue([ANSWER, id, ok, value]);
        }
        catch (e){
            record = encodeValue([ANSWER, id, false, failureOf(e)]);
        }
        unlessClosed(()=>send(record));
    };

    /** @param {number} id @param {string} target @param {string} method @param {any[]} args */
    const dispatch = (id, target, method, args)=>{
        const handler = handlers[target]?.[method];
        if (!handler)
        {
            answer(id, false, failureOf(new Error(`link: nothing answers ${target}.${method}`)));
            return;
        }
        let result;
        try
        {
            result = handler(...args);
        }
        catch (e){
            answer(id, false, failureOf(e));
            return;
        }
        if (typeof result?.then === 'function')
        {
            result.then((/** @type {any} */ value)=>answer(id, true, value),
                (/** @type {any} */ e)=>answer(id, false, failureOf(e)));
            return;
        }
        answer(id, true, result);
    };

    /** The whole of a record coming in parts, and how much of it is in. @type {Uint8Array | null} */
    let whole = null;
    let wholeAt = 0;
    /** The failure of this side's word call, come before its answer. @type {any} */
    let wordsFailure = null;
    /**
     * Records taken off the ring and not handled yet, in the order they came,
     * decoded where they lay: a handler that waits for a call of its own pumps
     * again from inside its record, and goes on from here, where the ring's
     * head would hand it that record a second time. A record that does not
     * decode is kept as its error, thrown where it would have been handled.
     *
     * @type {any[]}
     */
    const taken = [];
    /** @param {Uint8Array} bytes */
    const take = bytes=>{
        try
        {
            if (bytes[0] !== PART)
            {
                taken.push(decodeValue(bytes));
                return;
            }
            if (whole === null)
            {
                whole = new Uint8Array(new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true));
                wholeAt = 0;
            }
            whole.set(bytes.subarray(PART_HEAD), wholeAt);
            wholeAt += bytes.length - PART_HEAD;
            if (bytes[1] === 1)
            {
                const record = whole;
                whole = null;
                taken.push(decodeValue(record));
            }
        }
        catch (e){
            taken.push({ unreadable: e });
        }
    };
    /** @param {any} record */
    const handle = record=>{
        if (record.unreadable)
        {
            throw record.unreadable;
        }
        if (record[0] === CALL)
        {
            dispatch(record[1], record[2], record[3], record[4]);
            return;
        }
        if (record[0] === WORDS_FAILED)
        {
            wordsFailure = record[1];
            return;
        }
        const [, id, ok, value] = record;
        const waiting = promised.get(id);
        if (waiting)
        {
            promised.delete(id);
            if (ok)
            {
                waiting.resolve(value);
            }
            else
            {
                waiting.reject(errorOf(value));
            }
            return;
        }
        if (awaited.has(id))
        {
            arrived.set(id, { ok, value });
        }
    };

    /** The other side's word call and its answer, where they lie. */
    const asked = words.subarray(theirs + CALL_HEAD, theirs + CALL_HEAD + size);
    const reply = words.subarray(theirs + CALL_HEAD + size, theirs + stride);
    /** The other side's word calls this side took, and whether one taken is not answered yet. */
    let wordsTaken = Atomics.load(words, theirs + ANSWERED);
    let holding = false;
    /** This side's word calls, and whether one is out. */
    let wordsAsked = Atomics.load(words, mine + ASKED);
    let wordsOut = false;

    /** Publishes the answer to the word call taken. @param {boolean} failed */
    const publishAnswer = failed=>{
        holding = false;
        wordsTaken = (wordsTaken + 1) | 0;
        words[theirs + FAILED] = failed ? 1 : 0;
        Atomics.store(words, theirs + ANSWERED, wordsTaken);
        sent(outbound.bell.ring());
    };
    /** The other side's word call, once one waits and is not taken yet: its request. */
    const takeWords = ()=>{
        if (holding || Atomics.load(words, theirs + ASKED) === wordsTaken)
        {
            return null;
        }
        holding = true;
        return asked;
    };
    /** Answers the word call waiting with the handler: 1 where there was one. */
    const serveWords = ()=>{
        if (takeWords() === null)
        {
            return 0;
        }
        try
        {
            /** @type {WordsHandler} */ (wordsHandler)(asked, reply);
        }
        catch (e){
            // Sent before the answer's count: the asking side has it when it sees the answer.
            unlessClosed(()=>send(encodeValue([WORDS_FAILED, failureOf(e)])));
            publishAnswer(true);
            return 1;
        }
        publishAnswer(false);
        return 1;
    };

    /**
     * Handles everything the other side sent: its calls, its word call where
     * this side has a handler for them, and the answers to this side's calls.
     * How many there were.
     */
    const pump = ()=>{
        if (unsent.length > 0)
        {
            unlessClosed(()=>flush(false));
        }
        let count = inbound.drain(take);
        while (taken.length > 0)
        {
            handle(taken.shift());
        }
        if (wordsHandler !== undefined)
        {
            count += serveWords();
        }
        return count;
    };

    /**
     * What this side asked of the other with values, by target and method:
     * how often, and how long it was blocked for an answer.
     *
     * @type {Map<string, { count: number, waitedMs: number }>}
     */
    const askedOf = new Map();
    /** @param {string} target @param {string} method @param {number} waitedMs */
    const note = (target, method, waitedMs)=>{
        const key = `${target}.${method}`;
        const entry = askedOf.get(key) ?? { count: 0, waitedMs: 0 };
        entry.count++;
        entry.waitedMs += waitedMs;
        askedOf.set(key, entry);
    };

    /**
     * Whether `serve` goes on, whether its loop runs, and whether the link is
     * closed: an object, so the loop reads what `close` wrote.
     */
    const state = { serving: false, looping: false, closed: false };
    const closed = ()=>state.closed || inbound.closed();

    /** Whether the word call out is answered. */
    const wordsIn = ()=>Atomics.load(words, mine + ANSWERED) === wordsAsked;

    /**
     * Blocks until the value call `id` is answered, or with `id` -1 this side's
     * word call, handling everything the other side sends meanwhile; past
     * `until` it throws. One loop for both, made with no closure: the word
     * call's is the hot path.
     *
     * @param {number} id @param {number} until @param {string} what @param {number} timeoutMs
     */
    const waitFor = (id, until, what, timeoutMs)=>{
        for (;;)
        {
            const seen = bell.seen();
            pump();
            if (id < 0 ? wordsIn() : arrived.has(id))
            {
                return;
            }
            // Closed while it waited, by a call it answered meanwhile, or by
            // the other side, which will answer nothing now.
            if (closed())
            {
                throw new LinkClosed(what);
            }
            const peer = openHere.get(end.out.control);
            if (peer !== undefined)
            {
                // The other side is in this thread, which this wait holds: it
                // answers here, or never.
                if (peer.pump() > 0)
                {
                    continue;
                }
                throw new Error(`link: ${what}: the other side is in this thread and answered`
                    + ' nothing in place');
            }
            const left = until - performance.now();
            if (left <= 0)
            {
                throw new Error(`link: ${what} was not answered in ${timeoutMs} ms`);
            }
            if (bell.wait(seen, left, look()) === 'woke')
            {
                counts.slept++;
            }
        }
    };

    /**
     * Every call still waiting for an answer fails: nothing will answer it
     * now, and a caller left waiting would hold whatever it holds for good.
     */
    const failWaiting = ()=>{
        for (const [id, waiting] of [...promised])
        {
            promised.delete(id);
            waiting.reject(new LinkClosed(waiting.what));
        }
    };

    const self = {
        bell,
        pump,
        /** What this side sent, the sends that woke the other side, and its waits that slept. */
        counts,

        /**
         * Calls the other side and hands back a promise of its answer, which
         * `pump` - or `serve` - settles.
         *
         * @param {string} target @param {string} method @param {any[]} [args]
         * @returns {Promise<any>}
         */
        call(target, method, args = []){
            if (state.closed)
            {
                return Promise.reject(new LinkClosed(`${target}.${method}`));
            }
            note(target, method, 0);
            const id = nextId++;
            return new Promise((resolve, reject)=>{
                promised.set(id, { resolve, reject, what: `${target}.${method}` });
                try
                {
                    send(encodeValue([CALL, id, target, method, args]));
                }
                catch (e){
                    promised.delete(id);
                    reject(e instanceof RingClosed ? new LinkClosed(`${target}.${method}`) : e);
                }
            });
        },

        /**
         * Calls the other side and blocks this thread until it answers,
         * handling every call it is sent meanwhile. Only where the thread
         * may block.
         *
         * @param {string} target @param {string} method @param {any[]} [args]
         * @param {number} [timeoutMs]  in all; past it the call throws
         * @returns {any}
         */
        ask(target, method, args = [], timeoutMs = Infinity){
            const what = `${target}.${method}`;
            if (state.closed)
            {
                throw new LinkClosed(what);
            }
            const id = nextId++;
            const started = performance.now();
            awaited.add(id);
            try
            {
                try
                {
                    send(encodeValue([CALL, id, target, method, args]));
                }
                catch (e){
                    throw e instanceof RingClosed ? new LinkClosed(what) : e;
                }
                waitFor(id, started + timeoutMs, what, timeoutMs);
            }
            finally
            {
                awaited.delete(id);
            }
            note(target, method, performance.now() - started);
            const got = /** @type {{ ok: boolean, value: any }} */ (arrived.get(id));
            arrived.delete(id);
            if (!got.ok)
            {
                throw errorOf(got.value);
            }
            return got.value;
        },

        /**
         * Answers the other side for as long as the link is open, on the
         * event loop: the side that must never block. Resolves once `close`
         * is called, or the other side closes the link.
         */
        async serve(){
            if (state.closed)
            {
                return;
            }
            state.serving = true;
            state.looping = true;
            while (state.serving)
            {
                const seen = bell.seen();
                const handled = pump();
                // Closed here, or by the other side: it writes nothing more.
                if (!state.serving || inbound.closed())
                {
                    break;
                }
                // A side that asked one thing asks the next straight after;
                // the page's own thread does not look for it.
                if (handled > 0 && canBlock && bell.wait(seen, SPIN_MS, SPIN_MS) !== 'timed-out')
                {
                    continue;
                }
                await bell.waitAsync(seen);
            }
            // What the other side wrote before it was closed is still its word.
            pump();
            state.looping = false;
            failWaiting();
        },

        /** This side's word call's request words: written before `sendWords`. */
        request: words.subarray(mine + CALL_HEAD, mine + CALL_HEAD + size),
        /** Its answer's words, once `answered` says it came: read before the next word call. */
        answer: words.subarray(mine + CALL_HEAD + size, mine + stride),

        /**
         * Sends this side's word call, its words written into `request`, and
         * does not wait: `answered` says when it is answered, `waitWords`
         * waits. One at a time: another before this one's answer is taken throws.
         */
        sendWords(){
            if (wordsOut)
            {
                throw new Error('link: a word call while another is out');
            }
            if (closed())
            {
                throw new LinkClosed('a word call');
            }
            wordsOut = true;
            wordsAsked = (wordsAsked + 1) | 0;
            Atomics.store(words, mine + ASKED, wordsAsked);
            sent(outbound.bell.ring());
        },

        /**
         * Whether the word call sent is answered, its answer in `answer`:
         * taken once it is, and the next may be sent. Throws its failure
         * where its handler threw.
         */
        answered(){
            if (!wordsOut || !wordsIn())
            {
                return false;
            }
            wordsOut = false;
            if (words[mine + FAILED] !== 0)
            {
                // Its failure was sent before its answer: with the answer seen, it is in.
                if (wordsFailure === null)
                {
                    pump();
                }
                const failure = wordsFailure;
                wordsFailure = null;
                throw errorOf(failure);
            }
            return true;
        },

        /**
         * Blocks until the word call sent is answered, handling everything the
         * other side sends meanwhile, and takes its answer (`answered`).
         *
         * @param {number} [timeoutMs]
         */
        waitWords(timeoutMs = Infinity){
            if (!wordsOut)
            {
                throw new Error('link: no word call out to wait for');
            }
            if (!wordsIn())
            {
                waitFor(-1, performance.now() + timeoutMs, 'a word call', timeoutMs);
            }
            self.answered();
        },

        /** The other side's word call taken by `takeWords`: its request's words, where they lie. */
        asked,
        /** Where this side writes its answer to that call before `answerWords`. */
        reply,

        /**
         * The other side's word call, for a side with no handler of them: its
         * request (`asked`) once one waits and this side has not taken it, or
         * null. Answered by `answerWords`.
         *
         * @returns {Int32Array | null}
         */
        takeWords,

        /** Answers the word call taken with what `reply` holds. */
        answerWords(){
            if (!holding)
            {
                throw new Error('link: an answer with no word call taken');
            }
            publishAnswer(false);
        },

        /**
         * What this side asked with values, the most waited on first.
         *
         * @returns {{ calls: number, waitedMs: number,
         *     asked: { name: string, count: number, waitedMs: number }[] }}
         */
        diagnostics(){
            const rows = [...askedOf].map(([name, entry])=>({ name, ...entry }))
                .sort((x, y)=>y.waitedMs - x.waitedMs || y.count - x.count);
            return {
                calls: rows.reduce((sum, row)=>sum + row.count, 0),
                waitedMs: rows.reduce((sum, row)=>sum + row.waitedMs, 0),
                asked: rows.slice(0, 16),
            };
        },

        /** Whether either side closed the link. */
        closed,

        /**
         * Stops `serve`, and fails every call still waiting for an answer -
         * once `serve` has read what the other side wrote last, where it runs.
         * A call made after this fails at once, and so does one the other side
         * makes or waits on: the link is closed for both.
         */
        close(){
            state.serving = false;
            state.closed = true;
            if (openHere.get(end.in.control) === self)
            {
                openHere.delete(end.in.control);
            }
            // Both rings: a side waiting for room to write to this one, or
            // for its answer, ends now rather than at its own time. Closing
            // what this side reads rings its own doorbell, so its `serve` ends.
            outbound.close();
            inbound.close();
            if (!state.looping)
            {
                failWaiting();
            }
        },
    };
    openHere.set(end.in.control, self);
    return self;
}

/** @typedef {ReturnType<typeof openLink>} Link */
/** @typedef {import('./bell.js').WaitEnd} WaitEnd */
