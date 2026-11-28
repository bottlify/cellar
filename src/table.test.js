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

test('a cell read while its writer stores twice is one value the writer stored, never a mix',
    ()=>{
    // Two writes between a reader's looks that leave the high word as it was:
    // -1, 5, -3 (highs 0xffffffff, 0, 0xffffffff) and 1, 2^32 + 2, 3 (0, 1,
    // 0). Two 32-bit words checked high, low, high handed the reader -4294967291
    // and 2; a version in a finite word only moves the chance.
    for (const [first, ...then] of [[-1, 5, -3], [1, 2 ** 32 + 2, 3]])
    {
        const table = openTable(createTableMemory({ rows: 1, columns: ['delta'] }));
        table.set(0, 0, first);
        const load = Atomics.load;
        let looks = 0;
        /** @type {any} */ (Atomics).load = (/** @type {any} */ array, /** @type {number} */ index)=>{
            const value = load(array, index);
            if (looks < then.length)
            {
                table.set(0, 0, then[looks++]);
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
        assert.ok([first, ...then].includes(read), `${read} is a value the writer stored`);
    }
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

test('an add that would step past 2^53 by any amount is refused and stores nothing, a count too', ()=>{
    // A double holds 2^53 + 1 as 2^53: a check made in doubles let it through.
    const table = openTable(createTableMemory({ rows: 1, columns: ['wide', 'count'], counting: ['count'] }));
    table.set(0, 0, 2 ** 53 - 1);
    assert.throws(()=>table.add(0, 0, 2), RangeError, '2^53 - 1 and 2');
    assert.equal(table.get(0, 0), 2 ** 53 - 1, 'left as it was');
    table.add(0, 0, 1);
    assert.equal(table.get(0, 0), 2 ** 53, 'up to 2^53 itself');
    table.set(0, 0, -(2 ** 53) + 1);
    assert.throws(()=>table.add(0, 0, -2), RangeError, 'and below');
    assert.equal(table.get(0, 0), -(2 ** 53) + 1);
    table.add(0, 1, 2 ** 53 - 1);
    assert.throws(()=>table.add(0, 1, 2), RangeError, 'a count past it, carrying');
    assert.equal(table.get(0, 1), 2 ** 53 - 1);
    table.add(0, 1, 1);
    assert.equal(table.get(0, 1), 2 ** 53);
    assert.throws(()=>table.add(0, 1, 1), RangeError, 'a count at 2^53, not carrying');
    assert.equal(table.get(0, 1), 2 ** 53);
    table.add(0, 1, 0);
    assert.equal(table.get(0, 1), 2 ** 53, 'nothing added is no step past it');
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

test('a counting column only grows, and an add to it makes nothing', async()=>{
    const { bytesPerCall } = await import('./allocation.fixture.js');
    const table = openTable(createTableMemory({ rows: 2, columns: ['id', 'bytes', 'writes'],
        counting: ['bytes', 'writes'] }));
    table.set(0, 0, -7);
    table.add(0, 1, 2 ** 32 - 1);
    table.add(0, 1, 3);
    assert.equal(table.get(0, 1), 2 ** 32 + 2, 'across the carry into its high word');
    assert.throws(()=>table.add(0, 1, -1), RangeError, 'a count never comes down');
    assert.throws(()=>table.set(0, 1, 5), TypeError, 'nor is it set');
    assert.equal(table.get(0, 0), -7, 'the other columns as before');
    assert.deepEqual(table.row(0), { id: -7, bytes: 2 ** 32 + 2, writes: 0 });
    // Answering the settled promise the measure's empty loop awaits: only the adds differ.
    const settled = Promise.resolve();
    const made = await bytesPerCall(()=>{
        table.add(1, 1, 4096);
        table.add(1, 2, 1);
        return settled;
    });
    assert.ok(made < 4, `${made} bytes a writer's two adds`);
    assert.throws(()=>createTableMemory({ rows: 1, columns: ['a'], counting: ['b'] }), RangeError);
});

test('readers on other threads see a counting cell whole across every carry, without a version',
    { timeout: 30000 }, async()=>{
    const memory = createTableMemory({ rows: 1, columns: ['n'], counting: ['n'] });
    const table = openTable(memory);
    const reader = onWorker(`
        const table = openTable(data);
        let last = 0;
        let bad = 0;
        for (let i = 0; i < 2_000_000; i++)
        {
            const value = table.get(0, 0);
            // A multiple of 2^31 + 1, never less than seen: anything else is torn.
            if (value < last || value % (2 ** 31 + 1) !== 0) bad++;
            last = value;
        }
        parentPort.postMessage(bad);`, memory);
    for (let i = 0; i < 4_000_000; i++)
    {
        table.add(0, 0, 2 ** 31 + 1);
    }
    assert.equal(await reader, 0);
});
