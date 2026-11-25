/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Batches of bytes from one worker to another, three ways: what a thread
 * that records commands for another (a renderer's, a mixer's) pays to hand
 * them over.
 *
 *   post          the batch built in a buffer of its own, posted with its
 *                 buffer transferred, the buffer posted back once read
 *   ring write    built in a buffer of its own, copied into the ring
 *   ring reserve  built in the ring where `reserve` gives room, published
 *                 by `commit`: no copy
 *
 * Each batch is the same work to build (a word written every 4 bytes) and to
 * read (every word summed). Printed for each size and arm: the processor
 * time each thread spent a batch (not wall time: a loaded machine's waits
 * are not counted), the median of the runs, then the lowest and highest.
 *
 *   node examples/batches.mjs [runs]
 */

import { MessageChannel, Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRingMemory, openRing } from '../src/index.js';

const SIZES = [64, 8 << 10, 64 << 10, 256 << 10];
/** Bytes sent a run, whatever the batch size, at least this many batches. */
const BYTES = 256 << 20;
const MIN_BATCHES = 2000;
const ARMS = ['post', 'ring write', 'ring reserve'];
/** Buffers a posting sender keeps in flight before it waits for one back. */
const IN_FLIGHT = 8;

/** Processor time this thread has spent, in microseconds. */
const cpu = ()=>{
    const { user, system } = process.threadCpuUsage();
    return user + system;
};

/** @param {Uint32Array} words @param {number} from @param {number} length @param {number} n */
const build = (words, from, length, n)=>{
    for (let i = 0; i < length; i++)
    {
        words[from + i] = n + i;
    }
};

/** @param {Uint32Array} words */
const sum = words=>{
    let s = 0;
    for (let i = 0; i < words.length; i++)
    {
        s = (s + words[i]) | 0;
    }
    return s;
};

if (!isMainThread)
{
    const { role, arm, size, count } = workerData;
    const words = size / 4;
    if (arm === 'post' && role === 'send')
    {
        /** @type {ArrayBuffer[]} */
        const spare = Array.from({ length: IN_FLIGHT }, ()=>new ArrayBuffer(size));
        /** @type {(() => void) | null} */
        let wake = null;
        const port = workerData.port;
        port.on('message', (/** @type {ArrayBuffer} */ buffer)=>{
            spare.push(buffer);
            const w = wake;
            wake = null;
            w?.();
        });
        const start = cpu();
        for (let n = 0; n < count; n++)
        {
            while (spare.length === 0)
            {
                await new Promise(resolve=>{
                    wake = /** @type {() => void} */ (resolve);
                });
            }
            const buffer = /** @type {ArrayBuffer} */ (spare.pop());
            build(new Uint32Array(buffer), 0, words, n);
            port.postMessage(buffer, [buffer]);
        }
        const spent = cpu() - start;
        port.close();
        parentPort?.postMessage(spent);
    }
    else if (arm === 'post')
    {
        const port = workerData.port;
        let n = 0;
        let check = 0;
        let start = 0;
        port.on('message', (/** @type {ArrayBuffer} */ buffer)=>{
            if (n === 0)
            {
                start = cpu();
            }
            check = (check + sum(new Uint32Array(buffer))) | 0;
            port.postMessage(buffer, [buffer]);
            if (++n === count)
            {
                parentPort?.postMessage({ spent: cpu() - start, check });
                port.close();
            }
        });
    }
    else if (role === 'send')
    {
        const ring = openRing(workerData.ring);
        const own = new Uint32Array(words);
        const own8 = new Uint8Array(own.buffer);
        const inRing = new Uint32Array(ring.bytes.buffer);
        const start = cpu();
        for (let n = 0; n < count; n++)
        {
            if (arm === 'ring write')
            {
                build(own, 0, words, n);
                ring.writeWaiting(own8);
            }
            else
            {
                const at = ring.reserveWaiting(size);
                build(inRing, at / 4, words, n);
                ring.commit();
            }
        }
        parentPort?.postMessage(cpu() - start);
    }
    else
    {
        const ring = openRing(workerData.ring);
        let n = 0;
        let check = 0;
        let start = 0;
        const take = (/** @type {Uint8Array} */ record)=>{
            if (n === 0)
            {
                start = cpu();
            }
            check = (check + sum(new Uint32Array(record.buffer, record.byteOffset, words))) | 0;
            n++;
        };
        while (n < count)
        {
            const seen = ring.bell.seen();
            if (ring.drain(take) === 0)
            {
                ring.bell.wait(seen);
            }
        }
        parentPort?.postMessage({ spent: cpu() - start, check });
    }
}
else
{
    const runs = Number(process.argv[2] ?? 5);
    /** @param {Worker} worker */
    const answer = worker=>new Promise((resolve, reject)=>{
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    /** One run of an arm: processor microseconds a batch, the sender's and the reader's. */
    const run = async(/** @type {string} */ arm, /** @type {number} */ size)=>{
        const count = Math.max(MIN_BATCHES, Math.floor(BYTES / size));
        const shared = { arm, size, count };
        /** @type {Worker} */
        let sender;
        /** @type {Worker} */
        let reader;
        if (arm === 'post')
        {
            const { port1, port2 } = new MessageChannel();
            reader = new Worker(new URL(import.meta.url),
                { workerData: { ...shared, role: 'read', port: port2 }, transferList: [port2] });
            sender = new Worker(new URL(import.meta.url),
                { workerData: { ...shared, role: 'send', port: port1 }, transferList: [port1] });
        }
        else
        {
            const ring = createRingMemory(Math.max(1 << 20, size * 8));
            reader = new Worker(new URL(import.meta.url), { workerData: { ...shared, role: 'read', ring } });
            sender = new Worker(new URL(import.meta.url), { workerData: { ...shared, role: 'send', ring } });
        }
        const [sent, read] = await Promise.all([answer(sender), answer(reader)]);
        await Promise.all([sender.terminate(), reader.terminate()]);
        return { send: /** @type {number} */ (sent) / count, read: /** @type {any} */ (read).spent / count };
    };
    /** @param {number[]} list */
    const spread = list=>{
        const sorted = [...list].sort((a, b)=>a - b);
        const f = (/** @type {number} */ v)=>v.toFixed(2);
        return `${f(sorted[sorted.length >> 1])} (${f(sorted[0])}-${f(sorted.at(-1) ?? 0)})`;
    };
    console.log(`node ${process.version}, ${runs} runs an arm alternated; processor us a batch, `
        + 'median (lowest-highest)');
    for (const size of SIZES)
    {
        /** @type {Record<string, { send: number[], read: number[] }>} */
        const results = Object.fromEntries(ARMS.map(arm=>[arm, { send: [], read: [] }]));
        await run('ring reserve', size);
        for (let r = 0; r < runs; r++)
        {
            for (const arm of r % 2 === 0 ? ARMS : [...ARMS].reverse())
            {
                const { send, read } = await run(arm, size);
                results[arm].send.push(send);
                results[arm].read.push(read);
            }
        }
        for (const arm of ARMS)
        {
            console.log(`${String(size).padStart(7)} B  ${arm.padEnd(13)} sender ${spread(results[arm].send).padEnd(24)}`
                + ` reader ${spread(results[arm].read)}`);
        }
    }
}
