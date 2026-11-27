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

/*
 * Each worker claims and releases slots of a table too small for all of
 * them at once, under its own owner, stamping each row it holds with its
 * owner and a count of its own: a row two threads held at once shows the
 * other's stamp; a handle it released, kept, must be refused from then on.
 */
const WORKER = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then(({ openTable })=>{
        const { memory, owner, rounds, seed } = workerData;
        const table = openTable(memory);
        let state = seed;
        const random = ()=>(state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
        const held = [];
        const stale = [];
        let claims = 0;
        let full = 0;
        let bad = null;
        const check = (handle, stamp)=>{
            const row = table.slot(handle);
            if (row < 0) return 'a held handle refused';
            if (table.get(row, 1) !== owner || table.get(row, 2) !== stamp) return 'a row another thread wrote';
            return null;
        };
        for (let round = 0; round < rounds && bad === null; round++)
        {
            if (held.length > 0 && (random() < 0.5 || held.length > 6))
            {
                const [handle, stamp] = held.splice(Math.floor(random() * held.length), 1)[0];
                bad = check(handle, stamp);
                if (!table.release(handle)) bad ??= 'a release of a held handle refused';
                stale.push(handle);
                if (stale.length > 64) stale.shift();
            }
            else
            {
                const handle = table.claim(7, owner);
                if (handle < 0) { full++; continue; }
                claims++;
                const row = table.slot(handle);
                table.set(row, 2, round);
                held.push([handle, round]);
            }
            for (const handle of stale)
            {
                if (table.slot(handle) >= 0 || table.release(handle)) { bad ??= 'a stale handle accepted'; break; }
            }
            for (const [handle, stamp] of held)
            {
                bad ??= check(handle, stamp);
            }
        }
        parentPort.postMessage({ bad, claims, full, held: held.map(one=>one[0]) });
    });`;

test('threads racing to claim and release slots never share a row, and a stale handle is refused',
    { timeout: 120_000 }, async()=>{
    const WORKERS = 4;
    const memory = createTableMemory({ rows: 16, columns: ['stamp'], slots: true });
    const answers = await Promise.all(Array.from({ length: WORKERS }, (_, i)=>new Promise((resolve, reject)=>{
        const worker = new Worker(WORKER, { eval: true,
            workerData: { url: TABLE, memory, owner: 100 + i, rounds: 40_000, seed: 7 + i } });
        worker.once('message', resolve);
        worker.once('error', reject);
    })));
    const table = openTable(memory);
    for (const [i, { bad, claims, full, held }] of answers.entries())
    {
        assert.equal(bad, null, `worker ${i}: ${bad}`);
        assert.ok(claims > 1000, `worker ${i} claimed ${claims}`);
        assert.ok(full >= 0);
        assert.deepEqual(table.owned(100 + i).sort(), held.sort(), 'what it holds is found by its owner');
    }
    assert.ok(answers.some(one=>one.full > 0), 'the table ran full: the claims raced for rows');
    const holding = answers.reduce((sum, one)=>sum + one.held.length, 0);
    assert.equal(table.used(), holding);
    // An owner gone: every row it held released at once, from another thread.
    assert.equal(table.releaseOwner(100), answers[0].held.length);
    assert.deepEqual(table.owned(100), []);
    assert.equal(table.used(), holding - answers[0].held.length);
});
