/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A function that lives in a worker, called from the main thread, twice over:
 * as a page calls one today, with postMessage, and through a channel.
 *
 * The worker keeps a price list and answers `quote(item, quantity)`: a small
 * call, made often, where the cost is the round trip. Then it sums a large
 * array of samples: a call that carries data, where the cost is the copy.
 *
 *   postMessage   the arguments are cloned into the worker, the result cloned
 *                 back, each a task in the other thread's event loop; the
 *                 samples are copied whole on every call.
 *   channel       the arguments are a few bytes written where the worker
 *                 reads them; the samples stay where they are, in shared
 *                 memory both threads see, and only where they lie is sent.
 *
 *   node examples/call-a-worker.mjs
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createChannel, openClient, openServer } from '../src/index.js';

const SAMPLES = 1 << 20;
const QUOTES = 100_000;
const SUMS = 200;

/** The worker's own: a price list, and samples to sum where they lie. */
const PRICES = Float64Array.from({ length: 1000 }, (_, item)=>1 + (item % 97) * 0.25);
/** @param {number} item @param {number} quantity */
const quote = (item, quantity)=>PRICES[item % PRICES.length] * quantity * (quantity >= 10 ? 0.9 : 1);
/** @param {Float64Array} samples */
const sum = samples=>{
    let total = 0;
    for (let at = 0; at < samples.length; at++)
    {
        total += samples[at];
    }
    return total;
};

/**
 * Answers a request of the channel: op 0 is quote(item, quantity), op 1 the
 * sum of `count` samples from `at`, read where they lie.
 *
 * @param {Float64Array} samples
 */
const answering = samples=>{
    const answer = new Float64Array(1);
    const answerBytes = new Uint8Array(answer.buffer);
    return (/** @type {Uint8Array} */ request)=>{
        const words = new Int32Array(request.slice().buffer, 0, 3);
        answer[0] = words[0] === 0 ? quote(words[1], words[2])
            : sum(samples.subarray(words[1], words[1] + words[2]));
        return answerBytes;
    };
};

if (!isMainThread && workerData.blocking)
{
    // A worker that does nothing else: it sleeps on the channel itself.
    const server = openServer(workerData.channel);
    const handler = answering(new Float64Array(workerData.shared));
    try
    {
        for (;;)
        {
            server.serve(handler);
        }
    }
    catch
    {
        // closed
    }
}
else if (!isMainThread)
{
    const { channel, shared } = workerData;
    // postMessage: one message, one answer.
    parentPort?.on('message', ({ id, op, item, quantity, samples })=>{
        parentPort?.postMessage({ id, result: op === 'quote' ? quote(item, quantity) : sum(samples) });
    });
    // The channel: served between messages, without leaving the loop for long.
    const server = openServer(channel);
    const handler = answering(new Float64Array(shared));
    (async()=>{
        for (;;)
        {
            await server.serveAsync(handler);
        }
    })().catch(()=>{});
}
else
{
    const channel = createChannel({ slots: 16, slotBytes: 16 });
    const shared = new SharedArrayBuffer(SAMPLES * 8);
    const samples = new Float64Array(shared);
    for (let at = 0; at < SAMPLES; at++)
    {
        samples[at] = Math.sin(at);
    }
    const plain = Float64Array.from(samples);
    const worker = new Worker(new URL(import.meta.url), { workerData: { channel, shared } });

    /** postMessage, as a page calls a worker today: a promise an id answers. */
    let next = 0;
    /** @type {Map<number, (value: number) => void>} */
    const waiting = new Map();
    worker.on('message', ({ id, result })=>{
        waiting.get(id)?.(result);
        waiting.delete(id);
    });
    /** @param {Record<string, any>} message @returns {Promise<number>} */
    const post = message=>new Promise(resolve=>{
        const id = next++;
        waiting.set(id, resolve);
        worker.postMessage({ id, ...message });
    });

    const client = openClient(channel);
    const blockingChannel = createChannel({ slots: 16, slotBytes: 16 });
    const blockingWorker = new Worker(new URL(import.meta.url),
        { workerData: { channel: blockingChannel, shared, blocking: true } });
    const blockingClient = openClient(blockingChannel);
    const request = new Int32Array(3);
    const requestBytes = new Uint8Array(request.buffer);
    /** @param {Uint8Array} bytes */
    const asDouble = bytes=>new Float64Array(bytes.slice().buffer)[0];
    /** @param {number} op @param {number} a @param {number} b */
    const ask = (op, a, b, through = client)=>{
        request[0] = op;
        request[1] = a;
        request[2] = b;
        return through.ask(requestBytes, { read: asDouble });
    };

    /** @param {string} what @param {number} calls @param {() => Promise<number> | number} call */
    const timed = async(what, calls, call)=>{
        let check = 0;
        for (let n = 0; n < Math.min(calls, 1000); n++)
        {
            check += await call();
        }
        const start = performance.now();
        for (let n = 0; n < calls; n++)
        {
            check += await call();
        }
        const ms = performance.now() - start;
        console.log(`${what.padEnd(44)} ${(ms * 1000 / calls).toFixed(1).padStart(8)} us a call`
            + `  (answers sum to ${check.toFixed(3)})`);
    };

    let n = 0;
    await timed('quote, postMessage', QUOTES, ()=>post({ op: 'quote', item: n++, quantity: 12 }));
    n = 0;
    await timed('quote, channel (blocking ask)', QUOTES, ()=>ask(0, n++, 12));
    n = 0;
    await timed('quote, channel to a worker that blocks', QUOTES, ()=>ask(0, n++, 12, blockingClient));
    n = 0;
    await timed('quote, channel (call, awaited)', QUOTES, ()=>{
        request[0] = 0;
        request[1] = n++;
        request[2] = 12;
        return client.call(requestBytes, { read: asDouble });
    });
    await timed(`sum of ${SAMPLES} samples, postMessage (copied)`, SUMS,
        ()=>post({ op: 'sum', samples: plain }));
    await timed(`sum of ${SAMPLES} samples, channel (in place)`, SUMS, ()=>ask(1, 0, SAMPLES));
    client.close();
    blockingClient.close();
    await Promise.all([worker.terminate(), blockingWorker.terminate()]);
}
