/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { LinkClosed, createLinkMemory, openLink } from './link.js';

const LINK = new URL('./link.js', import.meta.url).href;

/**
 * What a test left open - its workers, its sides of links - is ended after
 * it: a test that fails or runs out of time then ends the file with its
 * failure, rather than holding the file open for good.
 *
 * @type {Set<{ terminate?: () => any, close?: () => any }>}
 */
const left = new Set();
afterEach(async()=>{
    for (const each of left)
    {
        await (each.terminate?.() ?? each.close?.());
    }
    left.clear();
});
/** `openLink`, the side ended after the test. @type {typeof openLink} */
const open = (end, handlers, options)=>{
    const link = openLink(end, handlers, options);
    left.add(link);
    return link;
};
/** A worker, ended after the test. @param {Worker} worker */
const kept = worker=>{
    left.add(worker);
    return worker;
};

/**
 * A thread that runs `body` with its side of a link open, and posts what it
 * returns: a side that blocks while it waits.
 *
 * @param {import('./link.js').LinkEnd} end
 * @param {string} body  the function's body; `link` and `openLink` are in scope
 * @param {string} [handlers]  an expression for the handlers it answers with
 * @param {string} [options]  an expression for the options it opens with
 */
const blockingThread = (end, body, handlers = '{}', options = '{}')=>new Promise((resolve, reject)=>{
    const worker = kept(new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        import(workerData.module).then(({ openLink })=>{
            let link;
            const handlers = ${handlers};
            link = openLink(workerData.end, handlers, ${options});
            const run = ()=>{ ${body} };
            try { parentPort.postMessage({ value: run() }); }
            catch (e) { parentPort.postMessage({ error: String(e.message) }); }
        });`, { eval: true, workerData: { module: LINK, end } }));
    worker.once('message', message=>{
        worker.terminate();
        if ('error' in message)
        {
            reject(new Error(message.error));
        }
        else
        {
            resolve(message.value);
        }
    });
    worker.once('error', reject);
});

test('a blocked side is answered by the other, in order, failures and all', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        /** @type {Map<string, Uint8Array>} */
        const values = new Map();
        const system = open(a, { registry: {
            set: (/** @type {string} */ name, /** @type {Uint8Array} */ data)=>{
                values.set(name, data);
                return values.size;
            },
            // Answered later, on the event loop.
            get: async(/** @type {string} */ name)=>{
                await new Promise(resolve=>setTimeout(resolve, 5));
                return values.get(name) ?? null;
            },
            fail: ()=>{
                throw new Error('no such key');
            },
        } });
        const serving = system.serve();
        const answers = await blockingThread(b, `
            const set = [link.ask('registry', 'set', ['a', Uint8Array.of(1, 2)]),
                link.ask('registry', 'set', ['b', Uint8Array.of(3)])];
            const got = link.ask('registry', 'get', ['a']);
            let failed = null;
            try { link.ask('registry', 'fail'); } catch (e) { failed = e.message; }
            const unknown = (()=>{ try { link.ask('nobody', 'home'); } catch (e) {
                return e.message; } })();
            return { set, got: [...got], failed, unknown };`);
        assert.deepEqual(answers, { set: [1, 2], got: [1, 2], failed: 'no such key',
            unknown: 'link: nothing answers nobody.home' });
        system.close();
        await serving;
    });

test('the serving side asks a blocked side back while it waits, and is answered',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        /** @type {ReturnType<typeof openLink>} */
        let system;
        system = open(a, { windows: {
            find: async(/** @type {string} */ title)=>
                [await system.call('endpoint', 'describe', [title]), 'found'],
        } });
        const serving = system.serve();
        const answer = await blockingThread(b, 'return link.ask(\'windows\', \'find\', [\'Game\']);',
            '{ endpoint: { describe: title => "window " + title } }');
        assert.deepEqual(answer, ['window Game', 'found']);
        system.close();
        await serving;
    });

test('two blocked sides: one\'s call needs the other, which is itself waiting on the server',
    { timeout: 20000 }, async()=>{
        const one = createLinkMemory();
        const two = createLinkMemory();
        /** @type {() => void} */
        let release = ()=>{};
        const held = new Promise(resolve=>{
            release = ()=>resolve('released');
        });
        // The second side waits here until the first's call is done.
        const toTwo = open(two.a, { system: { hold: ()=>held } });
        const toOne = open(one.a, { windows: {
            post: async(/** @type {number} */ value)=>{
                const echoed = await toTwo.call('endpoint', 'take', [value]);
                release();
                return echoed;
            },
        } });
        const serving = [toOne.serve(), toTwo.serve()];
        const second = blockingThread(two.b, 'return link.ask(\'system\', \'hold\');',
            '{ endpoint: { take: value => value * 2 } }');
        // The second is blocked in its call before the first asks.
        await new Promise(resolve=>setTimeout(resolve, 50));
        const first = blockingThread(one.b, 'return link.ask(\'windows\', \'post\', [21]);');
        assert.deepEqual(await Promise.all([first, second]), [42, 'released']);
        toOne.close();
        toTwo.close();
        await Promise.all(serving);
    });

test('calls back and forth nest forty deep, each answered at its own depth', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory({ capacity: 4096 });
        // Two blocking sides: each answers `down(n)` by asking the other for `down(n - 1)`.
        const handlers = `{ t: { down: n => n === 0 ? [] : [n, ...link.ask('t', 'down', [n - 1])] } }`;
        const other = kept(new Worker(`
            const { workerData } = require('node:worker_threads');
            import(workerData.module).then(({ openLink })=>{
                let link;
                link = openLink(workerData.end, ${handlers});
                // Serves until the link closes.
                const seen = () => link.bell.seen();
                for (;;) { const s = seen(); link.pump(); if (link.closed()) break; link.bell.wait(s); }
            });`, { eval: true, workerData: { module: LINK, end: a } }));
        const answer = await blockingThread(b, 'const got = link.ask(\'t\', \'down\', [40]); link.close();'
            + ' return got;', handlers);
        assert.deepEqual(answer, Array.from({ length: 40 }, (_, i)=>40 - i));
        await other.terminate();
    });

test('two blocked sides call each other at once, each served while it waits', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        const gate = new Int32Array(new SharedArrayBuffer(4));
        const body = (/** @type {string} */ name)=>`
            Atomics.add(workerData.gate, 0, 1);
            while (Atomics.load(workerData.gate, 0) < 2) {}
            const got = [];
            for (let i = 0; i < 200; i++) got.push(link.ask('t', 'twice', [i]));
            // The other may still be asking: serve it until it says it is done.
            link.ask('t', 'done', []);
            while (!globalThis.done) { const s = link.bell.seen(); link.pump(); if (!globalThis.done) link.bell.wait(s, 1000); }
            return got.every((v, i) => v === '${name}' + 2 * i);`;
        const run = (/** @type {any} */ end, /** @type {string} */ name)=>new Promise((resolve, reject)=>{
            const worker = kept(new Worker(`
                const { workerData, parentPort } = require('node:worker_threads');
                import(workerData.module).then(({ openLink })=>{
                    const link = openLink(workerData.end, { t: {
                        twice: n => '${name === 'a' ? 'b' : 'a'}' + 2 * n,
                        done: () => { globalThis.done = true; } } });
                    parentPort.postMessage((()=>{ ${body(name)} })());
                });`, { eval: true, workerData: { module: LINK, end, gate } }));
            worker.once('message', value=>{
                worker.terminate();
                resolve(value);
            });
            worker.once('error', reject);
        });
        assert.deepEqual(await Promise.all([run(a, 'a'), run(b, 'b')]), [true, true]);
    });

test('a side waiting on a call of its own handles the calls after it in their order, each once',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        /** @type {any[]} */
        const read = [];
        const system = open(a, {
            processes: { start: ()=>{
                read.push(system.call('parent', 'read', [1]), system.call('parent', 'read', [2]));
                return true;
            } },
            volume: { get: (/** @type {number} */ n)=>n * 10 },
        });
        const serving = system.serve();
        const order = await blockingThread(b, `
            link.ask('processes', 'start', []);
            return globalThis.order;`, `{ parent: { read: n=>{
                (globalThis.order ??= []).push('in ' + n);
                const got = link.ask('volume', 'get', [n]);
                globalThis.order.push('out ' + n);
                return got;
            } } }`);
        assert.deepEqual(await Promise.all(read), [10, 20]);
        assert.deepEqual(order, ['in 1', 'in 2', 'out 2', 'out 1'],
            'each once; the second, come while the first waited, handled inside that wait');
        system.close();
        await serving;
    });

test('answers that come out of nesting order each reach the wait they are for', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        /** @type {(value: string) => void} */
        let answerOuter = ()=>{};
        /** @type {ReturnType<typeof openLink>} */
        let system;
        system = open(a, { t: {
            // The outer call is answered only once the inner one is asked...
            outer: ()=>{
                system.call('side', 'nest', []).catch(()=>{});
                return new Promise(resolve=>{
                    answerOuter = resolve;
                });
            },
            // ... and before it: the blocked side's outer wait has its
            // answer while its inner wait still waits.
            inner: ()=>{
                answerOuter('outer');
                return new Promise(resolve=>setTimeout(()=>resolve('inner'), 20));
            },
        } });
        const serving = system.serve();
        const got = await blockingThread(b, `
            const outer = link.ask('t', 'outer', []);
            return { outer, inner: globalThis.inner };`, `{ side: { nest: ()=>{
                globalThis.inner = link.ask('t', 'inner', []);
            } } }`);
        assert.deepEqual(got, { outer: 'outer', inner: 'inner' });
        system.close();
        await serving;
    });

test('a failure crosses with what it says of itself, not only its message', { timeout: 20000 },
    async()=>{
        const { a, b } = createLinkMemory();
        const system = open(a, { volume: {
            read: ()=>{
                throw Object.assign(new Error('blocks are missing'),
                    { code: 'BLOCK_MISS', blocks: [{ index: 3, offset: 0, packed: 7 }], drop: ()=>0 });
            },
        } });
        const serving = system.serve();
        const answer = await blockingThread(b, `
            try { link.ask('volume', 'read'); return null; }
            catch (e) { return { message: e.message, code: e.code, blocks: e.blocks, drop: e.drop }; }`);
        assert.deepEqual(answer, { message: 'blocks are missing', code: 'BLOCK_MISS',
            blocks: [{ index: 3, offset: 0, packed: 7 }], drop: undefined });
        // And the other way, to a promise.
        const back = open(b, { endpoint: { fail: ()=>{
            throw Object.assign(new Error('no window'), { code: 1400 });
        } } });
        const asked = system.call('endpoint', 'fail');
        back.pump();
        await assert.rejects(asked, (/** @type {any} */ e)=>e.code === 1400
            && e.message === 'no window');
        system.close();
        await serving;
    });

test('an answer that cannot cross reaches the caller as a failure, and the link goes on',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        const system = open(a, { odd: { handler: ()=>()=>0, plain: ()=>42 } });
        const serving = system.serve();
        const answer = await blockingThread(b, `
            let failed = null;
            try { link.ask('odd', 'handler', []); }
            catch (e) { failed = e.message; }
            return { failed, after: link.ask('odd', 'plain', []) };`);
        system.close();
        await serving;
        assert.match(answer.failed, /cannot cross/);
        assert.equal(answer.after, 42);
    });

test('calls that together overflow the ring all cross, the writer waiting for room',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory({ capacity: 4096 });
        let total = 0;
        const system = open(a, { sink: { take: (/** @type {Uint8Array} */ bytes)=>{
            total += bytes.length;
            return total;
        } } });
        const serving = system.serve();
        const answer = await blockingThread(b, `
            let last = 0;
            for (let i = 0; i < 64; i++) last = link.ask('sink', 'take', [new Uint8Array(1500)]);
            return last;`);
        assert.equal(answer, 64 * 1500);
        system.close();
        await serving;
    });

test('a call and an answer longer than a ring holds cross in parts, whole and in order',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory({ capacity: 64 * 1024 });
        const big = (/** @type {number} */ size, /** @type {number} */ seed)=>
            Uint8Array.from({ length: size }, (_, at)=>(at * 31 + seed) & 0xff);
        const system = open(a, { volume: {
            read: (/** @type {number} */ size)=>big(size, 7),
            sum: (/** @type {Uint8Array} */ bytes)=>bytes.reduce((sum, byte)=>(sum + byte) >>> 0, 0),
        } });
        const serving = system.serve();
        const answer = await blockingThread(b, `
            const read = link.ask('volume', 'read', [300000]);
            const small = link.ask('volume', 'read', [16]);
            const sent = Uint8Array.from({ length: 200000 }, (_, at)=>(at * 31 + 3) & 0xff);
            const sum = link.ask('volume', 'sum', [sent]);
            return { length: read.length, head: [...read.subarray(0, 4)],
                tail: [...read.subarray(-4)], small: small.length, sum };`);
        system.close();
        await serving;
        const expected = big(300000, 7);
        assert.deepEqual(answer, {
            length: 300000, head: [...expected.subarray(0, 4)], tail: [...expected.subarray(-4)],
            small: 16, sum: big(200000, 3).reduce((sum, byte)=>(sum + byte) >>> 0, 0),
        });
    });

test('a side counts what it asked of the other and how long it waited, by target and method',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        const system = open(a, { registry: { get: ()=>1 }, ids: { take: ()=>2 } });
        const serving = system.serve();
        const counted = await blockingThread(b, `
            for (let i = 0; i < 3; i++) link.ask('registry', 'get', []);
            link.ask('ids', 'take', []);
            return link.diagnostics();`);
        system.close();
        await serving;
        assert.equal(counted.calls, 4);
        assert.deepEqual(counted.asked.map((/** @type {any} */ row)=>[row.name, row.count]).sort(),
            [['ids.take', 1], ['registry.get', 3]]);
        assert.ok(counted.waitedMs > 0 && counted.asked.every((/** @type {any} */ row)=>
            row.waitedMs > 0), 'each blocked for its answer');
    });

test('what a side said before the link closed is heard', { timeout: 20000 }, async()=>{
    const { a, b } = createLinkMemory();
    /** @type {number[]} */
    const heard = [];
    const system = open(a, { events: { emit: (/** @type {number} */ n)=>void heard.push(n) } });
    const serving = system.serve();
    await new Promise(resolve=>setImmediate(resolve));
    // The other side tells and ends while this thread is held, and the link
    // is closed before the serving side had a turn to look.
    const done = new Int32Array(new SharedArrayBuffer(4));
    const worker = kept(new Worker(`
        const { workerData } = require('node:worker_threads');
        import(workerData.module).then(({ openLink })=>{
            const link = openLink(workerData.end, {});
            for (let i = 0; i < 20; i++) link.call('events', 'emit', [i]);
            Atomics.store(workerData.done, 0, 1);
            Atomics.notify(workerData.done, 0);
        });`, { eval: true, workerData: { module: LINK, end: b, done } }));
    Atomics.wait(done, 0, 0, 10000);
    system.close();
    await serving;
    await worker.terminate();
    assert.deepEqual(heard, [...Array(20).keys()]);
});

test('a closed link fails the calls still waiting on it and every call after, on both sides',
    { timeout: 20000 }, async()=>{
        const { a, b } = createLinkMemory();
        const system = open(a, {});
        const serving = system.serve();
        // The other side never answers: a thread that died.
        const gone = open(b, {});
        const asked = system.call('endpoint', 'find', [7]);
        const told = gone.call('events', 'emit', [1]);
        system.close();
        await serving;
        await assert.rejects(asked, (/** @type {any} */ e)=>e instanceof LinkClosed
            && /endpoint\.find/.test(e.message), 'the waiting call fails');
        await assert.rejects(system.call('endpoint', 'find', [8]), LinkClosed,
            'and a call after the close fails at once');
        assert.throws(()=>system.ask('endpoint', 'find', [9]), LinkClosed,
            'a blocking one too, rather than waiting for good');
        gone.close();
        await assert.rejects(told, LinkClosed, 'the side that serves nothing fails its own');
    });

test('a side that closes the link closes it for the other, and a call in another thread waiting'
    + ' for room to write is let go', { timeout: 60000 }, async t=>{
    const memory = createLinkMemory({ capacity: 4096 });
    const here = open(memory.a, {});
    const there = open(memory.b, { echo: { back: (/** @type {any} */ value)=>value } });
    const serving = there.serve();
    here.close();
    await serving;
    await assert.rejects(there.call('echo', 'back', [6]), /closed/);
    assert.throws(()=>there.ask('echo', 'back', [7], 5000), /closed/);

    // A call far longer than the ring, from a thread that may block: its parts
    // fill the ring nobody here reads, and it waits for room - until the close.
    const other = createLinkMemory({ capacity: 4096 });
    const quiet = open(other.a, {});
    const caller = kept(new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.module).then(({ openLink })=>{
            const link = openLink(workerData.end, {});
            parentPort.postMessage('calling');
            try { link.ask('nobody', 'home', [new Uint8Array(1 << 16)]); parentPort.postMessage('answered'); }
            catch (e) { parentPort.postMessage(e.message); }
        });`, { eval: true, workerData: { module: LINK, end: other.b } }));
    caller.unref();
    t.after(()=>caller.terminate());
    /** @type {string[]} */
    const said = [];
    const ended = new Promise((resolve, reject)=>{
        caller.on('message', message=>{
            said.push(message);
            if (message !== 'calling')
            {
                resolve(message);
            }
        });
        caller.once('error', reject);
    });
    while (said.length === 0)
    {
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
    // Long enough for the call's parts to fill the ring and the caller to sleep.
    await new Promise(resolve=>setTimeout(resolve, 200));
    quiet.close();
    assert.match(String(await ended), /closed/, 'the waiting call was let go');
});

