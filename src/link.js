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
 * Beside the values, each side has calls in place (`slots` of them out at
 * once): the request's bytes written into the link's shared memory where the
 * other side reads them, an atomic count published after it, the answer the
 * same way back, no record and no value made. It is the path of a protocol
 * that takes turns millions of times - a slice asked for, a trap answered, a
 * keeper's room - for which the value path would be a record, a decode and an
 * object a turn. A word call is such a call of the slot's whole size, its
 * request and answer read as words. Calls in place and value calls are not
 * ordered with each other; each is in order with itself.
 *
 * Both sides may be in one thread: a side that waits for an answer from a side
 * of this thread serves that side in place, which only it can do then.
 */

import { SPIN_MS, mayWait, serveHere, servedHere } from './bell.js';
import { decodeValue, encodeValue } from './codec.js';
import { bytesOf } from './bytes.js';
import { RingClosed, createRingMemory, openRing } from './ring.js';

/** How a word call's answer is read: in `answer`, by whoever asked. */
const NO_READ = ()=>undefined;

/** The records on a link's rings: a call, an answer, a word call's failure. */
const CALL = 0;
const ANSWER = 1;
const WORDS_FAILED = 2;
/**
 * A part of a record too long for the ring: no value's first byte (`codec.js`),
 * the whole record's length in the word after, then its bytes; the whole is in
 * once that many have come.
 */
const PART = 0xff;
const PART_HEAD = 8;

/** The words of a link's calls in place: its layout, the words of a slot's request, its slots. */
const LAYOUT = 0;
const WORDS = 1;
const SLOTS = 2;
const HEAD_WORDS = 3;
/** A word that no zeroed or foreign memory holds: "LNK" and the layout's version. */
const LINK_LAYOUT = 0x4c4e4b02;
/**
 * A side's calls in place: the calls it made and those the other side
 * answered, counts that wrap at 2^32, then its slots, call `n` in slot `n`
 * modulo their count. A slot: whether its answer is a failure (then sent as
 * a value before the answer's count), the bytes of the request and of the
 * answer, then the request's words and the answer's.
 */
const ASKED = 0;
const ANSWERED = 1;
const CALLS_HEAD = 2;
const FAILED = 0;
const REQUEST_BYTES = 1;
const ANSWER_BYTES = 2;
const SLOT_HEAD = 3;
/**
 * Who takes a slot's answer: nobody (free), a wait, a promise, the word call;
 * or whoever reads it now, which a call made inside that read cannot wait
 * for.
 */
const FREE = 0;
const WAITED = 1;
const LATER = 2;
const WORD_CALL = 3;
const READING = 4;

/** How long a writer waits for room before it looks at what came in again. */
const ROOM_LOOK_MS = 1;

/** A link's rings, each way, by default: what a call and its values fit in, many times over. */
const LINK_BYTES = 1 << 20;

