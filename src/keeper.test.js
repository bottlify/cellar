/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuddy, UNIT } from './buddy.js';
import { openKeeper } from './keeper.js';
import { createReader } from './reader.js';
import { memoryDisk } from './disk.fixture.js';

const KIB = 1024;

/** A keeper and a reader in one thread, the clock stepped by hand. */
async function cacheOf(options = {}){
    let clock = 0;
    /** @type {any[]} */
    const said = [];
    /** @type {import('./reader.js').Reader | null} */
    let reader = null;
    const keeper = await openKeeper({
        budget: 256 * KIB, segmentBytes: 64 * KIB, coldAfterMs: 100, goneAfterMs: 1000,
        releaseAfterMs: 50, now: ()=>clock,
        announce: message=>{
            said.push(message);
            reader?.adopt(message);
        },
        ...options,
    });
    reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, opts)=>keeper.reserve(name, length, opts),
            raise: name=>keeper.raise(name),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    // The first pack opens behind a promise, as on OPFS.
    await new Promise(resolve=>setTimeout(resolve, 0));
    return {
        keeper, reader, said,
        /** @param {number} ms */
        step(ms){
            clock += ms;
            keeper.sweep();
        },
    };
}

/** @param {number} length @param {number} seed */
const bodyOf = (length, seed)=>Uint8Array.from({ length }, (_, i)=>(i * 31 + seed) & 255);

test('a buddy block given back joins its twin, and a segment emptied is one block again', ()=>{
    const buddy = createBuddy(64 * KIB);
    const a = buddy.place(5000);
    const b = buddy.place(UNIT);
    assert.equal(a, 0);
    assert.equal(buddy.used(), 3 * UNIT);
    assert.equal(buddy.wasted(), 3 * UNIT - 5000 - UNIT);
    assert.equal(buddy.place(64 * KIB), -1);
    buddy.give(a, 5000);
    buddy.give(b, UNIT);
    assert.equal(buddy.empty(), true);
    assert.equal(buddy.largest(), 64 * KIB);
    assert.equal(buddy.place(64 * KIB), 0);
});

test('a body written is read in place by its name, a miss is null, two names keep apart', async()=>{
    const { reader } = await cacheOf();
    assert.equal(reader.look('a'), null);
    assert.equal(reader.put('a', bodyOf(5000, 1)), true);
    assert.equal(reader.put('b', bodyOf(300, 2)), true);
    assert.equal(reader.look('a'), 'hot');
    assert.deepEqual(reader.with('a', body=>Array.from(body)), Array.from(bodyOf(5000, 1)));
    assert.deepEqual(reader.with('b', body=>Array.from(body)), Array.from(bodyOf(300, 2)));
    assert.equal(reader.with('c', ()=>1), undefined);
});

test('past the budget the oldest body goes cold to the disk and comes back as it was', async()=>{
    const { reader, keeper } = await cacheOf({ disk: memoryDisk() });
    for (let i = 0; i < 12; i++)
    {
        assert.equal(reader.put(`n${i}`, bodyOf(32 * KIB, i)), true, `n${i}`);
    }
    // 12 bodies of 32 KiB in 256 KiB: the first went cold.
    assert.equal(reader.look('n0'), 'cold');
    assert.equal(reader.look('n11'), 'hot');
    assert.equal(reader.with('n0', ()=>1), undefined);
    assert.deepEqual(reader.with('n1', body=>Array.from(body), { wait: true }),
        Array.from(bodyOf(32 * KIB, 1)));
    const figures = keeper.figures();
    assert.ok(figures.cooled >= 4, JSON.stringify(figures));
    assert.ok(figures.segmentBytes <= 256 * KIB);
});

test('without a disk a body that can be made again goes away, the only copy stays', async()=>{
    const { reader, keeper } = await cacheOf();
    assert.equal(reader.put('kept', bodyOf(32 * KIB, 9), { onlyCopy: true }), true);
    for (let i = 0; i < 12; i++)
    {
        reader.put(`n${i}`, bodyOf(32 * KIB, i));
    }
    assert.equal(reader.look('kept'), 'hot');
    assert.equal(reader.look('n0'), null);
    assert.ok(keeper.figures().gone > 0);
});

