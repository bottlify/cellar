/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A journal is written on the hottest paths (a log call, a frame shown):
 * writing a record and reading one back make nothing on the heap, or the
 * collector it calls in costs more than the record.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';
import { createJournalMemory, openJournal } from './journal.js';

/** Records written and read an arm, after as many to warm up. */
const RECORDS = 500_000;

/**
 * Collections while `work(n)` runs for each n, after as many runs to warm up.
 *
 * @param {(n: number) => void} work
 */
async function collectionsOf(work){
    for (let n = 0; n < RECORDS; n++)
    {
        work(n);
    }
    let collections = 0;
    const observer = new PerformanceObserver(list=>{
        collections += list.getEntries().length;
    });
    observer.observe({ entryTypes: ['gc'] });
    for (let n = RECORDS; n < 2 * RECORDS; n++)
    {
        work(n);
    }
    // The observer is told on a later turn.
    await new Promise(resolve=>setTimeout(resolve, 50));
    observer.disconnect();
    return collections;
}

test('writing a record and reading it back make no garbage', { timeout: 300_000 }, async()=>{
    // A view made for each record would be ~100 bytes on the heap a record:
    // tens of megabytes over the gate, a collection every few thousand.
    const journal = openJournal(createJournalMemory({ records: 1024, bytes: 1 << 16 }));
    const view = new DataView(journal.bytes.buffer);
    let sum = 0;
    /** What a reader does with a record: its words added up, as an integer. */
    const take = (/** @type {Uint8Array} */ _bytes, /** @type {number} */ at)=>
        (view.getUint32(at, true) + view.getUint32(at + 8, true)) | 0;
    const written = await collectionsOf(n=>{
        const at = journal.reserve(16);
        view.setUint32(at, n, true);
        view.setFloat64(at + 8, n * 0.5, true);
        journal.commit();
    });
    assert.ok(written <= 2, `${written} collections in ${RECORDS} records written`);
    const read = await collectionsOf(n=>{
        sum = (sum + (journal.read((journal.written() - 1 - (n % 512)) >>> 0, take) ?? 0)) | 0;
    });
    assert.ok(read <= 2, `${read} collections in ${RECORDS} records read`);
    assert.notEqual(sum, 0, 'the records were read');
});
