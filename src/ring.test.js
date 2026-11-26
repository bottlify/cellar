/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { ROOM_WORD, RingClosed, createRingMemory, openRing } from './ring.js';
import { createDoorbell, openDoorbell } from './bell.js';

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
}

/** A record whose bytes say which it is: its number, then that number's low byte over and over. */
function record(/** @type {number} */ n, /** @type {number} */ length){
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at++)
    {
        bytes[at] = at < 4 ? (n >>> (at * 8)) & 0xff : (n + at) & 0xff;
    }
    return bytes;
}

test('records come out in order, whole, across every wrap, and a full ring refuses rather than'
    + ' overwrites', ()=>{
    for (let seed = 1; seed <= 50; seed++)
    {
        const next = random(seed);
        const ring = openRing(createRingMemory(256));
        /** @type {Uint8Array[]} */
        const queued = [];
        let sent = 0;
        for (let step = 0; step < 2000; step++)
        {
            if (next() < 0.55)
            {
                const length = Math.floor(next() * (ring.maxRecord + 1));
                const bytes = record(sent, length);
                if (ring.write(bytes))
                {
                    queued.push(bytes);
                    sent++;
                }
                else
                {
                    assert.ok(queued.length > 0, 'refused only while something is held');
                }
            }
            else
            {
                const got = ring.peek();
                const want = queued.shift();
                assert.deepEqual(got, want ?? null, `seed ${seed} step ${step}`);
                if (got)
                {
                    ring.release();
                }
            }
        }
        ring.drain(got=>assert.deepEqual(got, queued.shift()));
        assert.equal(queued.length, 0);
        assert.equal(ring.held(), 0);
    }
});

test('an empty record is a record, and one longer than half the ring is refused outright', ()=>{
    const ring = openRing(createRingMemory(64));
    assert.equal(ring.write(new Uint8Array(0)), true);
    assert.deepEqual(ring.peek(), new Uint8Array(0));
    ring.release();
    assert.equal(ring.peek(), null);
    assert.throws(()=>ring.write(new Uint8Array(ring.maxRecord + 1)), /longer than/);
});

test('the doorbell counts writes, and a wait on a stale count returns at once', ()=>{
    const ring = openRing(createRingMemory(64));
    const seen = ring.bell.seen();
    ring.write(Uint8Array.of(1));
    assert.equal(ring.bell.wait(seen, 1000), 'moved',
        'a write between the look and the wait is not slept through');
    assert.equal(ring.bell.wait(ring.bell.seen(), 5), 'timed-out');
});

test('rings that share a doorbell wake their reader whichever is written', ()=>{
    const memory = createDoorbell();
    const bell = openDoorbell(memory);
    const first = openRing(createRingMemory(64, memory));
    const second = openRing(createRingMemory(64, memory));
    const seen = bell.seen();
    second.write(Uint8Array.of(2));
    assert.equal(bell.wait(seen, 1000), 'moved');
    assert.equal(first.peek(), null);
    assert.deepEqual(second.peek(), Uint8Array.of(2));
});

/**
 * A worker running `body` with the ring memories, the module's URL as `ring`.
 *
 * @param {string} body  an async function's body, given `memory`, `memories` and the ring module
 * @param {any} data
 */
function inWorker(body, data){
    const source = `
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.ring).then(async(ringModule)=>{
            const run = async(memory, data, ring)=>{ ${body} };
            parentPort.postMessage(await run(workerData.memory, workerData.data, ringModule));
        });`;
    return new Worker(source, { eval: true,
        workerData: { ring: new URL('./ring.js', import.meta.url).href, memory: data.memory,
            data } });
}

