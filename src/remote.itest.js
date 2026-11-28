/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The remote keeper's gate across threads: a reader in a worker reserving,
 * committing and reading, raising a cold body, an owner's names given and
 * let go of, over a channel and over a link alike; every request out at once
 * past a channel's slots; the channel closed in the middle; a body of a
 * segment of its own placed from the worker; and a link's call answered
 * while the keeper's thread waits on the worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { bodyOf, cacheOf } from './cache.fixture.js';
import { createAccountMemory, openAccount } from './account.js';
import { createChannel } from './channel.js';
import { createLinkMemory, openLink } from './link.js';
import { answerKeeper, keeperWords, serveKeeperChannel } from './remote.js';
import { memoryDisk } from './disk.fixture.js';

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * A keeper on this thread and a worker reading it over `carrier`: `run(part,
 * data)` answers what the worker saw.
 *
 * @param {'channel' | 'link'} carrier
 * @param {{ cache?: Partial<import('./keeper.js').KeeperOptions>, slots?: number,
 *     closeAfter?: number }} [options]  `closeAfter`: answers after which the keeper's
 *     side closes, from inside its serving
 */
async function across(carrier, { cache: options = {}, slots = 16, closeAfter = Infinity } = {}){
    /** @type {Worker | null} */
    let worker = null;
    /** @type {import('./reader.js').Reader | null} */
    let reader = null;
    const cache = await cacheOf({ disk: memoryDisk(), ...options, announce: message=>{
        reader?.adopt(message);
        worker?.postMessage({ adopt: message });
    } });
    reader = cache.reader;
    let owners = 0;
    const plain = answerKeeper({ keeper: cache.keeper, owners: {
        own: kind=>`${kind}/${++owners}/`,
        release: prefix=>cache.keeper.release(prefix),
    } });
    let answered = 0;
    /** @type {typeof plain} */
    const answer = (...args)=>{
        if (++answered === closeAfter)
        {
            serving.close();
        }
        return plain(...args);
    };
    /** @type {any} */
    let memory;
    /** @type {{ close: () => void, ended?: Promise<void> }} */
    let serving;
    /** @type {import('./link.js').Link | null} */
    let link = null;
    if (carrier === 'channel')
    {
        memory = createChannel({ slots, slotBytes: 256 });
        serving = serveKeeperChannel(memory, answer);
    }
    else
    {
        const ends = createLinkMemory({ capacity: 1 << 16, words: 64, slots: 4 });
        memory = ends.b;
        link = openLink(ends.a, {}, { words: keeperWords(answer) });
        link.serve();
        serving = link;
    }
    worker = new Worker(new URL('./remote.worker.fixture.js', import.meta.url), { workerData: {
        carrier, memory, shared: cache.keeper.shared, segments: cache.keeper.segmentBuffers(),
        account: options.account } });
    const messages = /** @type {any[]} */ ([]);
    /** @type {(() => void) | null} */
    let heard = null;
    worker.on('message', message=>{
        messages.push(message);
        heard?.();
    });
    const errors = /** @type {any[]} */ ([]);
    worker.on('error', e=>errors.push(e));
    const next = async()=>{
        while (messages.length === 0)
        {
            assert.deepEqual(errors, []);
            await new Promise(resolve=>{
                heard = ()=>resolve(undefined);
            });
        }
        return messages.shift();
    };
    assert.deepEqual(await next(), { ready: true });
    const self = /** @type {Worker} */ (worker);
    return {
        cache, serving, link, next,
        /** @param {string} part @param {any} [data] */
        send: (part, data = {})=>self.postMessage({ run: part, ...data }),
        /** @param {string} part @param {any} [data] */
        run: async(part, data = {})=>{
            self.postMessage({ run: part, ...data });
            const said = await next();
            assert.equal(said.error, undefined);
            return said.said;
        },
        end: async()=>{
            serving.close();
            await self.terminate();
        },
    };
}

for (const carrier of /** @type {const} */ (['channel', 'link']))
{
    test(`a reader in a worker over a ${carrier}: reserves, commits and reads; a cold body raised; `
        + 'an owner\'s names given and let go of', { timeout: 60_000 }, async()=>{
        const other = await across(carrier);
        try
        {
            const put = await other.run('put', { name: 'w/1', length: 3000, seed: 7 });
            assert.equal(put.put, true);
            assert.equal(put.sum, put.expected, 'read back where the worker wrote it');
            assert.equal(other.cache.reader.with('w/1', body=>body.length), 3000, 'and here');
            other.cache.step(150);
            assert.equal(other.cache.reader.look('w/1'), 'cold');
            const read = await other.run('read', { name: 'w/1' });
            assert.equal(read.look, 'cold');
            assert.equal(read.sum, put.expected, 'raised for the worker and read there');
            assert.equal(other.cache.keeper.figures().raised, 1);
            const owner = await other.run('owner', { kind: 'texels', count: 4 });
            assert.equal(owner.prefix, 'texels/1/');
            assert.deepEqual(owner.released, { bodies: 3, bytes: 300, waiting: 0 },
                'the three it still held');
            assert.equal(other.cache.keeper.under('texels/').bodies, 0);
        }
        finally
        {
            await other.end();
        }
    });
}