test('a body being read is not taken: its drop waits for the reader to leave', async()=>{
    const { reader, keeper, step } = await cacheOf();
    reader.put('a', bodyOf(100, 3));
    reader.with('a', ()=>{
        assert.equal(keeper.drop('a'), false);
        assert.equal(reader.look('a'), 'hot');
    });
    step(1);
    assert.equal(reader.look('a'), null);
});

test('a name written anew while read: the reader finishes the old body, the next one reads the new',
    async()=>{
        const { reader, keeper, step } = await cacheOf();
        reader.put('a', bodyOf(5000, 1));
        const seen = reader.with('a', body=>{
            assert.equal(reader.put('a', bodyOf(6000, 2)), true, 'written while read');
            return Array.from(body);
        });
        assert.deepEqual(seen, Array.from(bodyOf(5000, 1)), 'the old body, whole, to its reader');
        assert.deepEqual(reader.with('a', body=>Array.from(body)), Array.from(bodyOf(6000, 2)));
        const before = keeper.figures();
        assert.equal(before.replaced, 1);
        step(1);
        assert.equal(keeper.figures().hotBytes, 6000, 'the old body\'s room went once read');
    });

test('a name written anew while written: the later write wins, the earlier one is let go',
    async()=>{
        const { reader, step, keeper } = await cacheOf();
        const first = reader.reserve('a', 100);
        assert.ok(first);
        first.set(bodyOf(100, 1));
        // A second writer of the same name, before the first commits.
        assert.equal(reader.put('b', bodyOf(10, 0)), true);
        const second = keeper.reserve('a', 200);
        assert.ok(second);
        reader.commit('a');
        assert.equal(reader.with('a', ()=>1), undefined, 'the second is not written yet');
        step(1);
        assert.equal(keeper.figures().hotBytes, 10 + 200, 'the first write\'s room went');
    });

test('idle bodies go cold, then away; an emptied segment past the spare is let go', async()=>{
    const { reader, keeper, step, said } = await cacheOf({ disk: memoryDisk() });
    for (let i = 0; i < 6; i++)
    {
        reader.put(`n${i}`, bodyOf(32 * KIB, i));
    }
    const made = keeper.figures().segments;
    assert.ok(made >= 3);
    step(100);
    assert.equal(reader.look('n0'), 'cold');
    step(60);
    assert.equal(keeper.figures().segments, 1);
    assert.ok(said.some(message=>message.buffer === null));
    step(1000);
    assert.equal(reader.look('n0'), null);
});

test('a table filled is made larger and sent; every name is found through it', async()=>{
    const { reader, said } = await cacheOf({ budget: 8 * 1024 * KIB, segmentBytes: 1024 * KIB });
    for (let i = 0; i < 1500; i++)
    {
        reader.put(`name-${i}`, bodyOf(64, i));
    }
    assert.ok(said.some(message=>message.table !== undefined));
    for (let i = 0; i < 1500; i += 97)
    {
        assert.equal(reader.with(`name-${i}`, body=>body[1]), (31 + i) & 255);
    }
});

test('a run after a save finds every body cold on the disk and reads it back as it was', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('kept', bodyOf(9000, 4), { onlyCopy: true });
    for (let i = 0; i < 12; i++)
    {
        first.reader.put(`n${i}`, bodyOf(32 * KIB, i));
    }
    first.keeper.close();
    const second = await cacheOf({ disk });
    assert.equal(second.keeper.figures().loaded, 13);
    assert.equal(second.reader.look('n0'), 'cold');
    assert.equal(second.reader.look('n11'), 'cold');
    assert.deepEqual(second.reader.with('n0', body=>Array.from(body), { wait: true }),
        Array.from(bodyOf(32 * KIB, 0)));
    assert.deepEqual(second.reader.with('kept', body=>Array.from(body), { wait: true }),
        Array.from(bodyOf(9000, 4)));
});

