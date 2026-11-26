/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Records one thread writes and any number of threads read, the newest kept
 * and the oldest written over: a log, a trace, the times frames were shown.
 *
 * The writer never waits. A reader that falls behind loses the records the
 * writer laps, and is told so; it cannot hold the writer back. That is what
 * sets this apart from a ring (`ring.js`), whose one reader is handed every
 * record and whose writer waits for it when full.
 *
 * A record is built where it is read: `reserve(length)` gives its offset in
 * the journal's buffer, the writer fills it with views of its own, `commit()`
 * publishes it and answers its sequence. Each record is whole in the buffer
 * (one that would run past the end starts the buffer again), behind a header
 * of its length and sequence, at an offset a multiple of eight, so a
 * `Float64Array` or a `DataView` reads it in place.
 *
 * A reader asks for a record by sequence and is handed its bytes in place,
 * inside a call (`read(sequence, take)`): what `take` returns is the answer,
 * unless the writer reached those bytes while `take` read them, which the
 * check after it tells -- then the record is gone, as if read too late. So
 * `take` copies or decodes what it keeps, and keeps nothing of the view. A
 * reader on a hot path does the same in two steps of its own, with no call
 * between (`find`, then `intact`).
 *
 * Counts are of bytes ever reserved and records ever committed, in 32-bit
 * words that wrap, compared by their unsigned difference: exact as long as no
 * reader falls 2^31 records behind. The buffer's size is a power of two, so a
 * count of bytes maps to the same place on either side of a wrap.
 *
 * Over a `SharedArrayBuffer` the readers are on other threads; over an
 * `ArrayBuffer` (`shared: false`) they are on the writer's, and nothing else
 * changes.
 */

/** Control words. */
const VERSION = 0;
const RECORDS = 1;
const BYTES = 2;
const FIRST = 3;
/** Bytes ever reserved: moved before the bytes are written, so a reader sees a lap. */
const HEAD = 4;
/** Records ever committed: moved after, so a reader that sees a record sees its bytes. */
const WRITTEN = 5;
const CONTROL_WORDS = 8;
const CONTROL_BYTES = CONTROL_WORDS * 4;
/** The word of bytes ever reserved, for a test that starts a journal near a wrap of it. */
export const HEAD_WORD = HEAD;

const LAYOUT = 1;

/** A record's header: its length, then its sequence; its bytes after, eight-aligned. */
const HEADER = 8;

/** Why a record was not reserved: kept out of `reserve` so it stays small enough to inline. @param {number} length @param {number} most */
const refuse = (length, most)=>{
    throw new RangeError(`journal: a record of ${length} bytes, at most ${most}`);
};

/** @param {string} why */
const misuse = why=>{
    throw new Error(`journal: ${why}`);
};

/** @param {number} n @param {number} to */
const alignUp = (n, to)=>Math.ceil(n / to) * to;

/**
 * Where a journal lies: one buffer, handed over whole.
 *
 * @typedef {{ buffer: SharedArrayBuffer | ArrayBuffer }} JournalMemory
 */

/**
 * The memory of a new journal.
 *
 * @param {Object} [options]
 * @param {number} [options.records]  records a reader can still find by sequence
 *     (4096 by default): the index's length
 * @param {number} [options.bytes]  bytes of records, rounded up to a power of two of at
 *     least 64 (1 MiB by default); a record takes its length and 8, rounded up to 8
 * @param {number} [options.first]  the sequence of the first record (0 by default):
 *     a journal that takes over from another goes on counting where it ended
 * @param {boolean} [options.shared]  over shared memory, for readers on other
 *     threads (by default, where there is a `SharedArrayBuffer`)
 * @returns {JournalMemory}
 */