for (const carrier of /** @type {const} */ (['channel', 'link']))
{
    test(`the keeper's account from a worker over a ${carrier}: a take that does not fit has `
        + 'cold bodies go here, and both threads see one account', { timeout: 60_000 }, async()=>{
        const account = createAccountMemory({ limit: 512 * KIB, kinds: { cache: 256 * KIB, guest: Infinity } });
        const other = await across(carrier, { cache: { account, disk: null } });
        try
        {
            for (let n = 0; n < 16; n++)
            {
                assert.equal(other.cache.reader.put(`b/${n}`, bodyOf(16 * KIB, n)), true);
            }
            const fits = await other.run('grow', { bytes: 256 * KIB });
            assert.equal(fits.taken, true);
            assert.equal(other.cache.keeper.figures().roomAsked, 0, 'within the limit: none asked');
            const grown = await other.run('grow', { bytes: 128 * KIB });
            assert.equal(grown.taken, true, 'room made across');
            assert.deepEqual(grown.report, openAccount(account).report(), 'one account, the same words');
            assert.equal(grown.report.kinds.guest.bytes, 384 * KIB);
            assert.equal(grown.report.kinds.cache.bytes, 128 * KIB);
            assert.equal(other.cache.keeper.figures().roomMade, 1);
            const refused = await other.run('grow', { bytes: 256 * KIB });
            assert.equal(refused.taken, false, 'past what can be made: refused');
            assert.equal(refused.report.refused, 1);
        }
        finally
        {
            await other.end();
        }
    });
}

test('every request out at once, past the channel\'s slots: each answered with room of its own', { timeout: 60_000 },
    async()=>{
        const other = await across('channel', { slots: 4, cache: { budget: 1024 * 1024 } });
        try
        {
            other.send('many', { count: 64, length: 1000 });
            assert.deepEqual(await other.next(), { sent: 64 });
            const places = (await other.next()).said;
            assert.equal(places.length, 64);
            for (const [n, one] of places.entries())
            {
                assert.ok(one.place, `request ${n}: ${JSON.stringify(one)}`);
            }
            assert.equal(other.cache.keeper.under('many/').bodies, 64);
            assert.equal(new Set(places.map((/** @type {any} */ one)=>`${one.place.segment}:${one.place.offset}`))
                .size, 64, 'each its own room');
        }
        finally
        {
            await other.end();
        }
    });

test('the channel closed in the middle: what was asked before is answered, the rest fail closed, '
    + 'none waits for ever', { timeout: 60_000 }, async()=>{
    const other = await across('channel', { slots: 4, closeAfter: 3 });
    try
    {
        other.send('many', { count: 32, length: 100 });
        assert.deepEqual(await other.next(), { sent: 32 });
        const places = (await other.next()).said;
        const answered = places.filter((/** @type {any} */ one)=>one.place);
        const failed = places.filter((/** @type {any} */ one)=>one.failed);
        assert.equal(answered.length + failed.length, 32);
        assert.ok(answered.length >= 1 && failed.length >= 1, `${answered.length} answered, ${failed.length} failed`);
        assert.ok(places.slice(0, answered.length).every((/** @type {any} */ one)=>one.place),
            'the first ones answered, in order');
        assert.ok(failed.every((/** @type {any} */ one)=>one.failed === 'ChannelClosed'));
        await other.serving.ended;
        assert.deepEqual(await other.run('after'), { thrown: 'ChannelClosed' });
    }
    finally
    {
        await other.end();
    }
});

test('a body of a segment of its own placed from the worker, read here in place', { timeout: 60_000 },
    async()=>{
        const other = await across('channel', { cache: { budget: 64 * MIB, segmentBytes: 16 * MIB } });
        try
        {
            const put = await other.run('put', { name: 'big', length: 20 * MIB, seed: 3 });
            assert.equal(put.put, true);
            assert.equal(put.sum, put.expected);
            const figures = other.cache.keeper.figures();
            assert.ok(figures.segmentBytes >= 16 * MIB + 20 * MIB, `${figures.segmentBytes}`);
            assert.equal(other.cache.reader.with('big', body=>body.length), 20 * MIB);
        }
        finally
        {
            await other.end();
        }
    });

test('over a link, a keeper call the worker makes while the keeper\'s thread waits on it is answered '
    + 'inside that wait', { timeout: 60_000 }, async()=>{
    const other = await across('link');
    try
    {
        const link = /** @type {import('./link.js').Link} */ (other.link);
        const place = link.ask('worker', 'reserveNow', ['nested'], 10_000);
        assert.equal(place.segment, 0);
        assert.equal(other.cache.keeper.under('nested').bodies, 1);
    }
    finally
    {
        await other.end();
    }
});
