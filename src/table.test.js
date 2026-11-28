/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createTableMemory, openTable } from './table.js';

const TABLE = new URL('./table.js', import.meta.url).href;

/**
 * Runs `body` in a worker with `openTable` and `memory` in scope; answers what
 * it posts.
 *
 * @param {string} body @param {any} data
 * @returns {Promise<any>}
 */
const onWorker = (body, data)=>new Promise((resolve, reject)=>{
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(({ openTable })=>{
            const data = workerData.data;
            ${body}
        });`, { eval: true, workerData: { url: TABLE, data } });
    worker.once('message', answer=>{
        resolve(answer);
        worker.terminate();
    });
    worker.once('error', reject);
});

test('a value stored where it happens is what a reader picks up, by name', ()=>{
    const columns = ['turns', 'boosts'];
    const memory = createTableMemory({ rows: 2, columns });
    columns.push('later');
    const table = openTable(memory);
    assert.deepEqual(table.columns, ['turns', 'boosts'], 'the names are the ones it was made with');
    assert.equal(table.width, 2);
    table.add(0, 0, 3);
    table.add(0, 0, 4);
    table.set(1, 1, 9);
    assert.deepEqual(openTable(memory).all(), [], 'nothing is in use before it is published');
    table.use(2);

    const reader = openTable(memory);
    assert.equal(reader.used(), 2);
    assert.deepEqual(reader.all(), [{ turns: 7, boosts: 0 }, { turns: 0, boosts: 9 }]);
    assert.deepEqual(reader.row(1), { turns: 0, boosts: 9 });
    assert.equal(reader.get(1, 1), 9);
});

test('a ring of rows reads oldest first once it has lapped', ()=>{
    const table = openTable(createTableMemory({ rows: 3, columns: ['index'] }));
    assert.deepEqual([table.advance(), table.advance()], [0, 1]);
    assert.equal(table.used(), 2, 'a ring not yet full is in use as far as it was taken');
    table.set(0, 0, 0);
    table.set(1, 0, 1);
    for (let at = 2; at < 5; at++)
    {
        table.set(table.advance(), 0, at);
    }
    assert.equal(table.written(), 5);
    assert.equal(table.used(), 3);
    assert.deepEqual(openTable(table.memory).all().map(row=>row.index), [2, 3, 4]);
});

test('a cell is an integer either way of zero: a value set is rounded, one not finite throws', ()=>{
    const table = openTable(createTableMemory({ rows: 1, columns: ['ns'] }));
    table.set(0, 0, 2.6);
    table.add(0, 0, -0.4);
    assert.equal(table.get(0, 0), 3);
    table.add(0, 0, -5);
    assert.equal(table.get(0, 0), -2, 'below zero');
    table.set(0, 0, -1);
    assert.equal(table.get(0, 0), -1);
    table.add(0, 0, 2 ** 32 + 2);
    assert.equal(table.get(0, 0), 2 ** 32 + 1, 'back past zero and past 2^32');
    table.set(0, 0, 2 ** 52);
    table.add(0, 0, 2 ** 52);
    assert.equal(table.get(0, 0), 2 ** 53);
    table.set(0, 0, -(2 ** 53));
    assert.equal(table.get(0, 0), -(2 ** 53));
    assert.throws(()=>table.set(0, 0, NaN), RangeError);
    assert.throws(()=>table.add(0, 0, Infinity), RangeError);
});

test('a cell its writer left between its two words is said, not read as a number', ()=>{
    const memory = createTableMemory({ rows: 1, columns: ['n'] });
    const table = openTable(memory);
    table.set(0, 0, 7);
    // What a writer that stopped after marking the high word busy leaves.
    new Uint32Array(memory.buffer, 8)[1] = 0x40000000;
    assert.throws(()=>table.get(0, 0), /half-written/);
});

test('a cell whose high word changes twice between a reader\'s two looks at it is not read torn',
    ()=>{
    // -1, 5 and -3 have high words 0xffffffff, 0, 0xffffffff: a reader that
    // looked at the high word, then the low one, then the high one again, with
    // the writer storing 5 and then -3 between, saw the same high word twice.
    const table = openTable(createTableMemory({ rows: 1, columns: ['delta'] }));
    table.set(0, 0, -1);
    const load = Atomics.load;
    let looks = 0;
    /** @type {any} */ (Atomics).load = (/** @type {any} */ array, /** @type {number} */ index)=>{
        const value = load(array, index);
        if (++looks === 1)
        {
            table.set(0, 0, 5);
        }
        else if (looks === 2)
        {
            table.set(0, 0, -3);
        }
        return value;
    };
    let read;
    try
    {
        read = table.get(0, 0);
    }
    finally
    {
        /** @type {any} */ (Atomics).load = load;
    }
    assert.ok([-1, 5, -3].includes(read), `${read} is a value the writer stored`);
});

test('a value past 2^53 either way is refused, not stored for a reader to stall on', ()=>{
    // 2^62's high part would be the word a busy writer leaves.
    const table = openTable(createTableMemory({ rows: 1, columns: ['big'] }));
    for (const value of [2 ** 53 + 2, -(2 ** 53 + 2), 2 ** 62, -(2 ** 62)])
    {
        assert.throws(()=>table.set(0, 0, value), RangeError, String(value));
    }
    table.set(0, 0, -(2 ** 53));
    assert.equal(table.get(0, 0), -(2 ** 53));
    table.set(0, 0, 2 ** 53);
    assert.equal(table.get(0, 0), 2 ** 53);
    assert.throws(()=>table.add(0, 0, 2), RangeError, 'an add past it too');
});

test('a reader on another thread sees a counter added to across the carry into its high word',
    { timeout: 60_000 }, async()=>{
    // Each add carries every other time: a read of the low word of one value
    // and the high word of another is off the lattice `STEP * n`.
    const STEP = 2 ** 31 + 1;
    const LAST = 2_000_000;
    const memory = createTableMemory({ rows: 1, columns: ['count'] });
    const table = openTable(memory);
    table.use(1);
    const ready = new Int32Array(new SharedArrayBuffer(4));
    const reader = onWorker(`
        const table = openTable(data.memory);
        Atomics.store(data.ready, 0, 1);
        let last = 0;
        let bad = null;
        for (;;)
        {
            const value = table.get(0, 0);
            const n = value / data.STEP;
            if (!Number.isInteger(n) || n < last) { bad = value; break; }
            last = n;
            if (n === data.LAST) break;
        }
        parentPort.postMessage(bad);`, { memory, ready, STEP, LAST });
    while (Atomics.load(ready, 0) === 0)
    {
        await new Promise(resolve=>setTimeout(resolve, 1));
    }
    for (let n = 1; n <= LAST; n++)
    {
        table.add(0, 0, STEP);
    }
    assert.equal(await reader, null);
});

test('a table of no rows or no columns is refused', ()=>{
    assert.throws(()=>createTableMemory({ rows: 0, columns: ['a'] }), RangeError);
    assert.throws(()=>createTableMemory({ rows: 1.5, columns: ['a'] }), RangeError);
    assert.throws(()=>createTableMemory({ rows: 1, columns: [] }), RangeError);
});

test('readers on other threads see each cell whole while the writer stores into it',
    { timeout: 60_000 }, async()=>{
    // Each value differs from the last in both halves of its eight bytes: a
    // read that took one half of an old value and the other of a new one is
    // off the lattice `BASE + STEP * n`.
    const BASE = 2 ** 40;
    const STEP = 2 ** 32 + 1;
    const LAST = 2_000_000;
    const memory = createTableMemory({ rows: 1, columns: ['count'] });
    const table = openTable(memory);
    table.set(0, 0, BASE);
    table.use(1);
    const read = `
        const table = openTable(data.memory);
        let last = -1;
        let looks = 0;
        let bad = null;
        for (;;)
        {
            const value = table.get(0, 0);
            const n = (value - data.BASE) / data.STEP;
            if (!Number.isInteger(n) || n < last) { bad = value; break; }
            last = n;
            looks++;
            if (n === data.LAST) break;
        }
        parentPort.postMessage({ bad, looks });`;
    const data = { memory, BASE, STEP, LAST };
    const ready = new Int32Array(new SharedArrayBuffer(4));
    const readers = [onWorker(`Atomics.add(data.ready, 0, 1); ${read}`, { ...data, ready }),
        onWorker(`Atomics.add(data.ready, 0, 1); ${read}`, { ...data, ready })];
    while (Atomics.load(ready, 0) < 2)
    {
        await new Promise(resolve=>setTimeout(resolve, 1));
    }
    for (let n = 1; n <= LAST; n++)
    {
        table.set(0, 0, BASE + STEP * n);
    }
    for (const { bad, looks } of await Promise.all(readers))
    {
        assert.equal(bad, null, `a torn or backward value: ${bad}`);
        assert.ok(looks > 0);
    }
});

test('a row filled before its count was published is seen filled by a reader on another thread',
    { timeout: 60_000 }, async()=>{
    const ROWS = 4096;
    const memory = createTableMemory({ rows: ROWS, columns: ['a', 'b', 'c'] });
    const table = openTable(memory);
    const ready = new Int32Array(new SharedArrayBuffer(4));
    const reader = onWorker(`
        const table = openTable(data.memory);
        Atomics.store(data.ready, 0, 1);
        let empty = 0;
        for (let seen = 0; seen < data.ROWS;)
        {
            const used = table.used();
            for (let row = seen; row < used; row++)
            {
                for (let column = 0; column < 3; column++)
                {
                    if (table.get(row, column) !== row + 1) empty++;
                }
            }
            seen = used;
        }
        parentPort.postMessage(empty);`, { memory, ready, ROWS });
    while (Atomics.load(ready, 0) === 0)
    {
        await new Promise(resolve=>setTimeout(resolve, 1));
    }
    for (let row = 0; row < ROWS; row++)
    {
        for (let column = 0; column < 3; column++)
        {
            table.set(row, column, row + 1);
        }
        table.use(row + 1);
    }
    assert.equal(await reader, 0);
});

test('a slot is claimed with its type and owner, named by a handle that a reuse makes stale', ()=>{
    const table = openTable(createTableMemory({ rows: 2, columns: ['object'], slots: true }));
    assert.deepEqual(table.columns, ['type', 'owner', 'object']);
    const first = table.claim(3, 10);
    const second = table.claim(4, 11);
    assert.equal(table.claim(5, 12), -1, 'no row is free');
    assert.equal(table.used(), 2);
    const row = table.slot(first);
    assert.ok(row >= 0);
    assert.deepEqual(table.row(row), { type: 3, owner: 10, object: 0 });
    table.set(row, 2, 99);
    assert.equal(table.release(first), true);
    assert.equal(table.release(first), false, 'released once');
    assert.equal(table.slot(first), -1);
    const again = table.claim(6, 10);
    assert.equal(table.slot(again), row, 'the row freed is the one claimed again');
    assert.notEqual(again, first, 'under a new generation');
    assert.equal(table.slot(first), -1, 'the old handle is refused');
    assert.equal(table.release(first), false);
    assert.equal(table.get(row, 2), 0, 'a claim starts from zeros');
    assert.deepEqual(table.owned(10), [again]);
    assert.deepEqual(table.all().map(one=>one.type).sort(), [4, 6]);
    assert.equal(table.releaseOwner(11), 1);
    assert.equal(table.slot(second), -1);
    assert.equal(table.used(), 1);
    for (const handle of [-1, 0, 1, 1.5, NaN, 2 ** 60])
    {
        assert.equal(table.slot(handle), -1, `${handle} names no slot`);
    }
});

test('a table of slots is claimed, not published or advanced, and only it is claimed', ()=>{
    const slots = openTable(createTableMemory({ rows: 1, columns: [], slots: true }));
    assert.throws(()=>slots.use(1), TypeError);
    assert.throws(()=>slots.advance(), TypeError);
    const plain = openTable(createTableMemory({ rows: 1, columns: ['a'] }));
    assert.throws(()=>plain.claim(1, 1), TypeError);
    assert.throws(()=>plain.slot(1), TypeError);
    assert.throws(()=>createTableMemory({ rows: 2 ** 24 + 1, columns: [], slots: true }), RangeError);
});