export function createJournalMemory({ records = 4096, bytes = 1 << 20, first = 0,
    shared = typeof SharedArrayBuffer === 'function' } = {}){
    if (!Number.isInteger(records) || records < 1 || records > 1 << 24)
    {
        throw new RangeError(`journal: ${records} records`);
    }
    if (typeof bytes !== 'number' || !(bytes > 0) || bytes > 1 << 30)
    {
        throw new RangeError(`journal: ${bytes} bytes; at most 1 GiB`);
    }
    if (!Number.isInteger(first) || first < 0 || first > 0xffffffff)
    {
        throw new RangeError(`journal: a first sequence of ${first}`);
    }
    let size = 64;
    while (size < bytes)
    {
        size *= 2;
    }
    const total = CONTROL_BYTES + alignUp(records * 4, 8) + size;
    const buffer = shared ? new SharedArrayBuffer(total) : new ArrayBuffer(total);
    const control = new Int32Array(buffer, 0, CONTROL_WORDS);
    control[VERSION] = LAYOUT;
    control[RECORDS] = records;
    control[BYTES] = size;
    control[FIRST] = first | 0;
    return { buffer };
}

/**
 * One side of a journal, opened from its memory in any thread: the writer's
 * methods belong to one thread, the reader's to any. A class: its methods are
 * called on it (`journal.reserve(n)`), which is what lets an engine inline
 * them into a caller's hot path.
 */
class Journal {
    /** @param {JournalMemory} memory */
    constructor(memory){
        const { buffer } = memory;
        const control = new Int32Array(buffer, 0, CONTROL_WORDS);
        if (control[VERSION] !== LAYOUT)
        {
            throw new Error('journal: the memory is not a journal of this layout');
        }
        this.control = control;
        /** Records a reader can still find by sequence. */
        this.records = control[RECORDS];
        this.capacity = control[BYTES];
        this.firstSequence = control[FIRST] >>> 0;
        this.index = new Int32Array(buffer, CONTROL_BYTES, this.records);
        /** Where the records begin in the buffer. */
        this.base = CONTROL_BYTES + alignUp(this.records * 4, 8);
        this.mask = this.capacity - 1;
        this.words = new DataView(buffer);
        /** The whole buffer: a record's bytes are at the offsets `reserve` and `find` give. */
        this.bytes = new Uint8Array(buffer);
        /** The longest record: one that fits wherever the journal is. */
        this.maxRecord = this.capacity - HEADER;
        // The writer's own counts; the control words publish them.
        this.head = Atomics.load(control, HEAD) >>> 0;
        this.count = Atomics.load(control, WRITTEN) >>> 0;
        /** Where the record reserved and not committed starts, or -1. */
        this.reserved = -1;
        /** Where the record `find` answered last starts, in bytes ever reserved. */
        this.found = 0;
    }

    /**
     * The writer's: room for a record of `length` bytes, at the offset in
     * `bytes` it answers, eight-aligned. Records written before it may be
     * written over now. Throws where `length` is more than `maxRecord`, or
     * where a record reserved is not yet committed.
     *
     * @param {number} length
     * @returns {number}
     */
    reserve(length){
        if (this.reserved >= 0)
        {
            misuse('reserved again before a commit');
        }
        // An integer from 0 to the longest, NaN and fractions included:
        // `| 0` leaves only those unchanged.
        if (!(length >= 0 && length <= this.maxRecord && (length | 0) === length))
        {
            refuse(length, this.maxRecord);
        }
        const capacity = this.capacity;
        const need = HEADER + ((length + 7) & ~7);
        let start = this.head;
        const at = start & this.mask;
        if (at + need > capacity)
        {
            // Whole in the buffer: the tail is skipped, and the index says
            // where each record starts, so no reader looks for a marker.
            start = (start + (capacity - at)) >>> 0;
        }
        this.head = (start + need) >>> 0;
        // Moved before the bytes are written over: a reader checks its read
        // against it after, and the check is honest only if it covers them.
        Atomics.store(this.control, HEAD, this.head | 0);
        const place = this.base + (start & this.mask);
        this.words.setUint32(place, length, true);
        this.words.setUint32(place + 4, (this.firstSequence + this.count) >>> 0, true);
        this.reserved = start;
        return place + HEADER;
    }

