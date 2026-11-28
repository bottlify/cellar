/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Numbers one thread stores where they change and any thread reads when it
 * likes: counters, a row per worker, a ring of the last frames. Rows of
 * columns named once when the memory is made, and two counts: the rows that
 * carry something, and the rows ever taken from the ring.
 *
 * A cell is an integer within 2^53 either way, a 64-bit word stored and
 * loaded through `Atomics`; a fraction goes in units its column's name says
 * (nanoseconds, parts per million), rounded. An atomic access of a
 * `BigInt64Array` element is read whole by the standard, where a plain one
 * is not (ECMA-262 `IsNoTearConfiguration`), and two 32-bit words with a
 * check between them are not whole either: a writer that stores twice
 * between a reader's looks and leaves the high word as it was (-1, 5, -3)
 * hands it a value no write made, whatever version a finite word counts. A
 * row is not read whole. The counts are atomic: a row filled before a count
 * was published is seen filled by a reader that read that count.
 *
 * A counting column (`counting`) only grows: it is added to by an amount not
 * below zero and never set, as a count of bytes or of calls is at every
 * call. Its cell is two Uint32 words, low and high, with no BigInt made: an
 * add that does not carry is one plain store of the low word, read whole by
 * the standard; one that carries marks the high word busy, then stores the
 * low word and the next high through `Atomics`; a reader takes high, low,
 * high until the two highs are the same word and not busy. The high word
 * only grows, so the same word seen twice is a high part written once, never
 * one gone and come back.
 *
 * A table of slots (`slots: true`) is the same rows claimed by any thread:
 * each row has a word of its own, its generation and whether it is free,
 * being claimed or held, changed only by compare-and-swap. A claim takes a
 * free row and a new generation, writes the row's `type` and `owner` (its
 * first two columns) and the rest as zeros, and only then marks it held; its
 * holder is the row's one writer until it releases it. A handle names the row
 * and the generation (`generation * rows + row`), so a handle kept past its
 * release, the row claimed again, is refused (ABA). The counts are the rows
 * held and the claims ever made, where the next claim starts looking.
 */

const USED = 0;
const WRITTEN = 1;
const HEADER_BYTES = 8;
/** The most a cell holds either way of zero: every integer up to it is exact. */
const MOST = 2 ** 53;
const MOST_BIG = BigInt(MOST);
/** A counting cell's high word at 2^53: its low word 0 then. */
const HIGH_MOST = MOST / 2 ** 32;
/** A counting cell's high word while its writer is between its words: no count within 2^53 has it. */
const BUSY = 0x40000000;
/** How long a reader looks at a counting cell whose words never agree before it says so. */
const STUCK_MS = 1000;
/** A slot's word: its generation above, its state in the two bits below. */
const FREE = 0;
const CLAIMING = 1;
const HELD = 2;
/** Generations run 1 to this and round again: a handle stays within 2^53 for `MAX_SLOTS` rows. */
const MAX_GENERATION = (1 << 29) - 1;
const MAX_SLOTS = 1 << 24;

/**
 * What a reader on another thread is handed: post it, then open it there.
 *
 * @typedef {{ buffer: SharedArrayBuffer, rows: number, columns: string[], slots?: boolean,
 *     counting?: string[] }} TableMemory
 */

/**
 * @typedef {Object} Table
 * @property {TableMemory} memory
 * @property {number} rows
 * @property {number} width
 * @property {string[]} columns
 * @property {(row: number, column: number, value: number) => void} set
 * @property {(row: number, column: number, amount: number) => void} add
 * @property {(row: number, column: number) => number} get
 * @property {(count: number) => void} use      Publishes how many rows carry something.
 * @property {() => number} advance     Takes the next row of the ring; answers it.
 * @property {() => number} used
 * @property {() => number} written     Rows ever taken by `advance`.
 * @property {(row: number) => Record<string, number>} row
 * @property {() => Record<string, number>[]} all    The rows in use, oldest first once the ring lapped; a slot table's held rows.
 * @property {(type: number, owner: number) => number} claim   A slot table's: a free row held, its handle; -1 where none is free.
 * @property {(handle: number) => number} slot    The row a handle holds, -1 where it is released or never was.
 * @property {(handle: number) => boolean} release
 * @property {(owner: number) => number[]} owned    The handles an owner holds.
 * @property {(owner: number) => number} releaseOwner   Releases every row of an owner: how many.
 */

/**
 * @param {{ rows: number, columns: string[], slots?: boolean, counting?: string[] }} shape
 *     `slots`: rows claimed by any thread, `type` and `owner` columns before `columns`;
 *     `counting`: the columns that only grow, by `add` of an amount not below zero
 * @returns {TableMemory}
 */
