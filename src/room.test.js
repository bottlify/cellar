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
import { fixedViewsDisk } from './disk.fixture.js';
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

test('a body of its own segment written anew takes that segment where it needs its pages, and moves'
    + ' no other body', async()=>{
    for (const length of [8192, 6000])
    {
        const { reader, keeper } = await cacheOf({ budget: 16 * KIB, segmentBytes: 4 * KIB });
        reader.put('a', bytes(8192, 1));
        reader.put('b', bytes(8192, 2));
        assert.equal(reader.put('a', bytes(length, 9)), true, `${length}`);
        assert.equal(reader.look('b'), 'hot', `b stays for ${length}`);
        assert.deepEqual(reader.with('a', body=>[body.length, body[0], body[length - 1]]), [length, 9, 9]);
        assert.deepEqual(reader.with('b', body=>[body.length, body[0]]), [8192, 2]);
        const figures = keeper.figures();
        assert.equal(figures.placedBytes, 16384, 'its pages held, the rest of them rounding');
        assert.equal(figures.roundingBytes, 8192 - length);
    }
    // Fewer pages are placed afresh: the segment would hold pages past its
    // body. Beside an only copy with nowhere to go, the old body stays.
    const { reader } = await cacheOf({ budget: 16 * KIB, segmentBytes: 4 * KIB });
    reader.put('a', bytes(8192, 1));
    reader.put('b', bytes(8192, 2), ONLY);
    assert.equal(reader.put('a', bytes(4096, 9)), false);
    assert.deepEqual(reader.with('a', body=>[body.length, body[0]]), [8192, 1], 'a as it was');
    assert.equal(reader.look('b'), 'hot');
});

