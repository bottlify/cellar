/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Bodies over a quarter of a segment, each in a segment of its own sized to
 * it: placed and read in place on another thread, cooled to the disk and
 * read back, held and let go of, counted at their size, refused visibly when
 * the budget has no room, and their segments gone with them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { UNIT } from './buddy.js';
import { cacheOf } from './cache.fixture.js';
import { channelMemory, serve } from './channel.fixture.js';
import { memoryDisk } from './disk.fixture.js';

const MIB = 1024 * 1024;
/** The run's own: segments of 16 MiB, so a body over 4 MiB has a segment of its own. */
const RUN = { budget: 64 * MIB, segmentBytes: 16 * MIB };

/** @param {number} length @param {number} seed */
const pattern = (length, seed)=>{
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++)
    {
        bytes[i] = (i * 31 + seed + (i >>> 12)) & 255;
    }
    return bytes;
};

/** What the worker answers of a body: its length, its sum, whether it is shared memory. @param {Uint8Array} body */
const summed = body=>{
    let sum = 0;
    for (let i = 0; i < body.length; i += 4093)
    {
        sum = (sum + body[i] * (i + 1)) % 0x7fffffff;
    }
    return { length: body.length, sum, shared: true };
};

/**
 * A thread reading `cache`'s keeper, joined now, told of what the keeper
 * announces from now on: `read(name, wait)` answers what it found.
 *
 * @param {Awaited<ReturnType<typeof runCache>>} cache
 */
const thread = cache=>{
    const memory = channelMemory();
    const link = serve(memory, {
        reserve: (name, length, options)=>cache.keeper.reserve(name, length, options ?? {}),
        raise: (name, options)=>cache.keeper.raise(name, options ?? {}),
    });
    const worker = new Worker(new URL('./large.worker.fixture.js', import.meta.url), {
        workerData: { channel: memory, shared: cache.keeper.shared, segments: cache.keeper.segmentBuffers() },
    });
    cache.heard.add(message=>worker.postMessage(message));
    return {
        /** @param {string} name @param {boolean} [wait] @returns {Promise<{ found: any, hits: number }>} */
        read: (name, wait = false)=>new Promise((resolve, reject)=>{
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.postMessage({ read: name, wait });
        }),
        end: async()=>{
            link.stop();
            await worker.terminate();
        },
    };
};

/** @param {Partial<import('./keeper.js').KeeperOptions>} options */
const runCache = async options=>{
    /** @type {Set<(message: any) => void>} */
    const heard = new Set();
    /** @type {import('./reader.js').Reader | null} */
    let reader = null;
    const cache = await cacheOf({ ...RUN, ...options, announce: message=>{
        reader?.adopt(message);
        for (const tell of heard)
        {
            tell(message);
        }
    } });
    reader = cache.reader;
    return Object.assign(cache, { heard });
};

test('a body of 40 MiB is read in place on another thread, cooled to the disk and read back', async()=>{
    const cache = await runCache({ disk: memoryDisk(), coldAfterMs: 100 });
    const other = thread(cache);
    try
    {
        const bytes = pattern(40 * MIB, 7);
        assert.equal(cache.reader.put('big', bytes), true);
        assert.deepEqual((await other.read('big')).found, summed(bytes), 'read where it lies');
        const placed = cache.keeper.figures();
        assert.equal(placed.segmentBytes, 16 * MIB + 40 * MIB, 'a shared segment and its own');
        assert.equal(placed.placedBytes, 40 * MIB);
        cache.step(100);
        assert.equal(cache.reader.look('big'), 'cold');
        const cooled = cache.keeper.figures();
        assert.equal(cooled.segmentBytes, 16 * MIB, 'its segment went with it');
        assert.equal(cooled.writtenBytes, 40 * MIB);
        assert.deepEqual((await other.read('big', true)).found, summed(bytes), 'raised by the thread');
        assert.equal(cache.keeper.figures().raised, 1);
        assert.equal(cache.reader.with('big', body=>body.every((byte, i)=>byte === bytes[i])), true);
    }
    finally
    {
        await other.end();
    }
});

