/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a call to a worker costs in memory, by postMessage and by a channel:
 * each arm in a process of its own, so one arm's garbage is not another's.
 *
 *   node examples/memory.mjs                 every arm, 3 runs each
 *   node examples/memory.mjs ARM SCENARIO    one run (what the runs above start)
 *
 * Scenarios: `big` sends 8 MiB of samples to be summed, 200 times; `small`
 * asks a price 100 000 times. Arms: `post` (postMessage both ways, the
 * samples a Float64Array copied each call), `channel` (a blocking ask to a
 * worker sleeping on the channel, the samples in shared memory, only where
 * they lie sent).
 *
 * Measured, per run: the process's peak resident memory (getrusage), the
 * most ArrayBuffer bytes the worker's heap held (looked at every 10th call),
 * and the garbage collections of both threads (count and time, by
 * PerformanceObserver).
 */

import { execFileSync } from 'node:child_process';
import { PerformanceObserver } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createChannel, openClient, openServer } from '../src/index.js';

const SAMPLES = 1 << 20;
const MIB = 1024 * 1024;
const RUNS = 3;

/** Collections of this thread, from now on. */
const watchCollections = ()=>{
    const seen = { count: 0, ms: 0 };
    const observer = new PerformanceObserver(list=>{
        for (const entry of list.getEntries())
        {
            seen.count++;
            seen.ms += entry.duration;
        }
    });
    observer.observe({ entryTypes: ['gc'] });
    return { seen, stop: ()=>observer.disconnect() };
};

/** @param {number} item @param {number} quantity */
const quote = (item, quantity)=>(1 + (item % 97) * 0.25) * quantity;
/** @param {Float64Array} samples */
const sum = samples=>{
    let total = 0;
    for (let at = 0; at < samples.length; at++)
    {
        total += samples[at];
    }
    return total;
};

