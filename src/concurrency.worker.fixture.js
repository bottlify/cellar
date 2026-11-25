/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One thread of the cache's concurrency gate (`concurrency.itest.js`): reads,
 * writes and drops names of a shared pool by a seed, through a link to the
 * keeper, and checks every body it reads, in place, twice.
 *
 * A body says whose it is: its first words are its name's hash, a version and
 * its length, and every byte after them follows from those. A body read that
 * names another name, or whose bytes change between the two passes, is one
 * the keeper gave away while this thread was inside it.
 *
 * Each thread also owns names of its own (`o<thread>-<i>`), which only it
 * writes, each write one version up; every thread reads them. A version read
 * below one this thread read or wrote before is a stale record the index led
 * to: a body written over since.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { caller } from './channel.fixture.js';
import { createReader } from './reader.js';
import { hashName } from './shared.js';

const { channel, shared, segments, seed, operations, least, pool, thread, threads, owned } = workerData;
const keeper = caller(channel);
const reader = createReader({
    shared, segments,
    keeper: {
        reserve: (name, length, options)=>keeper.call('reserve', name, length, options),
        raise: (name, options)=>keeper.call('raise', name, options),
        raiseLater: name=>{
            keeper.call('raise', name);
        },
        drop: name=>{
            keeper.call('drop', name);
        },
    },
});
parentPort?.on('message', message=>reader.adopt(message));

let state = seed >>> 0 || 1;
const next = ()=>{
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
};

/** How long a reader holds a body between its two passes, in ms. */
const HOLD_MS = 0.3;

/** @param {number} a @param {number} version @param {number} i */
const byteAt = (a, version, i)=>(a + version * 7 + i * 13) & 255;

/** @param {string} name @param {Uint8Array} body */
const check = (name, body)=>{
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const [a, b] = hashName(name);
    if (view.getInt32(0, true) !== a || view.getInt32(4, true) !== b)
    {
        return `${name}: the body names another name`;
    }
    if (view.getUint32(12, true) !== body.length)
    {
        return `${name}: length ${view.getUint32(12, true)} in a body of ${body.length}`;
    }
    const version = view.getUint32(8, true);
    let sum = 0;
    for (let pass = 0; pass < 2; pass++)
    {
        let now = 0;
        for (let i = 16; i < body.length; i++)
        {
            if (body[i] !== byteAt(a, version, i))
            {
                return `${name}: byte ${i} of version ${version} changed under the reader`;
            }
            now += body[i];
        }
        if (pass === 1 && (now !== sum || view.getInt32(0, true) !== a
            || view.getUint32(8, true) !== version))
        {
            return `${name}: the body changed between two passes`;
        }
        sum = now;
        // Held a while between the passes, as a reader decoding a block holds it:
        // long enough for a keeper that took bodies being read to give the room
        // to another and for that one to be written.
        const until = performance.now() + HOLD_MS;
        while (performance.now() < until)
        {
            // Holding.
        }
    }
    return null;
};

const counts = { reads: 0, hits: 0, writes: 0, written: 0, drops: 0, ownHits: 0 };
/** @type {string[]} */
const failures = [];
/** The highest version this thread read or wrote of each owned name. @type {Map<string, number>} */
const highest = new Map();
/** The version this thread wrote last of each name of its own. @type {Map<string, number>} */
const versions = new Map();

/**
 * Writes `name`'s body of `version` into room reserved for it: true where
 * there was room.
 *
 * @param {string} name @param {number} version @param {number} length
 */
const write = (name, version, length)=>{
    const into = reader.reserve(name, length);
    if (into === null)
    {
        return false;
    }
    const [a, b] = hashName(name);
    const view = new DataView(into.buffer, into.byteOffset, into.byteLength);
    view.setInt32(0, a, true);
    view.setInt32(4, b, true);
    view.setUint32(8, version, true);
    view.setUint32(12, length, true);
    for (let i = 16; i < length; i++)
    {
        into[i] = byteAt(a, version, i);
    }
    reader.commit(name);
    return true;
};
/**
 * Whether the thread did what the gate counts on, as many times as it asks:
 * how many reads find a body hot is the machine's timing, not the code's, so
 * a thread goes on past `operations` until they did.
 */
const enough = ()=>counts.hits >= least && counts.written >= least && counts.ownHits >= least;
for (let op = 0; op < operations || !enough(); op++)
{
    if (op % 64 === 0)
    {
        // Between turns the keeper's messages arrive: segments made and let go.
        await new Promise(resolve=>setImmediate(resolve));
    }
    const roll = next() % 100;
    if ((next() & 1) === 0)
    {
        const writer = roll < 40 ? thread : next() % threads;
        const name = `o${writer}-${next() % owned}`;
        if (writer === thread && roll < 25)
        {
            const version = (versions.get(name) ?? 0) + 1;
            if (write(name, version, 16 + (next() % 4096)))
            {
                versions.set(name, version);
                highest.set(name, Math.max(highest.get(name) ?? 0, version));
            }
            continue;
        }
        let version = 0;
        const failure = reader.with(name, body=>{
            version = new DataView(body.buffer, body.byteOffset).getUint32(8, true);
            return check(name, body);
        }, { wait: (next() & 1) === 0 });
        if (failure === undefined)
        {
            continue;
        }
        counts.ownHits++;
        if (failure !== null)
        {
            failures.push(failure);
        }
        else if (version < (highest.get(name) ?? 0))
        {
            failures.push(`${name}: version ${version} read after ${highest.get(name)}`);
        }
        highest.set(name, Math.max(highest.get(name) ?? 0, version));
        continue;
    }
    const name = `n${next() % pool}`;
    if (roll < 60)
    {
        counts.reads++;
        const failure = reader.with(name, body=>check(name, body), { wait: (next() & 1) === 0 });
        if (failure !== undefined)
        {
            counts.hits++;
            if (failure !== null)
            {
                failures.push(failure);
            }
        }
    }
    else if (roll < 92)
    {
        counts.writes++;
        if (write(name, next(), 16 + (next() % (12 * 1024))))
        {
            counts.written++;
        }
    }
    else
    {
        counts.drops++;
        reader.drop(name);
    }
}
parentPort?.postMessage({ done: true, counts, failures: failures.slice(0, 20),
    failed: failures.length, reader: reader.figures() });
