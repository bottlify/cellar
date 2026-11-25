/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's concurrency gate: threads read, write and drop names of one
 * pool at once while the keeper, short of room and with a clock that makes
 * everything idle at once, cools bodies to the disk, brings them back, drops
 * them and lets segments go. No thread may read a body that is not its name's
 * or that changes while it is inside, nor a name's version older than one it
 * saw (`concurrency.worker.fixture.js`); the keeper's figures show the moves
 * happened and the table grew under them, so the gate cannot pass on a cache
 * that moved nothing. Once the threads are gone every name is dropped, and no
 * room may be left held: a body or a reservation the keeper lost track of.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { channelMemory, serve } from './channel.fixture.js';
import { openKeeper } from './keeper.js';
import { memoryDisk } from './disk.fixture.js';

const KIB = 1024;
const THREADS = 4;
const POOL = 120;
/** Names each thread owns: with the pool, past the first table's half, so it grows. */
const OWNED = 150;

/**
 * Runs the threads over a keeper of `options` and checks what every gate
 * checks; answers the keeper's figures and what the threads counted.
 *
 * @param {Partial<import('./keeper.js').KeeperOptions>} options
 */
async function gate(options){
    /** @type {Worker[]} */
    const workers = [];
    const keeper = await openKeeper({
        budget: 512 * KIB, disk: memoryDisk(), ...options,
        announce: message=>{
            for (const worker of workers)
            {
                worker.postMessage(message);
            }
        },
    });
    await new Promise(resolve=>setTimeout(resolve, 0));
    const sweeping = setInterval(()=>keeper.sweep(), 1);
    const links = [];
    const done = [];
    for (let t = 0; t < THREADS; t++)
    {
        const memory = channelMemory();
        links.push(serve(memory, {
            reserve: (name, length, options)=>keeper.reserve(name, length, options ?? {}),
            raise: (name, options)=>keeper.raise(name, options ?? {}),
            drop: name=>keeper.drop(name),
        }));
        const worker = new Worker(new URL('./concurrency.worker.fixture.js', import.meta.url), {
            workerData: { channel: memory, shared: keeper.shared, segments: keeper.segmentBuffers(),
                seed: 0x9e3779b9 + t * 7919, operations: 6000, pool: POOL, thread: t,
                threads: THREADS, owned: OWNED },
        });
        workers.push(worker);
        done.push(new Promise((resolve, reject)=>{
            worker.on('message', message=>{
                if (message.done)
                {
                    resolve(message);
                }
            });
            worker.on('error', reject);
        }));
    }
    /** @type {any[]} */
    let results;
    try
    {
        results = await Promise.all(done);
    }
    finally {
        clearInterval(sweeping);
        for (const link of links)
        {
            link.stop();
        }
        await Promise.all(workers.map(worker=>worker.terminate()));
    }

    const figures = keeper.figures();
    const failures = results.flatMap(result=>result.failures);
    assert.deepEqual(failures, [], `${results.reduce((sum, r)=>sum + r.failed, 0)} bad reads`);
    /** @param {string} what */
    const sum = what=>results.reduce((all, result)=>all + result.counts[what], 0);
    assert.ok(sum('hits') > 1000, `hits ${sum('hits')}`);
    assert.ok(sum('written') > 1000, `written ${sum('written')}`);
    assert.ok(sum('ownHits') > 1000, `owned names read ${sum('ownHits')}`);
    assert.ok(figures.replaced > 10, `written anew while read ${figures.replaced}`);
    assert.ok(figures.records > 512, `records ${figures.records}: the first table never grew`);

    // Every name dropped, the threads gone: nothing may stay placed.
    const names = [...Array.from({ length: POOL }, (_, i)=>`n${i}`),
        ...Array.from({ length: THREADS * OWNED }, (_, i)=>`o${i % THREADS}-${Math.floor(i / THREADS)}`)];
    for (const name of names)
    {
        keeper.drop(name);
    }
    keeper.sweep();
    const left = keeper.figures();
    assert.equal(left.placedBytes, 0, JSON.stringify(left));
    assert.equal(left.hot + left.cold, 0, JSON.stringify(left));
    return figures;
}

test('threads on one pool never read a body the keeper gave away', { timeout: 120_000 }, async()=>{
    // Short of room, and a clock that makes everything idle at once.
    const figures = await gate({ segmentBytes: 64 * KIB, coldAfterMs: 5, goneAfterMs: 200,
        releaseAfterMs: 10 });
    // The moves the gate is for happened, many times over.
    assert.ok(figures.cooled > 100, `cooled ${figures.cooled}`);
    assert.ok(figures.raised > 10, `raised ${figures.raised}`);
    assert.ok(figures.segmentsLetGo > 0, `segments let go ${figures.segmentsLetGo}`);
    assert.ok(figures.segmentBytes <= 512 * KIB);
});

test('threads never read a name older than one they saw, the bodies kept hot', { timeout: 120_000 },
    async()=>{
        // Nothing idles out: a record the index leads to wrongly is read, not missed.
        await gate({ budget: 64 * 1024 * KIB, segmentBytes: 1024 * KIB, coldAfterMs: 1e9,
            goneAfterMs: 1e9, releaseAfterMs: 1e9 });
    });
