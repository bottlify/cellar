/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Room made for a body only where it can be made: no body leaves for a
 * request that cannot be placed once it has gone, and one that could be
 * placed without any leaving is. Each case is one the dev audit found
 * destroying bodies for nothing, beside the case where leaving does make
 * the room.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheOf } from './cache.fixture.js';
import { createAccountMemory, openAccount } from './account.js';
import { reserveFlags } from './shared.js';

const ONLY = reserveFlags({ onlyCopy: true });
const KIB = 1024;

/** @param {number} length @param {number} [fill] */
const bytes = (length, fill = 1)=>new Uint8Array(length).fill(fill);

test('a body written anew that finds no room keeps its old one: the tail of its block is another\'s',
    async()=>{
    // a takes 1025 bytes of a 2048 block, b the 512 left past it.
    const { reader, keeper } = await cacheOf({ budget: 4 * KIB, segmentBytes: 64 * KIB });
    assert.equal(reader.put('a', bytes(1025)), true);
    assert.equal(reader.put('b', bytes(512), ONLY), true);
    assert.equal(reader.put('c', bytes(2048), ONLY), true);
    const placed = keeper.figures().placedBytes;
    assert.equal(reader.put('a', bytes(2048, 2), ONLY), false, 'no room: b and c cannot leave');
    assert.equal(reader.look('a'), 'hot', 'the old body is the name\'s still');
    assert.equal(keeper.figures().placedBytes, placed);
});

test('a body no block can be made for moves nothing: the tail of the oldest body\'s block is '
    + 'another\'s', async()=>{
    const { reader, keeper } = await cacheOf({ budget: 4 * KIB, segmentBytes: 64 * KIB });
    reader.put('a', bytes(1025));
    reader.put('b', bytes(512), ONLY);
    reader.put('c', bytes(2048), ONLY);
    assert.equal(reader.put('d', bytes(2048)), false);
    assert.equal(reader.look('a'), 'hot', 'a stays: its going would make no block');
    assert.equal(keeper.figures().placedBytes, 4096);
});

test('a body larger than the budget is refused before any body leaves for it', async()=>{
    const { reader, keeper } = await cacheOf({ budget: 4 * KIB, segmentBytes: 64 * KIB });
    assert.equal(reader.put('a', bytes(4096)), true);
    assert.equal(reader.put('b', bytes(8192)), false);
    assert.equal(reader.look('a'), 'hot');
    assert.equal(keeper.figures().placedBytes, 4096);
});

test('room asked of the cache for what the account could not hold were every body gone moves none',
    async()=>{
    const memory = createAccountMemory({ limit: 64 * KIB, kinds: { cache: Infinity, guest: Infinity } });
    const { keeper, reader } = await cacheOf({ account: memory });
    const guest = openAccount(memory, { room: bytes=>keeper.makeRoom(bytes) });
    assert.equal(guest.take(32 * KIB, 'guest'), true);
    for (let n = 0; n < 4; n++)
    {
        assert.equal(reader.put(`b/${n}`, bytes(4096, n)), true);
    }
    // 32 KiB taken, 4 bodies in a 16 KiB reach: 48 KiB more never fits, all of them gone.
    assert.equal(guest.take(48 * KIB, 'guest'), false);
    assert.equal(guest.take(128 * KIB, 'guest'), false, 'past the limit itself');
    assert.deepEqual([0, 1, 2, 3].map(n=>reader.look(`b/${n}`)), ['hot', 'hot', 'hot', 'hot']);
    assert.equal(guest.take(32 * KIB, 'guest'), true, 'where the bodies going makes room, they go');
});

test('memory held that cannot leave is no room: a body that fits only were it gone moves nothing',
    async()=>{
    // An own segment's body: 12 KiB of budget, 4 KiB held.
    const own = await cacheOf({ budget: 12 * KIB, segmentBytes: 4 * KIB });
    assert.ok(own.reader.hold('held', 4096));
    assert.equal(own.reader.put('a', bytes(8192)), true);
    assert.equal(own.reader.put('b', bytes(12288)), false);
    assert.equal(own.reader.look('a'), 'hot', 'a stays: with it gone b still would not fit');
    // A shared segment's bodies: 24 KiB of budget, 16 KiB held.
    const shared = await cacheOf({ budget: 24 * KIB, segmentBytes: 64 * KIB });
    assert.ok(shared.reader.hold('held', 16384));
    assert.equal(shared.reader.put('a', bytes(4096)), true);
    assert.equal(shared.reader.put('b', bytes(4096)), true);
    assert.equal(shared.reader.put('c', bytes(16384)), false);
    assert.deepEqual([shared.reader.look('a'), shared.reader.look('b')], ['hot', 'hot']);
    // Where the bodies going does make the room, they go.
    assert.equal(shared.reader.put('d', bytes(8192)), true);
    assert.deepEqual([shared.reader.look('a'), shared.reader.look('b')], [null, null]);
});

test('a body written anew in the room of its old one moves no other body', async()=>{
    const { reader, keeper } = await cacheOf({ budget: 8 * KIB, segmentBytes: 16 * KIB });
    reader.put('a', bytes(4096));
    reader.put('b', bytes(4096));
    assert.equal(reader.put('a', bytes(4096, 3)), true);
    assert.equal(reader.look('b'), 'hot', 'b stays');
    assert.equal(keeper.figures().placedBytes, 8192);
    assert.equal(reader.with('a', body=>body[0]), 3);
});

test('a body for a segment the writer has not heard of yet moves nothing: it is refused unseen',
    async()=>{
    const { keeper, reader } = await cacheOf({ budget: 64 * KIB, segmentBytes: 16 * KIB });
    assert.equal(reader.put('small', bytes(512)), true);
    const place = new Int32Array(8);
    // A writer that knows only the first two segments: own segments past them.
    assert.equal(keeper.reserve('big', 8192, 0, 2, place), false);
    assert.equal(reader.look('small'), 'hot');
    assert.equal(keeper.figures().refusedUnseen, 1);
});

test('an own segment the engine would not make once is made again when a large body asks for one',
    async()=>{
    const Real = SharedArrayBuffer;
    let refuse = 0;
    /** @type {any} */ (globalThis).SharedArrayBuffer = new Proxy(Real, { construct(target, args){
        if (args[1]?.maxByteLength !== undefined && args[0] === 0 && refuse-- > 0)
        {
            throw new RangeError('no address space');
        }
        return Reflect.construct(target, args);
    } });
    try
    {
        refuse = 1;
        const { keeper, reader } = await cacheOf({ budget: 64 * KIB, segmentBytes: 16 * KIB });
        assert.ok(keeper.figures().segmentFailures >= 1);
        assert.ok(reader.put('first', bytes(8192)) || reader.put('second', bytes(8192)),
            'a large body is placed once its segment is made again and heard of');
    }
    finally
    {
        /** @type {any} */ (globalThis).SharedArrayBuffer = Real;
    }
});