if (!isMainThread)
{
    const collections = watchCollections();
    /** The most ArrayBuffer bytes this thread's heap held, looked at every 10th call. */
    let peakBuffers = 0;
    let calls = 0;
    const look = ()=>{
        if (++calls % 10 === 0)
        {
            peakBuffers = Math.max(peakBuffers, process.memoryUsage().arrayBuffers);
        }
    };
    const report = ()=>{
        collections.stop();
        // The observer hands its last entries a turn later.
        setTimeout(()=>parentPort?.postMessage({ gc: collections.seen, peakBuffers }), 20);
    };
    if (workerData.arm === 'post')
    {
        parentPort?.on('message', message=>{
            if (message === 'report')
            {
                report();
                return;
            }
            look();
            const { id, item, quantity, samples } = message;
            parentPort?.postMessage({ id, result: samples ? sum(samples) : quote(item, quantity) });
        });
    }
    else
    {
        const server = openServer(workerData.channel);
        const samples = new Float64Array(workerData.shared);
        const answer = new Float64Array(1);
        const answerBytes = new Uint8Array(answer.buffer);
        const request = new Int32Array(3);
        const requestBytes = new Uint8Array(request.buffer);
        try
        {
            for (;;)
            {
                server.serve(bytes=>{
                    look();
                    requestBytes.set(bytes);
                    answer[0] = request[0] === 0 ? quote(request[1], request[2])
                        : sum(samples.subarray(request[1], request[1] + request[2]));
                    return answerBytes;
                });
            }
        }
        catch
        {
            report();
        }
    }
}
else if (process.argv.length >= 4)
{
    const [arm, scenario] = process.argv.slice(2);
    const calls = scenario === 'big' ? 200 : 100_000;
    const collections = watchCollections();
    const channel = createChannel({ slots: 4, slotBytes: 16 });
    const shared = new SharedArrayBuffer(SAMPLES * 8);
    const inShared = new Float64Array(shared);
    for (let at = 0; at < SAMPLES; at++)
    {
        inShared[at] = Math.sin(at);
    }
    // postMessage's own copy of the samples: the arm sends a plain array, as
    // a page does that has no shared memory.
    const plain = arm === 'post' ? Float64Array.from(inShared) : null;
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { arm, channel, shared } });
    const workerCollections = new Promise(resolve=>{
        worker.on('message', message=>{
            if (message.gc)
            {
                resolve(message);
            }
        });
    });

    /** @type {(n: number) => Promise<number> | number} */
    let call;
    if (arm === 'post')
    {
        /** @type {Map<number, (value: number) => void>} */
        const waiting = new Map();
        worker.on('message', ({ id, result })=>{
            waiting.get(id)?.(result);
            waiting.delete(id);
        });
        call = n=>new Promise(resolve=>{
            waiting.set(n, resolve);
            worker.postMessage(scenario === 'big' ? { id: n, samples: plain }
                : { id: n, item: n, quantity: 12 });
        });
    }
    else
    {
        const client = openClient(channel);
        const request = new Int32Array(3);
        const requestBytes = new Uint8Array(request.buffer);
        const answer = new Float64Array(1);
        const answerBytes = new Uint8Array(answer.buffer);
        /** @param {Uint8Array} bytes */
        const read = bytes=>{
            answerBytes.set(bytes);
            return answer[0];
        };
        const options = { read };
        call = n=>{
            request[0] = scenario === 'big' ? 1 : 0;
            request[1] = scenario === 'big' ? 0 : n;
            request[2] = scenario === 'big' ? SAMPLES : 12;
            return client.ask(requestBytes, options);
        };
    }
    const start = performance.now();
    let check = 0;
    for (let n = 0; n < calls; n++)
    {
        // Awaited only where it is a promise: an await of a number makes one.
        const answer = call(n);
        check += typeof answer === 'number' ? answer : await answer;
    }
    const ms = performance.now() - start;
    if (arm === 'post')
    {
        worker.postMessage('report');
    }
    else
    {
        openClient(channel).close();
    }
    const inWorker = /** @type {{ gc: { count: number, ms: number }, peakBuffers: number }} */ (
        await workerCollections);
    collections.stop();
    await new Promise(resolve=>setTimeout(resolve, 20));
    await worker.terminate();
    console.log(JSON.stringify({
        arm, scenario, calls, check, ms,
        usPerCall: ms * 1000 / calls,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
        heapUsedMiB: process.memoryUsage().heapUsed / MIB,
        workerBuffersMiB: inWorker.peakBuffers / MIB,
        gcMain: collections.seen, gcWorker: inWorker.gc,
    }));
}
else
{
    /** @type {Record<string, any[]>} */
    const results = {};
    for (const scenario of ['big', 'small'])
    {
        for (let run = 0; run < RUNS; run++)
        {
            // Alternated, so a slow moment of the machine falls on both arms.
            for (const arm of ['post', 'channel'])
            {
                const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), arm, scenario],
                    { encoding: 'utf8' });
                (results[`${scenario} ${arm}`] ??= []).push(JSON.parse(out));
            }
        }
    }
    /** @param {number[]} values */
    const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];
    /** @param {number[]} values @param {number} digits */
    const span = (values, digits)=>`${median(values).toFixed(digits)} (${Math.min(...values)
        .toFixed(digits)}-${Math.max(...values).toFixed(digits)})`;
    console.log(`node ${process.version}, ${RUNS} runs an arm, median (min-max)`);
    for (const [name, runs] of Object.entries(results))
    {
        console.log(`\n${name}: ${runs[0].calls} calls`);
        console.log(`  time a call        ${span(runs.map(r=>r.usPerCall), 1)} us`);
        console.log(`  peak RSS           ${span(runs.map(r=>r.peakRssMiB), 0)} MiB`);
        console.log(`  worker's buffers   ${span(runs.map(r=>r.workerBuffersMiB), 1)} MiB at most`);
        console.log(`  GC main thread     ${span(runs.map(r=>r.gcMain.count), 0)} collections,`
            + ` ${span(runs.map(r=>r.gcMain.ms), 1)} ms`);
        console.log(`  GC worker          ${span(runs.map(r=>r.gcWorker.count), 0)} collections,`
            + ` ${span(runs.map(r=>r.gcWorker.ms), 1)} ms`);
    }
}