test('a record is decoded where it lies in the ring, not copied out of it first', async()=>{
    const { a, b } = createLinkMemory();
    /** @type {number[][]} */
    const taken = [];
    const system = open(a, {});
    const other = open(b, { endpoint: {
        take: (/** @type {number[]} */ values)=>void taken.push(values),
    } });
    const values = Array.from({ length: 200 }, (_, i)=>i * 7);
    const told = system.call('endpoint', 'take', [values]);
    /** @type {number[]} */
    const copied = [];
    const slice = Uint8Array.prototype.slice;
    Uint8Array.prototype.slice = function(/** @type {any[]} */ ...args){
        if (this.buffer instanceof SharedArrayBuffer)
        {
            copied.push(this.length);
        }
        return slice.apply(this, /** @type {any} */ (args));
    };
    try
    {
        other.pump();
    }
    finally
    {
        Uint8Array.prototype.slice = slice;
    }
    assert.deepEqual(taken, [values]);
    // What the decoder copies are the record's short strings: the target and
    // the method's names. A copy of the whole record is the bytes of 200 values.
    assert.ok(copied.every(length=>length < 64), `copied out of the ring: ${copied.join(', ')}`);
    system.pump();
    assert.equal(await told, undefined);
});

test('a blocking call to a side of the same thread is served in place, values and words', ()=>{
    const { a, b } = createLinkMemory();
    const served = open(a, { math: { double: (/** @type {number} */ n)=>n * 2 } }, {
        words: (request, answer)=>{
            answer[0] = request[0] + request[1];
        },
    });
    const asking = open(b, {});
    // The serving side has no turn of its own: this thread is held by the asks.
    assert.equal(asking.ask('math', 'double', [21]), 42);
    asking.request[0] = 40;
    asking.request[1] = 2;
    asking.sendWords();
    asking.waitWords();
    assert.equal(asking.answer[0], 42);
    // One whose answer waits for this thread's event loop could never come.
    const { a: a2, b: b2 } = createLinkMemory();
    open(a2, { slow: { one: async()=>1 } });
    assert.throws(()=>open(b2, {}).ask('slow', 'one'), /in this thread and answered nothing/);
    served.close();
});

