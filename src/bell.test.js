/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createDoorbell, createSpin, deadlineOf, learnt, nextLooks, openDoorbell, publish, waitFor,
    waitForAsync, wake } from './bell.js';

const WORD = 0;
const SLEEPS = 1;
const CLOSED = 2;

test('a side that moves a word notifies only while a wait sleeps on it', { timeout: 10000 },
    async()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    assert.equal(publish(words, WORD, 1, SLEEPS), false, 'nobody sleeps: no notify');
    const waiting = waitForAsync(words, WORD, 1, SLEEPS, performance.now() + 5000);
    assert.equal(Atomics.load(words, SLEEPS), 1, 'the wait counted itself before it slept');
    assert.equal(publish(words, WORD, 2, SLEEPS), true);
    assert.equal(await waiting, 'woke');
    assert.equal(Atomics.load(words, SLEEPS), 0, 'and took itself off when it woke');
    assert.equal(wake(words, WORD, SLEEPS), false);
});

test('a wait ends at once on a word already moved, at its deadline, and on the closed word', async()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    assert.equal(waitFor(words, WORD, 5, SLEEPS), 'moved');
    assert.equal(waitFor(words, WORD, 0, SLEEPS, performance.now() + 5), 'timed-out');
    assert.equal(await waitForAsync(words, WORD, 0, SLEEPS, performance.now() + 5), 'timed-out');
    Atomics.store(words, CLOSED, 1);
    assert.equal(waitFor(words, WORD, 0, SLEEPS, Infinity, undefined, CLOSED), 'closed');
    assert.equal(await waitForAsync(words, WORD, 0, SLEEPS, Infinity, CLOSED), 'closed');
    assert.equal(Atomics.load(words, SLEEPS), 0);
});

/**
 * Two threads hand a turn back and forth through one word each way, each
 * waiting without a look first: every turn is a sleep and a wake that must
 * not be lost between the look and the sleep. A lost one leaves the sleeper
 * to its two-second deadline, every turn, and the test's own timeout fails it
 * long before 20 000 turns are done (the waits block their workers, never this
 * thread, whose timer must run; the deadline lets their thread end).
 */
