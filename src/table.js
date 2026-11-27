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
 * A cell is one kind: a signed 64-bit integer, stored, added to and read
 * through `Atomics`, so a reader sees each cell whole because the standard
 * says so, not because of how an engine compiles an eight-byte store. A
 * fraction has no cell: a figure goes in integer units its column's name
 * says (nanoseconds, parts per million), converted where it is read. A
 * value set is rounded to the nearest integer; one that is not finite
 * throws. One thread writes a table. A row is not read whole: a reader that
 * looks while the writer fills one may take some cells new and some old.
 * The counts are atomic words, and a row the writer filled before it
 * published a count is seen filled by a reader that read that count.
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
    const cells = new BigInt64Array(buffer, HEADER_BYTES, rows * width);
    /** @param {number} at @param {number} column */
    const get = (at, column)=>Number(Atomics.load(cells, at * width + column));
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
        set: (at, column, value)=>{
            Atomics.store(cells, at * width + column, BigInt(Math.round(value)));
        },
        add: (at, column, amount)=>{
            Atomics.add(cells, at * width + column, BigInt(Math.round(amount)));
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
