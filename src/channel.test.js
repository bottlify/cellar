/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { BELLS, COUNTS, ChannelClosed, ChannelFailed, createChannel, openClient, openServer }
    from './channel.js';

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

test('a reader that throws fails its own call alone', async()=>{
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

test('a closed channel takes no request: an ask or a call after the close publishes nothing',
    async()=>{
        for (const closing of ['client', 'server'])
        {
            const memory = createChannel({ slots: 4, slotBytes: 8 });
            const client = openClient(memory);
            const server = openServer(memory);
            (closing === 'client' ? client : server).close();
            assert.throws(()=>client.ask([1], { timeoutMs: 100 }), ChannelClosed);
            await assert.rejects(client.call([2]), ChannelClosed);
            assert.equal(server.waiting(), 0, `${closing} closed: nothing for the server to read`);
        }
    });

test('a call waiting for a slot of a full channel is failed by the close, the thread free',
    { timeout: 30000 }, async t=>{
        // In a worker of its own: a call that waited on would turn its
        // thread's loop for ever, this file's timers with it.
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            import(workerData.channel).then(async({ createChannel, openClient })=>{
                const client = openClient(createChannel({ slots: 2, slotBytes: 8 }));
                const out = [client.call([1]), client.call([2])];
                const third = client.call([3]);
                await new Promise(resolve=>setTimeout(resolve, 20));
                client.close();
                const ends = await Promise.allSettled([...out, third]);
                parentPort.postMessage(ends.map(end=>end.status + ':' + (end.reason?.name ?? '')));
            });`, { eval: true,
            workerData: { channel: new URL('./channel.js', import.meta.url).href } });
        worker.unref();
        t.after(()=>worker.terminate());
        const ends = await Promise.race([
            new Promise((resolve, reject)=>{
                worker.once('message', resolve);
                worker.once('error', reject);
            }),
            new Promise(resolve=>setTimeout(()=>resolve('its thread never came back'), 10000)),
        ]);
        assert.deepEqual(ends, Array(3).fill('rejected:ChannelClosed'));
    });

test('a handler that throws, or answers more than a slot holds, fails its own request alone, on'
    + ' the asking side', async()=>{
    const memory = createChannel({ slots: 4, slotBytes: 64 });
    const client = openClient(memory);
    const server = openServer(memory);
    const thrown = client.call([1]);
    const large = client.call([2]);
    const good = client.call([3]);
    /** @type {number[]} */
    const handled = [];
    assert.equal(server.serve(request=>{
        handled.push(request[0]);
        if (request[0] === 1)
        {
            throw new Error('no such thing');
        }
        return request[0] === 2 ? new Uint8Array(65) : reversed(request);
    }, { timeoutMs: 0 }), 3);
    await assert.rejects(thrown, (e)=>e instanceof ChannelFailed && /no such thing/.test(e.message));
    await assert.rejects(large, ChannelFailed);
    assert.deepEqual([...await good], [3]);
    assert.equal(server.serve(()=>[0], { timeoutMs: 0 }), 0, 'nothing handled again');
    assert.deepEqual(handled, [1, 2, 3]);
    // An ask, which blocks, sees the failure too: a serving side in another thread.
    const own = createChannel({ slots: 2, slotBytes: 64 });
    const thread = new Worker(`
        const { workerData } = require('node:worker_threads');
        import(workerData.channel).then(({ openServer })=>{
            openServer(workerData.memory).serve(()=>{ throw new Error('again'); }, { timeoutMs: 10000 });
        });`, { eval: true, workerData: { channel: new URL('./channel.js', import.meta.url).href,
        memory: own } });
    const asking = openClient(own);
    assert.throws(()=>asking.ask([4], { timeoutMs: 10000 }),
        (e)=>e instanceof ChannelFailed && /again/.test(e.message));
    await thread.terminate();
});

test('a serve from inside its own handler, or an ask or a call from inside the reading of an'
    + ' answer, throws and leaves every answer to its own asker', async()=>{
    const memory = createChannel({ slots: 4, slotBytes: 64 });
    const client = openClient(memory);
    const server = openServer(memory);
    const nested = client.call([7]);
    /** @type {number[]} */
    const handled = [];
    server.serve(request=>{
        handled.push(request[0]);
        server.serve(reversed, { timeoutMs: 0 });
        return [request[0]];
    }, { timeoutMs: 0 });
    await assert.rejects(nested, /from inside its own handler/);
    assert.deepEqual(handled, [7], 'handled once');
    const words = new Int32Array(memory);
    assert.equal(Atomics.load(words, COUNTS[2]), Atomics.load(words, COUNTS[0]), 'answered as asked');

    /** @type {any[]} */
    const inner = [];
    const a = client.call([1], {
        read: answer=>{
            inner.push(client.call([9]));
            return answer[0];
        },
    });
    const b = client.call([2]);
    server.serve(reversed, { timeoutMs: 0 });
    assert.equal(await a, 1);
    assert.deepEqual([...await b], [2]);
    await assert.rejects(inner[0], /inside the reading of an answer/);
    const c = client.call([3]);
    server.serve(reversed, { timeoutMs: 0 });
    assert.deepEqual([...await c], [3]);
});

test('an ask whose wait throws (a thread that may not block) leaves its request answered to'
    + ' nobody: the next call gets its own answer', async()=>{
    const memory = createChannel({ slots: 4, slotBytes: 8 });
    const client = openClient(memory, { spinMs: 0 });
    const server = openServer(memory);
    const wait = Atomics.wait;
    Atomics.wait = ()=>{
        throw new TypeError('Atomics.wait cannot be called in this context');
    };
    try
    {
        assert.throws(()=>client.ask([1]), TypeError);
    }
    finally
    {
        Atomics.wait = wait;
    }
    const words = new Int32Array(memory);
    assert.equal(Atomics.load(words, 2), 0, 'its sleep is not counted any more');
    const next = client.call([2]);
    server.serve(request=>[request[0] + 100], { timeoutMs: 0 });
    assert.deepEqual([...await next], [102]);
    assert.equal(client.out(), 0);
});

test('a call waiting for room goes out as soon as one answer frees a slot', { timeout: 30000 },
    async()=>{
        const memory = createChannel({ slots: 4, slotBytes: 8 });
        // A serving side that takes 300 ms over each request.
        const thread = new Worker(`
            const { workerData } = require('node:worker_threads');
            import(workerData.channel).then(({ openServer })=>{
                const server = openServer(workerData.memory);
                const nap = new Int32Array(new SharedArrayBuffer(4));
                for (let served = 0; served < 6;)
                {
                    served += server.serve(request=>{
                        Atomics.wait(nap, 0, 0, 300);
                        return [request[0]];
                    }, { timeoutMs: 10000 });
                }
            });`, { eval: true, workerData: { channel: new URL('./channel.js', import.meta.url).href,
            memory } });
        const client = openClient(memory);
        const words = new Int32Array(memory);
        const calls = [1, 2, 3, 4, 5, 6].map(n=>client.call([n]));
        // How many were answered when the fifth went out: one frees its slot,
        // and the next answer is 300 ms after it.
        while (Atomics.load(words, COUNTS[0]) < 5)
        {
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
        const answered = Atomics.load(words, COUNTS[2]);
        assert.deepEqual((await Promise.all(calls)).map(answer=>answer[0]), [1, 2, 3, 4, 5, 6]);
        await thread.terminate();
        assert.ok(answered < 4, `the fifth went out with ${answered} answered`);
    });

test('a request that is not bytes is refused', ()=>{
    const memory = createChannel({ slots: 2, slotBytes: 8 });
    const client = openClient(memory);
    assert.throws(()=>client.ask(/** @type {any} */ (new DataView(new ArrayBuffer(4)))), TypeError);
    assert.equal(openServer(memory).waiting(), 0);
});

test('a channel past 1 GiB is refused, its slots found by 32-bit arithmetic', ()=>{
    assert.throws(()=>createChannel({ slots: 1 << 16, slotBytes: 1 << 16 }), RangeError);
    assert.throws(()=>createChannel({ slots: 2, slotBytes: 2 ** 31 }), RangeError);
});

test('a handler that throws what cannot be a string still fails its own request alone', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 64 });
    const client = openClient(memory);
    const server = openServer(memory);
    const odd = client.call([1]);
    const getter = client.call([2]);
    const good = client.call([3]);
    assert.equal(server.serve(request=>{
        if (request[0] === 1)
        {
            throw Object.create(null);
        }
        if (request[0] === 2)
        {
            throw { get message(){
                throw new Error('no');
            } };
        }
        return [request[0]];
    }, { timeoutMs: 0 }), 2);
    await assert.rejects(odd, ChannelFailed);
    await assert.rejects(getter, ChannelFailed);
    assert.equal(server.serve(request=>[request[0]], { timeoutMs: 0 }), 1);
    assert.deepEqual([...await good], [3]);
});

test('a request that grows while it is written is written as long as it was', async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 64 });
    const client = openClient(memory);
    const server = openServer(memory);
    const shared = new /** @type {any} */ (SharedArrayBuffer)(8, { maxByteLength: 1024 });
    let reads = 0;
    /** A length-tracking view that grows once its length has been taken to size the copy. */
    class Growing extends Uint8Array {
        get length(){
            const length = super.length;
            // The second reading sizes the copy (the first checks the bytes).
            if (++reads === 2)
            {
                shared.grow(200);
            }
            return length;
        }
    }
    const answer = client.call(new Growing(shared));
    /** @type {number[]} */
    const lengths = [];
    server.serve(request=>{
        lengths.push(request.length);
        return [request.length];
    }, { timeoutMs: 0 });
    assert.deepEqual([...await answer], [8]);
    assert.deepEqual(lengths, [8]);
});

test('a serving side\'s blocking waits learn their spin from requests that come only once it'
    + ' sleeps', { timeout: 60_000 }, async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 8 });
    const server = openServer(memory);
    // The asking thread asks only once the serving side counted itself asleep
    // (the header's sixth word); its next ask waits for the answer to the last.
    const asking = new Worker(`
        const { workerData } = require('node:worker_threads');
        import(workerData.channel).then(({ openClient })=>{
            const words = new Int32Array(workerData.memory);
            const client = openClient(workerData.memory, { spinMs: 0 });
            const nap = new Int32Array(new SharedArrayBuffer(4));
            for (let n = 0; n < 3; n++)
            {
                while (Atomics.load(words, 5) === 0)
                    Atomics.wait(nap, 0, 0, 1);
                client.ask([n]);
            }
        });`, { eval: true, workerData: { channel: new URL('./channel.js', import.meta.url).href,
        memory } });
    for (let n = 0; n < 3; n++)
    {
        assert.equal(server.serve(request=>[request[0] + 1]), 1);
    }
    await asking.terminate();
    assert.equal(server.spin?.waits, 3, 'each wait for a request took the learning spin');
    assert.equal(server.spin?.looks, 3351, 'an eighth less for each of three waits that slept');
    assert.equal(openServer(memory, { spinMs: 0.01 }).spin, null, 'a spin of its own learns nothing');
});

test('an asking side\'s blocking waits learn their spin from answers that come only once it'
    + ' sleeps', { timeout: 60_000 }, async()=>{
    const memory = createChannel({ slots: 2, slotBytes: 8 });
    const client = openClient(memory);
    // The handler answers only once the asking side counted itself asleep
    // (the header's third word).
    const serving = new Worker(`
        const { workerData } = require('node:worker_threads');
        import(workerData.channel).then(({ openServer })=>{
            const words = new Int32Array(workerData.memory);
            const server = openServer(workerData.memory, { spinMs: 0 });
            const nap = new Int32Array(new SharedArrayBuffer(4));
            for (let n = 0; n < 3; n++)
            {
                server.serve(request=>{
                    while (Atomics.load(words, 2) === 0)
                        Atomics.wait(nap, 0, 0, 1);
                    return [request[0] * 2];
                });
            }
        });`, { eval: true, workerData: { channel: new URL('./channel.js', import.meta.url).href,
        memory } });
    for (let n = 0; n < 3; n++)
    {
        assert.deepEqual([...client.ask([n + 1])], [(n + 1) * 2]);
    }
    await serving.terminate();
    assert.equal(client.spin?.waits, 3, 'each wait for an answer took the learning spin');
    assert.equal(client.spin?.looks, 3351, 'an eighth less for each of three waits that slept');
    assert.equal(openClient(memory, { spinMs: 0 }).spin, null, 'a spin of its own learns nothing');
});