test('word calls go both ways at once, nested, and a failure crosses as a value', ()=>{
    const { a, b } = createLinkMemory({ words: 2 });
    /** @type {ReturnType<typeof openLink>} */
    let process;
    // The executor of a slice: it calls back for each trap while the slice is out.
    const executor = open(b, {});
    process = open(a, {}, { words: (request, answer)=>{
        if (request[0] < 0)
        {
            throw Object.assign(new Error('no handler'), { code: 5 });
        }
        answer[0] = request[0] * 10;
    } });
    process.request[0] = 3;
    process.sendWords();
    assert.equal(process.answered(), false);
    assert.throws(()=>process.sendWords(), /another is out/, 'one word call at a time');
    const run = executor.takeWords();
    assert.ok(run !== null && run[0] === 3);
    assert.equal(executor.takeWords(), null, 'taken once');
    /** @type {number[]} */
    const traps = [];
    for (let trap = 1; trap <= 3; trap++)
    {
        executor.request[0] = trap;
        executor.sendWords();
        executor.waitWords();
        traps.push(executor.answer[0]);
    }
    executor.request[0] = -1;
    executor.sendWords();
    assert.throws(()=>executor.waitWords(), (/** @type {any} */ e)=>e.code === 5
        && e.message === 'no handler');
    executor.reply[0] = traps.reduce((x, y)=>x + y, 0);
    executor.answerWords();
    assert.throws(()=>executor.answerWords(), /no call taken/);
    assert.equal(process.answered(), true);
    assert.equal(process.answer[0], 60);
    assert.equal(process.answered(), false, 'taken once');
    executor.close();
    assert.throws(()=>process.sendWords(), LinkClosed);
});

