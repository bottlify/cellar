/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether a ring's two counts want cache lines of their own on this machine.
 *
 * A ring's writer moves the count of bytes written and reads the count read;
 * its reader does the opposite. On one cache line, every record drags that
 * line from one core to the other ("false sharing"); a line apart, each core
 * keeps its own. Cellar keeps them together: on an x86 VM a line apart was no
 * faster (roadmap/negative-results.md in Bottlify). This stand asks again on
 * the machine it runs on, an arm64 one above all (an Apple M's lines are 128
 * bytes).
 *
 * The ring here is Cellar's ring cut to what the question needs: the same
 * counts and atomics, records of 8 bytes, no doorbell (the reader looks
 * without sleeping, as a busy reader does). The arms differ in one thing, the
 * distance between the two counts: 4 bytes (side by side), 64 and 128.
 *
 *   node examples/cache-lines.mjs [rounds]
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { cpus } from 'node:os';

const RECORDS = 20_000_000;
const RING_BYTES = 1 << 16;
const RECORD = 8;
const GAPS = [4, 64, 128];


if (!isMainThread)
{
    // The writer.
    const { control, data, gap } = workerData;
    const words = new Int32Array(control);
    const bytes = new Uint8Array(data);
    const READ = gap / 4;
    const mask = RING_BYTES - 1;
    let written = 0;
    for (let n = 0; n < RECORDS; n++)
    {
        while (((written - Atomics.load(words, READ)) >>> 0) + RECORD > RING_BYTES)
        {
            // full: the reader frees room
        }
        const at = written & mask;
        bytes[at] = n & 0xff;
        bytes[at + 4] = (n >>> 8) & 0xff;
        written = (written + RECORD) | 0;
        Atomics.store(words, 0, written);
    }
    parentPort?.postMessage('done');
}
else
{
    /** One run of an arm: records a second, in millions. @param {number} gap */
    const run = async gap=>{
        // The control block: the written count at word 0, the read count `gap` bytes on.
        const words = new Int32Array(new SharedArrayBuffer(256));
        const data = new SharedArrayBuffer(RING_BYTES);
        const bytes = new Uint8Array(data);
        const READ = gap / 4;
        const mask = RING_BYTES - 1;
        const writer = new Worker(new URL(import.meta.url),
            { workerData: { control: words.buffer, data, gap } });
        await new Promise(resolve=>writer.once('online', resolve));
        const start = performance.now();
        let read = 0;
        let sum = 0;
        for (let n = 0; n < RECORDS;)
        {
            const written = Atomics.load(words, 0);
            while (read !== written)
            {
                const at = read & mask;
                sum += bytes[at] + bytes[at + 4];
                read = (read + RECORD) | 0;
                n++;
            }
            Atomics.store(words, READ, read);
        }
        const ms = performance.now() - start;
        await writer.terminate();
        if (sum < 0)
        {
            throw new Error('unreachable');
        }
        return RECORDS / ms / 1000;
    };

    const rounds = Number(process.argv[2] ?? 7);
    const cpu = cpus()[0]?.model ?? 'unknown';
    console.log(`${process.arch}, ${cpu}, ${cpus().length} cores, node ${process.versions.node}`);
    console.log(`${RECORDS / 1e6} M records of ${RECORD} bytes through a ${RING_BYTES >> 10} KiB ring,`
        + ` ${rounds} rounds, arms alternated\n`);
    /** @type {Record<number, number[]>} */
    const results = Object.fromEntries(GAPS.map(gap=>[gap, []]));
    // One run of each first, not counted: the engine's tiers settle.
    for (const gap of GAPS)
    {
        await run(gap);
    }
    for (let round = 0; round < rounds; round++)
    {
        for (const gap of round % 2 === 0 ? GAPS : [...GAPS].reverse())
        {
            results[gap].push(await run(gap));
        }
        console.log(`round ${round + 1}: ` + GAPS.map(gap=>
            `${String(gap).padStart(3)} B apart ${(results[gap].at(-1) ?? 0).toFixed(2)}`).join('   '));
    }
    const median = (/** @type {number[]} */ list)=>[...list].sort((a, b)=>a - b)[list.length >> 1];
    console.log('\nmedian, M records a second:');
    for (const gap of GAPS)
    {
        const sorted = [...results[gap]].sort((a, b)=>a - b);
        console.log(`  counts ${String(gap).padStart(3)} bytes apart: ${median(sorted).toFixed(2)}`
            + `  (${sorted[0].toFixed(2)} - ${(sorted.at(-1) ?? 0).toFixed(2)})`);
    }
}