test('a thread joining after a large body was placed reads it', async()=>{
    const cache = await runCache({});
    const bytes = pattern(20 * MIB + 5, 3);
    assert.equal(cache.reader.put('big', bytes), true);
    const late = thread(cache);
    try
    {
        assert.deepEqual((await late.read('big')).found, summed(bytes));
        // The next large body, in the spare own segment it was told of as it joined.
        const next = pattern(6 * MIB, 4);
        assert.equal(cache.reader.put('next', next), true);
        assert.deepEqual((await late.read('next')).found, summed(next));
    }
    finally
    {
        await late.end();
    }
});

test('memory of 20 MiB is held, written in place, and its segment goes the moment it is released',
    async()=>{
        const { keeper, reader } = await runCache({});
        const held = reader.hold('owner/1/frame', 20 * MIB);
        assert.ok(held);
        assert.equal(held.length, 20 * MIB);
        held.set(pattern(20 * MIB, 9));
        assert.equal(held[20 * MIB - 1], pattern(20 * MIB, 9)[20 * MIB - 1], 'read back in place');
        const holding = keeper.figures();
        assert.equal(holding.segments, 2);
        assert.equal(holding.segmentBytes, 36 * MIB);
        assert.deepEqual(keeper.release('owner/1/'), { bodies: 1, bytes: 20 * MIB, waiting: 0 });
        const after = keeper.figures();
        assert.equal(after.segments, 1, 'no sweep between');
        assert.equal(after.segmentBytes, 16 * MIB);
        assert.equal(after.letGoBytes - holding.letGoBytes, 20 * MIB);
        assert.equal(after.peakSegmentBytes, 36 * MIB);
    });

test('a large hold is counted at its length rounded to a page, not to a power of two', async()=>{
    const { keeper, reader } = await runCache({});
    assert.ok(reader.hold('owner/1/texture', 5 * MIB + 100));
    const weighed = keeper.under('owner/1/');
    assert.equal(weighed.placedBytes, 5 * MIB + UNIT);
    assert.equal(keeper.figures().placedBytes, 5 * MIB + UNIT);
    assert.equal(keeper.figures().roundingBytes, UNIT - 100);
    // At a quarter of a segment and below, a block of the buddy as before.
    assert.ok(reader.hold('owner/1/small', 4 * MIB));
    assert.equal(keeper.under('owner/1/').placedBytes, 9 * MIB + UNIT);
});

test('large bodies over a small budget: the old ones make room, holds past it are refused and said'
    + ' so, and the segments are back to the spare once they go', async()=>{
    const { keeper, reader } = await runCache({});
    for (let i = 0; i < 10; i++)
    {
        assert.equal(reader.put(`body${i}`, pattern(20 * MIB, i)), true, `body${i}`);
    }
    // The shared spare is kept for small bodies: 48 MiB of the 64 for large ones.
    assert.equal(keeper.figures().gone, 8, 'two of 20 MiB beside the spare, the rest made room');
    assert.ok(keeper.figures().segmentBytes <= 64 * MIB);
    assert.equal(reader.with('body9', body=>body[12345]), pattern(20 * MIB, 9)[12345]);
    /** @type {(Uint8Array | null)[]} */
    const holds = [];
    for (let i = 0; i < 5; i++)
    {
        holds.push(reader.hold(`owner/1/${i}`, 20 * MIB));
    }
    assert.equal(holds.filter(Boolean).length, 2, 'two of 20 MiB beside the spare');
    assert.equal(keeper.figures().refusedRoom, 3, 'the rest refused, counted');
    assert.equal(reader.look('body9'), null, 'bodies that can be made again made room for them');
    assert.ok(keeper.figures().segmentBytes <= 64 * MIB);
    keeper.release('owner/1/');
    for (let i = 0; i < 10; i++)
    {
        keeper.drop(`body${i}`);
    }
    const left = keeper.figures();
    assert.equal(left.placedBytes, 0);
    assert.equal(left.hot + left.cold, 0);
    assert.equal(left.segments, 1, 'the shared spare alone');
    assert.equal(left.segmentBytes, 16 * MIB);
    assert.equal(reader.put('small', pattern(UNIT, 1)), true, 'a small body in the spare');
});
