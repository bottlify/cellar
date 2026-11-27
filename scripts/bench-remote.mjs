/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a reserve costs through the remote keeper, the keeper on this thread
 * and the reader's calls from a worker, against the keeper called here:
 *
 *   local           `keeper.reserve` on the keeper's thread
 *   channel         a blocking ask over a channel served on the event loop
 *   channel async   `reserveLater`, each awaited before the next
 *   link            a blocking ask over a link served on the event loop
 *
 * Each round reserves `ops` names of 256 bytes, then lets them all go; the
 * first round is a warm-up. Printed: µs a reserve, the median of the rounds,
 * the lowest and highest, and the bytes allocated a reserve on each thread
 * (the heap's growth over a round, with a young generation large enough that
 * no collection runs in it).
 *
 *   node --expose-gc --max-semi-space-size=128 scripts/bench-remote.mjs [rounds] [ops] [arm]
 */

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createChannel, openClient } from '../src/channel.js';
import { openKeeper } from '../src/keeper.js';
import { createLinkMemory, openLink } from '../src/link.js';
import { answerKeeper, keeperWords, linkCarrier, openKeeperClient, serveKeeperChannel } from '../src/remote.js';

const BODY = 256;

/** @param {number[]} values */
const spread = values=>{
    const sorted = [...values].sort((a, b)=>a - b);
    return { median: sorted[sorted.length >> 1] ?? NaN, low: sorted[0] ?? NaN, high: sorted.at(-1) ?? NaN };
};
const heap = ()=>{
    /** @type {any} */ (globalThis).gc?.();
    return process.memoryUsage().heapUsed;
};

if (isMainThread)
{
    const ROUNDS = Number(process.argv[2] ?? 9);
    const OPS = Number(process.argv[3] ?? 3000);
    const ONLY = process.argv[4];
    if (typeof /** @type {any} */ (globalThis).gc !== 'function')
    {
        throw new Error('run with --expose-gc --max-semi-space-size=128');
    }
    const keeper = await openKeeper({ budget: 64 << 20, segmentBytes: 16 << 20, disk: null });
    const names = Array.from({ length: OPS }, (_, n)=>`r/${n}`);
    const answer = answerKeeper({ keeper });
    /** @type {Record<string, () => Promise<{ us: number[], worker: number[], keeper: number[] }>>} */
    const arms = {
        async local(){
            const us = [];
            const bytes = [];
            for (let round = 0; round <= ROUNDS; round++)
            {
                const before = heap();
                const start = performance.now();
                for (const name of names)
                {
                    keeper.reserve(name, BODY, { known: 1 });
                }
                const took = performance.now() - start;
                const grew = process.memoryUsage().heapUsed - before;
                keeper.release('r/');
                if (round > 0)
                {
                    us.push(took * 1000 / OPS);
                    bytes.push(grew / OPS);
                }
            }
            return { us, worker: [], keeper: bytes };
        },
        channel: ()=>across('channel'),
        'channel async': ()=>across('async'),
        link: ()=>across('link'),
    };
    /**
     * @param {'channel' | 'async' | 'link'} carrier
     */
    async function across(carrier){
        const memory = carrier === 'link' ? createLinkMemory({ capacity: 1 << 16, words: 64, slots: 4 }) : createChannel();
        /** @type {any} */
        let serving;
        if (carrier === 'link')
        {
            serving = openLink(/** @type {any} */ (memory).a, {}, { words: keeperWords(answer) });
            serving.serve();
        }
        else
        {
            serving = serveKeeperChannel(/** @type {SharedArrayBuffer} */ (memory), answer);
        }
        const worker = new Worker(new URL(import.meta.url), { workerData: { carrier, memory: carrier === 'link'
            ? /** @type {any} */ (memory).b : memory, names, rounds: ROUNDS } });
        const us = [];
        const workerBytes = [];
        const keeperBytes = [];
        const next = ()=>/** @type {Promise<any>} */ (new Promise((resolve, reject)=>{
            worker.once('message', resolve);
            worker.once('error', reject);
        }));
        for (let round = 0; round <= ROUNDS; round++)
        {
            const before = heap();
            const done = next();
            worker.postMessage('go');
            const said = await done;
            const grew = process.memoryUsage().heapUsed - before;
            keeper.release('r/');
            if (round > 0)
            {
                us.push(said.us);
                workerBytes.push(said.bytes);
                keeperBytes.push(grew / OPS);
            }
        }
        await worker.terminate();
        serving.close();
        return { us, worker: workerBytes, keeper: keeperBytes };
    }
    console.log(`reserve of ${BODY} B, ${OPS} a round, ${ROUNDS} rounds after a warm-up; node ${process.version}`);
    for (const [arm, run] of Object.entries(arms))
    {
        if (ONLY && arm !== ONLY)
        {
            continue;
        }
        const { us, worker, keeper: kept } = await run();
        const time = spread(us);
        const f = (/** @type {number} */ n)=>n.toFixed(2);
        console.log(`${arm.padEnd(14)} ${f(time.median)} µs (${f(time.low)}-${f(time.high)})`
            + `  allocated a reserve: worker ${worker.length ? Math.round(spread(worker).median) : '-'} B,`
            + ` keeper ${Math.round(spread(kept).median)} B   raw µs: ${us.map(f).join(' ')}`);
    }
    keeper.close();
}
else
{
    const { carrier, memory, names } = workerData;
    /** @type {import('../src/remote.js').KeeperClient} */
    let client;
    if (carrier === 'link')
    {
        const link = openLink(memory);
        link.serve();
        client = openKeeperClient(linkCarrier(link));
    }
    else
    {
        client = openKeeperClient(openClient(memory));
    }
    const options = { onlyCopy: false, known: 1 };
    const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort);
    port.on('message', async()=>{
        const before = heap();
        const start = performance.now();
        if (carrier === 'async')
        {
            for (const name of names)
            {
                await client.reserveLater(name, BODY, options);
            }
        }
        else
        {
            for (const name of names)
            {
                client.keeper.reserve(name, BODY, options);
            }
        }
        const took = performance.now() - start;
        const grew = process.memoryUsage().heapUsed - before;
        port.postMessage({ us: took * 1000 / names.length, bytes: grew / names.length });
    });
}
