/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A ring's counts are bytes ever written and ever read, kept in 32-bit words:
 * past 4 GiB they wrap, and a ring that ran that long must read as one that
 * just began. Five gibibytes through a ring of 1 MiB, every record checked,
 * half of them copied in and half built in the ring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { createRingMemory, openRing } from './ring.js';

/**
 * `record` built in `ring` where it reserves, in room of more than it needs:
 * whether there was room.
 *
 * @param {import('./ring.js').Ring} ring @param {Uint8Array} record @param {number} n
 */
const built = (ring, record, n)=>{
    const at = ring.reserve(record.length + (n % 64));
    if (at < 0)
    {
        return false;
    }
    ring.bytes.set(record, at);
    ring.commit(record.length);
    return true;
};

test('records come out whole and in order past 4 GiB through the ring', { timeout: 600_000 }, ()=>{
    const ring = openRing(createRingMemory(1 << 20));
    // Not a divisor of the ring: records fall at every offset of it and wrap there.
    const length = 48_000 - 4;
    const record = new Uint8Array(length);
    const view = new DataView(record.buffer);
    const total = 5 * 2 ** 30;
    let sent = 0;
    let got = 0;
    let bytes = 0;
    /** @param {Uint8Array} taken */
    const check = taken=>{
        const at = new DataView(taken.buffer, taken.byteOffset, taken.length);
        assert.equal(taken.length, length);
        assert.equal(at.getUint32(0, true), got >>> 0, `record ${got}`);
        assert.equal(at.getUint32(length - 4, true), ~got >>> 0, `record ${got} whole`);
        got++;
    };
    while (bytes < total)
    {
        view.setUint32(0, sent, true);
        view.setUint32(length - 4, ~sent, true);
        // Every other record built in the ring, in room larger than it.
        if (sent % 2 === 0 ? ring.write(record) : built(ring, record, sent))
        {
            sent++;
            bytes += length;
            continue;
        }
        ring.drain(check);
    }
    ring.drain(check);
    assert.equal(got, sent);
    assert.ok(bytes > 2 ** 32, 'the counts wrapped');
});

/** Records the no-garbage gate writes an arm, after as many to warm up. */
const RECORDS = 500_000;

/**
 * A reader in a worker of `count` records of 8 bytes, each the number of
 * the record and that number's double: their sum, or the first out of place.
 *
 * @param {import('./ring.js').RingMemory} memory @param {number} count
 * @returns {Promise<number>}
 */
const readerOf = (memory, count)=>{
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.ring).then(({ openRing })=>{
            const ring = openRing(workerData.memory);
            let n = 0;
            while (n < workerData.count)
            {
                const seen = ring.bell.seen();
                const took = ring.drain(record=>{
                    const fields = new DataView(record.buffer, record.byteOffset, record.length);
                    if (record.length !== 8 || fields.getUint32(0, true) !== n
                        || fields.getUint32(4, true) !== n * 2)
                        throw new Error('record ' + n + ' out of place');
                    n++;
                });
                if (took === 0)
                    ring.bell.wait(seen);
            }
            parentPort.postMessage(n);
        });`, { eval: true, workerData: { ring: new URL('./ring.js', import.meta.url).href, memory,
        count } });
    return new Promise((resolve, reject)=>{
        worker.once('message', resolve);
        worker.once('error', reject);
    });
};

/**
 * Collections on this thread while it writes `RECORDS` records by `write`,
 * a blocking writer that waits for the reader in a worker.
 *
 * @param {(ring: import('./ring.js').Ring, n: number) => void} write
 */
async function collectionsWriting(write){
    const memory = createRingMemory(1 << 16);
    const ring = openRing(memory);
    const read = readerOf(memory, 2 * RECORDS);
    for (let n = 0; n < RECORDS; n++)
    {
        write(ring, n);
    }
    let collections = 0;
    const observer = new PerformanceObserver(list=>{
        collections += list.getEntries().length;
    });
    observer.observe({ entryTypes: ['gc'] });
    for (let n = RECORDS; n < 2 * RECORDS; n++)
    {
        write(ring, n);
    }
    assert.equal(await read, 2 * RECORDS, 'every record read, in order');
    observer.disconnect();
    return collections;
}

test('a writer makes no garbage, copying records in or building them in the ring', { timeout: 300_000 },
    async()=>{
        // A view made for each record would be ~100 bytes on the heap a record:
        // tens of megabytes over the gate, a collection every few thousand.
        const record = new Uint8Array(8);
        const fields = new DataView(record.buffer);
        const copied = await collectionsWriting((ring, n)=>{
            fields.setUint32(0, n, true);
            fields.setUint32(4, n * 2, true);
            assert.ok(ring.writeWaiting(record));
        });
        assert.ok(copied <= 2, `${copied} collections in ${RECORDS} records copied in`);
        /** @type {DataView | undefined} */
        let inRing;
        const built = await collectionsWriting((ring, n)=>{
            inRing ??= new DataView(ring.bytes.buffer);
            const at = ring.reserveWaiting(8);
            inRing.setUint32(at, n, true);
            inRing.setUint32(at + 4, n * 2, true);
            ring.commit();
        });
        assert.ok(built <= 2, `${built} collections in ${RECORDS} records built in the ring`);
    });
