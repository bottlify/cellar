/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The remote keeper's format on one thread: every op over both carriers,
 * answering what the keeper answers there; a request that is not of its
 * layout, or an op it does not know, refused with its failure and nothing
 * done for it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheOf, placeOf } from './cache.fixture.js';
import { createChannel, openClient } from './channel.js';
import { createLinkMemory, openLink } from './link.js';
import { createReader } from './reader.js';
import { answerKeeper, keeperWords, linkCarrier, openKeeperClient, serveKeeperChannel } from './remote.js';
import { memoryDisk } from './disk.fixture.js';
import { F_FOR_ROOM, F_HELD, F_NO_DISK, F_ONLY_COPY, F_THIS_RUN, P_SEGMENT, reserveFlags } from './shared.js';

/** A reservation of no options, in any segment. */
/**
 * A keeper served to a client on this thread over `carrier` ('channel' or
 * 'link'), its calls written down as the keeper had them, owners given out
 * as `kind/<n>/`.
 *
 * @param {'channel' | 'link'} carrier
 */
async function served(carrier){
    /** @type {((message: any) => void)[]} */
    const told = [];
    const cache = await cacheOf({ disk: memoryDisk(), announce: message=>told.forEach(tell=>tell(message)) });
    told.push(message=>cache.reader.adopt(message));
    /** @type {any[]} */
    const calls = [];
    let owners = 0;
    const answer = answerKeeper({
        keeper: {
            reserve: (name, length, flags, known, place)=>{
                calls.push(['reserve', name, length, flags, known]);
                return cache.keeper.reserve(name, length, flags, known, place);
            },
            raise: (name, options)=>{
                calls.push(['raise', name, options]);
                return cache.keeper.raise(name, options);
            },
            drop: name=>{
                calls.push(['drop', name]);
                return cache.keeper.drop(name);
            },
            makeRoom: bytes=>{
                calls.push(['room', bytes]);
                return cache.keeper.makeRoom(bytes);
            },
        },
        owners: {
            own: kind=>(kind === 'none' ? null : `${kind}/${++owners}/`),
            release: (prefix, held)=>{
                calls.push(['release', prefix, held]);
                return prefix === 'gone/' ? null : { ...cache.keeper.release(prefix), bytes: 2 ** 33 + 5 };
            },
        },
    });
    let close;
    let client;
    if (carrier === 'channel')
    {
        const memory = createChannel({ slots: 4, slotBytes: 512 });
        close = serveKeeperChannel(memory, answer).close;
        client = openKeeperClient(openClient(memory));
    }
    else
    {
        const { a, b } = createLinkMemory({ capacity: 1 << 16, words: 64, slots: 4 });
        const keeperSide = openLink(a, {}, { words: keeperWords(answer) });
        const asking = openLink(b);
        // Calls not waited on are answered on each side's event loop.
        keeperSide.serve();
        asking.serve();
        close = ()=>keeperSide.close();
        client = openKeeperClient(linkCarrier(asking));
    }
    const reader = createReader({ shared: cache.keeper.shared, segments: cache.keeper.segmentBuffers(),
        keeper: client.keeper });
    told.push(message=>reader.adopt(message));
    return { cache, calls, client, reader, close };
}

for (const carrier of /** @type {const} */ (['channel', 'link']))
{
    test(`every op over a ${carrier}: what the keeper answers, its flags as they were given`, async()=>{
        const { cache, calls, client, reader, close } = await served(carrier);
        try
        {
            const place = placeOf(client.keeper, 'a/1', 1000,
                reserveFlags({ onlyCopy: true, disk: 'run', idle: 'stay' }), 1);
            assert.ok(place && Number.isInteger(place.id) && place.segment === 0);
            assert.deepEqual(calls.at(-1), ['reserve', 'a/1', 1000, F_ONLY_COPY | F_THIS_RUN | F_FOR_ROOM, 1]);
            assert.notEqual(placeOf(client.keeper, 'a/2', 10, F_NO_DISK | F_HELD)?.segment ?? 0, 0,
                'held memory apart from the bodies');
            assert.deepEqual(calls.at(-1).slice(3), [F_NO_DISK | F_HELD, Infinity], 'no segments said: every one');
            assert.equal(placeOf(client.keeper, 'a/3', 1 << 30), null, 'refused: past the budget');

            assert.equal(reader.put('b/é', Uint8Array.of(1, 2, 3)), true, 'a name past ASCII');
            assert.equal(cache.reader.with('b/é', body=>body[2]), 3, 'committed where the keeper put it');
            cache.step(150);
            assert.equal(cache.reader.look('b/é'), 'cold');
            assert.equal(client.keeper.raise('b/é', { known: 4 }), true, 'raised');
            assert.deepEqual(calls.at(-1), ['raise', 'b/é', { known: 4 }]);
            assert.equal(client.keeper.raise('nothing', { known: 4 }), false);
            client.keeper.raiseLater('b/é');
            client.keeper.drop('b/é');
            await new Promise(resolve=>setTimeout(resolve, 20));
            assert.deepEqual(calls.slice(-2), [['raise', 'b/é', { known: Infinity }], ['drop', 'b/é']]);
            assert.equal(cache.reader.look('b/é'), null, 'dropped');

            const later = await client.reserveLater('c/1', 64, reserveFlags({ onlyCopy: true, disk: 'run' }), 1);
            assert.equal(later?.[P_SEGMENT], 0);
            assert.equal(client.own('texels'), 'texels/1/');
            assert.equal(client.own('none'), null);
            assert.deepEqual(client.release('a/', 2), { bodies: 2, bytes: 2 ** 33 + 5, waiting: 0 },
                'a count past 32 bits whole; the hold and the reservation taken back at once');
            assert.equal(client.release('gone/', 0), null);
            assert.deepEqual(await client.releaseLater('c/', 7), { bodies: 1, bytes: 2 ** 33 + 5,
                waiting: 0 });
            assert.deepEqual(calls.at(-1), ['release', 'c/', 7]);
            assert.equal(client.room(5000), true, 'the account has room already');
            assert.deepEqual(calls.at(-1), ['room', 8192], 'asked in whole units of 4 KiB');
        }
        finally
        {
            close();
        }
    });
}

