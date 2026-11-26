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
 * A record is drafted in the writer's own memory: `draft(length)` gives a
 * view of it, the writer fills its first `length` bytes, and `commit()`
 * copies them into the journal and answers the record's sequence. A reader
 * asks for a record by sequence (`read(sequence, take)`) and `take` is handed
 * a copy of the reader's own, made and checked before `take` sees it: only a
 * whole record is ever handed on.
 *
 * Why copies, on both sides: the writer writes over the bytes of records a
 * reader may be reading that moment, and the reader can tell only by a count
 * the writer moves before it writes a byte, which the reader checks after it
 * read the last one. That order holds between atomic accesses alone. A plain
 * store may be seen before an atomic store made ahead of it, and a plain load
 * may be satisfied after an atomic load made behind it: the JavaScript memory
 * model allows both, and arm64 does both (V8's `Atomics` are bare stlr and
 * ldar there, no barrier between them and plain accesses). So every word of
 * a record goes into the journal by `Atomics.store`, after the count moved,
 * and comes out by `Atomics.load`, before the check; the code of neither side
 * touches the journal's bytes itself.
 *
 * Each record is whole in the buffer (one that would run past the end starts
 * the buffer again), behind a header of its length and sequence, and the
 * index keeps where each of the newest records starts, by the low bits of its
 * sequence.
 *
 * Counts are of bytes ever written and records ever committed, in 32-bit
 * words that wrap, compared by their unsigned difference: exact as long as no
 * reader falls 2^31 records behind, and no read lasts while the writer writes
 * 4 GiB. The buffer's size is a power of two, so a count of bytes maps to the
 * same place on either side of a wrap; so is the index's length, for the
 * count of records.
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
/** Bytes ever written: moved before the bytes are, so a reader sees a lap. */
const HEAD = 4;
/** Records ever committed: moved after, so a reader that sees a record sees its bytes. */
const WRITTEN = 5;
/**
 * Not zero once `RECORDS` records were committed: the index holds that many
 * from then on, though the count of records wraps back to small numbers.
 */
const FULL = 6;
const CONTROL_WORDS = 8;
const CONTROL_BYTES = CONTROL_WORDS * 4;
/** The word of bytes ever written, for a test that starts a journal near a wrap of it. */
export const HEAD_WORD = HEAD;
/** The word of records ever committed, for a test that starts a journal near a wrap of it. */
export const WRITTEN_WORD = WRITTEN;

const LAYOUT = 2;

/** A record's header: its length, then its sequence; its bytes after. */
const HEADER = 8;

/** Why a record was not drafted: kept out of `draft` so it stays small enough to inline. @param {number} length @param {number} most */
const refuse = (length, most)=>{
    throw new RangeError(`journal: a record of ${length} bytes, at most ${most}`);
};

/** @param {string} why */
const misuse = why=>{
    throw new Error(`journal: ${why}`);
};

/** @param {number} n @param {number} to */
const alignUp = (n, to)=>Math.ceil(n / to) * to;

/** @param {number} n @returns {number} the least power of two not under `n` */
const powerOfTwo = n=>{
    let size = 1;
    while (size < n)
    {
        size *= 2;
    }
    return size;
};

/** A draft or a copy before the first record: no room at all. */
const NONE = new DataView(new ArrayBuffer(0));

/**
 * A view of a buffer of its own for a record of `length` bytes, in place of
 * `view`, whose buffer is detached: a view of it someone kept against the
 * contract fails where it is used, rather than write a record nobody sees or
 * read one that is not there any more.
 *
 * @param {DataView} view @param {number} length
 */
function grown(view, length){
    if (view !== NONE)
    {
        const old = /** @type {any} */ (view.buffer);
        if (typeof old.transfer === 'function')
        {
            old.transfer(0);
        }
        else
        {
            structuredClone(old, { transfer: [old] });
        }
    }
    return new DataView(new ArrayBuffer(Math.max(64, powerOfTwo(length))));
}

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
 *     (4096 by default)
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
    const size = Math.max(64, powerOfTwo(bytes));
    const total = CONTROL_BYTES + alignUp(powerOfTwo(records) * 4, 8) + size;
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
 * called on it (`journal.draft(n)`), which is what lets an engine inline
 * them into a caller's hot path.
 */
