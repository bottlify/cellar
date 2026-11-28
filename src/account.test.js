/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_UNIT, RUN_HOLDER, createAccountMemory, openAccount, openCharge } from './account.js';
import { bodyOf, cacheOf } from './cache.fixture.js';

const KIB = 1024;
const MIB = 1024 * KIB;

test('memory declared by kind is grown and shrunk through the account, refused past its limit', ()=>{
    const memory = createAccountMemory({ limit: 1 * MIB, kinds: { cache: Infinity, guest: Infinity } });
    /** @type {any[]} */
    const refusals = [];
    const account = openAccount(memory, { onRefused: refusal=>refusals.push(refusal) });
    assert.equal(account.take(624 * KIB, 'guest'), true);
    assert.equal(account.take(400 * KIB, 'cache'), true);
    assert.equal(account.take(ACCOUNT_UNIT, 'guest'), false, 'the limit reached');
    account.give(100 * KIB, 'guest');
    assert.equal(account.take(100 * KIB, 'guest'), true, 'what was given back is room again');
    const report = account.report();
    assert.equal(report.limit, 1 * MIB);
    assert.equal(report.used, 1 * MIB);
    assert.equal(report.refused, 1);
    assert.deepEqual(report.kinds.guest, { bytes: 624 * KIB, ceiling: null, peak: 624 * KIB, refused: 1 });
    assert.equal(report.kinds.cache.bytes, 400 * KIB);
    assert.deepEqual(refusals, [{ kind: 'guest', bytes: ACCOUNT_UNIT, used: 1 * MIB, limit: 1 * MIB }]);
    assert.throws(()=>account.take(1, 'texels'), /no kind texels/);
});

test('a kind\'s ceiling bounds it inside the limit; the other kinds keep the rest', ()=>{
    const memory = createAccountMemory({ limit: 1 * MIB, kinds: { cache: 256 * KIB, guest: Infinity } });
    const account = openAccount(memory);
    assert.equal(account.bound('cache'), 256 * KIB);
    assert.equal(account.bound('guest'), 1 * MIB);
    assert.equal(account.take(256 * KIB, 'cache'), true);
    assert.equal(account.fits(ACCOUNT_UNIT, 'cache'), false);
    assert.equal(account.take(ACCOUNT_UNIT, 'cache'), false, 'past its ceiling');
    assert.equal(account.take(768 * KIB, 'guest'), true, 'the rest is the others\'');
    assert.equal(openAccount(createAccountMemory({ limit: Infinity, kinds: { a: Infinity } })).bound('a'),
        Infinity);
});

test('each holder\'s part is counted apart, moved, and given back whole by release', ()=>{
    const memory = createAccountMemory({ limit: 64 * MIB, kinds: { guest: Infinity, engine: Infinity } });
    const run = openAccount(memory);
    const holder = run.claim();
    assert.notEqual(holder, RUN_HOLDER);
    const process = openAccount(memory, { holder });
    assert.equal(process.take(3 * MIB, 'guest'), true);
    assert.equal(process.take(1 * MIB, 'engine'), true);
    assert.deepEqual(run.report().holders, { [holder]: { guest: 3 * MIB, engine: 1 * MIB } });
    process.move(1 * MIB, 'guest', RUN_HOLDER);
    assert.equal(process.heldBy('guest'), 2 * MIB);
    assert.equal(run.heldBy('guest'), 1 * MIB);
    process.give(10 * MIB, 'engine');
    assert.equal(run.report().used, 3 * MIB, 'a give takes no more than its holder holds');
    assert.equal(run.release(holder), 2 * MIB);
    assert.equal(run.report().used, 1 * MIB, 'what the run holds stays');
    assert.deepEqual(run.report().holders, {});
    assert.equal(run.claim(), holder, 'a released holder is claimed again');
});

