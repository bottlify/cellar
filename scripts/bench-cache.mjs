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
 *   reserve    `reserve`, the body written into its view, `commit`, then `with`
 *              reading it back: the same names again and again
 *   hit        `with` on bodies found, summing nothing
 *
 * Each scenario runs on a fresh cache, `runs` times after a warm-up, for each
 * body size; printed are ns an operation, the median of the runs, the lowest
 * and highest, every run's value, the collections the runs made (all of them,
 * and their total ms), and the bytes an operation allocates in the steady
 * state (V8's sampling heap profiler, `allocation.fixture.js`: an estimate,
 * a few bytes either way).
 *
 *   node scripts/bench-cache.mjs [runs] [body bytes, comma separated] [scenario]
 */

import { PerformanceObserver } from 'node:perf_hooks';
import { cpus, loadavg } from 'node:os';
import { openKeeper } from '../src/keeper.js';
import { createReader } from '../src/reader.js';
import { bytesPerCall } from '../src/allocation.fixture.js';

const RUNS = Number(process.argv[2] ?? 7);
const BODIES = (process.argv[3] ?? '256,4096,65536').split(',').map(Number);
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
            reserve: keeper.reserve,
            raise: name=>keeper.raise(name),
            raiseLater: ()=>{},
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    return { keeper, reader };
}

const names = Array.from({ length: 1 << 16 }, (_, i)=>`bodies/${i}`);
let body = new Uint8Array(0);
/** Names a steady scenario cycles through: 1,024, or fewer where bodies are large. */
let cycle = 1023;

/**
 * Each scenario: its run, ops done, and one op of its steady state for the
 * allocation sample (none for `put new`, whose names run out).
 *
 * @type {Record<string, { run: (cache: Awaited<ReturnType<typeof cacheOf>>) => number,
 *     one?: (cache: Awaited<ReturnType<typeof cacheOf>>, i: number) => void,
 *     sizes: (body: number) => [number, number] }>}
 */
const SCENARIOS = {
    'put new': {
        sizes: ()=>[128 * MIB, 4 * MIB],
        run({ reader }){
            const n = Math.min(8000, (64 * MIB) / body.length);
            for (let i = 0; i < n; i++)
            {
                if (!reader.put(names[i], body))
                {
                    throw new Error('put new: refused');
                }
            }
            return n;
        },
    },
    'put over': {
        sizes: ()=>[128 * MIB, 4 * MIB],
        run({ reader }){
            const n = Math.min(200_000, 2 ** 31 / body.length);
            for (let i = 0; i < n; i++)
            {
                if (!reader.put(names[i & cycle], body))
                {
                    throw new Error('put over: refused');
                }
            }
            return n;
        },
        one: ({ reader }, i)=>{
            reader.put(names[i & cycle], body);
        },
    },
    'put full': {
        // Room for a quarter of the names cycled through: every put evicts.
        sizes: size=>[Math.max(MIB, (cycle + 1) / 4 * size), MIB],
        run({ reader }){
            const n = Math.min(100_000, 2 ** 31 / body.length);
            for (let i = 0; i < n; i++)
            {
                if (!reader.put(names[i & cycle], body))
                {
                    throw new Error('put full: refused');
                }
            }
            return n;
        },
        one: ({ reader }, i)=>{
            reader.put(names[i & cycle], body);
        },
    },
    reserve: {
        sizes: ()=>[128 * MIB, 4 * MIB],
        run(cache){
            const n = Math.min(200_000, 2 ** 31 / body.length);
            for (let i = 0; i < n; i++)
            {
                reserveOne(cache, i);
            }
            return n;
        },
        one: (cache, i)=>reserveOne(cache, i),
    },
    hit: {
        sizes: ()=>[128 * MIB, 4 * MIB],
        run({ reader }){
            for (let i = 0; i <= cycle; i++)
            {
                reader.put(names[i], body);
            }
            const n = 1_000_000;
            let s = 0;
            for (let i = 0; i < n; i++)
            {
                s += reader.with(names[i & cycle], lengthOf) ?? 0;
            }
            if (s !== n * body.length)
            {
                throw new Error('hit: missed');
            }
            return n;
        },
        one: ({ reader }, i)=>{
            reader.with(names[i & cycle], lengthOf);
        },
    },
};

/** @param {Uint8Array} read */
const lengthOf = read=>read.length;

/** @param {Awaited<ReturnType<typeof cacheOf>>} cache @param {number} i */
function reserveOne({ reader }, i){
    const name = names[i & cycle];
    const view = reader.reserve(name, body.length);
    if (view === null)
    {
        throw new Error('reserve: refused');
    }
    view[0] = i;
    if (!reader.commit(name) || reader.with(name, lengthOf) !== body.length)
    {
        throw new Error('reserve: not read back');
    }
}

/** @param {number[]} xs */
const median = xs=>[...xs].sort((a, b)=>a - b)[xs.length >> 1];

console.log(`node ${process.version}, ${cpus()[0]?.model ?? 'cpu not recorded'} x${cpus().length},`
    + ` load ${loadavg().map(x=>x.toFixed(2)).join(' ')}, ${RUNS} runs after a warm-up`);
for (const size of BODIES)
{
    body = Uint8Array.from({ length: size }, (_, i)=>i & 255);
    cycle = Math.min(1024, (32 * MIB) / size) - 1;
    for (const [name, scenario] of Object.entries(SCENARIOS))
    {
        if (ONLY !== undefined && name !== ONLY)
        {
            continue;
        }
        const [budget, segmentBytes] = scenario.sizes(size);
        scenario.run(await cacheOf(budget, segmentBytes));
        await new Promise(resolve=>setTimeout(resolve, 10));
        const before = [collections, collectedMs];
        /** @type {number[]} */
        const ns = [];
        for (let r = 0; r < RUNS; r++)
        {
            const cache = await cacheOf(budget, segmentBytes);
            const from = process.hrtime.bigint();
            const ops = scenario.run(cache);
            ns.push(Number(process.hrtime.bigint() - from) / ops);
        }
        await new Promise(resolve=>setTimeout(resolve, 10));
        const gc = `gc ${collections - before[0]}, ${(collectedMs - before[1]).toFixed(1)} ms`;
        let bytes = 'not measured';
        const one = scenario.one;
        if (one !== undefined)
        {
            const cache = await cacheOf(budget, segmentBytes);
            scenario.run(cache);
            let i = 0;
            bytes = `${(await bytesPerCall(()=>one(cache, i++), { empty: ()=>{} })).toFixed(0)} B/op`;
        }
        console.log(`${String(size).padStart(5)} B ${name.padEnd(9)} ${median(ns).toFixed(0).padStart(6)} ns`
            + `  (${Math.min(...ns).toFixed(0)}-${Math.max(...ns).toFixed(0)})  ${gc}  ${bytes}`
            + `  [${ns.map(x=>x.toFixed(0)).join(' ')}]`);
    }
}