test('calls in place: bytes each way, several out at once, answers read where they lie, in order',
    async()=>{
        const { a, b } = createLinkMemory({ words: 4, slots: 4 });
        /** @type {number[]} */
        const seen = [];
        // The answer: the request's bytes doubled, as long as the request says.
        const server = open(a, {}, { words: (request, answer, length)=>{
            const bytes = new Uint8Array(request.buffer, request.byteOffset, length);
            const out = new Uint8Array(answer.buffer, answer.byteOffset, length);
            seen.push(bytes[0]);
            for (let n = 0; n < length; n++)
            {
                out[n] = bytes[n] * 2;
            }
            if (bytes[0] === 99)
            {
                throw Object.assign(new Error('refused'), { code: 7 });
            }
            return bytes[0] === 98 ? 17 : length;
        } });
        const asking = open(b, {});
        const later = [1, 2, 3].map(tag=>asking.callBytes([tag, tag], answer=>[...answer]));
        assert.deepEqual(asking.askBytes([4, 5, 6], answer=>[...answer]), [8, 10, 12],
            'its own answer, read in place, after the calls before it');
        assert.deepEqual(await Promise.all(later), [[2, 2], [4, 4], [6, 6]]);
        assert.deepEqual(seen, [1, 2, 3, 4], 'answered in the order they went');
        assert.throws(()=>asking.askBytes([99], ()=>null), (/** @type {any} */ e)=>e.code === 7
            && e.message === 'refused');
        assert.throws(()=>asking.askBytes([98], ()=>null), /an answer of 17 bytes, a slot holds 16/);
        assert.throws(()=>asking.askBytes(new Uint8Array(17), ()=>null), /a slot holds 16/);
        assert.deepEqual(asking.askBytes([], answer=>answer.length), 0, 'no bytes either way');
        server.close();
        await assert.rejects(asking.callBytes([1], ()=>null), LinkClosed);
    });

