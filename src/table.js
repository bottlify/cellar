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
 * @typedef {{ buffer: SharedArrayBuffer, rows: number, columns: string[], slots?: boolean }} TableMemory
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
 * @param {{ rows: number, columns: string[], slots?: boolean }} shape
 *     `slots`: rows claimed by any thread, `type` and `owner` columns before `columns`
 * @returns {TableMemory}
 */
export function createTableMemory({ rows, columns, slots = false }){
    const named = slots ? ['type', 'owner', ...columns] : columns.slice();
    if (!Number.isInteger(rows) || rows < 1 || named.length < 1 || (slots && rows > MAX_SLOTS))
    {
        throw new RangeError(`table: ${rows} rows of ${columns.length} columns`);
    }
    const cells = HEADER_BYTES + rows * named.length * 8;
    return { buffer: new SharedArrayBuffer(cells + (slots ? rows * 4 : 0)), rows, columns: named,
        ...(slots ? { slots } : {}) };
}

/**
 * @param {TableMemory} memory
 * @returns {Table}
 */
export function openTable(memory){
    const { buffer, rows, columns, slots = false } = memory;
    const width = columns.length;
    const counts = new Int32Array(buffer, 0, 2);
    const cells = new BigInt64Array(buffer, HEADER_BYTES, rows * width);
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
    /** @param {number} at @param {number} column */
    const get = (at, column)=>Number(Atomics.load(cells, cellOf(at, column)));
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
        set: (at, column, value)=>put(cellOf(at, column), Math.round(value)),
        add: (at, column, amount)=>{
            const by = Math.round(amount);
            if (!Number.isInteger(by) || Math.abs(by) > MOST)
            {
                throw new RangeError(`table: ${amount} is not a number a cell holds`);
            }
            const cell = cellOf(at, column);
            // One writer: what it added it may take back before anyone else stores.
            const was = Number(Atomics.add(cells, cell, BigInt(by)));
            if (Math.abs(was + by) > MOST)
            {
                Atomics.store(cells, cell, BigInt(was));
                throw new RangeError(`table: ${was} and ${amount} is not a number a cell holds`);
            }
        },
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
                    put(cellOf(at, column), column === 0 ? type : column === 1 ? owner : 0);
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