class Journal {
    /** The journal's words: control, index and records, all read and written through `Atomics`. */
    #words;
    #firstSequence;
    /** The index's length less one: a mask of the low bits of a sequence. */
    #indexMask;
    /** Where the records begin, in words. */
    #base;
    /** The buffer's size less one: a mask of a count of bytes. */
    #mask;
    /** The writer's own counts; the control words publish them. */
    #head;
    #count;
    #full;
    /** The length of the record drafted and not committed, or -1. */
    #drafted = -1;
    /** The writer's draft, and the same bytes as words to copy. */
    #draft = NONE;
    #draftWords = new Int32Array(0);
    /**
     * A reader's copies, one a depth of reads inside one another's `take`,
     * each a view and the same bytes as words.
     *
     * @type {DataView[]}
     */
    #copies = [];
    /** @type {Int32Array[]} */
    #copyWords = [];
    /** Reads inside the `take` of another on this opening. */
    #depth = 0;
    /** The count of records `#held` read last. */
    #seen = 0;

    /** @param {JournalMemory} memory */
    constructor(memory){
        const { buffer } = memory;
        const words = new Int32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
        if (words.length < CONTROL_WORDS || words[VERSION] !== LAYOUT)
        {
            throw new Error('journal: the memory is not a journal of this layout');
        }
        this.#words = words;
        /** Records a reader can still find by sequence. */
        this.records = words[RECORDS];
        /** Bytes of records the journal holds. */
        this.capacity = words[BYTES];
        /** The longest record: one that fits wherever the journal is. */
        this.maxRecord = this.capacity - HEADER;
        this.#firstSequence = words[FIRST] >>> 0;
        const indexLength = powerOfTwo(this.records);
        this.#indexMask = indexLength - 1;
        this.#base = alignUp(CONTROL_WORDS + indexLength, 2);
        this.#mask = this.capacity - 1;
        if (!(this.records >= 1) || !(this.capacity >= 64) || (this.capacity & this.#mask) !== 0
            || words.length < this.#base + this.capacity / 4)
        {
            throw new Error('journal: the memory is not a journal of this layout');
        }
        this.#head = Atomics.load(words, HEAD) >>> 0;
        this.#count = Atomics.load(words, WRITTEN) >>> 0;
        this.#full = Atomics.load(words, FULL) !== 0;
    }

    /**
     * The writer's: the draft of a record of `length` bytes, a view of the
     * writer's own memory whose first `length` bytes the writer fills before
     * `commit`. Nothing of the journal is touched before the commit. The
     * view stays the draft's until a longer record than any before is
     * drafted; a view kept past that fails where it is used. Throws where
     * `length` is more than `maxRecord`, or where a record drafted is not yet
     * committed.
     *
     * @param {number} length
     * @returns {DataView}
     */
    draft(length){
        if (this.#drafted >= 0)
        {
            misuse('drafted again before a commit');
        }
        // An integer from 0 to the longest, NaN and fractions included:
        // `| 0` leaves only those unchanged.
        if (!(length >= 0 && length <= this.maxRecord && (length | 0) === length))
        {
            refuse(length, this.maxRecord);
        }
        if (length > this.#draft.byteLength)
        {
            this.#draft = grown(this.#draft, length);
            this.#draftWords = new Int32Array(this.#draft.buffer);
        }
        this.#drafted = length;
        return this.#draft;
    }

    /**
     * The writer's: copies the record drafted into the journal, publishes it,
     * and answers its sequence. Records written before it may be written
     * over now. Throws where none is drafted.
     *
     * @returns {number}
     */
    commit(){
        const length = this.#drafted;
        if (length < 0)
        {
            misuse('commit with nothing drafted');
        }
        this.#drafted = -1;
        const capacity = this.capacity;
        const need = HEADER + ((length + 7) & ~7);
        let start = this.#head;
        const at = start & this.#mask;
        if (at + need > capacity)
        {
            // Whole in the buffer: the tail is skipped, and the index says
            // where each record starts, so no reader looks for a marker.
            start = (start + (capacity - at)) >>> 0;
        }
        this.#head = (start + need) >>> 0;
        const words = this.#words;
        // Moved before a word is written over: a reader checks its copy
        // against it after, and the check is honest only if it covers them.
        Atomics.store(words, HEAD, this.#head | 0);
        const sequence = (this.#firstSequence + this.#count) >>> 0;
        const place = this.#base + ((start & this.#mask) >> 2);
        Atomics.store(words, place, length);
        Atomics.store(words, place + 1, sequence | 0);
        const draft = this.#draftWords;
        for (let n = 0, end = (length + 3) >> 2; n < end; n++)
        {
            Atomics.store(words, place + 2 + n, draft[n]);
        }
        Atomics.store(words, CONTROL_WORDS + (sequence & this.#indexMask), start | 0);
        this.#count = (this.#count + 1) >>> 0;
        Atomics.store(words, WRITTEN, this.#count | 0);
        // After the count: a reader that finds the word set and reads the
        // count again finds it past `records` too, unless it wrapped.
        if (!this.#full && this.#count >= this.records)
        {
            this.#full = true;
            Atomics.store(words, FULL, 1);
        }
        return sequence;
    }

    /** The sequence the next record gets: every record before it was committed. */
    written(){
        return (this.#firstSequence + (Atomics.load(this.#words, WRITTEN) >>> 0)) >>> 0;
    }

    /** The sequence of the first record this journal held. */
    first(){
        return this.#firstSequence;
    }

    /**
     * Records ever committed, as the count word says, into `#seen`, and
     * answers how many of the newest the index holds: `records`, or fewer
     * before that many were committed. The count read again where the full
     * word is set though the count read first was short of `records`: the
     * index is full, and either the count wrapped or it passed `records`
     * since, which the second reading sees (the word is set after the count).
     */
    #held(){
        const words = this.#words;
        this.#seen = Atomics.load(words, WRITTEN) >>> 0;
        if (this.#seen >= this.records)
        {
            return this.records;
        }
        if (Atomics.load(words, FULL) === 0)
        {
            return this.#seen;
        }
        this.#seen = Atomics.load(words, WRITTEN) >>> 0;
        return this.records;
    }

    /** The oldest sequence a reader may still find. */
    oldest(){
        const held = this.#held();
        return (this.#firstSequence + this.#seen - held) >>> 0;
    }

    /**
     * Record `sequence` copied into this opening's copy at `depth`: its
     * length, or -1 where it is not there - not committed, another record in
     * its place, or written over before the copy was whole.
     *
     * @param {number} sequence @param {number} depth
     * @returns {number}
     */
    #copy(sequence, depth){
        const held = this.#held();
        // Committed, and among the newest the index holds: by the records
        // alone, which stay exact across the count's wrap at 2^32.
        const behind = (this.#firstSequence + this.#seen - sequence) >>> 0;
        if (behind === 0 || behind > held)
        {
            return -1;
        }
        const words = this.#words;
        const start = Atomics.load(words, CONTROL_WORDS + (sequence & this.#indexMask)) >>> 0;
        const at = start & this.#mask;
        const place = this.#base + (at >> 2);
        const length = Atomics.load(words, place) >>> 0;
        // Another record's header, or words being written: refused before a
        // word is copied, so no copy runs past the room a record could have.
        if ((Atomics.load(words, place + 1) >>> 0) !== sequence
            || length > this.capacity - HEADER - at)
        {
            return -1;
        }
        let copy = this.#copies[depth];
        if (copy === undefined || length > copy.byteLength)
        {
            copy = grown(copy ?? NONE, length);
            this.#copies[depth] = copy;
            this.#copyWords[depth] = new Int32Array(copy.buffer);
        }
        const into = this.#copyWords[depth];
        for (let n = 0, end = (length + 3) >> 2; n < end; n++)
        {
            into[n] = Atomics.load(words, place + 2 + n);
        }
        // After the last load: the writer moves this count before it writes
        // over a word, so a copy that took one of them sees it moved.
        return ((Atomics.load(words, HEAD) - start) >>> 0) <= this.capacity ? length : -1;
    }

    /**
     * A reader's: record `sequence` handed to `take` as a copy of this
     * opening's own, whole, as a view and its length, and what `take`
     * returns; or undefined where the record is not there - not written yet,
     * or written over before it was copied. `take` keeps nothing of the
     * view: the next read copies over it. A read inside `take` copies into a
     * view of its own.
     *
     * @template T
     * @param {number} sequence
     * @param {(record: DataView, length: number) => T} take
     * @returns {T | undefined}
     */
    read(sequence, take){
        const depth = this.#depth;
        const length = this.#copy(sequence >>> 0, depth);
        if (length < 0)
        {
            return undefined;
        }
        this.#depth = depth + 1;
        try
        {
            return take(this.#copies[depth], length);
        }
        finally
        {
            this.#depth = depth;
        }
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