test('a call in place made inside the wait for another takes the next slot; with none left it '
    + 'is refused, said', async()=>{
    for (const slots of [2, 1])
    {
        const { a, b } = createLinkMemory({ words: 2, slots });
        /** @type {ReturnType<typeof openLink>} */
        let asking;
        // The side asked calls back with a value before it answers: the asking
        // side answers that inside its wait, with a call in place of its own.
        const server = open(a, {}, { words: (request, answer)=>{
            answer[0] = request[0] + 1;
        } });
        let inner = /** @type {any} */ (null);
        asking = open(b, { back: { now: ()=>{
            try
            {
                inner = asking.askBytes([7, 0, 0, 0], answer=>answer[0]);
            }
            catch (e){
                inner = String(e);
            }
            return null;
        } } });
        const back = server.call('back', 'now');
        // The value call is in before the call in place's answer.
        assert.equal(asking.askBytes([1, 0, 0, 0], answer=>answer[0]), 2);
        server.pump();
        assert.equal(await back, null, 'the value call answered too');
        assert.equal(inner, slots === 2 ? 8 : 'Error: link: a call in place: every call in place is out (1)');
        server.close();
    }
});

test('memory that is no link is refused', ()=>{
    const { a } = createLinkMemory();
    assert.throws(()=>open({ ...a, words: new SharedArrayBuffer(64) }), /not a link/);
    assert.throws(()=>createLinkMemory({ words: -1 }), RangeError);
});

