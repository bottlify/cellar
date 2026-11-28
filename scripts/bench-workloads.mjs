/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The speed gate's workloads (`bench-gate.mjs`): what each primitive costs an
 * operation, measured on the tree at `root` - this one, or the reference the
 * gate holds it to. Each workload is its own number, warmed up and timed
 * `RUNS` times in this process, the median printed: the gate weighs each
 * against the same workload of the reference, none against a sum.
 *
 *   node scripts/bench-workloads.mjs <root> [workload, ...]
 *
 * Prints one JSON object: ns an operation by workload.
 */

import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

const root = pathToFileURL(`${process.argv[2] ?? new URL('..', import.meta.url).pathname}/`).href;
const only = new Set(process.argv.slice(3));
const lib = await import(`${root}src/index.js`);
const RUNS = 5;

/**
 * The median ns an operation of `step` over `count` operations, after a
 * warm-up of as many.
 *
 * @param {number} count @param {(i: number) => void} step
 */
const timed = (count, step)=>{
    for (let i = 0; i < count; i++)
    {
        step(i);
    }
    const runs = [];
    for (let run = 0; run < RUNS; run++)
    {
        const started = performance.now();
        for (let i = 0; i < count; i++)
        {
            step(i);
        }
        runs.push((performance.now() - started) * 1e6 / count);
    }
    return runs.sort((a, b)=>a - b)[RUNS >> 1];
};

/** @param {any} keeper */
const directCalls = keeper=>({
    reserve: keeper.reserve,
    raise: (/** @type {string} */ name)=>keeper.raise(name),
    raiseLater: (/** @type {string} */ name)=>{
        keeper.raise(name);
    },
    drop: (/** @type {string} */ name)=>{
        keeper.drop(name);
    },
});

/** A keeper and its reader in this thread. @param {number} budget @param {number} segmentBytes */
const cacheOf = async(budget, segmentBytes)=>{
    /** @type {any} */
    let reader = null;
    const keeper = await lib.openKeeper({ budget, segmentBytes, disk: null,
        announce: (/** @type {any} */ message)=>reader?.adopt(message) });
    reader = lib.createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: directCalls(keeper) });
    return { keeper, reader };
};

