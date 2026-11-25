/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Events from the main thread to a worker that is busy, twice over: posted,
 * as a page sends input to a worker today, and written into a ring.
 *
 * The worker runs a long computation in steps (a frame, a slice of a
 * program) and must see what it was sent between two of them.
 *
 *   postMessage   an event reaches the worker only when its event loop
 *                 turns: the worker gives its thread back after every step
 *                 to hear it, and every event is a structured clone.
 *   ring          an event is a record written where the worker reads it:
 *                 the worker drains the ring between two steps without
 *                 leaving its loop, and when it has nothing to do it sleeps
 *                 on the ring's doorbell, which the writer rings only then.
 *
 * Then the same events with the worker idle: how long one takes to arrive,
 * a message against a doorbell.
 *
 *   node examples/ring.mjs
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createDoorbell, createRingMemory, openDoorbell, openRing } from '../src/index.js';

/** Steps of work the busy worker runs, and the work in each. */
const STEPS = 2000;
const STEP_WORK = 20_000;
/** Events sent while it works, and events sent one at a time to it idle. */
const EVENTS = 20_000;
const PINGS = 2000;

/** A step of the worker's computation. @param {number} seed */
const step = seed=>{
    let x = seed;
    for (let n = 0; n < STEP_WORK; n++)
    {
        x = (x * 1103515245 + 12345) | 0;
    }
    return x;
};

/** An event as the page has it: a pointer's move. @param {number} n */
const eventOf = n=>({ kind: 'move', x: n % 1024, y: (n * 7) % 768, at: n });

/** The same event as a record of the ring: three words. */
const record = new Int32Array(3);
const recordBytes = new Uint8Array(record.buffer);
/** @param {number} n */
const recordOf = n=>{
    record[0] = n % 1024;
    record[1] = (n * 7) % 768;
    record[2] = n;
    return recordBytes;
};

if (!isMainThread && workerData.arm === 'post')
{
    let heard = 0;
    parentPort?.on('message', message=>{
        if (message === 'busy')
        {
            (async()=>{
                let x = 0;
                for (let n = 0; n < STEPS; n++)
                {
                    x ^= step(n);
                    // Its thread back to the event loop, or no event is heard.
                    await new Promise(resolve=>setImmediate(resolve));
                }
                parentPort?.postMessage({ heard, x });
            })();
            return;
        }
        heard++;
        if (message.ping)
        {
            parentPort?.postMessage('pong');
        }
    });
}
else if (!isMainThread)
{
    const ring = openRing(workerData.ring);
    const back = openDoorbell(workerData.back);
    let heard = 0;
    let pinged = 0;
    const take = (/** @type {Uint8Array} */ bytes)=>{
        heard++;
        // A ping is an event whose third word is negative.
        if (new Int32Array(bytes.buffer, bytes.byteOffset, 3)[2] < 0)
        {
            pinged++;
            back.ring();
        }
    };
    // Busy: the ring drained between two steps, the thread never given back.
    let x = 0;
    for (let n = 0; n < STEPS; n++)
    {
        x ^= step(n);
        ring.drain(take);
    }
    parentPort?.postMessage({ heard, x });
    // Idle: asleep on the doorbell until the next event.
    while (pinged < PINGS)
    {
        const seen = ring.bell.seen();
        if (ring.drain(take) === 0)
        {
            ring.bell.wait(seen);
        }
    }
}
else
{
    /** @param {string} what @param {number} ms @param {number} count @param {string} unit */
    const report = (what, ms, count, unit)=>console.log(
        `${what.padEnd(46)} ${(ms * 1000 / count).toFixed(1).padStart(8)} us ${unit}`);

    // postMessage.
    {
        const worker = new Worker(new URL(import.meta.url), { workerData: { arm: 'post' } });
        const done = new Promise(resolve=>worker.once('message', resolve));
        const start = performance.now();
        worker.postMessage('busy');
        for (let n = 0; n < EVENTS; n++)
        {
            worker.postMessage(eventOf(n));
            if (n % 100 === 99)
            {
                await new Promise(resolve=>setImmediate(resolve));
            }
        }
        const { heard } = /** @type {any} */ (await done);
        report(`busy worker, postMessage (${heard} events heard)`, performance.now() - start,
            STEPS, 'a step');
        const pings = performance.now();
        for (let n = 0; n < PINGS; n++)
        {
            const pong = new Promise(resolve=>worker.once('message', resolve));
            worker.postMessage({ ...eventOf(n), ping: true });
            await pong;
        }
        report('idle worker, postMessage there and back', performance.now() - pings, PINGS,
            'an event');
        await worker.terminate();
    }

    // The ring.
    {
        const memory = createRingMemory(1 << 16, createDoorbell());
        const back = createDoorbell();
        const worker = new Worker(new URL(import.meta.url),
            { workerData: { arm: 'ring', ring: memory, back } });
        const done = new Promise(resolve=>worker.once('message', resolve));
        const ring = openRing(memory);
        const start = performance.now();
        for (let n = 0; n < EVENTS; n++)
        {
            // A page may not block: a full ring is tried again on a later turn.
            while (!ring.write(recordOf(n)))
            {
                await new Promise(resolve=>setImmediate(resolve));
            }
            if (n % 100 === 99)
            {
                await new Promise(resolve=>setImmediate(resolve));
            }
        }
        const { heard } = /** @type {any} */ (await done);
        report(`busy worker, ring (${heard} events heard)`, performance.now() - start, STEPS,
            'a step');
        const answer = openDoorbell(back);
        const pings = performance.now();
        for (let n = 0; n < PINGS; n++)
        {
            const seen = answer.seen();
            recordOf(n);
            record[2] = -1 - n;
            ring.write(recordBytes);
            // This thread may block in node; a page would use waitAsync.
            answer.wait(seen);
        }
        report('idle worker, ring and doorbell there and back', performance.now() - pings, PINGS,
            'an event');
        await worker.terminate();
    }
}