test('an answer in place is read before its slot is anyone else\'s: a call made inside the read is '
    + 'refused, the answer read intact', ()=>{
    const { a, b } = createLinkMemory({ words: 1, slots: 1 });
    const server = open(a, {}, { words: (request, answer)=>{
        answer[0] = request[0];
    } });
    const asking = open(b, {});
    let nested = /** @type {any} */ (null);
    const read = asking.askBytes([17, 0, 0, 0], answer=>{
        const before = answer[0];
        try
        {
            nested = asking.askBytes([42, 0, 0, 0], inner=>inner[0]);
        }
        catch (e){
            nested = String(e);
        }
        return [before, answer[0]];
    });
    assert.deepEqual(read, [17, 17], 'the outer answer, as it was');
    assert.match(nested, /every call in place is out/);
    assert.equal(asking.askBytes([5, 0, 0, 0], answer=>answer[0]), 5, 'the slot free again after');
    server.close();
});

test('a call in place whose slot was found free by waiting takes the slot of its own number, '
    + 'whatever was called while it waited', async()=>{
    const { a, b } = createLinkMemory({ words: 1, slots: 2 });
    /** @type {number[]} */
    const seen = [];
    const server = open(a, {}, { words: (request, answer)=>{
        seen.push(request[0] & 255);
        answer[0] = request[0];
    } });
    /** @type {ReturnType<typeof openLink>} */
    let asking;
    let inner = 0;
    asking = open(b, { back: { now: ()=>{
        inner = asking.askBytes([33, 0, 0, 0], answer=>answer[0]);
        return null;
    } } });
    // In before the calls in place: handled in the wait the third one makes for a slot.
    const back = server.call('back', 'now');
    const first = asking.callBytes([11, 0, 0, 0], answer=>answer[0]);
    const second = asking.callBytes([22, 0, 0, 0], answer=>answer[0]);
    const outer = asking.askBytes([44, 0, 0, 0], answer=>answer[0]);
    server.pump();
    assert.deepEqual([await first, await second, inner, outer], [11, 22, 33, 44]);
    assert.deepEqual(seen, [11, 22, 33, 44], 'the server read each request once, in order');
    assert.equal(await back, null);
    server.close();
});