test('no wake is lost between a wait\'s last look and its sleep', { timeout: 60000 }, async()=>{
    const turns = 20000;
    const ping = createDoorbell();
    const pong = createDoorbell();
    /**
     * @param {boolean} first @param {import('./bell.js').DoorbellMemory} there
     * @param {import('./bell.js').DoorbellMemory} here
     */
    const side = (first, there, here)=>new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.bell).then(({ openDoorbell })=>{
            const there = openDoorbell(workerData.there);
            const here = openDoorbell(workerData.here);
            let woke = 0;
            let notified = 0;
            for (let turn = 0; turn < workerData.turns; turn++)
            {
                if (workerData.first && here.ring()) notified++;
                const end = there.wait(turn, 2000, 0);
                if (end === 'timed-out') throw new Error('both sides asleep at turn ' + turn);
                if (end === 'woke') woke++;
                if (!workerData.first && here.ring()) notified++;
            }
            parentPort.postMessage({ woke, notified });
        });`, { eval: true, workerData: { bell: new URL('./bell.js', import.meta.url).href,
        first, there, here, turns } });
    const workers = [side(true, pong, ping), side(false, ping, pong)];
    // Two sides asleep for good must not keep the test's process alive.
    workers.forEach(worker=>worker.unref());
    try
    {
        const [first, second] = /** @type {{ woke: number, notified: number }[]} */ (
            await Promise.all(workers.map(worker=>new Promise((resolve, reject)=>{
                worker.once('message', resolve);
                worker.once('error', reject);
            }))));
        assert.ok(first.woke + second.woke > 0, 'a side did sleep and was woken');
        // A side notifies only a wait that counted itself asleep: never more
        // notifies than the other side's waits that ended so.
        assert.ok(first.notified <= second.woke && second.notified <= first.woke,
            JSON.stringify({ first, second }));
    }
    finally
    {
        await Promise.all(workers.map(worker=>worker.terminate()));
    }
});

test('a timeout or a spin that is not a number is refused, not a wait that never sleeps', async()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    assert.throws(()=>deadlineOf(NaN), RangeError);
    assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, NaN), RangeError);
    assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, Infinity, NaN), RangeError);
    await assert.rejects(waitForAsync(words, WORD, 0, SLEEPS, NaN), RangeError);
    assert.throws(()=>openDoorbell(createDoorbell()).wait(0, NaN), RangeError);
    assert.equal(Atomics.load(words, SLEEPS), 0);
});

test('a wait whose sleep throws (a thread that may not block) takes itself off the count', ()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    const wait = Atomics.wait;
    Atomics.wait = ()=>{
        throw new TypeError('Atomics.wait cannot be called in this context');
    };
    try
    {
        assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, Infinity, 0), TypeError);
    }
    finally
    {
        Atomics.wait = wait;
    }
    assert.equal(Atomics.load(words, SLEEPS), 0);
    assert.equal(publish(words, WORD, 1, SLEEPS), false, 'nobody counted asleep: no notify');
});

test('a wait with no deadline never reads the clock, spinning or asleep: it makes no garbage', async()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    const now = performance.now;
    let readings = 0;
    performance.now = function(){
        readings++;
        return now.call(performance);
    };
    try
    {
        // Spins to its end, then sleeps until another thread moves the word.
        const mover = new Worker(`
            const { workerData } = require('node:worker_threads');
            const words = new Int32Array(workerData);
            const nap = new Int32Array(new SharedArrayBuffer(4));
            Atomics.wait(nap, 0, 0, 50);
            Atomics.store(words, 0, 1);
            Atomics.notify(words, 0);`, { eval: true, workerData: words.buffer });
        assert.equal(waitFor(words, WORD, 0, SLEEPS, Infinity, 0.05), 'woke');
        await mover.terminate();
    }
    finally
    {
        performance.now = now;
    }
    assert.equal(readings, 0);
});

test('a spin that is not a finite time, or a deadline that is not a number, is refused', ()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    for (const spin of [Infinity, /** @type {any} */ ('1')])
    {
        assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, Infinity, spin), RangeError);
    }
    assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, /** @type {any} */ ('5')), RangeError);
    assert.equal(waitFor(words, WORD, 0, SLEEPS, performance.now() + 1, -1), 'timed-out',
        'a spin of none sleeps at once');
});

test('a spin past a second is refused: its count of looks would not end', ()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, Infinity, Number.MAX_VALUE), RangeError);
    assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, Infinity, 1001), RangeError);
});

test('an asynchronous wait whose sleep throws takes itself off the count', async()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    const waitAsync = /** @type {any} */ (Atomics).waitAsync;
    /** @type {any} */ (Atomics).waitAsync = ()=>{
        throw new TypeError('not a shared array');
    };
    try
    {
        await assert.rejects(waitForAsync(words, WORD, 0, SLEEPS, Infinity), TypeError);
    }
    finally
    {
        /** @type {any} */ (Atomics).waitAsync = waitAsync;
    }
    assert.equal(Atomics.load(words, SLEEPS), 0);
});

test('a wait on a bell past its words takes itself off the count', ()=>{
    const words = new Int32Array(new SharedArrayBuffer(12));
    assert.throws(()=>waitFor(words, WORD, 0, SLEEPS, Infinity, 0, -1, 99), RangeError);
    assert.equal(Atomics.load(words, SLEEPS), 0);
});

test('a spin looks an eighth less after a wait that slept, down to a few hundred, and keeps twice '
    + 'what a wait that ended looking needed, up to its most', ()=>{
    const spin = createSpin(0.05);
    assert.equal(spin.most, 5000);
    assert.equal(spin.looks, 5000, 'it begins with the whole spin');
    assert.equal(learnt(spin, 5000, true), 4375);
    assert.equal(learnt({ ...spin, looks: 280 }, 280, true), 256, 'never below a few hundred');
    assert.equal(learnt({ ...spin, looks: 256 }, 3, false), 256, 'a quick wait takes nothing away');
    assert.equal(learnt({ ...spin, looks: 256 }, 1800, false), 3600, 'a longer one gives back');
    assert.equal(learnt({ ...spin, looks: 4000 }, 4500, false), 5000, 'up to its most');
    const probed = { ...spin, looks: 256, waits: 0 };
    const taken = Array.from({ length: 32 }, ()=>nextLooks(probed));
    assert.deepEqual(taken.flatMap((looks, i)=>looks === 5000 ? [i + 1] : []), [16, 32],
        'one wait in sixteen looks the whole way');
    assert.ok(taken.every(looks=>looks === 5000 || looks === 256), 'the others as learnt');
    const none = createSpin(0);
    assert.equal(none.most, 0, 'no spin is no spin');
    assert.equal(learnt(none, 0, true), 0);
    assert.throws(()=>createSpin(NaN), RangeError);
    assert.throws(()=>createSpin(1001), RangeError);
});

test('a side whose waits always end asleep learns to look little, the one in sixteen that looks '
    + 'the whole way asleep all the same', { timeout: 60_000 }, async()=>{
    // The other side moves the word only once the wait counted itself asleep,
    // and the wait before it said it ended (the third word): every wait spends
    // its whole spin, whatever the machine's speed.
    const words = new Int32Array(new SharedArrayBuffer(12));
    const mover = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const words = new Int32Array(workerData);
        const nap = new Int32Array(new SharedArrayBuffer(4));
        parentPort.postMessage('up');
        for (let n = 1; n <= 40; n++)
        {
            while (Atomics.load(words, 2) !== n - 1 || Atomics.load(words, 1) === 0)
                Atomics.wait(nap, 0, 0, 1);
            Atomics.store(words, 0, n);
            Atomics.notify(words, 0);
        }`, { eval: true, workerData: words.buffer });
    // Up before this thread blocks: a worker starts through its parent's loop.
    await new Promise(resolve=>mover.once('message', resolve));
    const spin = createSpin(0.05);
    /** @type {number[]} */
    const looks = [];
    for (let n = 0; n < 40; n++)
    {
        assert.equal(waitFor(words, WORD, n, SLEEPS, Infinity, spin), 'woke');
        looks.push(spin.looks);
        Atomics.store(words, 2, n + 1);
    }
    await mover.terminate();
    assert.deepEqual(looks.slice(0, 3), [4375, 3829, 3351], 'an eighth less at each');
    assert.equal(looks[29], 256, 'down to a few hundred');
    assert.equal(looks[31], 256, 'the thirty-second looked the whole way, slept all the same');
    assert.equal(looks[39], 256);
    assert.equal(spin.waits, 40);
});