test('a reader asleep on the doorbell is woken by each write from another thread, and reads all'
    + ' of them in order', { timeout: 30000 }, async()=>{
    const memory = createRingMemory(1024);
    const count = 20000;
    const reader = inWorker(`
        const r = ring.openRing(memory);
        let expected = 0;
        let sleeps = 0;
        while (expected < data.count)
        {
            const seen = r.bell.seen();
            const took = r.drain(bytes=>{
                const n = bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
                if (n !== expected || bytes.length !== 4 + (n % 61))
                    throw new Error('out of order at ' + n);
                expected++;
            });
            if (took === 0)
            {
                sleeps++;
                if (r.bell.wait(seen, 5000, 0) === 'timed-out')
                    throw new Error('lost a wake-up at ' + expected);
            }
        }
        return { expected, sleeps };`, { memory, count });
    /** @type {{ error: Error | null }} */
    const reading = { error: null };
    const result = new Promise((resolve, reject)=>{
        reader.once('message', resolve);
        reader.once('error', error=>{
            reading.error = error;
            reject(error);
        });
    });
    result.catch(()=>{});
    const writer = openRing(memory);
    for (let n = 0; n < count && !reading.error; n++)
    {
        const bytes = record(n, 4 + (n % 61));
        while (!writer.write(bytes) && !reading.error)
        {
            // The reader is behind: the page's side would wait on the ring's
            // room word; this thread may not block, so it yields instead.
            await new Promise(resolve=>setImmediate(resolve));
        }
        if (n % 1000 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
    }
    const { expected, sleeps } = /** @type {any} */ (await result);
    assert.equal(expected, count);
    assert.ok(sleeps > 0, 'the reader did sleep on the doorbell');
    await reader.terminate();
});

test('a writer that may block waits for the reader to make room, and gives up after its time',
    { timeout: 30000 }, async()=>{
        const memory = createRingMemory(64);
        const stopped = new SharedArrayBuffer(4);
        const writer = inWorker(`
        const w = ring.openRing(memory);
        const bytes = new Uint8Array(w.maxRecord);
        let written = 0;
        for (let n = 0; n < 50; n++)
        {
            if (!w.writeWaiting(bytes, 5000)) throw new Error('timed out at ' + n);
            written++;
        }
        // Filled to the brim once the reader stopped: nobody makes room now.
        Atomics.wait(new Int32Array(data.stopped), 0, 0);
        while (w.write(bytes))
        {
            // Filling.
        }
        const from = performance.now();
        const late = w.writeWaiting(bytes, 20);
        return { written, late, waited: performance.now() - from };`, { memory, stopped });
        const result = new Promise((resolve, reject)=>{
            writer.once('message', resolve);
            writer.once('error', reject);
        });
        const reader = openRing(memory);
        let read = 0;
        while (read < 50)
        {
            read += reader.drain(()=>{});
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
        const words = new Int32Array(stopped);
        Atomics.store(words, 0, 1);
        Atomics.notify(words, 0);
        const { written, late, waited } = /** @type {any} */ (await result);
        assert.equal(written, 50);
        assert.equal(late, false, 'with nobody reading, a full ring times out');
        assert.ok(waited >= 19, `it waited for its time first: ${waited} ms`);
        await writer.terminate();
    });

test('a ring closed: what was written is read, then the reader finds it closed; a write after'
    + ' throws', ()=>{
    const ring = openRing(createRingMemory(256));
    ring.write(Uint8Array.of(1));
    const seen = ring.bell.seen();
    ring.close();
    assert.equal(ring.bell.wait(seen, 1000), 'moved', 'the reader is rung for it');
    assert.deepEqual(ring.peek(), Uint8Array.of(1));
    ring.release();
    assert.equal(ring.peek(), null);
    assert.equal(ring.closed(), true);
    assert.throws(()=>ring.write(Uint8Array.of(2)), RingClosed);
});

test('a drain takes no more than it is asked: a ring written without a pause leaves room for'
    + ' the others', ()=>{
    const ring = openRing(createRingMemory(1024));
    for (let n = 0; n < 10; n++)
    {
        ring.write(Uint8Array.of(n));
    }
    /** @type {number[]} */
    const taken = [];
    assert.equal(ring.drain(record=>taken.push(record[0]), 4), 4);
    assert.deepEqual(taken, [0, 1, 2, 3]);
    assert.equal(ring.drain(record=>taken.push(record[0])), 6);
    assert.deepEqual(taken, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a writer that may not block waits for room on its event loop, and a close ends the wait',
    { timeout: 30000 }, async()=>{
        const memory = createRingMemory(64);
        const writer = openRing(memory);
        const reader = openRing(memory);
        const record = new Uint8Array(writer.maxRecord);
        while (writer.write(record))
        {
            // full
        }
        const waiting = writer.writeWaitingAsync(record);
        reader.drain(()=>{});
        assert.equal(await waiting, true, 'written once the reader made room');
        while (writer.write(record))
        {
            // full again
        }
        const ended = writer.writeWaitingAsync(record);
        reader.close();
        await assert.rejects(ended, RingClosed);
    });

test('a writer asleep on a full ring in another thread ends when the reader closes the ring',
    { timeout: 30000 }, async t=>{
        const memory = createRingMemory(64);
        const writer = inWorker(`
        const w = ring.openRing(memory);
        const bytes = new Uint8Array(w.maxRecord);
        while (w.write(bytes)) {}
        try { return w.writeWaiting(bytes) ? 'written' : 'timed out'; }
        catch (e) { return e.name; }`, { memory });
        // A writer a lost wake left asleep for good must not hold the test's process.
        writer.unref();
        t.after(()=>writer.terminate());
        const result = new Promise((resolve, reject)=>{
            writer.once('message', resolve);
            writer.once('error', reject);
        });
        const reader = openRing(memory);
        while (reader.held() < reader.capacity)
        {
            await new Promise(resolve=>setTimeout(resolve, 1));
        }
        // Long enough that the writer, past its look, sleeps: the close must wake it.
        await new Promise(resolve=>setTimeout(resolve, 100));
        reader.close();
        assert.equal(await result, 'RingClosed');
        await writer.terminate();
    });

test('a close moves the word a writer sleeps on: a wait that looked before the close and sleeps'
    + ' after it ends at once', ()=>{
    // The writer's last look at the closed word, then the close, then its
    // sleep: a close that only notified would wake nobody, and the sleep
    // would run its time out. A close that moves the word makes it return.
    const memory = createRingMemory(64);
    const words = new Int32Array(memory.control);
    const room = Atomics.load(words, ROOM_WORD);
    openRing(memory).close();
    assert.equal(Atomics.wait(words, ROOM_WORD, room, 1000), 'not-equal');
});

test('a take that drains its own ring, or a release with no record peeked, throws and leaves the'
    + ' ring whole', ()=>{
    const ring = openRing(createRingMemory(256));
    ring.write(Uint8Array.of(1));
    ring.write(Uint8Array.of(2));
    assert.throws(()=>ring.release(), /no record peeked/);
    /** @type {number[]} */
    const taken = [];
    assert.throws(()=>ring.drain(record=>{
        taken.push(record[0]);
        ring.drain(()=>{});
    }), /inside its own take/);
    assert.deepEqual(taken, [1]);
    // The record taken when it threw is still there: taken again, then the next.
    assert.equal(ring.drain(record=>void taken.push(record[0])), 2);
    assert.deepEqual(taken, [1, 1, 2]);
    assert.equal(ring.held(), 0);
    assert.equal(ring.write(Uint8Array.of(3)), true);
    assert.equal(ring.peek()?.[0], 3);
    ring.release();
    assert.throws(()=>ring.release(), /no record peeked/);
    assert.equal(ring.held(), 0);
});

test('a record that is not bytes is refused, not cut or written as zeros', async()=>{
    const ring = openRing(createRingMemory(256));
    for (const record of [Uint32Array.of(0x12345678), new Float64Array(1),
        new DataView(new ArrayBuffer(4)), new ArrayBuffer(4), null, 'hello', { length: 3 },
        [300], [-1], [1.5]])
    {
        assert.throws(()=>ring.write(/** @type {any} */ (record)), TypeError);
        assert.throws(()=>ring.writeWaiting(/** @type {any} */ (record), 0), TypeError);
        await assert.rejects(ring.writeWaitingAsync(/** @type {any} */ (record), 0), TypeError);
    }
    assert.equal(ring.held(), 0);
    assert.equal(ring.write([1, 2, 255]), true);
    assert.equal(ring.write(Uint8Array.of(4)), true);
    /** @type {number[][]} */
    const records = [];
    ring.drain(record=>void records.push([...record]));
    assert.deepEqual(records, [[1, 2, 255], [4]]);
});

test('a ring\'s methods work taken off it', async()=>{
    const { write, writeWaiting, writeWaitingAsync, reserve, reserveWaiting, reserveWaitingAsync,
        commit, abandon, bytes, drain } = openRing(createRingMemory(256));
    assert.equal(write(Uint8Array.of(1)), true);
    reserve(1);
    abandon();
    bytes[reserveWaiting(1, 10)] = 4;
    commit();
    bytes[await reserveWaitingAsync(1, 10)] = 5;
    commit();
    assert.equal(writeWaiting(Uint8Array.of(2), 10), true);
    assert.equal(await writeWaitingAsync(Uint8Array.of(3), 10), true);
    /** @type {number[]} */
    const taken = [];
    assert.equal(drain(record=>void taken.push(record[0])), 5);
    assert.deepEqual(taken, [1, 4, 5, 2, 3]);
});

test('a ring of a capacity that is not a number of bytes is refused', ()=>{
    for (const capacity of [NaN, -1, 0, /** @type {any} */ ('64')])
    {
        assert.throws(()=>createRingMemory(capacity), RangeError);
    }
});

test('a take that releases its own record: freed once, and the drain throws rather than free the'
    + ' next', ()=>{
    const ring = openRing(createRingMemory(256));
    ring.write(Uint8Array.of(1));
    ring.write(Uint8Array.of(2));
    assert.throws(()=>ring.drain(()=>ring.release()), /no record peeked/);
    /** @type {number[]} */
    const taken = [];
    assert.equal(ring.drain(record=>void taken.push(record[0])), 1);
    assert.deepEqual(taken, [2], 'the first freed once, the second still there');
    assert.equal(ring.held(), 0);
});

test('a record that grows while it is written is written as long as it was', ()=>{
    const ring = openRing(createRingMemory(256));
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
    assert.equal(ring.write(new Growing(shared)), true);
    assert.equal(ring.write(Uint8Array.of(7)), true);
    /** @type {number[][]} */
    const records = [];
    assert.equal(ring.drain(record=>void records.push([...record])), 2);
    assert.deepEqual(records, [[0, 0, 0, 0, 0, 0, 0, 0], [7]]);
});

test('records built in the ring come out in order, whole and as long as committed, across every'
    + ' wrap, beside records copied in', ()=>{
    for (let seed = 1; seed <= 50; seed++)
    {
        const next = random(seed);
        const ring = openRing(createRingMemory(256));
        /** @type {Uint8Array[]} */
        const queued = [];
        let sent = 0;
        for (let step = 0; step < 2000; step++)
        {
            const roll = next();
            if (roll < 0.3)
            {
                // Room for more than is written: a record's size is what is committed.
                const asked = Math.floor(next() * (ring.maxRecord + 1));
                const length = Math.floor(next() * (asked + 1));
                const at = ring.reserve(asked);
                if (at < 0)
                {
                    assert.ok(queued.length > 0, 'refused only while something is held');
                    continue;
                }
                assert.ok(at + asked <= ring.capacity, `seed ${seed} step ${step}: room whole`);
                const bytes = record(sent, length);
                ring.bytes.set(bytes, at);
                if (next() < 0.1)
                {
                    ring.abandon();
                    continue;
                }
                ring.commit(length);
                queued.push(bytes);
                sent++;
            }
            else if (roll < 0.55)
            {
                const bytes = record(sent, Math.floor(next() * (ring.maxRecord + 1)));
                if (ring.write(bytes))
                {
                    queued.push(bytes);
                    sent++;
                }
            }
            else
            {
                const got = ring.peek();
                assert.deepEqual(got, queued.shift() ?? null, `seed ${seed} step ${step}`);
                if (got)
                {
                    ring.release();
                }
            }
        }
        ring.drain(got=>assert.deepEqual(got, queued.shift()));
        assert.equal(queued.length, 0);
        assert.equal(ring.held(), 0);
    }
});

test('a reservation that would run past the end starts the buffer again, and a writer fills it'
    + ' where it is read', ()=>{
    const ring = openRing(createRingMemory(64));
    // 16 bytes taken and read, then 24 more: 24 left before the end.
    assert.equal(ring.write(new Uint8Array(12)), true);
    ring.drain(()=>{});
    assert.equal(ring.reserve(20), 20, 'room right after the record read');
    ring.commit();
    ring.drain(()=>{});
    // A record of 24 needs 28: it starts at 0, the tail spent.
    const at = ring.reserve(24);
    assert.equal(at, 4, 'the record whole, at the start, behind its length');
    ring.bytes.fill(9, at, at + 24);
    ring.commit();
    const got = ring.peek();
    assert.deepEqual(got, new Uint8Array(24).fill(9));
    assert.equal(got?.byteOffset, at, 'read where it was built');
});

test('one reservation at a time, a commit of no more than was reserved, and an abandoned one'
    + ' gives its room back', ()=>{
    const ring = openRing(createRingMemory(64));
    assert.throws(()=>ring.commit(), /nothing reserved/);
    const at = ring.reserve(ring.maxRecord);
    assert.ok(at >= 0);
    assert.throws(()=>ring.reserve(1), /reserved again/);
    assert.throws(()=>ring.write(Uint8Array.of(1)), /reserved again/);
    assert.throws(()=>ring.commit(ring.maxRecord + 1), RangeError);
    assert.equal(ring.held(), 0, 'nothing published by a refused commit');
    ring.abandon();
    assert.equal(ring.held(), 0);
    assert.throws(()=>ring.commit(), /nothing reserved/, 'nothing held after the abandon');
    // The room is back: the largest record fits again, twice.
    assert.ok(ring.reserve(ring.maxRecord) >= 0);
    ring.commit(ring.maxRecord);
    assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
    assert.equal(ring.reserve(1), -1, 'full: no room, and nothing held');
    assert.equal(ring.drain(record=>assert.equal(record.length, ring.maxRecord)), 2);
    assert.ok(ring.reserve(1) >= 0);
    for (const length of [ring.maxRecord + 1, -1, 1.5, NaN, /** @type {any} */ ('4')])
    {
        ring.abandon();
        assert.throws(()=>ring.reserve(length), RangeError);
    }
});

test('a reservation the ring was closed under is published by no commit', ()=>{
    const ring = openRing(createRingMemory(64));
    const at = ring.reserve(8);
    ring.bytes.fill(1, at, at + 8);
    ring.close();
    assert.throws(()=>ring.commit(), RingClosed);
    assert.equal(ring.peek(), null, 'nothing to read');
    assert.equal(ring.held(), 0);
    assert.throws(()=>ring.reserve(8), RingClosed, 'not a second reservation: the ring is closed');
});

test('a writer waiting for room for a reservation gives up after its time holding nothing, and a'
    + ' close ends an asynchronous wait', async()=>{
    const ring = openRing(createRingMemory(64));
    assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
    assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
    assert.equal(ring.reserveWaiting(1, 5), -1);
    assert.equal(await ring.reserveWaitingAsync(1, 5), -1);
    ring.drain(()=>{}, 1);
    assert.ok(ring.reserveWaiting(ring.maxRecord, 5) >= 0, 'no reservation left by the waits');
    ring.commit();
    const waiting = ring.reserveWaitingAsync(1);
    ring.close();
    await assert.rejects(waiting, RingClosed);
});

test('a record growing while its writer waits for room is written as long as it was', async()=>{
    const ring = openRing(createRingMemory(64));
    assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
    assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
    const shared = new /** @type {any} */ (SharedArrayBuffer)(4, { maxByteLength: 64 });
    const growing = new Uint8Array(shared);
    const waiting = ring.writeWaitingAsync(growing);
    shared.grow(16);
    ring.drain(()=>{}, 1);
    assert.equal(await waiting, true);
    ring.drain(()=>{}, 1);
    assert.equal(ring.peek()?.length, 4);
});

test('a writer\'s waits for room learn their spin: a reader that frees room only once the writer'
    + ' sleeps makes it look an eighth less at each wait', { timeout: 60_000 }, async()=>{
    // Four records of 12 bytes fill a ring of 64; the reader takes one only
    // once the writer counted itself asleep for room (the control block's
    // second word) and the wait before it said it ended.
    const memory = createRingMemory(64);
    const ended = new Int32Array(new SharedArrayBuffer(4));
    const ring = openRing(memory);
    for (let n = 0; n < 4; n++)
    {
        assert.equal(ring.write(record(n, 12)), true);
    }
    const reader = inWorker(`
        const r = ring.openRing(memory);
        const control = new Int32Array(memory.control);
        const ended = new Int32Array(data.ended);
        const nap = new Int32Array(new SharedArrayBuffer(4));
        for (let n = 0; n < 3; n++)
        {
            while (Atomics.load(ended, 0) !== n || Atomics.load(control, 1) === 0)
                Atomics.wait(nap, 0, 0, 1);
            r.drain(()=>{}, 1);
        }
        return true;`, { memory, ended: ended.buffer });
    for (let n = 0; n < 3; n++)
    {
        assert.ok(ring.reserveWaiting(12) >= 0);
        ring.commit();
        Atomics.store(ended, 0, n + 1);
    }
    await new Promise(resolve=>reader.once('message', resolve));
    await reader.terminate();
    assert.equal(ring.roomSpin.waits, 3, 'each wait for room took the learning spin');
    assert.equal(ring.roomSpin.looks, 3351, 'an eighth less for each of three waits that slept');
});

/**
 * The reader loop of docs/ring.md: the doorbell's count, then the closed word, then
 * the drain, and out once a drain followed a close. `between` runs at the
 * point named: as the writer would on another thread.
 *
 * @param {Ring} ring @param {import('./bell.js').Doorbell} doorbell
 * @param {(record: Uint8Array) => void} take
 * @param {string} [at] @param {() => void} [between]
 */
function readUntilClosed(ring, doorbell, take, at, between){
    for (let rounds = 0; rounds < 100; rounds++)
    {
        if (at === 'before the count') between?.();
        const seen = doorbell.seen();
        if (at === 'before the closed word') between?.();
        const closed = ring.closed();
        if (at === 'before the drain') between?.();
        ring.drain(take);
        if (closed)
        {
            return;
        }
        if (at === 'before the wait') between?.();
        // A wait the writer's last ring was lost to would sleep for good:
        // its time here only lets the test say so.
        assert.notEqual(doorbell.wait(seen, 10_000), 'timed-out', `lost the last ring (${at})`);
    }
    assert.fail('the loop did not end');
}

/** @typedef {import('./ring.js').Ring} Ring */

test('the close gate: a reader looping as docs/ring.md says reads every record written before the'
    + ' close, wherever the writer\'s last record and close fall in its loop', ()=>{
    for (const at of ['before the count', 'before the closed word', 'before the drain',
        'before the wait'])
    {
        const memory = createRingMemory(256);
        const reader = openRing(memory);
        const writer = openRing(memory);
        const doorbell = openDoorbell(memory.bell);
        writer.write(Uint8Array.of(1));
        /** @type {number[]} */
        const got = [];
        let once = false;
        readUntilClosed(reader, doorbell, record=>void got.push(record[0]), at, ()=>{
            if (!once)
            {
                once = true;
                writer.write(Uint8Array.of(2));
                writer.close();
            }
        });
        assert.deepEqual(got, [1, 2], `the last record read (${at})`);
        assert.equal(reader.held(), 0);
    }
});

test('the close gate across threads: every trial\'s reader reads every record written before the'
    + ' close', { timeout: 120_000 }, async t=>{
    // The reader in a worker loops over the rings in turn as docs/ring.md says;
    // this thread writes each ring's records, the last after a pause in which
    // the reader drained and went to wait, then closes it.
    const TRIALS = 100;
    const RECORDS = 4;
    const memories = Array.from({ length: TRIALS }, ()=>createRingMemory(256));
    const reader = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        Promise.all([import(workerData.ring), import(workerData.bell)]).then(([{ openRing }, { openDoorbell }])=>{
            for (const memory of workerData.memories)
            {
                const ring = openRing(memory);
                const doorbell = openDoorbell(memory.bell);
                let got = 0;
                for (;;)
                {
                    const seen = doorbell.seen();
                    const closed = ring.closed();
                    ring.drain(()=>{ got++; });
                    if (closed) break;
                    doorbell.wait(seen);
                }
                parentPort.postMessage(got);
            }
        });`, { eval: true, workerData: { ring: new URL('./ring.js', import.meta.url).href,
        bell: new URL('./bell.js', import.meta.url).href, memories } });
    // A reader a lost ring left asleep for good must not hold the test's process.
    reader.unref();
    t.after(()=>reader.terminate());
    /** @type {((count: number) => void)[]} */
    const takers = [];
    reader.on('message', count=>takers.shift()?.(count));
    /** @type {Error[]} */
    const failed = [];
    reader.once('error', error=>failed.push(error));
    let lost = 0;
    for (const memory of memories)
    {
        const writer = openRing(memory);
        const read = new Promise(resolve=>takers.push(resolve));
        for (let n = 0; n < RECORDS; n++)
        {
            if (n === RECORDS - 1)
            {
                await new Promise(resolve=>setTimeout(resolve, 1));
            }
            writer.write(Uint8Array.of(n));
        }
        writer.close();
        if (await read !== RECORDS)
        {
            lost++;
        }
    }
    assert.deepEqual(failed, []);
    assert.equal(lost, 0, 'trials that lost a record written before the close');
});

test('a reader skipping the tail a wrap left frees that room, and a writer asleep for it is woken',
    { timeout: 60_000 }, async t=>{
    const memory = createRingMemory(64);
    const ring = openRing(memory);
    const r24 = new Uint8Array(24);
    ring.write(r24);
    ring.write(r24);                                 // at 0 and 28: 56 written
    ring.drain(()=>{}, 1);                           // 28 read
    ring.write(r24);                                 // the tail from 56 skipped, at 0: 92 written
    ring.drain(()=>{}, 1);                           // 56 read: 28 free, 32 wanted below
    // The writer asleep for room for 28 bytes, which only the tail gives:
    // with no deadline, a wake lost leaves it asleep for good.
    const writer = inWorker(`
        const w = ring.openRing(memory);
        return w.reserveWaiting(28);`, { memory });
    writer.unref();
    t.after(()=>writer.terminate());
    const result = new Promise((resolve, reject)=>{
        writer.once('message', resolve);
        writer.once('error', reject);
    });
    const control = new Int32Array(memory.control);
    while (Atomics.load(control, 1) === 0)
    {
        // The writer's waits asleep for room, counted beside it.
        await new Promise(resolve=>setTimeout(resolve, 1));
    }
    const record = ring.peek();                      // over the tail, to the record at 0: held
    assert.equal(record?.length, 24);
    assert.equal(await result, 32, 'the writer woke to the room the skipped tail gave: at 28');
});

test('a writer whose wait for room ran out takes a last look: room made while it slept is room',
    async()=>{
    // Room made with nothing moved for the writer to wake to (a reader on
    // another thread, between the writer's look and its sleep, as a hook
    // here): the wait times out, and the last look finds the room.
    for (const asynchronous of [false, true])
    {
        const memory = createRingMemory(64);
        const ring = openRing(memory);
        assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
        assert.equal(ring.write(new Uint8Array(ring.maxRecord)), true);
        const control = new Int32Array(memory.control);
        const freeAll = ()=>Atomics.store(control, 2, Atomics.load(control, 0));   // read = written
        const wait = Atomics.wait;
        const waitAsync = /** @type {any} */ (Atomics).waitAsync;
        Atomics.wait = (...args)=>{
            freeAll();
            return 'timed-out';
        };
        /** @type {any} */ (Atomics).waitAsync = ()=>{
            freeAll();
            return { async: false, value: 'timed-out' };
        };
        try
        {
            const at = asynchronous ? await ring.reserveWaitingAsync(ring.maxRecord, 20)
                : ring.reserveWaiting(ring.maxRecord, 20);
            assert.ok(at >= 0, `${asynchronous ? 'async' : 'blocking'}: room found at the last look`);
            ring.abandon();
        }
        finally
        {
            Atomics.wait = wait;
            /** @type {any} */ (Atomics).waitAsync = waitAsync;
        }
    }
});

test('memory that is not a ring of this layout is refused at open, not read as counts', ()=>{
    const a = createRingMemory(64);
    const b = createRingMemory(1 << 12);
    assert.throws(()=>openRing({ control: a.control, data: b.data, bell: a.bell }), /not a ring/,
        'one ring\'s control over another\'s data');
    assert.throws(()=>openRing({ control: new SharedArrayBuffer(64), data: a.data, bell: a.bell }),
        /not a ring/, 'a control block of zeros');
    assert.throws(()=>openRing({ control: new SharedArrayBuffer(8), data: a.data, bell: a.bell }),
        /not a ring/, 'a control block too short');
    assert.equal(openRing(a).capacity, 64);
});
