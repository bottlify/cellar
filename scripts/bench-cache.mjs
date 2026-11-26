/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a cache write and a cache hit cost in one thread, the keeper beside
 * the reader (no transport between them): the price of `put` itself, its
 * reserve, copy and commit, and of `with` on a body found.
 *
 *   put new    names never written, into a cache with room
 *   put over   the same names written again and again (the body replaced)
 *   put full   more names than the budget holds: every put makes a body leave
 *   hit        `with` on bodies found, summing nothing
 *
 * Each scenario runs on a fresh cache, `runs` times after a warm-up; printed
 * are ns an operation, the median of the runs, the lowest and highest, and
 * the collections the runs made (all of them, and their total ms).
 *
 *   node scripts/bench-cache.mjs [runs] [body bytes] [scenario]
 */

import { PerformanceObserver } from 'node:perf_hooks';
import { openKeeper } from '../src/keeper.js';
import { createReader } from '../src/reader.js';

const RUNS = Number(process.argv[2] ?? 7);
const BODY = Number(process.argv[3] ?? 256);
const ONLY = process.argv[4];
const MIB = 1 << 20;

let collections = 0;
let collectedMs = 0;
new PerformanceObserver(list=>{
    for (const entry of list.getEntries())
    {
        collections++;
        collectedMs += entry.duration;
    }
}).observe({ entryTypes: ['gc'] });

/** @param {number} budget @param {number} segmentBytes */
async function cacheOf(budget, segmentBytes){
    /** @type {import('../src/reader.js').Reader | null} */
    let reader = null;
    const keeper = await openKeeper({
        budget, segmentBytes, disk: null,
        announce: message=>reader?.adopt(message),
    });
    reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: name=>keeper.raise(name),
            raiseLater: ()=>{},
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    return { keeper, reader };
}

const body = Uint8Array.from({ length: BODY }, (_, i)=>i & 255);
const names = Array.from({ length: 1 << 16 }, (_, i)=>`bodies/${i}`);

/** @type {Record<string, (cache: Awaited<ReturnType<typeof cacheOf>>) => number>} ops done */
const SCENARIOS = {
    'put new'({ reader }){
        const n = 8000;
        for (let i = 0; i < n; i++)
        {
            if (!reader.put(names[i], body))
            {
                throw new Error('put new: refused');
            }
        }
        return n;
    },
    'put over'({ reader }){
        const n = 200_000;
        for (let i = 0; i < n; i++)
        {
            if (!reader.put(names[i & 1023], body))
            {
                throw new Error('put over: refused');
            }
        }
        return n;
    },
    'put full'({ reader }){
        // 4 MiB of 4 KiB blocks holds 1024 bodies; 4096 names cycle through it.
        const n = 100_000;
        for (let i = 0; i < n; i++)
        {
            if (!reader.put(names[i & 4095], body))
            {
                throw new Error('put full: refused');
            }
        }
        return n;
    },
    hit({ reader }){
        for (let i = 0; i < 1024; i++)
        {
            reader.put(names[i], body);
        }
        const n = 1_000_000;
        /** @param {Uint8Array} read */
        const length = read=>read.length;
        let s = 0;
        for (let i = 0; i < n; i++)
        {
            s += reader.with(names[i & 1023], length) ?? 0;
        }
        if (s !== n * BODY)
        {
            throw new Error('hit: missed');
        }
        return n;
    },
};

const SIZES = { 'put new': [64 * MIB, 4 * MIB], 'put over': [64 * MIB, 4 * MIB],
    'put full': [4 * MIB, MIB], hit: [64 * MIB, 4 * MIB] };

/** @param {number[]} xs */
const median = xs=>[...xs].sort((a, b)=>a - b)[xs.length >> 1];

console.log(`node ${process.version}, body ${BODY} B, ${RUNS} runs after a warm-up`);
for (const [name, run] of Object.entries(SCENARIOS))
{
    if (ONLY !== undefined && name !== ONLY)
    {
        continue;
    }
    const [budget, segmentBytes] = SIZES[/** @type {keyof typeof SIZES} */ (name)];
    run(await cacheOf(budget, segmentBytes));
    await new Promise(resolve=>setTimeout(resolve, 10));
    const before = [collections, collectedMs];
    /** @type {number[]} */
    const ns = [];
    for (let r = 0; r < RUNS; r++)
    {
        const cache = await cacheOf(budget, segmentBytes);
        const from = process.hrtime.bigint();
        const ops = run(cache);
        ns.push(Number(process.hrtime.bigint() - from) / ops);
    }
    await new Promise(resolve=>setTimeout(resolve, 10));
    console.log(`${name.padEnd(9)} ${median(ns).toFixed(0).padStart(6)} ns  (${Math.min(...ns).toFixed(0)}`
        + `-${Math.max(...ns).toFixed(0)})  gc ${collections - before[0]}, `
        + `${(collectedMs - before[1]).toFixed(1)} ms`);
}