test('a doorbell\'s waits learn their spin, unless a wait names its own', { timeout: 60_000 },
    async()=>{
    const memory = createDoorbell();
    const bell = openDoorbell(memory);
    // The ringer rings only once the wait counted itself asleep and the wait
    // before it said it ended.
    const ended = new Int32Array(new SharedArrayBuffer(4));
    const ringer = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const words = new Int32Array(workerData.bell);
        const ended = new Int32Array(workerData.ended);
        const nap = new Int32Array(new SharedArrayBuffer(4));
        parentPort.postMessage('up');
        for (let n = 0; n < 3; n++)
        {
            while (Atomics.load(ended, 0) !== n || Atomics.load(words, 1) === 0)
                Atomics.wait(nap, 0, 0, 1);
            Atomics.add(words, 0, 1);
            Atomics.notify(words, 0);
        }`, { eval: true, workerData: { bell: memory.buffer, ended: ended.buffer } });
    await new Promise(resolve=>ringer.once('message', resolve));
    for (let n = 0; n < 3; n++)
    {
        assert.equal(bell.wait(bell.seen()), 'woke');
        Atomics.store(ended, 0, n + 1);
    }
    await ringer.terminate();
    assert.equal(bell.spin.looks, 3351, 'an eighth less for each of three waits that slept');
    assert.equal(bell.wait(bell.seen(), 0, 0.05), 'timed-out', 'a spin of its own');
    assert.equal(bell.spin.waits, 3, 'is not the learning one');
    assert.throws(()=>bell.wait(bell.seen(), undefined, NaN), RangeError);
});
