/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Numbers one thread stores where they change and any thread reads when it
 * likes: counters, a row per worker, a ring of the last frames. Rows of
 * float64 columns, the columns named once when the memory is made, and two
 * counts: the rows that carry something, and the rows ever taken from the
 * ring.
 *
 * A cell is a plain float64 store, no atomic: a count that passes 2^31 in
 * seconds fits, and a store costs what a store into any typed array does.
 * One thread writes a table (`add` reads before it stores). A reader sees
 * each cell whole: an aligned eight-byte access is one instruction on x86-64
 * and arm64, which is how engines compile it, though the JavaScript memory
 * model promises that only for integer arrays. A row is not read whole: a
 * reader that looks while the writer fills one may take some cells new and
 * some old. The counts are atomic words, and a row the writer filled before
 * it published a count is seen filled by a reader that read that count.
 */

const USED = 0;
const WRITTEN = 1;
const HEADER_BYTES = 8;

/**
 * What a reader on another thread is handed: post it, then open it there.
 *
 * @typedef {{ buffer: SharedArrayBuffer, rows: number, columns: string[] }} TableMemory
 */

/**
 * @typedef {Object} Table
 * @property {TableMemory} memory
 * @property {Float64Array} values      `rows * width` cells, row-major.
 * @property {number} rows
 * @property {number} width
 * @property {string[]} columns
 * @property {(row: number, column: number, value: number) => void} set
 * @property {(row: number, column: number, amount: number) => void} add
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
    const values = new Float64Array(buffer, HEADER_BYTES, rows * width);
    /** @param {number} at */
    const row = at=>{
        /** @type {Record<string, number>} */
        const out = {};
        for (let column = 0; column < width; column++)
        {
            out[columns[column]] = values[at * width + column];
        }
        return out;
    };
    return {
        memory,
        values,
        rows,
        width,
        columns,
        set: (at, column, value)=>{ values[at * width + column] = value; },
        add: (at, column, amount)=>{ values[at * width + column] += amount; },
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