test('a save torn mid-write leaves the one before it, which the next run reads', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('a', bodyOf(100, 1));
    first.keeper.save();
    first.reader.put('b', bodyOf(100, 2));
    first.keeper.close();
    // The newer of the two index files, cut short as a tab closing mid-write leaves it.
    const [newer] = [...disk.files].filter(([name])=>name.startsWith('index-'))
        .sort(([, x], [, y])=>y.length - x.length);
    disk.files.set(newer[0], newer[1].slice(0, newer[1].length - 5));
    const second = await cacheOf({ disk });
    assert.equal(second.reader.look('a'), 'cold');
    assert.equal(second.reader.look('b'), null, 'the torn save is not read');
    assert.equal(second.reader.with('a', body=>body[1], { wait: true }), (31 + 1) & 255);
});

test('a body larger than a segment is refused and said so', async()=>{
    const { reader, keeper } = await cacheOf();
    assert.equal(reader.put('big', new Uint8Array(65 * KIB)), false);
    assert.equal(keeper.figures().refusedLarge, 1);
});

test('where memory cannot be shared the cache is one thread\'s, every part of it the same', async()=>{
    // A page not cross-origin isolated has no SharedArrayBuffer: the keeper
    // and its readers are one thread, on buffers of their own.
    const shared = globalThis.SharedArrayBuffer;
    // @ts-ignore -- removed for the test, put back below
    delete globalThis.SharedArrayBuffer;
    try
    {
        // Room for every body (a body takes a unit of the buddy at least).
        const { keeper, reader, step } = await cacheOf({ disk: memoryDisk(),
            budget: 16 * KIB * KIB, segmentBytes: KIB * KIB });
        assert.equal(keeper.shared.records instanceof ArrayBuffer, true, 'a buffer of its own');
        // Enough names to grow the records, the names and the table.
        for (let n = 0; n < 3000; n++)
        {
            assert.equal(reader.put(`name with a long tail ${n}`, bodyOf(32, n)), true);
        }
        for (const n of [0, 1499, 2999])
        {
            assert.deepEqual(reader.with(`name with a long tail ${n}`, body=>[...body]),
                [...bodyOf(32, n)], `body ${n} read back`);
        }
        // The only copy of a body cooled to the disk and raised again.
        assert.equal(reader.put('only', bodyOf(5000, 9), { onlyCopy: true }), true);
        step(150);
        assert.ok(keeper.figures().cooled > 0, 'cooled');
        assert.equal(reader.look('only'), 'cold');
        assert.deepEqual(reader.with('only', body=>[...body], { wait: true }), [...bodyOf(5000, 9)]);
    }
    finally
    {
        globalThis.SharedArrayBuffer = shared;
    }
});

test('a name written anew while read keeps leading to its new body after the table grows', async()=>{
    const { reader, keeper, step, said } = await cacheOf({ budget: 8 * 1024 * KIB,
        segmentBytes: 1024 * KIB });
    reader.put('a', bodyOf(100, 1));
    reader.with('a', ()=>{
        reader.put('a', bodyOf(100, 2));
    });
    step(1);
    // Past the first table's half: it is made larger from what it leads to.
    for (let i = 0; i < 600; i++)
    {
        reader.put(`n${i}`, bodyOf(16, i));
    }
    // A reader that remembers no record, over the larger table as it was sent.
    const table = said.filter(message=>message.table !== undefined).at(-1).table;
    const late = createReader({ shared: { ...keeper.shared, table }, segments: keeper.segmentBuffers(),
        keeper: /** @type {any} */ ({}) });
    assert.equal(late.with('a', body=>body[1]), (31 + 2) & 255, 'the body committed last');
    reader.with('a', ()=>{
        reader.put('a', bodyOf(100, 3));
    });
    step(1);
    assert.equal(keeper.figures().hotBytes, 100 + 600 * 16, 'one body a name');
});

test('a thread joining after the table grew is handed the larger table', async()=>{
    const { reader, keeper } = await cacheOf({ budget: 8 * 1024 * KIB, segmentBytes: 1024 * KIB });
    for (let i = 0; i < 2000; i++)
    {
        reader.put(`n${i}`, bodyOf(16, i));
    }
    const late = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: /** @type {any} */ ({}) });
    for (let i = 0; i < 2000; i++)
    {
        assert.equal(late.look(`n${i}`), 'hot', `n${i}`);
    }
});