test('a word call\'s request is written where no call out lies, whatever it waits for to be sent',
    async()=>{
    const { a, b } = createLinkMemory({ words: 1, slots: 1 });
    const server = open(a, {}, { words: (request, answer)=>{
        answer[0] = request[0];
    } });
    const asking = open(b, {});
    const first = asking.callBytes([17, 0, 0, 0], answer=>answer[0]);
    asking.request[0] = 42;
    asking.sendWords();
    asking.waitWords();
    assert.equal(asking.answer[0], 42);
    assert.equal(await first, 17, 'the call out before it answered with its own request');
    server.close();
});

test('a hook after a send that throws fails no call: the call is answered, the next has its slot, '
    + 'the failure told', async()=>{
    const { a, b } = createLinkMemory({ words: 1, slots: 1 });
    const server = open(a, {}, { words: (request, answer)=>{
        answer[0] = request[0] + 1;
    } });
    /** @type {unknown[]} */
    const told = [];
    let throws = 1;
    const asking = open(b, {}, { afterSend: ()=>{
        if (throws-- > 0)
        {
            throw new Error('hook failed');
        }
    }, onAfterSendFailure: e=>told.push(e) });
    assert.equal(asking.askBytes([1, 0, 0, 0], answer=>answer[0]), 2);
    assert.equal(asking.askBytes([2, 0, 0, 0], answer=>answer[0]), 3);
    assert.equal(told.length, 0, 'told after the send, not inside it');
    await Promise.resolve();
    assert.equal(told.length, 1);
    assert.match(String(told[0]), /hook failed/);
    assert.equal(asking.diagnostics().afterSendFailures, 1);
    server.close();
});

test('a handler of a failed hook that throws fails no call either: its throw is its own, not the '
    + 'send\'s', { timeout: 20000 }, async()=>{
    const worker = kept(new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData).then(({ createLinkMemory, openLink })=>{
            const { a, b } = createLinkMemory({ words: 1, slots: 1 });
            const server = openLink(a, {}, { words: (request, answer)=>{
                answer[0] = request[0] + 1;
            } });
            const asking = openLink(b, {}, {
                afterSend: ()=>{ throw new Error('hook'); },
                onAfterSendFailure: ()=>{ throw new Error('handler'); },
            });
            const answers = [];
            for (let n = 1; n <= 3; n++)
            {
                try { answers.push(asking.askBytes([n, 0, 0, 0], answer=>answer[0])); }
                catch (e) { answers.push(String(e.message)); }
            }
            parentPort.postMessage({ answers, failures: asking.diagnostics().afterSendFailures });
        });`, { eval: true, workerData: LINK }));
    const said = /** @type {any} */ (await new Promise(resolve=>worker.once('message', resolve)));
    assert.deepEqual(said, { answers: [2, 3, 4], failures: 3 }, 'every call answered, its slot free');
    const thrown = await new Promise(resolve=>worker.once('error', resolve));
    assert.match(String(thrown), /handler/, 'the handler\'s throw is said where nothing catches it');
});

test('a value longer than the ring crosses to a side of the same thread, and back, as the writer '
    + 'waits for room', { timeout: 20000 }, async()=>{
    // Both sides in one worker: the side waiting for room in its ring is the
    // only one that can read it, by serving the other in place.
    const worker = kept(new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData).then(({ createLinkMemory, openLink })=>{
            const { a, b } = createLinkMemory({ capacity: 256 });
            const server = openLink(a, { echo: { back: value=>value + '!' } });
            const asking = openLink(b, {});
            const long = 'x'.repeat(1024);
            parentPort.postMessage(asking.ask('echo', 'back', [long]) === long + '!');
            server.close();
        });`, { eval: true, workerData: LINK }));
    const answer = await Promise.race([new Promise(resolve=>worker.once('message', resolve)),
        new Promise(resolve=>setTimeout(()=>resolve('held'), 10000))]);
    assert.equal(answer, true, 'crossed, not held for good');
});