/** Why a call ended without its answer: the link is closed, or closing, and nothing will answer it. */
export class LinkClosed extends Error {
    /** @param {string} what  the call */
    constructor(what){
        super(`link: ${what}: the link is closed`);
        this.name = 'LinkClosed';
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
const errorOf = ({ message, ...said })=>Object.assign(new Error(message), said);

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
 * @param {{ capacity?: number, words?: number, slots?: number,
 *     bellA?: import('./bell.js').DoorbellMemory, bellB?: import('./bell.js').DoorbellMemory }} [options]
 *     capacity: each ring's bytes (`LINK_BYTES`); words: of a call in place's request, and of
 *     its answer (4); slots: such calls a side has out at once, a power of two (1)
 * @returns {{ a: LinkEnd, b: LinkEnd }}
 */
export function createLinkMemory({ capacity = LINK_BYTES, words = 4, slots = 1, bellA, bellB } = {}){
    if (!Number.isInteger(words) || words < 0 || words > 256)
    {
        throw new RangeError(`link: calls in place of ${words} words`);
    }
    if (!Number.isInteger(slots) || slots < 1 || slots > 256 || (slots & (slots - 1)) !== 0)
    {
        throw new RangeError(`link: ${slots} slots of calls in place`);
    }
    const toA = createRingMemory(capacity, bellA);
    const toB = createRingMemory(capacity, bellB);
    const shared = new SharedArrayBuffer((HEAD_WORDS + 2 * sideWords(words, slots)) * 4);
    const head = new Int32Array(shared);
    head[LAYOUT] = LINK_LAYOUT;
    head[WORDS] = words;
    head[SLOTS] = slots;
    return { a: { out: toB, in: toA, words: shared, side: 0 },
        b: { out: toA, in: toB, words: shared, side: 1 } };
}

/** A side's words of calls in place. @param {number} size @param {number} slots */
const sideWords = (size, slots)=>CALLS_HEAD + slots * (SLOT_HEAD + 2 * size);

/**
 * What a side answers the other's value calls with: a handler per target and
 * method, which may return a promise, its answer sent when it settles.
 *
 * @typedef {Record<string, Record<string, (...args: any[]) => any>>} Handlers
 */

/**
 * What answers the other side's calls in place in `pump`, so at any depth of
 * a wait: the request's words and the answer's, both where they lie, and the
 * bytes of the request; it writes the answer before it returns, and returns
 * its bytes (the slot's whole size where it returns nothing, as a word call's
 * answer is). A throw is the call's failure. A side whose answer cannot be
 * made in one turn (a slice run between turns of its event loop) has none,
 * and takes the call itself (`takeWords`, `answerWords`).
 *
 * @typedef {(request: Int32Array, answer: Int32Array, length: number) => number | void} WordsHandler
 */

/**
 * One side of a link.
 *
 * @param {LinkEnd} end
 * @param {Handlers} [handlers]
 * @param {{ words?: WordsHandler, spinMs?: number | (() => number), afterSend?: () => void,
 *     onAfterSendFailure?: (error: unknown) => void }}
 *     [options]  spinMs: how long a blocking wait looks before it sleeps, or what says so as
 *     each wait begins; by default as long as this side's waits learnt to (`createSpin`).
 *     afterSend: run after each send has rung the other side, where the other side must also
 *     be told another way (a word its running loop polls). The send is made by then: a
 *     throw from it fails no call, and is counted (`afterSendFailures`) and handed to
 *     onAfterSendFailure, by default thrown where nothing catches it.
 */
export function openLink(end, handlers = {}, { words: wordsHandler, spinMs, afterSend,
    onAfterSendFailure = e=>{
        queueMicrotask(()=>{
            throw e;
        });
    } } = {}){
    const outbound = openRing(end.out);
    const inbound = openRing(end.in);
    const bell = inbound.bell;
    const words = new Int32Array(end.words);
    const size = words[WORDS];
    const slots = words[SLOTS];
    if (words.length < HEAD_WORDS || words[LAYOUT] !== LINK_LAYOUT || !(size >= 0) || !(slots >= 1)
        || (slots & (slots - 1)) !== 0 || words.length < HEAD_WORDS + 2 * sideWords(size, slots)
        || (end.side !== 0 && end.side !== 1))
    {
        throw new Error('link: the memory is not a link of this layout');
    }
    const stride = sideWords(size, slots);
    const mine = HEAD_WORDS + end.side * stride;
    const theirs = HEAD_WORDS + (1 - end.side) * stride;
    /** Waits look this long, or as the side's waits learnt to (undefined). */
    const look = typeof spinMs === 'function' ? spinMs : ()=>spinMs;
    /** Its records and word sends, the word sends that woke the other side, its waits that slept. */
    const counts = { sent: 0, woke: 0, slept: 0, afterSendFailures: 0 };
    /** `afterSend`, after a send made: what it throws is its own failure, not the call's. */
    const told = ()=>{
        try
        {
            afterSend?.();
        }
        catch (e){
            counts.afterSendFailures++;
            onAfterSendFailure(e);
        }
    };
    /** A word send, and whether it woke the other side. @param {boolean} notified */
    const sent = notified=>{
        counts.sent++;
        if (notified)
        {
            counts.woke++;
        }
        told();
    };

    let nextId = 1;
    /**
     * The calls not answered yet, by id, whether a promise or a wait is
     * handed their answer: each answer settles its own, in whatever order
     * the answers come.
     *
     * @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void,
     *     what: string }>}
     */
    const waiting = new Map();
    const canBlock = mayWait();

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
    /** Whether a flush is writing: one called from inside it, by what it handles while it waits, leaves the rest to it. */
    let flushing = false;
    const partWords = new DataView(outbound.bytes.buffer);
    /**
     * Room for `length` bytes in the ring this side writes, waited for where
     * the thread may block: the other side may itself be waiting for room in
     * this side's ring, or be in this thread, so while there is none this
     * side reads what came in and serves a side of this thread in place.
     *
     * @param {number} length
     */
    const roomFor = length=>{
        for (;;)
        {
            const at = outbound.reserve(length);
            if (at >= 0)
            {
                return at;
            }
            const served = servedHere(end.out.control);
            if (pump() > 0 || served > 0)
            {
                continue;
            }
            if (served === 0)
            {
                throw new Error(`link: a record of ${length} bytes: the other side is in this`
                    + ' thread and read nothing');
            }
            const waited = outbound.reserveWaiting(length, ROOM_LOOK_MS);
            if (waited >= 0)
            {
                return waited;
            }
        }
    };
    /**
     * Writes what waits to be written; a ring the other side closed takes
     * nothing more, and what waited goes to nobody.
     *
     * @param {boolean} block
     */
    const flush = block=>{
        if (flushing)
        {
            return;
        }
        flushing = true;
        try
        {
            for (; unsent.length > 0; unsent.shift(), unsentAt = 0)
            {
                const record = unsent[0];
                const head = record.length > outbound.maxRecord ? PART_HEAD : 0;
                do
                {
                    const length = Math.min(outbound.maxRecord - head, record.length - unsentAt);
                    let at = outbound.reserve(head + length);
                    if (at < 0)
                    {
                        if (!block)
                        {
                            return;
                        }
                        at = roomFor(head + length);
                    }
                    if (head > 0)
                    {
                        outbound.bytes[at] = PART;
                        partWords.setUint32(at + 4, record.length, true);
                    }
                    outbound.bytes.set(record.subarray(unsentAt, unsentAt + length), at + head);
                    outbound.commit();
                    counts.sent++;
                    unsentAt += length;
                } while (unsentAt < record.length);
            }
        }
        catch (e){
            if (e instanceof RingClosed)
            {
                unsent.length = 0;
                unsentAt = 0;
            }
            throw e;
        }
        finally
        {
            flushing = false;
        }
    };
    /** @param {Uint8Array} record */
    const send = record=>{
        unsent.push(record);
        flush(canBlock && unsent.length === 1);
        told();
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
     * Answers call `id` with a value, or (`ok` false) the failure thrown. An
     * answer that cannot cross - a handler that returned what the codec does
     * not carry - goes as the failure it is: the caller is told, and the side
     * answering, which serves every call, goes on.
     *
     * @param {number} id @param {boolean} ok @param {any} value
     */
    const answer = (id, ok, value)=>{
        let record;
        try
        {
            record = encodeValue([ANSWER, id, ok, ok ? value : failureOf(value)]);
        }
        catch (e){
            record = encodeValue([ANSWER, id, false, failureOf(e)]);
        }
        unlessClosed(()=>send(record));
    };

    /** @param {number} id @param {string} target @param {string} method @param {any[]} args */
    const dispatch = (id, target, method, args)=>{
        let result;
        try
        {
            const handler = handlers[target]?.[method];
            if (!handler)
            {
                throw new Error(`link: nothing answers ${target}.${method}`);
            }
            result = handler(...args);
        }
        catch (e){
            answer(id, false, e);
            return;
        }
        if (typeof result?.then === 'function')
        {
            result.then((/** @type {any} */ value)=>answer(id, true, value),
                (/** @type {any} */ e)=>answer(id, false, e));
            return;
        }
        answer(id, true, result);
    };

    /** The whole of a record coming in parts, and how much of it is in. @type {Uint8Array | null} */
    let whole = null;
    let wholeAt = 0;
    /** The failures of this side's calls in place, by number, come before their answers. @type {Map<number, any>} */
    const failures = new Map();
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
            if (wholeAt === whole.length)
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
            failures.set(record[1], record[2]);
            return;
        }
        const [, id, ok, value] = record;
        const call = waiting.get(id);
        if (call)
        {
            waiting.delete(id);
            if (ok)
            {
                call.resolve(value);
            }
            else
            {
                call.reject(errorOf(value));
            }
        }
    };

    /**
     * A side's slots where they lie: each one's words and bytes, request and
     * answer, made once.
     *
     * @param {number} side
     */
    const slotsOf = side=>Array.from({ length: slots }, (_, slot)=>{
        const at = side + CALLS_HEAD + slot * (SLOT_HEAD + 2 * size);
        return { at, request: words.subarray(at + SLOT_HEAD, at + SLOT_HEAD + size),
            answer: words.subarray(at + SLOT_HEAD + size, at + SLOT_HEAD + 2 * size),
            requestBytes: new Uint8Array(end.words, (at + SLOT_HEAD) * 4, size * 4),
            answerBytes: new Uint8Array(end.words, (at + SLOT_HEAD + size) * 4, size * 4),
            /** The answer's bytes as last read, made again only when their length changes. */
            answered: /** @type {Uint8Array} */ (new Uint8Array(0)) };
    });
    const mySlots = slotsOf(mine);
    const theirSlots = slotsOf(theirs);
    /** @param {number} n */
    const slotOf = n=>n & (slots - 1);

    /** The other side's calls this side took, and whether one taken is not answered yet. */
    let callsTaken = Atomics.load(words, theirs + ANSWERED);
    let holding = false;

    /**
     * Answers the call taken with the `length` bytes its answer holds, or
     * with `failure`, sent as a value before the answer's count: the asking
     * side has it when it sees the answer.
     *
     * @param {unknown} [failure] @param {number} [length]
     */
    const answerWords = (failure, length = size * 4)=>{
        if (!holding)
        {
            throw new Error('link: an answer with no call taken');
        }
        if (failure !== undefined)
        {
            unlessClosed(()=>send(encodeValue([WORDS_FAILED, callsTaken, failureOf(failure)])));
        }
        const at = theirSlots[slotOf(callsTaken)].at;
        holding = false;
        words[at + FAILED] = failure === undefined ? 0 : 1;
        words[at + ANSWER_BYTES] = failure === undefined ? length : 0;
        callsTaken = (callsTaken + 1) | 0;
        Atomics.store(words, theirs + ANSWERED, callsTaken);
        sent(outbound.bell.ring());
    };
    /** The other side's next call, once one waits and is not taken yet: its request. */
    const takeWords = ()=>{
        if (holding || Atomics.load(words, theirs + ASKED) === callsTaken)
        {
            return null;
        }
        holding = true;
        return theirSlots[slotOf(callsTaken)].request;
    };
    /** Answers every call waiting with the handler: how many. */
    const serveWords = ()=>{
        let count = 0;
        while (takeWords() !== null)
        {
            const slot = theirSlots[slotOf(callsTaken)];
            let failure;
            let length = size * 4;
            try
            {
                const said = /** @type {WordsHandler} */ (wordsHandler)(slot.request, slot.answer,
                    words[slot.at + REQUEST_BYTES]);
                if (said !== undefined)
                {
                    if (!(said >= 0 && said <= size * 4))
                    {
                        throw new RangeError(`link: an answer of ${said} bytes, a slot holds ${size * 4}`);
                    }
                    length = said;
                }
            }
            catch (e){
                failure = e ?? new Error('link: a call in place failed');
            }
            answerWords(failure, length);
            count++;
        }
        return count;
    };

    /** This side's calls in place: how many it sent; whose each slot's answer is, and its call's number. */
    let callsSent = Atomics.load(words, mine + ASKED);
    const owners = new Uint8Array(slots);
    const numbers = new Int32Array(slots);
    /** For a slot whose answer a promise takes: its reader and its promise's ends. */
    const laterReads = /** @type {((answer: Uint8Array) => any)[]} */ (new Array(slots).fill(null));
    const laterResolves = /** @type {((value: any) => void)[]} */ (new Array(slots).fill(null));
    const laterRejects = /** @type {((reason: any) => void)[]} */ (new Array(slots).fill(null));
    let later = 0;
    /** Whether the word call is out, or being sent, and its number. */
    let wordsOut = false;
    let wordsSending = false;
    let wordsNumber = 0;
    /**
     * The word call's request as written (`request`), and as it is sent: a
     * slot is the other side's to read once its call is out, and the slot the
     * next call takes may still hold one, so the request is written here and
     * copied in once the slot is free; taken before the wait for it, as a
     * call handled meanwhile may write the next.
     */
    const requestWords = new Int32Array(size);
    const sendingWords = new Int32Array(size);

    /** Whether this side's call `n` is answered. @param {number} n */
    const callIn = n=>((Atomics.load(words, mine + ANSWERED) - n) | 0) > 0;

    /**
     * The answer of call `n`, in slot `slot`, read by `read` where it lies,
     * the slot free again; its failure thrown.
     *
     * @template T @param {number} slot @param {number} n @param {(answer: Uint8Array) => T} read
     * @returns {T}
     */
    const finish = (slot, n, read)=>{
        const one = mySlots[slot];
        if (words[one.at + FAILED] !== 0)
        {
            owners[slot] = FREE;
            // Its failure was sent before its answer: with the answer seen, it is in.
            if (!failures.has(n))
            {
                pump();
            }
            const failure = failures.get(n) ?? { message: 'link: a call in place failed' };
            failures.delete(n);
            throw errorOf(failure);
        }
        const length = words[one.at + ANSWER_BYTES];
        if (one.answered.length !== length)
        {
            one.answered = one.answerBytes.subarray(0, length);
        }
        // The answer lies in the slot until it is read: a call made inside
        // the read is refused rather than written over it.
        owners[slot] = READING;
        try
        {
            return read(one.answered);
        }
        finally
        {
            owners[slot] = FREE;
        }
    };

    /** Answers come for calls whose promise takes them: settled, oldest first. */
    const settleLater = ()=>{
        for (let k = 0; k < slots && later > 0; k++)
        {
            const slot = slotOf(callsSent + k);
            if (owners[slot] !== LATER || !callIn(numbers[slot]))
            {
                continue;
            }
            later--;
            const read = laterReads[slot];
            const resolve = laterResolves[slot];
            const reject = laterRejects[slot];
            laterReads[slot] = laterResolves[slot] = laterRejects[slot] = /** @type {any} */ (null);
            let value;
            try
            {
                value = finish(slot, numbers[slot], read);
            }
            catch (e){
                reject(e);
                continue;
            }
            resolve(value);
        }
    };

    /**
     * Handles everything the other side sent: its calls, its word call where
     * this side has a handler for them, and the answers to this side's calls.
     * How many there were.
     */
    const pump = ()=>{
        unlessClosed(()=>flush(false));
        let count = inbound.drain(take);
        while (taken.length > 0)
        {
            handle(taken.shift());
        }
        if (wordsHandler !== undefined)
        {
            count += serveWords();
        }
        if (later > 0)
        {
            settleLater();
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

    /**
     * Blocks until the value call `id` is answered, or with `id` 0 this side's
     * call in place `n`, handling everything the other side sends meanwhile;
     * past `until` it throws. One loop for both, made with no closure: the
     * call in place's is the hot path.
     *
     * @param {number} id @param {number} until @param {string} what @param {number} timeoutMs
     * @param {number} [n]
     */
    const waitFor = (id, until, what, timeoutMs, n = 0)=>{
        for (;;)
        {
            const seen = bell.seen();
            pump();
            if (id === 0 ? callIn(n) : !waiting.has(id))
            {
                return;
            }
            // Closed while it waited, by a call it answered meanwhile, or by
            // the other side, which will answer nothing now.
            if (closed())
            {
                throw new LinkClosed(what);
            }
            // The other side is in this thread, which this wait holds: it
            // answers here, or never.
            const served = servedHere(end.out.control);
            if (served > 0)
            {
                continue;
            }
            if (served === 0)
            {
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
        for (const [id, call] of [...waiting])
        {
            waiting.delete(id);
            call.reject(new LinkClosed(call.what));
        }
        for (let slot = 0; slot < slots; slot++)
        {
            if (owners[slot] === LATER)
            {
                owners[slot] = FREE;
                later--;
                laterRejects[slot](new LinkClosed('a call in place'));
            }
        }
    };

    /**
     * The slot of this side's next call in place, once it is free: an answer
     * a promise takes is settled, and one not in yet waited for where this
     * thread may block. A slot whose answer a wait or the word call is to
     * take - a wait this call is made inside of - is not freed by waiting:
     * every slot out is said.
     *
     * @param {string} what
     */
    const claim = what=>{
        if (closed())
        {
            throw new LinkClosed(what);
        }
        // The next call's slot, looked at again after every wait: a call
        // handled while this one waited may have sent calls of its own.
        for (let slot = slotOf(callsSent); ; slot = slotOf(callsSent))
        {
            if (owners[slot] === FREE)
            {
                return slot;
            }
            if (owners[slot] !== LATER || !canBlock)
            {
                throw new Error(`link: ${what}: every call in place is out (${slots})`);
            }
            if (callIn(numbers[slot]))
            {
                settleLater();
            }
            else
            {
                waitFor(0, Infinity, what, Infinity, numbers[slot]);
            }
        }
    };

    /**
     * Sends the request written into `slot`, `length` bytes, its answer taken
     * by `owner`: the call's number.
     *
     * @param {number} slot @param {number} length @param {number} owner
     */
    const sendInPlace = (slot, length, owner)=>{
        const n = callsSent;
        if (slot !== slotOf(n) || owners[slot] !== FREE)
        {
            throw new Error(`link: call ${n} sent from slot ${slot}, not its own free one`);
        }
        words[mySlots[slot].at + REQUEST_BYTES] = length;
        owners[slot] = owner;
        numbers[slot] = n;
        callsSent = (callsSent + 1) | 0;
        Atomics.store(words, mine + ASKED, callsSent);
        sent(outbound.bell.ring());
        return n;
    };

    /**
     * Writes `request` into the next slot, once it is free: the slot.
     *
     * @param {ArrayLike<number>} request @param {string} what
     */
    const writeRequest = (request, what)=>{
        const bytes = bytesOf(request, 'link');
        if (bytes.length > size * 4)
        {
            throw new RangeError(`link: ${what} of ${bytes.length} bytes, a slot holds ${size * 4}`);
        }
        const slot = claim(what);
        mySlots[slot].requestBytes.set(bytes);
        return { slot, length: bytes.length };
    };

    /**
     * Sends call `id`, its answer to `resolve` or `reject`; a link closed
     * fails it with `LinkClosed`, which it throws.
     *
     * @param {number} id @param {string} target @param {string} method @param {any[]} args
     * @param {(value: any) => void} resolve @param {(error: Error) => void} reject
     * @returns {Uint8Array}  the call's record
     */
    const sendCall = (id, target, method, args, resolve, reject)=>{
        const what = `${target}.${method}`;
        try
        {
            if (state.closed)
            {
                throw new RingClosed();
            }
            waiting.set(id, { resolve, reject, what });
            const record = encodeValue([CALL, id, target, method, args]);
            send(record);
            return record;
        }
        catch (e){
            waiting.delete(id);
            throw e instanceof RingClosed ? new LinkClosed(what) : e;
        }
    };

    const self = {
        bell,
        pump,

        /**
         * Calls the other side and hands back a promise of its answer, which
         * `pump` - or `serve` - settles.
         *
         * @param {string} target @param {string} method @param {any[]} [args]
         * @returns {Promise<any>}
         */
        call(target, method, args = []){
            note(target, method, 0);
            const id = nextId++;
            return new Promise((resolve, reject)=>sendCall(id, target, method, args, resolve, reject));
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
            const id = nextId++;
            const started = performance.now();
            /** @type {{ value?: any, error?: Error }} */
            const got = {};
            const record = sendCall(id, target, method, args, value=>{
                got.value = value;
            }, error=>{
                got.error = error;
            });
            try
            {
                // Made by what this side handles while it waits for room to
                // send a record before it: it goes out only once that one
                // has, which is after this wait.
                if (flushing && unsent.includes(record))
                {
                    throw new Error(`link: ${target}.${method}: asked while this side waits to send`
                        + ' a record before it, which it cannot send until this is answered');
                }
                waitFor(id, started + timeoutMs, `${target}.${method}`, timeoutMs);
            }
            finally
            {
                waiting.delete(id);
            }
            note(target, method, performance.now() - started);
            if (got.error !== undefined)
            {
                throw got.error;
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

        /**
         * Calls the other side in place and blocks until it answers, handling
         * every call it is sent meanwhile: what `read` makes of the answer,
         * read where it lies (valid only inside `read`). The request's bytes
         * are copied into the link's memory. Only where the thread may block.
         *
         * @template T
         * @param {ArrayLike<number>} request @param {(answer: Uint8Array) => T} read
         * @param {number} [timeoutMs]
         * @returns {T}
         */
        askBytes(request, read, timeoutMs = Infinity){
            const { slot, length } = writeRequest(request, 'a call in place');
            const n = sendInPlace(slot, length, WAITED);
            if (!callIn(n))
            {
                try
                {
                    waitFor(0, performance.now() + timeoutMs, 'a call in place', timeoutMs, n);
                }
                catch (e){
                    // Its answer, if one comes, goes to nobody.
                    owners[slot] = LATER;
                    later++;
                    laterReads[slot] = ()=>undefined;
                    laterResolves[slot] = laterRejects[slot] = ()=>{};
                    throw e;
                }
            }
            return finish(slot, n, read);
        },

        /**
         * Calls the other side in place and hands back a promise of what
         * `read` makes of the answer, which `pump` - or `serve` - settles.
         * With every slot out, a thread that may block waits for one; one
         * that may not is refused.
         *
         * @template T
         * @param {ArrayLike<number>} request @param {(answer: Uint8Array) => T} read
         * @returns {Promise<T>}
         */
        callBytes(request, read){
            try
            {
                const { slot, length } = writeRequest(request, 'a call in place');
                const answered = new Promise((resolve, reject)=>{
                    laterReads[slot] = read;
                    laterResolves[slot] = resolve;
                    laterRejects[slot] = reject;
                });
                later++;
                sendInPlace(slot, length, LATER);
                return answered;
            }
            catch (e){
                return Promise.reject(e);
            }
        },

        /** This side's next word call's request words: written before `sendWords`. */
        get request(){
            return requestWords;
        },
        /** The word call's answer words, once `answered` says it came: read before the next call. */
        get answer(){
            return mySlots[slotOf(wordsNumber)].answer;
        },

        /**
         * Sends this side's word call, its words written into `request`, and
         * does not wait: `answered` says when it is answered, `waitWords`
         * waits. One at a time: another before this one's answer is taken throws.
         */
        sendWords(){
            if (wordsOut || wordsSending)
            {
                throw new Error('link: a word call while another is out');
            }
            sendingWords.set(requestWords);
            wordsSending = true;
            try
            {
                const slot = claim('a word call');
                mySlots[slot].request.set(sendingWords);
                wordsNumber = sendInPlace(slot, size * 4, WORD_CALL);
                wordsOut = true;
            }
            finally
            {
                wordsSending = false;
            }
        },

        /**
         * Whether the word call sent is answered, its answer in `answer`:
         * taken once it is, and the next may be sent. Throws its failure
         * where its handler threw.
         */
        answered(){
            if (!wordsOut || !callIn(wordsNumber))
            {
                return false;
            }
            wordsOut = false;
            finish(slotOf(wordsNumber), wordsNumber, NO_READ);
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
            if (!callIn(wordsNumber))
            {
                waitFor(0, performance.now() + timeoutMs, 'a word call', timeoutMs, wordsNumber);
            }
            self.answered();
        },

        /** Where this side writes its answer to the call taken before `answerWords`. */
        get reply(){
            return theirSlots[slotOf(callsTaken)].answer;
        },

        /**
         * The other side's next call in place, for a side with no handler of
         * them: its request's words once one waits and this side has not taken
         * it, or null. Answered by `answerWords`.
         *
         * @returns {Int32Array | null}
         */
        takeWords,
        answerWords,

        /**
         * What this side sent, woke and slept (`counts`), how often `afterSend` threw,
         * and what it asked with
         * values, the most waited on first.
         *
         * @returns {{ sent: number, woke: number, slept: number, afterSendFailures: number,
         *     calls: number, waitedMs: number, asked: { name: string, count: number, waitedMs: number }[] }}
         */
        diagnostics(){
            const rows = [...askedOf].map(([name, entry])=>({ name, ...entry }))
                .sort((x, y)=>y.waitedMs - x.waitedMs || y.count - x.count);
            return {
                ...counts,
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
            withdraw();
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
    const withdraw = serveHere(end.in.control, pump);
    return self;
}

/** @typedef {ReturnType<typeof openLink>} Link */
/** @typedef {import('./bell.js').WaitEnd} WaitEnd */