/** A worker over `root`'s library, running `body` with `lib` and `workerData`. @param {string} body @param {any} data */
const workerOf = (body, data)=>new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    import(workerData.root + 'src/index.js').then(lib=>{ ${body} });`,
{ eval: true, workerData: { root, ...data } });

/** @type {Record<string, () => Promise<number> | number>} */
const workloads = {
    // A body put under names never written, into a cache with room.
    'cache put new 256 B': async()=>{
        const { keeper, reader } = await cacheOf(256 << 20, 1 << 20);
        const body = new Uint8Array(256);
        let n = 0;
        const ns = timed(20000, ()=>reader.put(`new/${n++}`, body));
        keeper.close();
        return ns;
    },
    // The same names written again and again: the body replaced.
    'cache put over 256 B': async()=>{
        const { keeper, reader } = await cacheOf(64 << 20, 1 << 20);
        const body = new Uint8Array(256);
        const ns = timed(50000, i=>reader.put(`over/${i & 1023}`, body));
        keeper.close();
        return ns;
    },
    'cache put over 64 KiB': async()=>{
        const { keeper, reader } = await cacheOf(256 << 20, 1 << 20);
        const body = new Uint8Array(65536);
        const ns = timed(5000, i=>reader.put(`over/${i & 255}`, body));
        keeper.close();
        return ns;
    },
    // More names than the budget holds: every put makes a body leave.
    'cache put full 4 KiB': async()=>{
        const { keeper, reader } = await cacheOf(4 << 20, 1 << 20);
        const body = new Uint8Array(4096);
        const ns = timed(20000, i=>reader.put(`full/${i & 4095}`, body));
        keeper.close();
        return ns;
    },
    // A reservation written in place, committed and read back.
    'cache reserve 256 B': async()=>{
        const { keeper, reader } = await cacheOf(64 << 20, 1 << 20);
        const first = (/** @type {Uint8Array} */ body)=>body[0];
        const ns = timed(50000, i=>{
            const name = `reserve/${i & 1023}`;
            const into = reader.reserve(name, 256);
            into[0] = i;
            reader.commit(name);
            reader.with(name, first);
        });
        keeper.close();
        return ns;
    },
    'cache hit 256 B': async()=>{
        const { keeper, reader } = await cacheOf(64 << 20, 1 << 20);
        const body = new Uint8Array(256);
        for (let i = 0; i < 1024; i++)
        {
            reader.put(`hit/${i}`, body);
        }
        const names = Array.from({ length: 1024 }, (_, i)=>`hit/${i}`);
        const first = (/** @type {Uint8Array} */ b)=>b[0];
        const ns = timed(1_000_000, i=>reader.with(names[i & 1023], first));
        keeper.close();
        return ns;
    },
    'cache hit 64 KiB': async()=>{
        const { keeper, reader } = await cacheOf(256 << 20, 1 << 20);
        const body = new Uint8Array(65536);
        for (let i = 0; i < 256; i++)
        {
            reader.put(`hit/${i}`, body);
        }
        const names = Array.from({ length: 256 }, (_, i)=>`hit/${i}`);
        const first = (/** @type {Uint8Array} */ b)=>b[0];
        const ns = timed(1_000_000, i=>reader.with(names[i & 255], first));
        keeper.close();
        return ns;
    },
    'journal commit 16 B': ()=>{
        const journal = lib.openJournal(lib.createJournalMemory({ records: 4096, bytes: 1 << 20 }));
        return timed(1_000_000, i=>{
            const draft = journal.draft(16);
            draft.setUint32(0, i, true);
            draft.setFloat64(8, i, true);
            journal.commit();
        });
    },
    'journal read 16 B': ()=>{
        const journal = lib.openJournal(lib.createJournalMemory({ records: 4096, bytes: 1 << 20 }));
        for (let i = 0; i < 4096; i++)
        {
            journal.draft(16).setFloat64(8, i, true);
            journal.commit();
        }
        const end = journal.written();
        const take = (/** @type {DataView} */ view)=>view.getFloat64(8, true);
        let sum = 0;
        const ns = timed(1_000_000, i=>{
            sum += journal.read((end - 1 - (i & 1023)) >>> 0, take) ?? 0;
        });
        return sum < 0 ? NaN : ns;
    },
    // A record written and drained in one thread: the ring's own work, no wait.
    'ring write and drain 64 B': ()=>{
        const ring = lib.openRing(lib.createRingMemory(1 << 16));
        const record = new Uint8Array(64);
        let sum = 0;
        const take = (/** @type {Uint8Array} */ bytes)=>{
            sum += bytes[0];
        };
        const ns = timed(1_000_000, i=>{
            record[0] = i;
            ring.write(record);
            ring.drain(take);
        });
        return sum < 0 ? NaN : ns;
    },
    'table add counting': ()=>{
        const table = lib.openTable(lib.createTableMemory({ rows: 8, columns: ['bytes', 'writes'],
            counting: ['bytes', 'writes'] }));
        return timed(5_000_000, i=>{
            table.add(i & 7, 0, 4);
            table.add(i & 7, 1, 1);
        });
    },
    'table add wide': ()=>{
        const table = lib.openTable(lib.createTableMemory({ rows: 8, columns: ['level'] }));
        return timed(1_000_000, i=>table.add(i & 7, 0, (i & 1) === 0 ? 3 : -3));
    },
    'account take and give': ()=>{
        const account = lib.openAccount(lib.createAccountMemory({ limit: 1 << 30, kinds: { guest: 1 << 30 } }));
        return timed(1_000_000, ()=>{
            account.take(4096, 'guest');
            account.give(4096, 'guest');
        });
    },
    // A blocking ask of a server in a worker, answered from its slot.
    'channel ask round trip': async()=>{
        const memory = lib.createChannel({ slots: 4, slotBytes: 64 });
        const server = workerOf(`
            const server = lib.openServer(workerData.memory);
            const answer = new Uint8Array(1);
            for (;;) {
                try { server.serve(request=>{ answer[0] = request[0]; return answer; }, { timeoutMs: 1000 }); }
                catch (e) { if (e instanceof lib.ChannelClosed) break; throw e; }
            }`, { memory });
        const client = lib.openClient(memory);
        const request = new Uint8Array(1);
        const ns = timed(100_000, i=>{
            request[0] = i;
            client.ask(request);
        });
        client.close();
        await server.terminate();
        return ns;
    },
    // A blocking ask of a link whose other side answers in its worker.
    'link ask round trip': async()=>{
        const { a, b } = lib.createLinkMemory({ capacity: 1 << 16 });
        const server = workerOf(`
            const link = lib.openLink(workerData.end, { echo: { back: value=>value } });
            parentPort.postMessage('ready');
            link.serve();`, { end: a });
        await new Promise(resolve=>server.once('message', resolve));
        const link = lib.openLink(b, {});
        const ns = timed(50_000, i=>link.ask('echo', 'back', [i]));
        await server.terminate();
        return ns;
    },
};

/** @type {Record<string, number>} */
const measured = {};
for (const [name, workload] of Object.entries(workloads))
{
    if (only.size === 0 || only.has(name))
    {
        measured[name] = await workload();
    }
}
process.stdout.write(`${JSON.stringify(measured)}\n`);
process.exit(0);
