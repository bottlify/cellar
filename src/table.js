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
 * A cell is an integer, exact within 2^53 either way, in two Uint32 words
 * (low, high; two's complement); a fraction goes in units its column's
 * name says (nanoseconds, parts per million), rounded. One thread writes a
 * table with plain stores: an add that does not carry stores the low word,
 * read whole by the standard (ECMA-262 `IsNoTearConfiguration`). A write to
 * the high word marks it busy, then stores both through `Atomics`; a reader
 * takes high, low, high until the highs agree and are not busy. A row is
 * not read whole. The counts are atomic: a row filled before a count was
 * published is seen filled by a reader that read that count.
 */

const USED = 0;
const WRITTEN = 1;
const HEADER_BYTES = 8;
/** A high word no value within 2^53 has: the writer is between the words. */
const BUSY = 0x40000000;
/** How long a reader looks at a cell whose words never agree before it says so. */
const STUCK_MS = 1000;

/**
 * What a reader on another thread is handed: post it, then open it there.
 *
 * @typedef {{ buffer: SharedArrayBuffer, rows: number, columns: string[] }} TableMemory
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
 * @property {() => Record<string, number>[]} all    The rows in use, oldest first once the ring lapped.
 */

/**
 * @param {{ rows: number, columns: string[] }} shape
 * @returns {TableMemory}
 */
export function createTableMemory({ rows, columns }){
    if (!Number.isInteger(rows) || rows < 1 || columns.length < 1)
    {
        throw new RangeError(`table: ${rows} rows of ${columns.length} columns`);
    }
    return { buffer: new SharedArrayBuffer(HEADER_BYTES + rows * columns.length * 8), rows,
        columns: columns.slice() };
}

/**
 * @param {TableMemory} memory
 * @returns {Table}
 */
export function openTable(memory){
    const { buffer, rows, columns } = memory;
    const width = columns.length;
    const counts = new Int32Array(buffer, 0, 2);
    const words = new Uint32Array(buffer, HEADER_BYTES, rows * width * 2);
    /** A cell's low word. @param {number} at @param {number} column */
    const cellOf = (at, column)=>(at * width + column) * 2;
    /** The writer's: the cell at `cell` holds `value`. @param {number} cell @param {number} value */
    const put = (cell, value)=>{
        if (!Number.isFinite(value))
        {
            throw new RangeError(`table: ${value} is not a number a cell holds`);
        }
        const high = Math.floor(value / 2 ** 32) >>> 0;
        if (words[cell + 1] !== high)
        {
            Atomics.store(words, cell + 1, BUSY);
            Atomics.store(words, cell, value >>> 0);
            Atomics.store(words, cell + 1, high);
        }
        words[cell] = value >>> 0;
    };
    /** @param {number} at @param {number} column */
    const get = (at, column)=>{
        const cell = cellOf(at, column);
        for (let since = 0; ; since ||= performance.now())
        {
            const high = Atomics.load(words, cell + 1);
            const low = Atomics.load(words, cell);
            if (high !== BUSY && Atomics.load(words, cell + 1) === high)
            {
                return (high | 0) * 2 ** 32 + low;
            }
            if (since > 0 && performance.now() - since > STUCK_MS)
            {
                throw new Error(`table: row ${at} column ${column} was left half-written`);
            }
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
    return {
        memory,
        rows,
        width,
        columns,
        set: (at, column, value)=>put(cellOf(at, column), Math.round(value)),
        add: (at, column, amount)=>{
            const cell = cellOf(at, column);
            const low = words[cell] + Math.round(amount);
            if (low >= 0 && low <= 0xffffffff)
            {
                words[cell] = low;
                return;
            }
            put(cell, (words[cell + 1] | 0) * 2 ** 32 + low);
        },
        get,
        use: count=>{ Atomics.store(counts, USED, count); },
        advance(){
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
    };
}
