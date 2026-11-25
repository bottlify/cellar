/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BELLS, COUNTS, ChannelClosed, createChannel, openClient, openServer } from './channel.js';

/** A handler answering each request with its bytes reversed. @param {Uint8Array} request */
const reversed = request=>request.slice().reverse();

test('a call is answered in order, read where the answer lies', async()=>{
    const memory = createChannel({ slots: 4, slotBytes: 64 });
    const client = openClient(memory);
    const server = openServer(memory);
    /** @type {boolean[]} */
    const inPlace = [];
    const answers = [1, 2, 3].map(n=>client.call([n, n + 1, n + 2], {
        read: answer=>{
            inPlace.push(answer.buffer === memory);
            return [...answer];
        },
    }));
    assert.equal(server.waiting(), 3);
    /** @type {boolean[]} */
    const requestsInPlace = [];
    assert.equal(server.serve(request=>{
        requestsInPlace.push(request.buffer === memory);
        return reversed(request);
    }, { timeoutMs: 0 }), 3);
    assert.deepEqual(await Promise.all(answers), [[3, 2, 1], [4, 3, 2], [5, 4, 3]]);
    assert.deepEqual(inPlace, [true, true, true], 'answers read in the channel, not copied out');
    assert.deepEqual(requestsInPlace, [true, true, true], 'requests read in the channel too');
    assert.equal(client.out(), 0);
});

test('no more calls go out than there are slots: the next waits for an answer', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 8 });
    const client = openClient(memory);
    const server = openServer(memory);
    const answers = [1, 2, 3].map(n=>client.call([n]));
    await new Promise(resolve=>setTimeout(resolve, 5));
    assert.equal(server.waiting(), 2, 'the third waits for room');
    server.serve(request=>[request[0] * 10], { timeoutMs: 0 });
    await new Promise(resolve=>setTimeout(resolve, 5));
    assert.equal(server.waiting(), 1, 'an answer read made room for it');
    server.serve(request=>[request[0] * 10], { timeoutMs: 0 });
    assert.deepEqual((await Promise.all(answers)).map(answer=>[...answer]), [[10], [20], [30]]);
});

test('a slot wraps past its count many times and past 2^32 requests', async()=>{
    const memory = createChannel({ slots: 4, slotBytes: 4 });
    // Both counters near the wrap, as a channel that ran long has them.
    const words = new Int32Array(memory);
    for (const counter of COUNTS)
    {
        words[counter] = -5;
    }
    const client = openClient(memory);
    const server = openServer(memory);
    for (let n = 0; n < 40; n++)
    {
        const answer = client.call([n & 255, n >> 8]);
        server.serve(request=>[request[0], request[1], 7], { timeoutMs: 0 });
        assert.deepEqual([...await answer], [n & 255, n >> 8, 7]);
    }
});

test('an empty answer, an empty request, a request too large', async()=>{
    const memory = createChannel({ slots: 1, slotBytes: 3 });
    const client = openClient(memory);
    const server = openServer(memory);
    const answer = client.call([]);
    server.serve(request=>{
        assert.equal(request.length, 0);
    }, { timeoutMs: 0 });
    assert.equal((await answer).length, 0);
    await assert.rejects(client.call([1, 2, 3, 4]), RangeError);
    assert.throws(()=>client.ask([1, 2, 3, 4]), RangeError);
    assert.equal(server.waiting(), 0, 'a request refused is not sent');
    assert.equal(client.out(), 0, 'nor waits for an answer');
    const next = client.call([5]);
    server.serve(request=>[request[0] + 1], { timeoutMs: 0 });
    assert.deepEqual([...await next], [6], 'the next request gets its own answer');
});

test('serve with nothing waiting answers nothing within its timeout', ()=>{
    const memory = createChannel();
    assert.equal(openServer(memory).serve(reversed, { timeoutMs: 5 }), 0);
});

test('an ask not answered in time throws; its answer, when it comes, is dropped', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 4 });
    const client = openClient(memory);
    const server = openServer(memory);
    assert.throws(()=>client.ask([1], { timeoutMs: 5 }), /no answer in 5 ms/);
    server.serve(()=>[9], { timeoutMs: 0 });
    const next = client.call([2]);
    server.serve(request=>[request[0]], { timeoutMs: 0 });
    assert.deepEqual([...await next], [2], 'the late answer went to nobody, the next to its caller');
});

test('closing ends every wait on either side', async()=>{
    const memory = createChannel();
    const client = openClient(memory);
    const server = openServer(memory);
    const pending = client.call([1]);
    client.close();
    await assert.rejects(pending, ChannelClosed);
    assert.equal(server.closed(), true);
    assert.equal(server.serve(reversed), 1, 'what was asked before is still answered');
    assert.throws(()=>server.serve(reversed), ChannelClosed);

    const idle = createChannel();
    const serving = openServer(idle).serveAsync(reversed);
    openClient(idle).close();
    await assert.rejects(serving, ChannelClosed);
});

test('a handler that throws fails its own call alone, through the reader', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 4 });
    const client = openClient(memory);
    const server = openServer(memory);
    const bad = client.call([1], {
        read: ()=>{
            throw new Error('unreadable');
        },
    });
    const good = client.call([2]);
    server.serve(reversed, { timeoutMs: 0 });
    await assert.rejects(bad, /unreadable/);
    assert.deepEqual([...await good], [2]);
});

test('a close moves the bells both sides sleep on: a wait that looked before the close and'
    + ' sleeps after it ends at once', ()=>{
    // Each side sleeps on its bell; a close that only notified would leave
    // one that looked at the closed word just before it asleep for its time.
    for (const closing of ['client', 'server'])
    {
        const memory = createChannel({ slots: 2, slotBytes: 8 });
        const words = new Int32Array(memory);
        const seen = BELLS.map(bell=>Atomics.load(words, bell));
        (closing === 'client' ? openClient(memory) : openServer(memory)).close();
        BELLS.forEach((bell, at)=>{
            assert.equal(Atomics.wait(words, bell, seen[at], 1000), 'not-equal',
                `${closing} closed: bell ${bell}`);
        });
    }
});

test('requests out together across the counts\' wrap each keep their own slot', async()=>{
    // Three slots put the requests counted 2^32 - 1 and 0 in one: refused.
    assert.throws(()=>createChannel({ slots: 3 }), /power of two/);
    for (const slots of [1, 2, 4, 8, 16])
    {
        const memory = createChannel({ slots, slotBytes: 4 });
        // The counts just short of 2^32, so the requests out at once straddle it.
        const words = new Int32Array(memory);
        for (const counter of COUNTS)
        {
            words[counter] = -1 - Math.floor(slots / 2);
        }
        const client = openClient(memory);
        const server = openServer(memory);
        for (let round = 0; round < 3; round++)
        {
            const answers = Array.from({ length: slots }, (_, n)=>client.call([round, n]));
            server.serve(request=>[request[0], request[1], 9], { timeoutMs: 0 });
            assert.deepEqual((await Promise.all(answers)).map(answer=>[...answer]),
                Array.from({ length: slots }, (_, n)=>[round, n, 9]), `${slots} slots, round ${round}`);
        }
    }
});
