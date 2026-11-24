/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The channel's gate: two threads ask and answer tens of thousands of times,
 * each side blocking or not, with as many requests out as the slots hold.
 * Every answer is checked against its request (`channel-gate.fixture.js`),
 * so an answer read before its bytes, or handed to the wrong caller, fails
 * it; a wake-up lost leaves a side asleep and the gate runs out of time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { ChannelClosed, createChannel, openClient, openServer } from './channel.js';
import { GATE_SLOT_BYTES, answerTo, requestOf } from './channel-gate.fixture.js';

const COUNT = 30_000;
const WORKER = new URL('./channel.worker.fixture.js', import.meta.url);

/** @param {Worker} worker @returns {Promise<any>} */
const resultOf = worker=>new Promise((resolve, reject)=>{
    worker.once('message', resolve);
    worker.once('error', reject);
});

test('a thread that blocks serves another that asks, blocking and not', { timeout: 120_000 }, async()=>{
    const memory = createChannel({ slots: 8, slotBytes: GATE_SLOT_BYTES });
    const server = new Worker(WORKER, { workerData: { role: 'server', memory } });
    const served = resultOf(server);
    const client = new Worker(WORKER, { workerData: { role: 'client', memory, seed: 11, count: COUNT } });
    const { failures } = await resultOf(client);
    openClient(memory).close();
    assert.deepEqual(failures, []);
    assert.equal((await served).served, COUNT);
    await Promise.all([client.terminate(), server.terminate()]);
});

test('a thread with an event loop to keep serves on it', { timeout: 120_000 }, async()=>{
    const memory = createChannel({ slots: 3, slotBytes: GATE_SLOT_BYTES });
    const server = openServer(memory);
    const client = new Worker(WORKER, { workerData: { role: 'client', memory, seed: 23, count: COUNT } });
    const done = resultOf(client);
    let served = 0;
    const serving = (async()=>{
        try
        {
            for (;;)
            {
                served += await server.serveAsync(answerTo);
            }
        }
        catch (e){
            if (!(e instanceof ChannelClosed))
            {
                throw e;
            }
        }
    })();
    const { failures } = await done;
    server.close();
    await serving;
    assert.deepEqual(failures, []);
    assert.equal(served, COUNT);
    await client.terminate();
});

test('calls of a thread with an event loop, served by one that blocks', { timeout: 120_000 }, async()=>{
    const memory = createChannel({ slots: 16, slotBytes: GATE_SLOT_BYTES });
    const server = new Worker(WORKER, { workerData: { role: 'server', memory } });
    const served = resultOf(server);
    const client = openClient(memory);
    /** @type {string[]} */
    const failures = [];
    /** @type {Promise<void>[]} */
    const calls = [];
    for (let n = 0; n < COUNT; n++)
    {
        const request = requestOf(5, n);
        const expected = answerTo(request);
        calls.push(client.call(request, { read: answer=>answer.every((value, at)=>value === expected[at])
            && answer.length === expected.length }).then(right=>{
            if (!right)
            {
                failures.push(`request ${n}: answered another`);
            }
        }));
        if (calls.length >= 100)
        {
            await Promise.all(calls.splice(0));
        }
    }
    await Promise.all(calls);
    client.close();
    assert.deepEqual(failures, []);
    assert.equal((await served).served, COUNT);
    await server.terminate();
});

test('an ask makes no garbage: a call by the channel collects nothing on the asking thread',
    { timeout: 120_000 }, async()=>{
        // Each look at the clock while waiting was a number made on the heap:
        // ~400 bytes a call, a collection every 20 000 calls.
        const memory = createChannel({ slots: 4, slotBytes: 16 });
        const server = new Worker(WORKER, { workerData: { role: 'server', memory } });
        const served = resultOf(server);
        const client = openClient(memory);
        const request = new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]);
        const options = { read: (/** @type {Uint8Array} */ answer)=>answer[0] };
        for (let n = 0; n < 10_000; n++)
        {
            client.ask(request, options);
        }
        let collections = 0;
        const observer = new PerformanceObserver(list=>{
            collections += list.getEntries().length;
        });
        observer.observe({ entryTypes: ['gc'] });
        let sum = 0;
        for (let n = 0; n < 200_000; n++)
        {
            sum += client.ask(request, options);
        }
        await new Promise(resolve=>setTimeout(resolve, 50));
        observer.disconnect();
        client.close();
        await served;
        await server.terminate();
        assert.equal(sum, 200_000 * 2, 'every answer');
        assert.ok(collections <= 2, `${collections} collections in 200 000 asks`);
    });