test('two blocked sides each sending a value longer than the ring both cross: each reads the other '
    + 'while it waits for room', { timeout: 30000 }, async()=>{
    const { a, b } = createLinkMemory({ capacity: 256 });
    const body = `
        const long = 'y'.repeat(2048);
        return link.ask('echo', 'back', [long]) === long + '!';`;
    const handlers = `{ echo: { back: value=>value + '!' } }`;
    const both = Promise.all([blockingThread(a, body, handlers), blockingThread(b, body, handlers)]);
    const answer = await Promise.race([both,
        new Promise(resolve=>setTimeout(()=>resolve('held'), 15000))]);
    assert.deepEqual(answer, [true, true], 'both crossed, not held for good');
});

test('a blocking call made while its side waits for room to send a record before it fails, said, '
    + 'rather than wait for good', { timeout: 20000 }, async()=>{
    const worker = kept(new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData).then(({ createLinkMemory, openLink })=>{
            const { a, b } = createLinkMemory({ capacity: 256 });
            let asking;
            let inner = null;
            // The server calls back as it reads the long value: the asking
            // side handles that while it waits for room, and asks in turn.
            let echoed = 0;
            const server = openLink(a, { echo: { back: value=>(echoed++, value.length) } });
            asking = openLink(b, { nested: { now: ()=>{
                try { inner = asking.ask('echo', 'back', ['z']); }
                catch (e) { inner = String(e.message); }
                return null;
            } } });
            server.call('nested', 'now');
            const length = asking.ask('echo', 'back', ['x'.repeat(1024)]);
            // What is left to come in, come in: a refused call would be here.
            const after = asking.ask('echo', 'back', ['after']);
            server.pump();
            parentPort.postMessage({ length, inner, after, echoed });
            server.close();
        });`, { eval: true, workerData: LINK }));
    const answer = /** @type {any} */ (await Promise.race([new Promise(resolve=>worker.once('message', resolve)),
        new Promise(resolve=>setTimeout(()=>resolve('held'), 10000))]));
    assert.equal(answer.length, 1024);
    assert.match(String(answer.inner), /waits to send a record before it/);
    assert.equal(answer.after, 5, 'the next call goes out');
    assert.equal(answer.echoed, 2, 'the refused call never ran on the other side');
});

test('a blocking call in place with a time waits that long in all, for its slot as for its answer',
    { timeout: 20000 }, async()=>{
    // The other side is in a worker that never answers a call in place: the
    // one slot is out with a promise's call, and the next call's time runs
    // out while it waits for the slot.
    const { a, b } = createLinkMemory({ words: 1, slots: 1 });
    const worker = kept(new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        import(workerData.module).then(({ openLink })=>{
            openLink(workerData.end, {});
            parentPort.postMessage('open');
            setTimeout(()=>{}, 60000);
        });`, { eval: true, workerData: { module: LINK, end: a } }));
    await new Promise(resolve=>worker.once('message', resolve));
    const asking = open(b, {});
    asking.callBytes([1, 0, 0, 0], answer=>answer[0]).catch(()=>{});
    const started = performance.now();
    assert.throws(()=>asking.askBytes([2, 0, 0, 0], answer=>answer[0], 200), /200 ms/);
    const took = performance.now() - started;
    assert.ok(took >= 190 && took < 5000, `${took.toFixed(0)} ms`);
});

test('a call in place refused by a side that cannot block brings its failure whole, behind any '
    + 'records that side had still to send', { timeout: 30000 }, async()=>{
    // The answering side is a page's own thread: Atomics.wait throws there.
    // It has sent the asking side long calls the ring has no room for yet,
    // and refuses the word call that comes; its failure is a record behind
    // those, and the answer's count must not be published before it is out.
    const { a, b } = createLinkMemory({ capacity: 256, words: 1, slots: 1 });
    const worker = kept(new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        Atomics.wait = ()=>{ throw new TypeError('a page does not block'); };
        import(workerData.module).then(({ openLink })=>{
            const link = openLink(workerData.end, {}, { words: ()=>{
                throw Object.assign(new Error('refused'), { code: 7 });
            } });
            for (let i = 0; i < 40; i++)
            {
                link.call('sink', 'take', ['x'.repeat(300)]).catch(()=>{});
            }
            link.serve();
            parentPort.postMessage('serving');
        });`, { eval: true, workerData: { module: LINK, end: a } }));
    await new Promise(resolve=>worker.once('message', resolve));
    let taken = 0;
    const asking = open(b, { sink: { take: ()=>{
        taken++;
        return null;
    } } });
    asking.request[0] = 1;
    asking.sendWords();
    assert.throws(()=>asking.waitWords(10000), (/** @type {any} */ e)=>e.message === 'refused' && e.code === 7,
        'the failure the other side threw, not "a call in place failed"');
    assert.ok(taken > 0, 'the records before it were read on the way');
});