/** A request written by hand: words, then bytes. @param {number[]} words @param {number[]} [bytes] */
const raw = (words, bytes = [])=>{
    const out = new Uint8Array(words.length * 4 + bytes.length);
    new DataView(out.buffer).setInt32(0, 0, true);
    words.forEach((word, n)=>new DataView(out.buffer).setInt32(n * 4, word, true));
    out.set(bytes, words.length * 4);
    return out;
};

test('an op it does not know is a failure, never another call; a request not of its layout is '
    + 'refused, and the next is answered', async()=>{
    const { cache, calls, close } = await served('channel');
    const memory = createChannel({ slots: 4, slotBytes: 512 });
    /** @type {any} */
    const answer = answerKeeper({ keeper: { reserve: (...args)=>{
        calls.push(['reserve', ...args]);
        return cache.keeper.reserve(...args);
    }, raise: ()=>false, makeRoom: ()=>false, drop: name=>{
        calls.push(['drop', name]);
        return true;
    } } });
    const serving = serveKeeperChannel(memory, answer);
    const channel = openClient(memory);
    const said = (/** @type {Uint8Array} */ request)=>channel.ask(request, { read: bytes=>{
        const words = new DataView(bytes.buffer, bytes.byteOffset);
        return { status: words.getInt32(0, true),
            text: new TextDecoder().decode(bytes.slice(20, 20 + words.getInt32(4, true))) };
    } });
    try
    {
        calls.length = 0;
        assert.deepEqual(said(raw([99, 0, 0, 0, 1], [0x61])), { status: -1, text: 'remote keeper: no op 99' });
        assert.deepEqual(said(raw([0, 0, 0, 0, 1], [0x61])).status, -1);
        assert.equal(said(Uint8Array.of(3, 0, 0)).status, -2, 'shorter than its words');
        assert.equal(said(raw([3, 0, 0, 0, 5], [0x61])).status, -2, 'a name shorter than it says');
        assert.equal(said(raw([3, 0, 0, 0, 0], [0x61])).status, -2, 'bytes past the name');
        assert.equal(said(raw([1, 10, -1, 1 << 9, 1], [0x61])).status, -2, 'flags it does not know');
        assert.equal(said(raw([1, 10, -1, 3 << 3, 1], [0x61])).status, -2, 'a disk policy past them');
        assert.deepEqual(calls, [], 'nothing done for any of them');
        assert.deepEqual(said(raw([4, 0, 0, 0, 1], [0x61])), { status: -3,
            text: 'remote keeper: no owners are given names here' });
        assert.equal(said(raw([3, 0, 0, 0, 1], [0x61])).status, 0, 'the next answered');
        assert.deepEqual(calls, [['drop', 'a']]);

        // The client says it: a failure thrown where it asked.
        const client = openKeeperClient(channel);
        assert.throws(()=>client.own('x'), /no owners are given names here/);
    }
    finally
    {
        serving.close();
        close();
    }
});

test('a call not waited on that fails is said, not dropped; a closed carrier is not a failure', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 128 });
    const serving = serveKeeperChannel(memory, answerKeeper({ keeper: {
        makeRoom: ()=>false, reserve: ()=>false, raise: ()=>{
            throw new Error('the keeper is closed');
        }, drop: ()=>true } }));
    /** @type {unknown[]} */
    const failures = [];
    const client = openKeeperClient(openClient(memory), { onFailure: e=>failures.push(e) });
    client.keeper.raiseLater('x');
    await new Promise(resolve=>setTimeout(resolve, 20));
    assert.match(String(failures[0]), /the keeper is closed/);
    serving.close();
    await serving.ended;
    client.keeper.drop('y');
    await new Promise(resolve=>setTimeout(resolve, 20));
    assert.equal(failures.length, 1);
    assert.throws(()=>placeOf(client.keeper, 'z', 1), /closed/);
});

test('a client refuses what the format cannot say, before anything is sent', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 64 });
    const serving = serveKeeperChannel(memory, answerKeeper({ keeper: { reserve: ()=>false,
        raise: ()=>false, drop: ()=>true, makeRoom: ()=>false } }));
    const client = openKeeperClient(openClient(memory));
    try
    {
        assert.throws(()=>placeOf(client.keeper, 'a', 2 ** 32), RangeError);
        assert.throws(()=>placeOf(client.keeper, 'a', -1), RangeError);
        assert.throws(()=>placeOf(client.keeper, 'a', 1, 1 << 9), RangeError, 'a flag no reservation asks');
        assert.throws(()=>client.keeper.raise(/** @type {any} */ (null), { known: 1 }), TypeError);
        assert.throws(()=>placeOf(client.keeper, 'a'.repeat(100), 1), /a slot holds 64/,
            'a name past what its carrier holds, said by the carrier');
        assert.equal(placeOf(client.keeper, 'a', 1), null, 'the next one goes');
    }
    finally
    {
        serving.close();
    }
});