test('a reserve refused leaves the name\'s body as it was, hot or on the disk', async()=>{
    const disk = memoryDisk();
    const { reader, keeper } = await cacheOf({ disk });
    reader.put('doc', bodyOf(5000, 7), { onlyCopy: true });
    // Refused: no segment the writer has, and a body no block holds.
    assert.equal(keeper.reserve('doc', 5000, { onlyCopy: true, known: 0 }), null);
    assert.equal(reader.put('doc', new Uint8Array(0), { onlyCopy: true }), false);
    assert.deepEqual(reader.with('doc', body=>[...body]), [...bodyOf(5000, 7)]);
    keeper.close();
    const next = await cacheOf({ disk });
    assert.deepEqual(next.reader.with('doc', body=>[...body], { wait: true }), [...bodyOf(5000, 7)]);
});

test('a body rewritten into a full cache takes its own block, written over in place', async()=>{
    const { reader } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
    for (let i = 0; i < 16; i++)
    {
        assert.equal(reader.put(`n${i}`, bodyOf(UNIT, i), { onlyCopy: true }), true);
    }
    assert.equal(reader.put('n3', bodyOf(UNIT - 100, 40), { onlyCopy: true }), true);
    assert.deepEqual(reader.with('n3', body=>[...body]), [...bodyOf(UNIT - 100, 40)]);
    assert.equal(reader.put('n4', bodyOf(2 * UNIT, 41), { onlyCopy: true }), false, 'no block holds it');
    assert.deepEqual(reader.with('n4', body=>[...body]), [...bodyOf(UNIT, 4)], 'kept');
});

test('a drop asked while read, then the name written anew while still read, gives the old room back',
    async()=>{
        const { reader, keeper, step } = await cacheOf();
        reader.put('a', bodyOf(20000, 1));
        reader.with('a', ()=>{
            keeper.drop('a');
            reader.put('a', bodyOf(100, 2));
        });
        step(1);
        const figures = keeper.figures();
        assert.equal(figures.placedBytes, UNIT);
        assert.equal(figures.hotBytes, 100);
        assert.deepEqual(reader.with('a', body=>[...body]), [...bodyOf(100, 2)], 'the write after the drop');
    });

test('a reservation let go of, or reserved again before its commit, gives its room back', async()=>{
    const { reader, keeper, step } = await cacheOf();
    reader.put('a', bodyOf(100, 1));
    const into = reader.reserve('a', 9000);
    assert.ok(into);
    reader.abandon('a');
    assert.throws(()=>reader.commit('a'), /not reserved/);
    assert.equal(reader.look('a'), null, 'no body: the reserve took the one before');
    assert.ok(reader.reserve('b', 9000));
    assert.ok(reader.reserve('b', 5000));
    reader.commit('b');
    step(1);
    const figures = keeper.figures();
    assert.equal(figures.placedBytes, 2 * UNIT, 'the second b alone');
    assert.equal(reader.figures().abandoned, 2);
});

test('a cold body is raised only into a segment the asking thread has', async()=>{
    const { keeper, reader, step } = await cacheOf({ disk: memoryDisk() });
    reader.put('a', bodyOf(60 * KIB, 1));
    step(100);
    assert.equal(reader.look('a'), 'cold');
    // A thread that knows the first segment only, which a body fills now.
    const late = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers().slice(0, 1),
        keeper: {
            reserve: (name, length, options)=>keeper.reserve(name, length, options),
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: ()=>{}, drop: ()=>{},
        } });
    assert.equal(late.put('b', bodyOf(60 * KIB, 2)), true);
    assert.equal(late.with('a', body=>body[1], { wait: true }), (31 + 1) & 255);
});

test('a body the disk holds less of than the index says is gone, not answered with other bytes',
    async()=>{
        const disk = memoryDisk();
        const first = await cacheOf({ disk });
        first.reader.put('doc', bodyOf(8000, 5), { onlyCopy: true });
        first.keeper.close();
        disk.files.delete('pack-0');
        const second = await cacheOf({ disk });
        second.reader.put('other', bodyOf(8000, 99));
        second.keeper.drop('other');
        assert.equal(second.reader.with('doc', body=>body.slice(), { wait: true }), undefined);
        assert.equal(second.reader.look('doc'), null);
        assert.equal(second.keeper.figures().lostOnDisk, 1);
    });