export function createTableMemory({ rows, columns, slots = false, counting = [] }){
    const named = slots ? ['type', 'owner', ...columns] : columns.slice();
    if (!Number.isInteger(rows) || rows < 1 || named.length < 1 || (slots && rows > MAX_SLOTS))
    {
        throw new RangeError(`table: ${rows} rows of ${columns.length} columns`);
    }
    const unknown = counting.find(name=>!columns.includes(name));
    if (unknown !== undefined)
    {
        throw new RangeError(`table: no column ${unknown} to count`);
    }
    const cells = HEADER_BYTES + rows * named.length * 8;
    return { buffer: new SharedArrayBuffer(cells + (slots ? rows * 4 : 0)), rows, columns: named,
        ...(slots ? { slots } : {}), ...(counting.length > 0 ? { counting: counting.slice() } : {}) };
}

/**
 * @param {TableMemory} memory
 * @returns {Table}
 */
export function openTable(memory){
    const { buffer, rows, columns, slots = false, counting = [] } = memory;
    const width = columns.length;
    const counts = new Int32Array(buffer, 0, 2);
    const cells = new BigInt64Array(buffer, HEADER_BYTES, rows * width);
    /** The same cells as low and high words, for the counting columns. */
    const words = new Uint32Array(buffer, HEADER_BYTES, rows * width * 2);
    /** By column: whether it only grows. */
    const grows = Uint8Array.from(columns, name=>(counting.includes(name) ? 1 : 0));
    /** A slot table's words, a row each: generation and state. */
    const states = new Int32Array(buffer, HEADER_BYTES + cells.byteLength, slots ? rows : 0);
    /** @param {number} at @param {number} column */
    const cellOf = (at, column)=>at * width + column;
    /** The writer's: the cell at `cell` holds `value`. @param {number} cell @param {number} value */
    const put = (cell, value)=>{
        if (!Number.isInteger(value) || Math.abs(value) > MOST)
        {
            throw new RangeError(`table: ${value} is not a number a cell holds`);
        }
        Atomics.store(cells, cell, BigInt(value));
    };
    /** A counting cell's count: its two words, read until they agree. @param {number} cell */
    const count = cell=>{
        const low = cell * 2;
        for (let since = 0; ; since ||= performance.now())
        {
            const high = Atomics.load(words, low + 1);
            const read = Atomics.load(words, low);
            if (high !== BUSY && Atomics.load(words, low + 1) === high)
            {
                return high * 2 ** 32 + read;
            }
            if (since > 0 && performance.now() - since > STUCK_MS)
            {
                throw new Error(`table: cell ${cell} was left half-written`);
            }
        }
    };
    /** @param {number} at @param {number} column */
    const get = (at, column)=>(grows[column] === 1 ? count(cellOf(at, column))
        : Number(Atomics.load(cells, cellOf(at, column))));
    /**
     * The writer's: `amount` more in the counting cell whose low word is at
     * `low`, a plain store but where it carries. A function of its own, so
     * that the path of every call is not the BigInt one's.
     *
     * @param {number} low @param {number} column @param {number} amount
     */
    const addCount = (low, column, amount)=>{
        const sum = words[low] + Math.round(amount);
        // Below the top high part a sum that does not carry stays within 2^53.
        if (sum >= words[low] && sum <= 0xffffffff && words[low + 1] < HIGH_MOST)
        {
            words[low] = sum;
            return;
        }
        carry(low, column, amount);
    };
    /**
     * `addCount`'s add that carries, is refused, or reaches the top high
     * part: apart, so the plain store above stays small enough to be
     * inlined where it is called (with this inside it, an add cost 8.5 ns
     * where it cost 5.4).
     *
     * @param {number} low @param {number} column @param {number} amount
     */
    const carry = (low, column, amount)=>{
        if (!(amount >= 0) || !Number.isFinite(amount))
        {
            throw new RangeError(`table: ${columns[column]} only grows, not by ${amount}`);
        }
        // Summed word by word, every part exact: the sum as one double rounds
        // past 2^53 (2 and 2^53 - 1 come to 2^53 there, not 2^53 + 1).
        const by = Math.round(amount);
        if (by > MOST)
        {
            throw new RangeError(`table: ${columns[column]} past 2^53`);
        }
        const lows = words[low] + by % 2 ** 32;
        const high = words[low + 1] + Math.floor(by / 2 ** 32) + Math.floor(lows / 2 ** 32);
        if (high > HIGH_MOST || (high === HIGH_MOST && lows % 2 ** 32 !== 0))
        {
            throw new RangeError(`table: ${columns[column]} past 2^53`);
        }
        Atomics.store(words, low + 1, BUSY);
        Atomics.store(words, low, lows >>> 0);
        Atomics.store(words, low + 1, high);
    };
    /** The writer's: `amount` more in a cell of any sign. @param {number} cell @param {number} amount */
    const addWide = (cell, amount)=>{
        const by = Math.round(amount);
        if (!Number.isInteger(by) || Math.abs(by) > MOST)
        {
            throw new RangeError(`table: ${amount} is not a number a cell holds`);
        }
        // One writer: what it added it may take back before anyone else stores.
        // Summed as a BigInt: in a double 2^53 + 1 is 2^53, and passes.
        const step = BigInt(by);
        const was = Atomics.add(cells, cell, step);
        const sum = was + step;
        if (sum > MOST_BIG || sum < -MOST_BIG)
        {
            Atomics.store(cells, cell, was);
            throw new RangeError(`table: ${was} and ${amount} is not a number a cell holds`);
        }
    };
    /** @param {number} at */
    const row = at=>{
        /** @type {Record<string, number>} */
        const out = {};
        for (let column = 0; column < width; column++)
        {
            out[columns[column]] = get(at, column);
        }
        return out;
    };
    const claimed = ()=>{
        if (!slots)
        {
            throw new TypeError('table: rows are claimed only in a table of slots');
        }
    };
    const unclaimed = ()=>{
        if (slots)
        {
            throw new TypeError('table: a table of slots counts its rows by their claims');
        }
    };
    /** @param {number} handle */
    const slot = handle=>{
        claimed();
        if (!Number.isSafeInteger(handle) || handle < rows)
        {
            return -1;
        }
        const at = handle % rows;
        const generation = (handle - at) / rows;
        return generation <= MAX_GENERATION && Atomics.load(states, at) === (generation << 2 | HELD)
            ? at : -1;
    };
    /** @param {number} owner */
    const owned = owner=>{
        claimed();
        /** @type {number[]} */
        const found = [];
        for (let at = 0; at < rows; at++)
        {
            const word = Atomics.load(states, at);
            // The owner read between two looks at the same held word is that holder's.
            if ((word & 3) === HELD && get(at, 1) === owner && Atomics.load(states, at) === word)
            {
                found.push((word >>> 2) * rows + at);
            }
        }
        return found;
    };
    /** @param {number} handle */
    const release = handle=>{
        const at = slot(handle);
        const word = (handle - at) / rows << 2;
        if (at < 0 || Atomics.compareExchange(states, at, word | HELD, word | FREE) !== (word | HELD))
        {
            return false;
        }
        Atomics.sub(counts, USED, 1);
        return true;
    };
    return {
        memory,
        rows,
        width,
        columns,
        set: (at, column, value)=>{
            if (grows[column] === 1)
            {
                throw new TypeError(`table: ${columns[column]} only grows, by add`);
            }
            put(cellOf(at, column), Math.round(value));
        },
        add: (at, column, amount)=>(grows[column] === 1 ? addCount(cellOf(at, column) * 2, column, amount)
            : addWide(cellOf(at, column), amount)),
        get,
        use: count=>{
            unclaimed();
            Atomics.store(counts, USED, count);
        },
        advance(){
            unclaimed();
            const written = Atomics.load(counts, WRITTEN) >>> 0;
            Atomics.store(counts, WRITTEN, written + 1);
            if (written < rows)
            {
                Atomics.store(counts, USED, written + 1);
            }
            return written % rows;
        },
        used: ()=>Atomics.load(counts, USED),
        written: ()=>Atomics.load(counts, WRITTEN) >>> 0,
        row,
        all(){
            if (slots)
            {
                return [...states.keys()].filter(at=>(Atomics.load(states, at) & 3) === HELD).map(row);
            }
            const used = Atomics.load(counts, USED);
            const written = Atomics.load(counts, WRITTEN) >>> 0;
            // A lapped ring starts at its oldest row, the one `advance` takes next.
            const first = written > rows ? written % rows : 0;
            const out = [];
            for (let i = 0; i < used; i++)
            {
                out.push(row((first + i) % rows));
            }
            return out;
        },
        claim(type, owner){
            claimed();
            const from = Atomics.add(counts, WRITTEN, 1) >>> 0;
            for (let i = 0; i < rows; i++)
            {
                const at = (from + i) % rows;
                const word = Atomics.load(states, at);
                const generation = (word >>> 2) % MAX_GENERATION + 1;
                if ((word & 3) !== FREE
                    || Atomics.compareExchange(states, at, word, generation << 2 | CLAIMING) !== word)
                {
                    continue;
                }
                for (let column = 0; column < width; column++)
                {
                    const cell = cellOf(at, column);
                    if (grows[column] === 1)
                    {
                        // The row is no one's until it is held: its count starts again.
                        Atomics.store(words, cell * 2 + 1, 0);
                        Atomics.store(words, cell * 2, 0);
                        continue;
                    }
                    put(cell, column === 0 ? type : column === 1 ? owner : 0);
                }
                Atomics.store(states, at, generation << 2 | HELD);
                Atomics.add(counts, USED, 1);
                return generation * rows + at;
            }
            return -1;
        },
        slot,
        release,
        owned,
        releaseOwner: owner=>owned(owner).filter(release).length,
    };
}