test('a take that does not fit asks for room once, and is taken where room was made', ()=>{
    const memory = createAccountMemory({ limit: 1 * MIB, kinds: { cache: Infinity, guest: Infinity } });
    const cache = openAccount(memory);
    cache.take(512 * KIB, 'cache');
    /** @type {number[]} */
    const asked = [];
    const guest = openAccount(memory, { room: bytes=>{
        asked.push(bytes);
        cache.give(bytes, 'cache');
        return true;
    } });
    assert.equal(guest.take(768 * KIB, 'guest'), true);
    assert.deepEqual(asked, [768 * KIB], 'room for what it wants');
    assert.equal(guest.take(512 * KIB, 'guest'), false, 'no room left to make');
    const report = guest.report();
    assert.deepEqual([report.roomAsked, report.roomMade, report.refused], [2, 1, 1]);
});

test('a charge of any size takes whole units only where its sum crosses one, weighed', ()=>{
    const account = openAccount(createAccountMemory({ limit: 1 * MIB, kinds: { translation: Infinity } }));
    const charge = openCharge(account, 'translation', 4);
    assert.equal(charge.take(100), true);
    assert.equal(charge.take(100), true);
    assert.equal(account.report().used, ACCOUNT_UNIT, '800 bytes weighed: one unit');
    assert.equal(charge.take(1024), true);
    assert.equal(account.report().used, 2 * ACCOUNT_UNIT);
    charge.give(1224);
    assert.equal(account.report().used, 0);
    assert.equal(charge.held(), 0);
});

test('the keeper\'s segments are a kind of the account: a take of another that does not fit '
    + 'has cold bodies go, and is refused only where none can', async()=>{
    const memory = createAccountMemory({ limit: 512 * KIB, kinds: { cache: 256 * KIB, guest: Infinity } });
    const { keeper, reader } = await cacheOf({ account: memory });
    const room = (/** @type {number} */ bytes)=>keeper.makeRoom(bytes);
    const guest = openAccount(memory, { room });
    // Four segments of 64 KiB, filled: the cache at its ceiling.
    for (let n = 0; n < 16; n++)
    {
        assert.equal(reader.put(`b/${n}`, bodyOf(16 * KIB, n)), true);
    }
    assert.equal(guest.report().kinds.cache.bytes, 256 * KIB, 'the segments, counted in the account');
    assert.equal(guest.take(256 * KIB, 'guest'), true, 'within the limit: nothing goes');
    assert.equal(keeper.figures().roomAsked, 0);
    // One body read all along: its segment cannot go.
    const kept = reader.with('b/0', body=>{
        assert.equal(guest.take(128 * KIB, 'guest'), true, 'two segments let go for it');
        return body.length;
    });
    assert.equal(kept, 16 * KIB);
    assert.equal(reader.look('b/0'), 'hot', 'the body read stays');
    assert.equal(reader.look('b/15'), 'hot', 'the most recently read stays: only what was needed went');
    assert.equal(reader.look('b/4'), null, 'the least recently read went');
    const figures = keeper.figures();
    assert.equal(figures.segmentBytes, 128 * KIB);
    assert.equal(figures.account.kinds.cache.bytes, 128 * KIB);
    assert.equal(figures.account.kinds.guest.bytes, 384 * KIB);
    assert.deepEqual([figures.roomAsked, figures.roomMade], [1, 1]);
    // Everything read at once: no room can be made, and the take fails.
    const ids = [0, 12, 13, 14, 15].filter(n=>reader.look(`b/${n}`) === 'hot');
    const refused = ids.reduce((/** @type {() => boolean} */ inner, n)=>()=>/** @type {boolean} */ (
        reader.with(`b/${n}`, ()=>inner())), ()=>guest.take(128 * KIB, 'guest'))();
    assert.equal(refused, false);
    assert.equal(keeper.figures().roomRefused, 1);
    assert.equal(guest.report().refused, 1);
});

test('a keeper with a budget alone holds an account of its own', async()=>{
    const { keeper } = await cacheOf({ budget: 256 * KIB });
    assert.deepEqual(Object.keys(keeper.figures().account.kinds), ['cache']);
    assert.equal(keeper.figures().account.kinds.cache.ceiling, 256 * KIB);
    await assert.rejects(()=>cacheOf({ budget: undefined,
        account: createAccountMemory({ limit: Infinity, kinds: { cache: Infinity } }) }), /a keeper needs a bound/);
});