test('a body of its own segment written anew larger grows its segment where the budget has the'
    + ' pages, and moves nothing where it has not', async()=>{
    const { reader, keeper } = await cacheOf({ budget: 24 * KIB, segmentBytes: 4 * KIB });
    reader.put('a', bytes(8192, 1), ONLY);
    reader.put('b', bytes(8192, 2));
    assert.equal(reader.put('a', bytes(12288, 9), ONLY), true, 'the budget grows it by 4 KiB');
    assert.equal(reader.look('b'), 'hot');
    assert.equal(keeper.figures().placedBytes, 20480);
    // a an only copy with no disk to go to: nothing can leave for b.
    assert.equal(reader.put('b', bytes(16384, 3)), false, 'past the budget');
    assert.deepEqual(reader.with('b', body=>[body.length, body[0]]), [8192, 2], 'b as it was');
    assert.deepEqual(reader.with('a', body=>[body.length, body[0]]), [12288, 9]);
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

test('large memory held with no own segment to be had moves nothing, and is had once one is', async()=>{
    const Real = SharedArrayBuffer;
    let refuse = 1;
    /** @type {any} */ (globalThis).SharedArrayBuffer = new Proxy(Real, { construct(target, args){
        if (args[1]?.maxByteLength !== undefined && args[0] === 0 && refuse-- > 0)
        {
            throw new RangeError('no address space');
        }
        return Reflect.construct(target, args);
    } });
    try
    {
        const { keeper, reader } = await cacheOf({ budget: 64 * KIB, segmentBytes: 16 * KIB });
        assert.ok(keeper.figures().segmentFailures >= 1);
        assert.equal(reader.put('small', bytes(4096)), true);
        assert.equal(reader.hold('held', 8192), null, 'no segment of its own yet');
        assert.equal(reader.look('small'), 'hot', 'and nothing went for it');
        assert.ok(reader.hold('held', 8192) ?? reader.hold('held', 8192),
            'held once its segment is made again and heard of');
        assert.equal(reader.look('small'), 'hot');
    }
    finally
    {
        /** @type {any} */ (globalThis).SharedArrayBuffer = Real;
    }
});

test('a body of its own segment goes to a disk that takes only views of fixed memory, and comes back',
    async()=>{
    const { reader, keeper, step } = await cacheOf({ budget: 256 * KIB, segmentBytes: 64 * KIB,
        disk: fixedViewsDisk() });
    const body = Uint8Array.from({ length: 40000 }, (_, i)=>i * 7);
    assert.equal(reader.put('big', body, ONLY), true);
    assert.equal(reader.put('small', bytes(5000, 9), ONLY), true);
    step(200);
    step(200);
    assert.deepEqual([reader.look('big'), reader.look('small')], ['cold', 'cold']);
    assert.equal(keeper.figures().diskFailures, 0);
    assert.equal(keeper.raise('big'), true);
    assert.deepEqual(reader.with('big', read=>read.slice()), body);
});

test('a body moved from one pack to another passes through memory of a fixed bound, not its own length',
    async()=>{
    // A pack mostly dead: a cold only copy of 1.5 MiB in it is moved to the
    // next pack by the sweep, read and written through the keeper's memory.
    const MIB = 1024 * KIB;
    const { reader, keeper, step } = await cacheOf({ budget: 16 * MIB, segmentBytes: MIB,
        disk: fixedViewsDisk(), packBytes: 8 * MIB });
    const body = Uint8Array.from({ length: 1.5 * MIB }, (_, i)=>i * 13);
    assert.equal(reader.put('dead', bytes(6.5 * MIB)), true);
    assert.equal(reader.put('big', body, ONLY), true);
    step(200);
    step(200);
    assert.deepEqual([reader.look('dead'), reader.look('big')], ['cold', 'cold']);
    // The next pack opens behind a promise, as on OPFS.
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.equal(reader.put('next', bytes(MIB, 4)), true, 'the next pack');
    step(200);
    step(200);
    assert.equal(reader.look('next'), 'cold');
    reader.drop('dead');
    const moved = keeper.figures().compactedBytes;
    step(200);
    assert.ok(keeper.figures().compactedBytes > moved, 'the sweep moved the only copy');
    assert.ok(keeper.figures().ioScratchBytes <= MIB, `${keeper.figures().ioScratchBytes} bytes`);
    assert.equal(keeper.raise('big'), true);
    assert.deepEqual(reader.with('big', read=>read.slice()), body);
});

test('a body of its own segment cut short on the disk is no body there: it stays, and once saved '
    + 'whole a keeper opened again reads it back', async()=>{
    // 2.5 MiB, written in pieces of at most 1 MiB; the second piece cut in half.
    const MIB = 1024 * KIB;
    const inner = fixedViewsDisk();
    let cut = false;
    let pieces = 0;
    /** @type {import('./keeper.js').Disk} */
    const disk = {
        ...inner,
        async open(name){
            const file = await inner.open(name);
            return { ...file, write(view, where){
                if (cut && name.startsWith('pack') && ++pieces === 2)
                {
                    return file.write(view.subarray(0, view.length >> 1), where);
                }
                return file.write(view, where);
            } };
        },
    };
    const body = Uint8Array.from({ length: 2.5 * MIB }, (_, i)=>i * 17 + (i >> 12));
    const first = await cacheOf({ budget: 16 * MIB, segmentBytes: MIB, disk });
    cut = true;
    assert.equal(first.reader.put('big', body, ONLY), true);
    first.step(200);
    first.step(200);
    assert.equal(first.reader.look('big'), 'hot', 'an only copy the disk did not take whole stays');
    assert.ok(first.keeper.figures().diskFailures > 0, 'the cut said');
    cut = false;
    // The pack the cut body was refused by is left; the next opens behind a promise.
    for (let tries = 0; tries < 10 && first.reader.look('big') === 'hot'; tries++)
    {
        await new Promise(resolve=>setTimeout(resolve, 0));
        first.step(200);
    }
    assert.equal(first.reader.look('big'), 'cold', 'written whole once the disk takes it');
    assert.equal(first.keeper.save(), true);
    first.keeper.close();
    const second = await cacheOf({ budget: 16 * MIB, segmentBytes: MIB, disk });
    assert.deepEqual(second.reader.with('big', read=>read.slice(), { wait: true }), body,
        'read back whole by a keeper opened again');
});

test('the room lists of the shared segments are counted beside their memory, nine bytes a grain', async()=>{
    // The four spare shared segments a keeper announces ahead (two of bodies,
    // two of held memory) hold no memory and still have their lists.
    const { keeper, reader } = await cacheOf({ budget: 256 * KIB, segmentBytes: 64 * KIB });
    const grains = 64 * KIB / 512;
    const each = grains * 9 + 2 * 4 * (Math.log2(grains) + 1);
    assert.equal(keeper.figures().metadataBytes, 4 * each);
    for (let n = 0; n < 20; n++)
    {
        reader.put(`b/${n}`, bytes(8192, n));
    }
    assert.equal(keeper.figures().metadataBytes % each, 0);
    assert.ok(keeper.figures().metadataBytes > 4 * each, 'a segment grown is one more');
});

test('a sweep cools a bounded part of the idle bodies, the rest at the sweeps after: none left moving',
    async()=>{
    const MIB = 1024 * KIB;
    const { reader, keeper, step } = await cacheOf({ budget: 64 * MIB, segmentBytes: 16 * MIB,
        disk: fixedViewsDisk(), coldAfterMs: 100 });
    for (let n = 0; n < 4096; n++)
    {
        assert.equal(reader.put(`b/${n}`, bytes(4096, n)), true);
    }
    await new Promise(resolve=>setTimeout(resolve, 0));
    step(200);
    const first = keeper.figures().cold;
    assert.ok(first > 0 && first <= 1025, `${first} of 4096 cooled by one sweep, 4 MiB and one body`);
    const looks = Array.from({ length: 4096 }, (_, n)=>reader.look(`b/${n}`));
    assert.ok(looks.every(look=>look === 'hot' || look === 'cold'), 'nothing left moving between sweeps');
    for (let sweeps = 0; sweeps < 8 && keeper.figures().cold < 4096; sweeps++)
    {
        step(200);
    }
    assert.equal(keeper.figures().cold, 4096, 'the rest at the sweeps after');
});

test('the own segments announced ahead reserve a bounded address space, whatever the budget', async()=>{
    // Each spare can grow to the budget: a spare for every large body the
    // budget holds was 511 of 2 GiB for a budget of 2 GiB - a TiB of address
    // space, which a browser's V8 sandbox has in all (Chromium made 502).
    const { openKeeper } = await import('./keeper.js');
    const MIB = 1024 * KIB;
    for (const budget of [256 * MIB, 2048 * MIB])
    {
        const keeper = await openKeeper({ budget, segmentBytes: 16 * MIB, announce: ()=>{} });
        const figures = keeper.figures();
        assert.ok(figures.spareAddressBytes <= 16 * 1024 * MIB + budget,
            `${figures.spareAddressBytes / MIB} MiB of address space for a budget of ${budget / MIB}`);
        assert.ok(figures.spareAddressBytes >= 2 * Math.min(budget, 2 ** 31 - 4096), 'two spares at least');
        keeper.close();
    }
});