    /**
     * The writer's: publishes the record `reserve` gave room for, and
     * answers its sequence. Throws where none is reserved.
     *
     * @returns {number}
     */
    commit(){
        if (this.reserved < 0)
        {
            misuse('commit with nothing reserved');
        }
        const sequence = (this.firstSequence + this.count) >>> 0;
        this.index[sequence % this.records] = this.reserved | 0;
        this.reserved = -1;
        this.count = (this.count + 1) >>> 0;
        Atomics.store(this.control, WRITTEN, this.count | 0);
        return sequence;
    }

    /** The sequence the next record gets: every record before it was committed. */
    written(){
        return (this.firstSequence + (Atomics.load(this.control, WRITTEN) >>> 0)) >>> 0;
    }

    /** The sequence of the first record this journal held. */
    first(){
        return this.firstSequence;
    }

    /** The oldest sequence a reader may still find. */
    oldest(){
        const next = this.written();
        const held = Math.min((next - this.firstSequence) >>> 0, this.records);
        return (next - held) >>> 0;
    }

    /**
     * A reader's, in two steps with `intact`: where record `sequence`'s
     * bytes are in `bytes`, its length at `lengthAt` of it, or -1 where the
     * record is not there -- not committed, or another record in its place.
     * The reader decodes it in place, then asks `intact()`: whatever it
     * decoded is good only if that answers true, and the bytes may be
     * another record's until then (a decoder bounds what it reads by the
     * length). One record found at a time for each opening of the journal.
     *
     * @param {number} sequence
     * @returns {number}
     */
    find(sequence){
        const next = this.written();
        // Committed, and since the first: an index slot a later record took
        // is told by the header's sequence below.
        const behind = (next - (sequence >>> 0)) >>> 0;
        if (behind === 0 || behind > ((next - this.firstSequence) >>> 0))
        {
            return -1;
        }
        const start = this.index[sequence % this.records] >>> 0;
        const place = this.base + (start & this.mask);
        // Not another record in its place. One written over already may still
        // look like it: `intact` says so after, and `read` before it hands the
        // bytes on.
        if (this.words.getUint32(place + 4, true) !== (sequence >>> 0)
            || this.words.getUint32(place, true) > this.maxRecord)
        {
            return -1;
        }
        this.found = start;
        return place + HEADER;
    }

    /** The length of the record whose bytes `find` answered are at `at`. @param {number} at */
    lengthAt(at){
        return this.words.getUint32(at - HEADER, true);
    }

    /**
     * Whether the record `find` answered last is still whole: the writer
     * reached none of its bytes since. It moves its count before it writes a
     * byte, the header included.
     */
    intact(){
        return ((Atomics.load(this.control, HEAD) - this.found) >>> 0) <= this.capacity;
    }

    /**
     * A reader's: record `sequence` handed to `take` in place, as the buffer,
     * its offset and its length, and what `take` returns; or undefined where
     * the record is not there -- not written yet, or written over before or
     * while `take` read it. `take` keeps nothing of the view: once it
     * returns, the writer may write over the bytes.
     *
     * @template T
     * @param {number} sequence
     * @param {(bytes: Uint8Array, at: number, length: number) => T} take
     * @returns {T | undefined}
     */
    read(sequence, take){
        const at = this.find(sequence);
        // `take` is handed only a record still whole.
        if (at < 0 || !this.intact())
        {
            return undefined;
        }
        const answer = take(this.bytes, at, this.lengthAt(at));
        return this.intact() ? answer : undefined;
    }
}

/**
 * One side of a journal, opened from its memory (`Journal`).
 *
 * @param {JournalMemory} memory
 * @returns {Journal}
 */
export const openJournal = memory=>new Journal(memory);

export { Journal };