test('a body saved by a run of larger segments is not raised, and moves nothing', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk, budget: 512 * KIB, segmentBytes: 128 * KIB });
    first.reader.put('big', bodyOf(100 * KIB, 1));
    first.keeper.close();
    const second = await cacheOf({ disk });
    for (let i = 0; i < 4; i++)
    {
        second.reader.put(`n${i}`, bodyOf(32 * KIB, i));
    }
    assert.equal(second.reader.with('big', ()=>1, { wait: true }), undefined);
    assert.equal(second.keeper.figures().cooled, 0);
});

test('a name past what the names hold is refused, not written where it cannot be found', async()=>{
    const { reader, keeper } = await cacheOf({ budget: 1024 * KIB, segmentBytes: 1024 * KIB });
    const long = 'x'.repeat(1 << 20);
    let n = 0;
    while (reader.put(`${n}${long}`, bodyOf(16, n)))
    {
        assert.equal(reader.with(`${n}${long}`, body=>body[1]), (31 + n) & 255);
        n++;
    }
    assert.equal(n, 31, 'names of 2^20 units in 2^25');
    const records = keeper.figures().records;
    assert.equal(reader.put(`${n}${long}`, bodyOf(16, n)), false);
    assert.equal(keeper.figures().records, records, 'no record for a name not held');
    assert.equal(reader.put('short', bodyOf(16, 1)), true, 'a name that fits still does');
});

test('a name longer than a call takes as arguments is saved and found by the next run', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    const long = 'n'.repeat(300_000);
    first.reader.put(long, bodyOf(100, 1), { onlyCopy: true });
    first.keeper.close();
    const second = await cacheOf({ disk });
    assert.equal(second.reader.with(long, body=>body[1], { wait: true }), (31 + 1) & 255);
});

test('past 24.8 days of the clock, idle is still told by how long', async()=>{
    const { reader, step } = await cacheOf({ disk: memoryDisk(), coldAfterMs: 30_000 });
    step(2 ** 31 + 1000);
    reader.put('a', bodyOf(100, 1));
    step(10);
    assert.equal(reader.look('a'), 'hot', 'used 10 ms ago, across the wrap');
    step(30_000);
    assert.equal(reader.look('a'), 'cold');
});

test('a disk that fails to flush fails the save, and close still lets go of every file', async()=>{
    const base = memoryDisk();
    let failing = false;
    /** @type {Set<string>} */
    const open = new Set();
    const disk = {
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            open.add(name);
            return { ...file,
                flush(){
                    if (failing && name.startsWith('pack'))
                    {
                        throw new Error('flush failed');
                    }
                },
                close(){
                    open.delete(name);
                } };
        },
    };
    const { reader, keeper, step } = await cacheOf({ disk });
    reader.put('a', bodyOf(100, 1));
    assert.equal(keeper.save(), true);
    failing = true;
    step(1);
    assert.equal(keeper.save(), false);
    assert.equal(keeper.close(), false);
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.deepEqual([...open], []);
    assert.ok(keeper.figures().diskFailures > 0);
});

test('close lets go of the pack still opening', async()=>{
    const base = memoryDisk();
    /** @type {Set<string>} */
    const open = new Set();
    /** @type {(() => void)[]} */
    const later = [];
    const disk = {
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            if (name === 'pack-0')
            {
                await new Promise(resolve=>later.push(()=>resolve(undefined)));
            }
            open.add(name);
            return { ...file,
                close(){
                    open.delete(name);
                } };
        },
    };
    const keeper = await openKeeper({ budget: 256 * KIB, segmentBytes: 64 * KIB, disk });
    keeper.close();
    later.forEach(go=>go());
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.deepEqual([...open], []);
});

test('an engine whose shared buffers cannot grow is told so when the keeper opens', async()=>{
    const prototype = SharedArrayBuffer.prototype;
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(prototype,
        'maxByteLength'));
    // @ts-ignore -- removed for the test, put back below
    delete prototype.maxByteLength;
    try
    {
        await assert.rejects(openKeeper({ budget: 256 * KIB }), /cannot grow/);
    }
    finally
    {
        Object.defineProperty(prototype, 'maxByteLength', descriptor);
    }
});
