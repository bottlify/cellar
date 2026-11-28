/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuddy, grainsOf, UNIT } from './buddy.js';
import { INDEX_FILES, openKeeper, readSaved } from './keeper.js';
import { createReader } from './reader.js';
import { crashDisk, memoryDisk } from './disk.fixture.js';
import { bodyOf, cacheOf, placeOf } from './cache.fixture.js';
import { BASE, chunkWriter, readIndexFile } from './index-file.js';
import {
    COLD, F_NO_DISK, F_ONLY_COPY, F_ON_DISK, F_THIS_RUN, HOT, H_COUNT, R_FLAGS, R_LENGTH, R_NAME,
    R_NAME_LENGTH, R_PACK, R_PACK_OFFSET, hashName, reserveFlags, viewIndex,
} from './shared.js';

const KIB = 1024;

/**
 * The newer index file of a disk and what it says, as Cellar 0.9.0 wrote an
 * index (JSON, version 1): what a test changes to see what a run trusts.
 *
 * @param {Map<string, Uint8Array>} files
 */
function newerAsVersion1(files){
    const [name, state] = /** @type {[string, import('./index-file.js').IndexFileState][]} */ (
        [...files].filter(([file])=>file.startsWith('index-'))
            .map(([file, bytes])=>[file, readIndexFile(bytes, 1 << 20, 1)])
            .filter(([, read])=>read !== null))
        .sort(([, x], [, y])=>y.generation - x.generation)[0];
    return { name, saved: { version: 1, generation: state.generation, packs: state.nextPack,
        /** @type {any[]} */
        records: [...state.entries].map(([body, { pack, offset, length, flags }])=>
            [body, pack, offset, length, flags]) } };
}

/** @param {any} saved */
const json = saved=>new TextEncoder().encode(JSON.stringify(saved));

/** Lets the promises of the disk settle: a pack opened ahead, a pack removed. */
const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));

test('a buddy block given back joins its twin, and a segment emptied is one block again', ()=>{
    const buddy = createBuddy(64 * KIB);
    const a = buddy.place(5000);
    const b = buddy.place(UNIT);
    assert.equal(a, 0);
    assert.equal(buddy.used(), grainsOf(5000) + UNIT);
    assert.equal(buddy.wasted(), grainsOf(5000) - 5000);
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
    assert.equal(reader.put('kept', bodyOf(32 * KIB, 9), F_ONLY_COPY), true);
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
        const second = placeOf(keeper, 'a', 200);
        assert.ok(second);
        reader.commit('a');
        assert.equal(reader.with('a', ()=>1), undefined, 'the second is not written yet');
        step(1);
        assert.equal(keeper.figures().hotBytes, 10 + 200, 'the first write\'s room went');
    });

test('idle bodies go cold, then away; an emptied segment is let go, the spare holding nothing', async()=>{
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
    assert.equal(keeper.figures().segments, 0);
    assert.equal(keeper.figures().segmentBytes, 0);
    assert.ok(said.some(message=>message.buffer === null));
    step(1000);
    assert.equal(reader.look('n0'), null);
});

test('a shared segment costs the budget as far as its blocks reach: the spare nothing, an emptied'
    + ' one its reach until releaseAfterMs, and room already counted is placed in first', async()=>{
    const { reader, keeper, step } = await cacheOf({ coldAfterMs: 1e6, goneAfterMs: 1e6 });
    assert.equal(keeper.figures().segmentBytes, 0, 'the spare, announced, holds nothing');
    assert.ok(keeper.segmentBuffers().some(buffer=>buffer?.byteLength === 64 * KIB));
    assert.ok(reader.put('a', bodyOf(5000, 1)));
    assert.equal(keeper.figures().segmentBytes, 8 * KIB, 'its block, to the page past it');
    for (let i = 0; i < 4; i++)
    {
        assert.ok(reader.put(`b${i}`, bodyOf(UNIT, i)));
    }
    const grown = keeper.figures().segmentBytes;
    reader.drop('b1');
    assert.ok(reader.put('c', bodyOf(UNIT, 9)));
    assert.equal(keeper.figures().segmentBytes, grown, 'the room b1 left, not a page more');
    for (const name of ['a', 'b0', 'b2', 'b3', 'c'])
    {
        reader.drop(name);
    }
    step(1);
    assert.equal(keeper.figures().segmentBytes, grown, 'emptied: kept for a burst to come');
    step(50);
    assert.equal(keeper.figures().segmentBytes, 0, 'let go after releaseAfterMs');
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
    first.reader.put('kept', bodyOf(9000, 4), F_ONLY_COPY);
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

test('a body larger than the budget is refused and said so', async()=>{
    const { reader, keeper } = await cacheOf();
    const made = keeper.figures().segmentsMade;
    assert.equal(reader.put('big', new Uint8Array(257 * KIB)), false);
    assert.equal(keeper.figures().refusedLarge, 1);
    assert.equal(keeper.figures().segmentsMade, made, 'nothing moved for it');
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
        assert.equal(reader.put('only', bodyOf(5000, 9), F_ONLY_COPY), true);
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
    reader.put('doc', bodyOf(5000, 7), F_ONLY_COPY);
    // Refused: no segment the writer has, and a body no block holds.
    assert.equal(placeOf(keeper, 'doc', 5000, F_ONLY_COPY, 0), null);
    assert.equal(reader.put('doc', new Uint8Array(0), F_ONLY_COPY), false);
    assert.deepEqual(reader.with('doc', body=>[...body]), [...bodyOf(5000, 7)]);
    keeper.close();
    const next = await cacheOf({ disk });
    assert.deepEqual(next.reader.with('doc', body=>[...body], { wait: true }), [...bodyOf(5000, 7)]);
});

test('a body rewritten into a full cache takes its own block, written over in place', async()=>{
    const { reader } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
    for (let i = 0; i < 16; i++)
    {
        assert.equal(reader.put(`n${i}`, bodyOf(UNIT, i), F_ONLY_COPY), true);
    }
    assert.equal(reader.put('n3', bodyOf(UNIT - 100, 40), F_ONLY_COPY), true);
    assert.deepEqual(reader.with('n3', body=>[...body]), [...bodyOf(UNIT - 100, 40)]);
    assert.equal(reader.put('n4', bodyOf(2 * UNIT, 41), F_ONLY_COPY), false, 'no block holds it');
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
        assert.equal(figures.placedBytes, grainsOf(100));
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
    assert.equal(figures.placedBytes, grainsOf(5000), 'the second b alone');
    assert.equal(reader.figures().abandoned, 2);
});

test('a put lets go of the name\'s reservation not committed yet and holds none of its own', async()=>{
    const { reader, keeper, step } = await cacheOf();
    assert.ok(reader.reserve('a', 9000));
    assert.equal(reader.put('a', bodyOf(100, 1)), true);
    assert.throws(()=>reader.commit('a'), /not reserved/, 'neither the reserve nor the put is held');
    reader.abandon('a');
    assert.deepEqual(reader.with('a', body=>[...body]), [...bodyOf(100, 1)]);
    step(1);
    assert.equal(keeper.figures().placedBytes, grainsOf(100), 'the put\'s body alone');
    assert.deepEqual([reader.figures().abandoned, reader.figures().reserved], [1, 2]);
});

test('a cold body is raised only into a segment the asking thread has', async()=>{
    const { keeper, reader, step } = await cacheOf({ disk: memoryDisk() });
    reader.put('a', bodyOf(16 * KIB, 1));
    step(100);
    assert.equal(reader.look('a'), 'cold');
    // A thread that knows the first segment only, which its bodies fill now.
    const late = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers().slice(0, 1),
        keeper: {
            reserve: keeper.reserve,
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: ()=>{}, drop: ()=>{},
        } });
    for (let i = 0; i < 4; i++)
    {
        assert.equal(late.put(`b${i}`, bodyOf(16 * KIB, 2)), true);
    }
    assert.equal(late.with('a', body=>body[1], { wait: true }), (31 + 1) & 255);
    assert.equal(late.look('b0'), 'cold', 'the oldest of the first segment made room');
});

test('a body the disk holds less of than the index says is gone, or an only copy stays cold, not'
    + ' answered with other bytes',
    async()=>{
        // The pack gone before the run: its entries are skipped as the index is read.
        const disk = memoryDisk();
        const first = await cacheOf({ disk });
        first.reader.put('doc', bodyOf(8000, 5), F_ONLY_COPY);
        first.keeper.close();
        disk.files.delete('pack-0');
        const second = await cacheOf({ disk });
        assert.equal(second.reader.look('doc'), null);
        assert.equal(second.keeper.figures().skippedEntries, 1);

        // The pack read short while the run goes on: the body is gone, not another's bytes.
        let short = false;
        const cut = {
            files: disk.files,
            async open(/** @type {string} */ name){
                const file = await disk.open(name);
                return { ...file,
                    read(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                        return short ? file.read(view.subarray(0, view.length >> 1), where)
                            : file.read(view, where);
                    } };
            },
        };
        const third = await cacheOf({ disk: cut });
        third.reader.put('doc', bodyOf(8000, 6), F_ONLY_COPY);
        third.reader.put('block', bodyOf(8000, 7));
        third.step(150);
        assert.deepEqual([third.reader.look('doc'), third.reader.look('block')], ['cold', 'cold']);
        third.reader.put('other', bodyOf(8000, 99));
        third.keeper.drop('other');
        short = true;
        assert.equal(third.reader.with('block', body=>body.slice(), { wait: true }), undefined);
        assert.equal(third.reader.look('block'), null, 'one that can be made again is gone');
        assert.equal(third.keeper.figures().lostOnDisk, 1);
        const failures = third.keeper.figures().diskFailures;
        assert.equal(third.reader.with('doc', body=>body.slice(), { wait: true }), undefined);
        assert.equal(third.reader.look('doc'), 'cold', 'an only copy is not let go on a read');
        assert.equal(third.keeper.figures().lostOnDisk, 1);
        assert.equal(third.keeper.figures().diskFailures, failures + 1, 'the read a failure, counted');
        short = false;
        assert.deepEqual(third.reader.with('doc', body=>[...body], { wait: true }), [...bodyOf(8000, 6)]);
    });

test('a body saved by a run of a larger budget is not raised, and moves nothing', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk, budget: 512 * KIB, segmentBytes: 128 * KIB });
    first.reader.put('big', bodyOf(300 * KIB, 1));
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
    first.reader.put(long, bodyOf(100, 1), F_ONLY_COPY);
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
    assert.equal(keeper.save(), true, 'nothing written since: no pack flushed');
    reader.put('b', bodyOf(100, 2));
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

test('a disk that writes less than asked holds no body, and two failed saves keep the last whole'
    + ' index', async()=>{
    const base = memoryDisk();
    let short = false;
    let failIndex = false;
    const disk = {
        files: base.files,
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            return { ...file,
                write(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                    if (failIndex && name.startsWith('index'))
                    {
                        throw new Error('quota');
                    }
                    return short && name.startsWith('pack')
                        ? file.write(view.subarray(0, view.length >> 1), where) : file.write(view, where);
                } };
        },
    };
    const first = await cacheOf({ disk });
    first.reader.put('kept', bodyOf(5000, 1), F_ONLY_COPY);
    assert.equal(first.keeper.save(), true);
    short = true;
    first.reader.put('cut', bodyOf(5000, 2), F_ONLY_COPY);
    assert.equal(first.keeper.save(), false, 'the disk did not take it whole');
    first.step(150);
    assert.equal(first.reader.look('cut'), 'hot', 'an only copy stays in memory');
    short = false;
    failIndex = true;
    assert.equal(first.keeper.save(), false);
    assert.equal(first.keeper.save(), false);
    const second = await cacheOf({ disk });
    assert.deepEqual(second.reader.with('kept', body=>[...body], { wait: true }), [...bodyOf(5000, 1)],
        'the index saved last whole');
});

test('an index of Cellar 0.9.0: an entry that does not say a body is skipped, the rest read', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('a', bodyOf(100, 1));
    first.keeper.close();
    const { name, saved } = newerAsVersion1(disk.files);
    saved.records.push([7, 0, 0, 10, 0], ['b', 0, -1, 10, 0], ['c', 0, 0, 'x', 0], null);
    disk.files.set(name, json(saved));
    const second = await cacheOf({ disk });
    assert.equal(second.keeper.figures().loaded, 1);
    assert.equal(second.reader.with('a', body=>body[1], { wait: true }), (31 + 1) & 255);
});

test('an idle span past half the keeper\'s 32-bit clock is refused', async()=>{
    for (const options of [{ coldAfterMs: 2 ** 31 }, { goneAfterMs: 30 * 24 * 3600_000 },
        { releaseAfterMs: NaN }, { coldAfterMs: -1 }, { packBytes: 2 ** 31 }])
    {
        await assert.rejects(openKeeper({ budget: 256 * KIB, ...options }), RangeError);
    }
});

test('a body idle longer than the clock\'s half, with no sweep between, is as old as it is', async()=>{
    const { reader, step } = await cacheOf({ disk: memoryDisk(), goneAfterMs: 24 * 3600_000 });
    reader.put('a', bodyOf(100, 1));
    step(150);
    assert.equal(reader.look('a'), 'cold');
    step(2 ** 31 + 10);
    assert.equal(reader.look('a'), null, 'gone: idle 24.8 days and more');
});

test('a disk that throws at once when a pack is opened is counted, and no body is left mid-move',
    async()=>{
        const base = memoryDisk();
        const disk = {
            open(/** @type {string} */ name){
                if (name.startsWith('pack'))
                {
                    throw new Error('no room');
                }
                return base.open(name);
            },
        };
        const { reader, keeper, step } = await cacheOf({ disk });
        reader.put('a', bodyOf(100, 1), F_ONLY_COPY);
        step(150);
        assert.equal(reader.look('a'), 'hot', 'an only copy the disk did not take stays');
        assert.ok(keeper.figures().diskFailures > 0);
        assert.equal(keeper.save(), false);
    });

test('a pack still opening at close whose close throws is counted, not left a rejection', async()=>{
    /** @type {unknown[]} */
    const rejected = [];
    const listen = (/** @type {unknown} */ reason)=>rejected.push(reason);
    process.on('unhandledRejection', listen);
    try
    {
        const base = memoryDisk();
        /** @type {(() => void)[]} */
        const later = [];
        const disk = {
            async open(/** @type {string} */ name){
                const file = await base.open(name);
                if (name === 'pack-0')
                {
                    await new Promise(resolve=>later.push(()=>resolve(undefined)));
                }
                return { ...file,
                    close(){
                        throw new Error('busy');
                    } };
            },
        };
        const keeper = await openKeeper({ budget: 256 * KIB, segmentBytes: 64 * KIB, disk });
        keeper.close();
        later.forEach(go=>go());
        await new Promise(resolve=>setTimeout(resolve, 10));
        assert.deepEqual(rejected, []);
        assert.ok(keeper.figures().diskFailures > 0);
    }
    finally
    {
        process.off('unhandledRejection', listen);
    }
});

test('an index of Cellar 0.9.0: an entry past its pack\'s file or of other fields, or an index read'
    + ' short, is not trusted',
    async()=>{
        const disk = memoryDisk();
        const first = await cacheOf({ disk });
        first.reader.put('a', bodyOf(100, 1));
        first.keeper.save();
        first.reader.put('b', bodyOf(100, 2));
        first.keeper.close();
        const { name, saved } = newerAsVersion1(disk.files);
        saved.records.push(['c', 0, 2 ** 40, 10, 0], ['d', 0, 0, 2 ** 31, 0], ['e', 0, 0, 10, 0, 1],
            ['f', 0, 0, 10]);
        disk.files.set(name, json(saved));
        const second = await cacheOf({ disk });
        assert.equal(second.keeper.figures().loaded, 2);
        assert.equal(second.keeper.figures().skippedEntries, 4);

        // The newer index read short: no run of it is trusted, not even its older file's.
        const short = {
            files: disk.files,
            async open(/** @type {string} */ file){
                const opened = await disk.open(file);
                return { ...opened,
                    read(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                        return file === name ? opened.read(view.subarray(1), where) : opened.read(view, where);
                    } };
            },
        };
        await assert.rejects(cacheOf({ disk: short }), /failed to read/);
    });

test('after close the keeper is memory\'s only: an only copy stays hot, a cold body is the next'
    + ' run\'s', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('cold', bodyOf(100, 1));
    first.step(150);
    assert.equal(first.reader.look('cold'), 'cold');
    first.reader.put('only', bodyOf(100, 2), F_ONLY_COPY);
    first.keeper.close();
    first.step(150);
    first.step(150);
    assert.deepEqual(first.reader.with('only', body=>[...body]), [...bodyOf(100, 2)], 'still read');
    assert.equal(first.reader.look('cold'), null, 'no body of this run');
    assert.equal(first.keeper.save(), false);
    const second = await cacheOf({ disk });
    assert.deepEqual(second.reader.with('cold', body=>[...body], { wait: true }), [...bodyOf(100, 1)]);
    assert.deepEqual(second.reader.with('only', body=>[...body], { wait: true }), [...bodyOf(100, 2)]);
});

test('an index file the disk fails to read, or reads short, keeps the keeper from opening: no pack'
    + ' is let go and no file written, and a run with the disk well reads every body', async()=>{
    const disk = crashDisk();
    const first = await cacheOf({ disk, packBytes: 16 * KIB });
    first.reader.put('old', bodyOf(12 * KIB, 1));
    first.step(150);
    await settle();
    first.keeper.save();
    first.keeper.save();
    await settle();
    // An only copy named by a delta of the newer file alone, in a pack the other does not list.
    first.reader.put('only', bodyOf(12 * KIB, 2), F_ONLY_COPY);
    first.step(150);
    await settle();
    assert.equal(first.keeper.save(), true);
    const left = disk.crash();
    for (const name of ['index-a', 'index-b'])
    {
        for (const fault of ['throws', 'short'])
        {
            const again = crashDisk(left);
            /** @type {import('./keeper.js').Disk} */
            let failing = again;
            if (fault === 'throws')
            {
                again.failing.read.add(name);
            }
            else
            {
                failing = { async open(/** @type {string} */ file){
                    const opened = await again.open(file);
                    return file !== name ? opened : { ...opened,
                        read: (/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where)=>
                            opened.read(view.subarray(1), where) };
                } };
            }
            await assert.rejects(openKeeper({ budget: 256 * KIB, segmentBytes: 64 * KIB, disk: failing }),
                new RegExp(`failed to read ${name}`), `${name} ${fault}`);
            await settle();
            assert.deepEqual(again.current(), left, `${name} ${fault}: the disk as it was`);
        }
    }
    assert.deepEqual(await nextRunReads(left, ['old', 'only']), [[...bodyOf(12 * KIB, 1)],
        [...bodyOf(12 * KIB, 2)]]);
});

test('a segment past 1 GiB, or not a power of two, is refused when the keeper opens', async()=>{
    for (const segmentBytes of [2 ** 31, 3 * UNIT, UNIT + 0.5, UNIT / 2])
    {
        await assert.rejects(openKeeper({ budget: 1, segmentBytes }), RangeError);
    }
});

test('a budget that is not a number of bytes, and a body of a fraction of a byte, are refused',
    async()=>{
        for (const budget of [NaN, -1, Infinity, /** @type {any} */ ('1')])
        {
            await assert.rejects(openKeeper({ budget }), RangeError);
        }
        const { keeper, reader } = await cacheOf();
        assert.throws(()=>placeOf(keeper, 'a', 100.5), RangeError);
        assert.equal(reader.put('a', bodyOf(100, 1)), true);
        assert.equal(keeper.figures().placedBytes, grainsOf(100));
    });

test('a disk that fails to open a file as the keeper opens has every file it opened let go',
    async()=>{
        const disk = memoryDisk();
        const first = await cacheOf({ disk });
        first.reader.put('a', bodyOf(100, 1));
        first.keeper.close();
        /** @type {Set<string>} */
        const open = new Set();
        const failing = {
            async open(/** @type {string} */ name){
                if (name === 'pack-0')
                {
                    throw new Error('no such file');
                }
                const file = await disk.open(name);
                open.add(name);
                return { ...file,
                    close(){
                        open.delete(name);
                    } };
            },
        };
        await assert.rejects(openKeeper({ budget: 256 * KIB, segmentBytes: 64 * KIB, disk: failing }),
            /no such file/);
        assert.deepEqual([...open], []);
    });

test('a keeper closed twice, a pack opening between, lets go of each file once', async()=>{
    const base = memoryDisk();
    /** @type {string[]} */
    const closes = [];
    /** @type {(() => void)[]} */
    const later = [];
    const disk = {
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            if (name === 'pack-0')
            {
                await new Promise(resolve=>later.push(()=>resolve(undefined)));
            }
            return { ...file,
                close(){
                    closes.push(name);
                } };
        },
    };
    const keeper = await openKeeper({ budget: 256 * KIB, segmentBytes: 64 * KIB, disk });
    // The pack's opening under way, held.
    while (later.length === 0)
    {
        await new Promise(resolve=>setTimeout(resolve, 0));
    }
    keeper.close();
    later.forEach(go=>go());
    await new Promise(resolve=>setTimeout(resolve, 10));
    assert.equal(keeper.close(), false);
    assert.deepEqual(closes.sort(), ['index-a', 'index-b', 'pack-0']);
});

test('an announce that throws is counted and the keeper goes on', async()=>{
    const { keeper } = await cacheOf({ announce: ()=>{
        throw new Error('no thread to tell');
    } });
    assert.ok(keeper.figures().announceFailures > 0);
    assert.notEqual(placeOf(keeper, 'a', 100), null);
});

test('an index of Cellar 0.9.0 of more packs than a run opens, or of an unsafe generation, is not'
    + ' read', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('a', bodyOf(100, 1));
    first.keeper.save();
    first.reader.put('b', bodyOf(100, 2));
    first.keeper.save();
    const { name: newer, saved } = newerAsVersion1(disk.files);
    /** @type {string[]} */
    const opened = [];
    const counting = {
        async open(/** @type {string} */ name){
            opened.push(name);
            return disk.open(name);
        },
    };
    for (const change of [{ packs: 1e9 }, { generation: 2 ** 60 }])
    {
        disk.files.set(newer, json({ ...saved, ...change }));
        opened.length = 0;
        const next = await cacheOf({ disk: counting });
        assert.equal(next.reader.look('a'), 'cold', 'the other index read');
        assert.equal(next.reader.look('b'), null);
        assert.ok(opened.length < 10, `${opened.length} files opened`);
    }
});

test('a body asked away while read and then cooled for room goes, not to the disk', async()=>{
    // Each in a segment of its own, the budget's room for one of them.
    const { reader, keeper, step } = await cacheOf({ disk: memoryDisk(), budget: 64 * KIB });
    reader.put('a', bodyOf(32 * KIB, 1), F_ONLY_COPY);
    reader.with('a', ()=>{
        keeper.drop('a');
    });
    // Room for another: the oldest is cooled before any sweep.
    assert.equal(reader.put('b', bodyOf(48 * KIB, 2)), true);
    assert.equal(reader.look('a'), null);
    step(1);
    assert.equal(keeper.figures().cold, 0);
    keeper.save();
    const next = await cacheOf({ disk: memoryDisk() });
    assert.equal(next.reader.look('a'), null);
});

test('a segment the engine will not make is counted, and room found by cooling as if the budget'
    + ' were spent: no body is left mid-move, no reservation half made', async()=>{
    const { reader, keeper } = await cacheOf({ disk: memoryDisk(), budget: 1024 * KIB });
    reader.put('cold', bodyOf(16 * KIB, 1), F_ONLY_COPY);
    reader.put('a', bodyOf(16 * KIB, 2));
    const Shared = globalThis.SharedArrayBuffer;
    globalThis.SharedArrayBuffer = /** @type {any} */ (class extends /** @type {any} */ (Shared) {
        /** @param {number} bytes @param {any} [options] */
        constructor(bytes, options){
            if (bytes === 64 * KIB)
            {
                throw new RangeError('out of memory');
            }
            super(bytes, options);
        }
    });
    try
    {
        // Four bodies fill a segment: the first and the spare made before
        // are filled, the next spare is refused, and the next write cools
        // what it must.
        for (const name of ['b', 'c', 'd', 'e', 'f', 'g', 'h'])
        {
            assert.equal(reader.put(name, bodyOf(16 * KIB, 3)), true, name);
        }
        assert.equal(reader.look('cold'), 'cold');
        assert.deepEqual(reader.with('cold', body=>[...body], { wait: true }), [...bodyOf(16 * KIB, 1)]);
        assert.equal(reader.put('c', bodyOf(16 * KIB, 5)), true, 'rewritten');
    }
    finally
    {
        globalThis.SharedArrayBuffer = Shared;
    }
    assert.ok(keeper.figures().segmentFailures > 0);
    assert.deepEqual(reader.with('c', body=>[...body]), [...bodyOf(16 * KIB, 5)]);
});

test('names are not spent once the records are full', { timeout: 120_000 }, async()=>{
    const { reader, keeper } = await cacheOf({ budget: 4096 * KIB, segmentBytes: 1024 * KIB });
    const words = new Int32Array(keeper.shared.records);
    const body = bodyOf(8, 1);
    // Each name written and dropped: its record stays for the run.
    for (let n = 0; reader.put(`${n}`, body); n++)
    {
        keeper.drop(`${n}`);
    }
    assert.equal(keeper.figures().records, 1 << 20);
    const names = Atomics.load(words, 2);
    assert.equal(reader.put('a name past the records', bodyOf(16, 1)), false);
    assert.equal(Atomics.load(words, 2), names);
});

test('an index of Cellar 0.9.0 of a generation past what a save counts to is not read', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('a', bodyOf(100, 1));
    first.keeper.save();
    first.reader.put('b', bodyOf(100, 2));
    first.keeper.save();
    const { name: newer, saved } = newerAsVersion1(disk.files);
    for (const generation of [-3, Number.MAX_SAFE_INTEGER])
    {
        disk.files.set(newer, json({ ...saved, generation }));
        const next = await cacheOf({ disk });
        assert.equal(next.reader.look('b'), null, `generation ${generation} not read`);
        assert.equal(next.reader.look('a'), 'cold');
        assert.equal(next.keeper.save(), true, 'the next save writes');
    }
});

test('a reader that missed a segment\'s message is placed only below it: an only copy rewritten is'
    + ' not lost', async()=>{
    const { reader: full, keeper } = await cacheOf({ budget: 192 * KIB });
    // The first segment: the only copy and three that never leave; the
    // second and the third four bodies each.
    full.put('a', bodyOf(16 * KIB, 1), F_ONLY_COPY);
    for (let i = 0; i < 3; i++)
    {
        full.put(`pin${i}`, bodyOf(16 * KIB, 5), F_ONLY_COPY | F_NO_DISK);
    }
    for (let i = 0; i < 8; i++)
    {
        full.put(`${i < 4 ? 'b' : 'c'}${i}`, bodyOf(16 * KIB, 2));
    }
    for (let i = 0; i < 4; i++)
    {
        keeper.drop(`b${i}`);
    }
    // A reader told of the first and the third, not of the second, which is
    // the free one (the own segments between are spares of no bytes).
    const [s0, free, s3] = keeper.segmentBuffers().filter(buffer=>buffer?.byteLength === 64 * KIB);
    const partial = createReader({ shared: keeper.shared, segments: [s0], keeper: {
        reserve: keeper.reserve,
        raise: (name, options)=>keeper.raise(name, options),
        raiseLater: ()=>{}, drop: ()=>{},
    } });
    partial.adopt({ segment: keeper.segmentBuffers().indexOf(s3), buffer: s3 });
    assert.ok(keeper.segmentBuffers().indexOf(free) < keeper.segmentBuffers().indexOf(s3));
    assert.equal(partial.put('a', bodyOf(16 * KIB, 4), F_ONLY_COPY), true);
    assert.deepEqual(partial.with('a', body=>[...body]), [...bodyOf(16 * KIB, 4)]);
    assert.equal(partial.figures().refused, 0);
});

test('a name\'s own body is not cooled to make room for its rewrite, though its reader left',
    async()=>{
        const { reader, keeper } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
        reader.put('a', bodyOf(16 * KIB, 1));
        // The rest of the one segment the budget holds, never to leave.
        for (let i = 0; i < 3; i++)
        {
            reader.put(`pin${i}`, bodyOf(16 * KIB, 2), F_ONLY_COPY | F_NO_DISK);
        }
        // Read when the rewrite looks at it, out before room is sought: a
        // reader in another thread leaving between the two.
        const words = new Int32Array(keeper.shared.records);
        const state = 16 + 2;
        Atomics.add(words, state, 1);
        const compareExchange = Atomics.compareExchange;
        let leave = true;
        Atomics.compareExchange = /** @type {any} */ ((/** @type {any} */ array, /** @type {number} */ at,
            /** @type {number} */ expected, /** @type {number} */ value)=>{
            const was = compareExchange(array, at, expected, value);
            if (leave && array.buffer === words.buffer && at === state)
            {
                // The rewrite found it read; the reader leaves now.
                leave = false;
                Atomics.sub(words, state, 1);
            }
            return was;
        });
        let place;
        try
        {
            place = placeOf(keeper, 'a', 16 * KIB, 0, 1);
        }
        finally
        {
            Atomics.compareExchange = compareExchange;
        }
        assert.equal(leave, false, 'the reader left between the two');
        assert.equal(place, null, 'no room but its own');
        assert.deepEqual(reader.with('a', body=>[...body]), [...bodyOf(16 * KIB, 1)], 'as it was');
    });

test('bytes that grow while they are put are put as long as they were', async()=>{
    const { reader } = await cacheOf();
    const shared = new /** @type {any} */ (SharedArrayBuffer)(16, { maxByteLength: 64 * KIB });
    /** A length-tracking view that grows once its length has been taken. */
    class Growing extends Uint8Array {
        get length(){
            const length = super.length;
            if (shared.byteLength === 16)
            {
                shared.grow(8 * KIB);
            }
            return length;
        }
    }
    assert.equal(reader.put('a', new Growing(shared)), true);
    assert.equal(reader.with('a', body=>body.length), 16);
});

test('a put whose bytes cannot be copied lets its reservation go', async()=>{
    const { reader, keeper } = await cacheOf();
    reader.put('a', bodyOf(100, 1));
    const odd = bodyOf(100, 2);
    const set = Uint8Array.prototype.set;
    Uint8Array.prototype.set = function(){
        throw new RangeError('offset is out of bounds');
    };
    try
    {
        assert.throws(()=>reader.put('b', odd), RangeError);
    }
    finally
    {
        Uint8Array.prototype.set = set;
    }
    keeper.sweep();
    assert.equal(keeper.figures().placedBytes, grainsOf(100), 'only a');
    assert.equal(reader.figures().abandoned, 1);
});

test('a body for this run goes cold to the disk and back, and the next run is not told of it',
    async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('texels', bodyOf(32 * KIB, 7), reserveFlags({ onlyCopy: true, disk: 'run' }));
    first.reader.put('block', bodyOf(32 * KIB, 8));
    first.step(100);
    assert.equal(first.reader.look('texels'), 'cold', 'an only copy left memory: the disk holds it');
    assert.deepEqual(first.reader.with('texels', body=>Array.from(body), { wait: true }),
        Array.from(bodyOf(32 * KIB, 7)));
    first.keeper.close();
    const second = await cacheOf({ disk });
    assert.equal(second.keeper.figures().loaded, 1, 'the block only');
    assert.equal(second.reader.look('texels'), null);
    assert.equal(second.reader.look('block'), 'cold');
});

test('a body never on the disk goes away when idle, or stays hot as the only copy; a save writes '
    + 'neither', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk });
    first.reader.put('again', bodyOf(32 * KIB, 1), reserveFlags({ disk: 'never' }));
    first.reader.put('only', bodyOf(32 * KIB, 2), F_ONLY_COPY | F_NO_DISK);
    first.step(100);
    assert.equal(first.reader.look('again'), null, 'made again: away, not to the disk');
    assert.equal(first.reader.look('only'), 'hot', 'the only copy: kept in memory');
    assert.equal(first.keeper.figures().written, 0);
    assert.equal(first.keeper.save(), true, 'whole: the next run is owed neither');
    first.keeper.close();
    assert.equal((await cacheOf({ disk })).keeper.figures().loaded, 0);
});

test('a disk policy not one of the three is refused', async()=>{
    const { reader } = await cacheOf();
    assert.throws(()=>reader.put('a', bodyOf(8, 1), reserveFlags({ disk: /** @type {any} */ ('always') })),
        /disk policy/);
    assert.throws(()=>reader.put('a', bodyOf(8, 1), reserveFlags({ disk: /** @type {any} */ ('toString') })),
        /disk policy/);
});

/**
 * What a base saved now would say, read from the shared index: every name
 * whose record is hot or cold with a copy on the disk for the next run.
 *
 * @param {import('./keeper.js').Keeper} keeper
 * @returns {Map<string, import('./index-file.js').Entry>}
 */
function indexNow(keeper){
    const index = viewIndex(keeper.shared);
    const out = new Map();
    for (let id = 0; id < index.words[H_COUNT]; id++)
    {
        const at = index.at(id);
        const state = index.state(id);
        const flags = index.words[at + R_FLAGS];
        if ((state === HOT || state === COLD) && (flags & (F_ON_DISK | F_THIS_RUN | F_NO_DISK)) === F_ON_DISK)
        {
            const from = index.words[at + R_NAME];
            const name = String.fromCharCode(...index.names.subarray(from,
                from + index.words[at + R_NAME_LENGTH]));
            out.set(name, { pack: index.words[at + R_PACK], offset: index.words[at + R_PACK_OFFSET],
                length: index.words[at + R_LENGTH], flags: flags & F_ONLY_COPY });
        }
    }
    return out;
}

/** What the newer index file of `files` says. @param {Map<string, Uint8Array>} files */
const savedIndex = files=>/** @type {import('./index-file.js').IndexFileState} */ ([...files]
    .filter(([file])=>file.startsWith('index-'))
    .map(([, bytes])=>readIndexFile(bytes, 1 << 20, F_ONLY_COPY))
    .filter(read=>read !== null)
    .sort((x, y)=>/** @type {any} */ (y).generation - /** @type {any} */ (x).generation)[0]);

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

test('a save of what changed leaves the index a base would: seeded runs of writes, reads, drops,'
    + ' rewrites while read, idle time and packs compacted', { timeout: 120_000 }, async()=>{
    let deltas = 0;
    let compacted = 0;
    let removed = 0;
    for (let seed = 1; seed <= 12; seed++)
    {
        const next = random(seed);
        const disk = memoryDisk();
        const cache = await cacheOf({ disk, packBytes: 48 * KIB });
        const { reader, keeper } = cache;
        /** @type {Map<string, number>} */
        const content = new Map();
        for (let step = 0; step < 400; step++)
        {
            const name = `n${Math.floor(next() * 30)}`;
            const roll = next();
            if (roll < 0.35)
            {
                const body = 1 + Math.floor(next() * 12 * KIB);
                const policy = next() < 0.75 ? 'kept' : next() < 0.6 ? 'run' : 'never';
                if (reader.put(name, bodyOf(body, step), reserveFlags({ onlyCopy: next() < 0.3, disk: policy })))
                {
                    content.set(name, step);
                }
            }
            else if (roll < 0.45)
            {
                // Rewritten while read: the name leads to a new record, the old one retired.
                reader.with(name, ()=>{
                    if (reader.put(name, bodyOf(64, step)))
                    {
                        content.set(name, step);
                    }
                });
            }
            else if (roll < 0.6)
            {
                reader.with(name, ()=>{}, { wait: true });
            }
            else if (roll < 0.65)
            {
                reader.drop(name);
            }
            else if (roll < 0.85)
            {
                cache.step(Math.floor(next() * 150));
            }
            else
            {
                keeper.save();
                assert.deepEqual(new Map([...savedIndex(disk.files).entries].sort()),
                    new Map([...indexNow(keeper)].sort()), `seed ${seed}, step ${step}`);
            }
            if (step % 25 === 0)
            {
                // A pack opens behind a promise.
                await new Promise(resolve=>setTimeout(resolve, 0));
            }
        }
        const figures = keeper.figures();
        deltas += figures.saved - figures.wholeSaves;
        compacted += figures.compactedBytes;
        removed += figures.packsRemoved;
        const left = indexNow(keeper);
        keeper.close();
        // A pack let go of is removed behind a promise, as on OPFS.
        await new Promise(resolve=>setTimeout(resolve, 0));
        const listed = savedIndex(disk.files).packs.map(number=>`pack-${number}`);
        for (const file of [...disk.files.keys()].filter(name=>name.startsWith('pack-')))
        {
            assert.ok(listed.includes(file), `seed ${seed}: ${file} on the disk, not listed`);
        }
        const again = await cacheOf({ disk, packBytes: 48 * KIB });
        for (const [name] of left)
        {
            const step = /** @type {number} */ (content.get(name));
            const length = /** @type {import('./index-file.js').Entry} */ (left.get(name)).length;
            assert.deepEqual(again.reader.with(name, body=>[...body], { wait: true }),
                [...bodyOf(length, step)], `seed ${seed}: ${name} read back`);
        }
    }
    assert.ok(deltas > 100, `${deltas} deltas saved`);
    assert.ok(compacted > 0, `${compacted} bytes compacted`);
    assert.ok(removed > 0, `${removed} packs removed`);
});

test('a save torn anywhere in its write, base or delta, leaves the index of the save before it',
    { timeout: 120_000 }, async()=>{
    const base = memoryDisk();
    /** @type {{ name: string, at: number, length: number } | null} */
    let last = null;
    const disk = {
        files: base.files,
        remove: base.remove,
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            return { ...file,
                write(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                    if (name.startsWith('index-'))
                    {
                        last = { name, at: where.at, length: view.length };
                    }
                    return file.write(view, where);
                } };
        },
    };
    const next = random(7);
    const cache = await cacheOf({ disk, packBytes: 48 * KIB });
    let torn = 0;
    let deltas = 0;
    for (let step = 0; step < 300; step++)
    {
        const name = `n${Math.floor(next() * 20)}`;
        const roll = next();
        if (roll < 0.5)
        {
            cache.reader.put(name, bodyOf(1 + Math.floor(next() * 8 * KIB), step),
                reserveFlags({ onlyCopy: next() < 0.3 }));
        }
        else if (roll < 0.6)
        {
            cache.reader.drop(name);
        }
        else if (roll < 0.8)
        {
            cache.step(Math.floor(next() * 150));
        }
        else
        {
            const before = savedIndex(base.files);
            last = null;
            const saved = cache.keeper.figures().wholeSaves;
            cache.keeper.save();
            const wrote = /** @type {{ name: string, at: number, length: number } | null} */ (last);
            if (wrote !== null && before !== undefined)
            {
                deltas += cache.keeper.figures().wholeSaves === saved ? 1 : 0;
                // The write cut at a point of it, as a tab closing mid-write leaves it.
                const cut = wrote.at + Math.floor(next() * wrote.length);
                const files = new Map(base.files);
                files.set(wrote.name, /** @type {Uint8Array} */ (base.files.get(wrote.name)).slice(0, cut));
                assert.deepEqual(new Map([...savedIndex(files).entries].sort()),
                    new Map([...before.entries].sort()), `step ${step}, cut at ${cut}`);
                if (torn++ % 8 === 0)
                {
                    const copy = memoryDisk();
                    for (const [file, bytes] of files)
                    {
                        copy.files.set(file, bytes.slice());
                    }
                    const run = await cacheOf({ disk: copy });
                    for (const [body, { length }] of before.entries)
                    {
                        assert.equal(run.reader.with(body, read=>read.length, { wait: true }), length,
                            `step ${step}: ${body} read by the next run`);
                    }
                }
            }
        }
        if (step % 25 === 0)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
    }
    assert.ok(torn > 20 && deltas > 10, `${torn} saves torn, ${deltas} of them deltas`);
});

/** The packs on a memory disk, by name, and their sizes. @param {Map<string, Uint8Array>} files */
const packFiles = files=>Object.fromEntries([...files].filter(([file])=>file.startsWith('pack-'))
    .map(([file, bytes])=>[file, bytes.length]).sort());

test('a pack its bodies fill less than a quarter of is compacted: what is left moves, and the save'
    + ' after lets the file go', async()=>{
    for (const remove of [true, false])
    {
        const disk = memoryDisk({ remove });
        const { reader, keeper, step } = await cacheOf({ disk, packBytes: 64 * KIB });
        for (let i = 0; i < 6; i++)
        {
            reader.put(`a${i}`, bodyOf(10 * KIB, i));
        }
        step(100);
        await settle();
        reader.put('b', bodyOf(10 * KIB, 9));
        step(100);
        assert.equal(keeper.figures().packs, 2, 'pack-0 full, b in pack-1');
        for (let i = 1; i < 6; i++)
        {
            reader.put(`a${i}`, bodyOf(10 * KIB, 20 + i));
        }
        assert.equal(keeper.figures().compactedBytes, 0);
        step(1);
        assert.equal(keeper.figures().compactedBytes, 10 * KIB, 'a0 moved, the rest of pack-0 dead');
        keeper.save();
        await settle();
        assert.equal(keeper.figures().packsRemoved, 1);
        assert.equal(keeper.figures().reclaimedBytes, 60 * KIB);
        assert.equal(packFiles(disk.files)['pack-0'], remove ? undefined : 0,
            remove ? 'removed' : 'cut to nothing where the disk cannot remove a file');
        assert.deepEqual(reader.with('a0', body=>[...body], { wait: true }), [...bodyOf(10 * KIB, 0)]);
        keeper.close();
        const again = await cacheOf({ disk, packBytes: 64 * KIB });
        assert.deepEqual(again.reader.with('a0', body=>[...body], { wait: true }),
            [...bodyOf(10 * KIB, 0)], 'and found where it moved by the next run');
        assert.deepEqual(again.reader.with('a3', body=>[...body], { wait: true }),
            [...bodyOf(10 * KIB, 23)]);
    }
});

test('a pass compacts a mebibyte at most past its first body; the next sweep moves on, and every'
    + ' body is read back where it moved', async()=>{
    const MIB = 1024 * KIB;
    const { reader, keeper, step } = await cacheOf({ disk: memoryDisk(), packBytes: 8 * MIB,
        budget: 32 * MIB, segmentBytes: 2 * MIB, goneAfterMs: 1e9 });
    for (let i = 0; i < 15; i++)
    {
        reader.put(`a${i}`, bodyOf(512 * KIB, i));
    }
    step(100);
    await settle();
    // Past what pack-0 has left: pack-1 is the one bodies go to.
    reader.put('b', bodyOf(600 * KIB, 99));
    step(100);
    assert.equal(keeper.figures().packs, 2);
    // Three bodies of 512 KiB left live in pack-0: a fifth of its file.
    for (let i = 3; i < 15; i++)
    {
        reader.put(`a${i}`, bodyOf(512 * KIB, 50 + i));
    }
    step(1);
    assert.equal(keeper.figures().compactedBytes, MIB, 'two bodies, the third past the pass');
    step(1);
    assert.equal(keeper.figures().compactedBytes, 1.5 * MIB, 'the rest at the next sweep');
    step(1);
    assert.equal(keeper.figures().compactedBytes, 1.5 * MIB);
    for (let i = 0; i < 3; i++)
    {
        const want = bodyOf(512 * KIB, i);
        assert.equal(reader.with(`a${i}`, body=>body.every((byte, at)=>byte === want[at]), { wait: true }),
            true, `a${i}`);
    }
});

test('a pack let go of is reclaimed once its file is gone: until then, and where the disk fails to'
    + ' remove it, it is going, in the figures', async()=>{
    for (const fails of [false, true])
    {
        const disk = crashDisk();
        const { reader, keeper, step } = await cacheOf({ disk, packBytes: 16 * KIB });
        reader.put('a', bodyOf(12 * KIB, 1));
        step(150);
        await settle();
        reader.put('b', bodyOf(12 * KIB, 2));
        step(150);
        await settle();
        // a written anew: pack-0 holds nothing live, and the save lets it go.
        reader.put('a', bodyOf(12 * KIB, 3));
        if (fails)
        {
            disk.failing.remove.add('pack-0');
        }
        keeper.save();
        assert.deepEqual([keeper.figures().packsRemoved, keeper.figures().going,
            keeper.figures().reclaimedBytes], [1, 1, 0], 'let go of, its file not gone yet');
        await settle();
        assert.deepEqual([keeper.figures().going, keeper.figures().reclaimedBytes],
            fails ? [1, 0] : [0, 12 * KIB], fails ? 'left to the next run' : 'gone');
        assert.equal(disk.current().has('pack-0'), fails);
    }
});

test('a pack whose only copy cannot be read is set aside: compaction tries it once, not at every'
    + ' sweep, and a raise still tries its body', async()=>{
    const disk = crashDisk();
    const { reader, keeper, step } = await cacheOf({ disk, packBytes: 16 * KIB });
    reader.put('only', bodyOf(2 * KIB, 1), F_ONLY_COPY);
    reader.put('a', bodyOf(12 * KIB, 2));
    step(150);
    await settle();
    reader.put('b', bodyOf(12 * KIB, 3));
    step(150);
    await settle();
    // a written anew: pack-0 is the only copy alone, a seventh of it live.
    reader.put('a', bodyOf(12 * KIB, 4));
    disk.failing.read.add('pack-0');
    const failures = keeper.figures().diskFailures;
    for (let i = 0; i < 4; i++)
    {
        step(1);
    }
    assert.equal(keeper.figures().diskFailures - failures, 1, 'read once');
    assert.equal(keeper.figures().packsSetAside, 1);
    assert.equal(reader.look('only'), 'cold', 'the only copy stays where it is');
    assert.equal(keeper.raise('only'), false);
    assert.equal(keeper.figures().diskFailures - failures, 2, 'a raise reads it again');
    disk.failing.read.clear();
    assert.deepEqual(reader.with('only', body=>[...body], { wait: true }), [...bodyOf(2 * KIB, 1)]);
});

test('a keeper opening an index lets go of the packs no body of it is in: what the run before'
    + ' wrote for itself', async()=>{
    const disk = memoryDisk();
    const first = await cacheOf({ disk, packBytes: 64 * KIB });
    for (let i = 0; i < 6; i++)
    {
        first.reader.put(`texels${i}`, bodyOf(10 * KIB, i), reserveFlags({ onlyCopy: true, disk: 'run' }));
    }
    first.step(100);
    await settle();
    first.reader.put('block', bodyOf(10 * KIB, 9));
    first.step(100);
    first.keeper.close();
    await settle();
    assert.ok('pack-0' in packFiles(disk.files), 'its bodies were this run\'s to the end');
    const second = await cacheOf({ disk, packBytes: 64 * KIB });
    await settle();
    assert.equal(second.keeper.figures().packsRemoved, 2, 'pack-0, and pack-2 opened ahead at the close');
    assert.deepEqual(Object.keys(packFiles(disk.files)), ['pack-1', 'pack-3'],
        'the block\'s, and the one this run opened ahead');
    assert.equal(second.reader.look('texels0'), null);
    assert.deepEqual(second.reader.with('block', body=>[...body], { wait: true }),
        [...bodyOf(10 * KIB, 9)]);
});

/**
 * A memory disk that refuses a write to a pack, as a full disk does, where
 * the packs would hold more than `quota` bytes.
 *
 * @param {number} quota
 */
function quotaDisk(quota){
    const base = memoryDisk();
    return {
        files: base.files,
        remove: base.remove,
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            return { ...file,
                write(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                    const others = [...base.files].filter(([other])=>other.startsWith('pack-')
                        && other !== name).reduce((sum, [, bytes])=>sum + bytes.length, 0);
                    if (name.startsWith('pack-') && others + Math.max(file.getSize(),
                        where.at + view.length) > quota)
                    {
                        throw new Error('QuotaExceededError');
                    }
                    return file.write(view, where);
                } };
        },
    };
}

test('a disk that refuses for room makes it from the bodies used longest ago, not the newest',
    async()=>{
    // Packs of 32 KiB, room for two on the disk.
    const disk = quotaDisk(64 * KIB);
    const { reader, keeper, step } = await cacheOf({ disk, packBytes: 32 * KIB,
        goneAfterMs: 1e6 });
    for (let i = 0; i < 6; i++)
    {
        reader.put(`old${i}`, bodyOf(10 * KIB, i));
        step(100);
        await settle();
    }
    assert.equal(keeper.figures().cold, 6, 'two packs of three');
    step(5000);
    reader.put('new0', bodyOf(10 * KIB, 10));
    step(100);
    assert.ok(keeper.figures().diskFailures > 0, 'the disk refused it');
    keeper.save();
    await settle();
    assert.equal(keeper.figures().evicted, 3, 'the pack used longest ago emptied');
    assert.equal(keeper.figures().packsRemoved, 1);
    for (let i = 1; i <= 3; i++)
    {
        reader.put(`new${i}`, bodyOf(10 * KIB, 10 + i));
        step(100);
        await settle();
        assert.equal(reader.look(`new${i}`), 'cold', `new${i} on the disk`);
    }
    assert.deepEqual([0, 1, 2].map(i=>reader.look(`old${i}`)), [null, null, null]);
    assert.deepEqual([3, 4, 5].map(i=>reader.look(`old${i}`)), ['cold', 'cold', 'cold']);
});

test('a pack an only copy moved out of stays while either index file names it there, so a torn'
    + ' save still finds the copy', async()=>{
    const base = memoryDisk();
    /** @type {{ name: string, at: number } | null} */
    let last = null;
    const disk = {
        files: base.files,
        remove: base.remove,
        async open(/** @type {string} */ name){
            const file = await base.open(name);
            return { ...file,
                write(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                    if (name.startsWith('index-'))
                    {
                        last = { name, at: where.at };
                    }
                    return file.write(view, where);
                } };
        },
    };
    const { reader, keeper, step } = await cacheOf({ disk, packBytes: 64 * KIB });
    reader.put('only', bodyOf(10 * KIB, 1), F_ONLY_COPY);
    for (let i = 0; i < 5; i++)
    {
        reader.put(`a${i}`, bodyOf(10 * KIB, 2 + i));
    }
    step(100);
    keeper.save();
    keeper.save();
    await settle();
    reader.put('b', bodyOf(10 * KIB, 9));
    step(100);
    for (let i = 0; i < 5; i++)
    {
        reader.drop(`a${i}`);
    }
    step(1);
    assert.equal(keeper.figures().compactedBytes, 10 * KIB, 'the only copy moved to pack-1');
    keeper.save();
    await settle();
    assert.ok('pack-0' in packFiles(base.files), 'the file not written names it in pack-0');
    // That save torn: the index before it is read, the only copy in pack-0.
    const wrote = /** @type {{ name: string, at: number } | null} */ (last);
    assert.ok(wrote !== null);
    const copy = memoryDisk();
    for (const [file, bytes] of base.files)
    {
        copy.files.set(file, file === wrote.name ? bytes.slice(0, wrote.at + 3) : bytes.slice());
    }
    const torn = await cacheOf({ disk: copy });
    assert.deepEqual(torn.reader.with('only', body=>[...body], { wait: true }),
        [...bodyOf(10 * KIB, 1)]);
    keeper.save();
    await settle();
    assert.ok(!('pack-0' in packFiles(base.files)), 'both files written anew: it goes');
    keeper.close();
    const again = await cacheOf({ disk: base });
    assert.deepEqual(again.reader.with('only', body=>[...body], { wait: true }),
        [...bodyOf(10 * KIB, 1)]);
});

test('a save with nothing changed writes nothing, and one after a change writes the change',
    async()=>{
    const disk = memoryDisk();
    const { reader, keeper, step } = await cacheOf({ disk, budget: 4 << 20,
        segmentBytes: 1 << 20 });
    for (let i = 0; i < 1000; i++)
    {
        reader.put(`bundles/demo/blocks/${i}`, bodyOf(64, i));
    }
    step(100);
    keeper.save();
    keeper.save();
    const { saved, savedBytes, wholeSaves } = keeper.figures();
    assert.equal(wholeSaves, 2, 'a base into each file as the keeper opens');
    assert.equal(keeper.save(), true);
    assert.equal(keeper.figures().saved, saved, 'nothing written');
    assert.equal(keeper.figures().savedBytes, savedBytes);
    reader.put('bundles/demo/blocks/new', bodyOf(64, 1));
    step(100);
    keeper.save();
    const delta = keeper.figures().savedBytes - savedBytes;
    assert.equal(keeper.figures().wholeSaves, 2, 'a delta');
    assert.ok(delta < 200, `${delta} bytes for one body, the base ${savedBytes / 2}`);
});

test('what a saved index names is read without a keeper as a keeper opening it reads it, a torn '
    + 'newest one leaving the one before', async()=>{
    const { INDEX_FILES, packFile, readSaved } = await import('./keeper.js');
    const disk = memoryDisk();
    const { reader, keeper, step } = await cacheOf({ disk });
    for (let i = 0; i < 6; i++)
    {
        reader.put(`n${i}`, bodyOf(20 * KIB, i));
    }
    reader.put('only', bodyOf(5000, 9), F_ONLY_COPY);
    reader.put('run', bodyOf(5000, 10), reserveFlags({ onlyCopy: true, disk: 'run' }));
    step(100);
    assert.equal(keeper.save(), true);
    /** @returns {(Uint8Array | null)[]} */
    const bytes = ()=>INDEX_FILES.map(name=>disk.files.get(name)?.slice() ?? null);
    const saved = readSaved(bytes());
    assert.ok(saved);
    assert.deepEqual([...saved.bodies.keys()].sort(), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'only'],
        'every body the next run reads, and not one of this run only');
    for (const [name, body] of saved.bodies)
    {
        const pack = /** @type {Uint8Array} */ (disk.files.get(packFile(body.pack)));
        const expected = name === 'only' ? bodyOf(5000, 9) : bodyOf(20 * KIB, Number(name.slice(1)));
        assert.deepEqual(pack.subarray(body.offset, body.offset + body.length), expected, name);
    }
    // The next save: a body more, then its delta cut short.
    reader.put('n6', bodyOf(20 * KIB, 6));
    step(100);
    const before = bytes();
    assert.equal(keeper.save(), true);
    const after = bytes();
    const grown = after.findIndex((file, at)=>(file?.length ?? 0) !== (before[at]?.length ?? 0));
    assert.ok(grown >= 0, 'the save wrote one of the files');
    assert.ok(readSaved(after)?.bodies.has('n6'));
    after[grown] = /** @type {Uint8Array} */ (after[grown]).subarray(0,
        /** @type {Uint8Array} */ (after[grown]).length - 1);
    assert.equal(readSaved(after)?.bodies.has('n6'), false, 'torn: the index before it');
    assert.equal(readSaved([null, null]), null);
    keeper.close();
});

/**
 * The bodies a run after this one finds, read by a keeper over `files` and
 * closed: each name's body as an array, or null where it has none.
 *
 * @param {Map<string, Uint8Array>} files @param {string[]} names @param {object} [options]
 */
async function nextRunReads(files, names, options = {}){
    const run = await cacheOf({ disk: crashDisk(files), ...options });
    const out = names.map(name=>run.reader.with(name, body=>[...body], { wait: true }) ?? null);
    run.keeper.close();
    return out;
}

test('a save whose index the disk took but did not flush spends its generation: the save after it'
    + ' is the newer one', async()=>{
    const disk = crashDisk();
    const { reader, keeper } = await cacheOf({ disk });
    reader.put('a', bodyOf(5000, 1), F_ONLY_COPY);
    assert.equal(keeper.save(), true);
    assert.equal(keeper.save(), true, 'a base into each file');
    reader.put('b', bodyOf(5000, 2), F_ONLY_COPY);
    // A delta written whole, its flush refused: the bytes are on the disk all the same.
    disk.failing.flush.add('index-a').add('index-b');
    assert.equal(keeper.save(), false);
    disk.failing.flush.clear();
    reader.put('c', bodyOf(5000, 3), F_ONLY_COPY);
    assert.equal(keeper.close(), true);
    assert.deepEqual(await nextRunReads(disk.current(), ['a', 'b', 'c']),
        [[...bodyOf(5000, 1)], [...bodyOf(5000, 2)], [...bodyOf(5000, 3)]]);
});

test('a pack compacted moves a hot body as it moves a cold one: an only copy read again is still'
    + ' named where it went, though the disk refuses to write it after', async()=>{
    const disk = crashDisk();
    const { reader, keeper, step } = await cacheOf({ disk, packBytes: 64 * KIB });
    reader.put('only', bodyOf(10 * KIB, 1), F_ONLY_COPY);
    for (let i = 0; i < 5; i++)
    {
        reader.put(`a${i}`, bodyOf(10 * KIB, 2 + i));
    }
    step(150);
    await settle();
    keeper.save();
    keeper.save();
    reader.put('b', bodyOf(10 * KIB, 9));
    step(150);
    await settle();
    assert.deepEqual(reader.with('only', body=>[...body], { wait: true }), [...bodyOf(10 * KIB, 1)]);
    assert.equal(reader.look('only'), 'hot', 'read again: its copy in pack-0 still its own');
    for (let i = 0; i < 5; i++)
    {
        reader.drop(`a${i}`);
    }
    step(1);
    assert.equal(keeper.figures().compactedBytes, 10 * KIB, 'the hot only copy moved to pack-1');
    disk.failing.write.add('pack-1');
    assert.equal(keeper.save(), true, 'nothing left to write');
    await settle();
    assert.deepEqual(await nextRunReads(disk.crash(), ['only', 'b']),
        [[...bodyOf(10 * KIB, 1)], [...bodyOf(10 * KIB, 9)]]);
});

test('a close whose save fails brings back into memory the cold only copies no whole save names, and'
    + ' a body for this run; one memory has no room for is counted', async()=>{
    for (const fault of ['none', 'index', 'pack'])
    {
        const disk = crashDisk();
        const { reader, keeper, step } = await cacheOf({ disk, packBytes: 16 * KIB });
        reader.put('first', bodyOf(12 * KIB, 1));
        step(150);
        await settle();
        keeper.save();
        keeper.save();
        reader.put('only', bodyOf(12 * KIB, 2), F_ONLY_COPY);
        reader.put('texels', bodyOf(2 * KIB, 3), reserveFlags({ onlyCopy: true, disk: 'run' }));
        step(150);
        await settle();
        assert.deepEqual([reader.look('only'), reader.look('texels')], ['cold', 'cold'], fault);
        if (fault === 'index')
        {
            disk.failing.write.add('index-a').add('index-b');
        }
        else if (fault === 'pack')
        {
            // A body the close's save writes there: a pack nothing was
            // written to since its flush is not flushed again.
            reader.put('late', bodyOf(KIB, 4));
            disk.failing.flush.add('pack-0').add('pack-1');
        }
        assert.equal(keeper.close(), fault === 'none', fault);
        assert.deepEqual(reader.with('texels', body=>[...body]), [...bodyOf(2 * KIB, 3)], fault);
        assert.equal(reader.look('first'), null, `${fault}: named, so the next run's`);
        assert.equal(keeper.figures().lostAtClose, 0);
        if (fault === 'none')
        {
            assert.equal(reader.look('only'), null, 'named, so the next run\'s');
            continue;
        }
        assert.deepEqual(reader.with('only', body=>[...body]), [...bodyOf(12 * KIB, 2)], fault);
        step(1000);
        assert.equal(reader.look('only'), 'hot', `${fault}: memory's for good`);
    }
    // Memory full of only copies that stay: the one brought back has no room.
    const disk = crashDisk();
    const { reader, keeper, step } = await cacheOf({ disk, budget: 64 * KIB });
    reader.put('only', bodyOf(60 * KIB, 4), F_ONLY_COPY);
    step(150);
    // Its own segment: the budget's room for one such.
    assert.equal(reader.put('h1', bodyOf(60 * KIB, 5), F_ONLY_COPY | F_NO_DISK), true);
    disk.failing.write.add('index-a').add('index-b');
    assert.equal(keeper.close(), false);
    assert.equal(reader.look('only'), null);
    assert.equal(keeper.figures().lostAtClose, 1);
});

test('a full disk makes room from the oldest pack it can empty: not one an only copy holds, whose'
    + ' bodies would go for nothing', async()=>{
    for (const order of ['only copy first', 'only copy last'])
    {
        const { reader, keeper, step } = await cacheOf({ disk: quotaDisk(40_000), packBytes: 16_384,
            goneAfterMs: 1e6 });
        /** @param {string[]} names @param {boolean} [onlyCopy] */
        const round = async(names, onlyCopy = false)=>{
            for (const name of names)
            {
                reader.put(name, bodyOf(4000, name.charCodeAt(1)), reserveFlags({ onlyCopy }));
            }
            step(100);
            keeper.save();
            await settle();
        };
        const first = ['c0', 'c1', 'c2'];
        if (order === 'only copy first')
        {
            await round(['X0'], true);
            await round(first);
        }
        else
        {
            await round(first);
            await round(['X0'], true);
        }
        await round(['d0', 'd1', 'd2', 'd3']);
        await round(['e0', 'e1', 'e2', 'e3']);
        assert.ok(keeper.figures().diskFailures > 0, `${order}: the disk full`);
        for (let i = 0; i < 4; i++)
        {
            await round([`o${i}`], true);
        }
        assert.deepEqual([0, 1, 2, 3].map(i=>reader.look(`o${i}`)), ['cold', 'cold', 'cold', 'cold'],
            `${order}: the only copies written after made room`);
        assert.deepEqual(['d0', 'd1', 'd2', 'd3'].map(name=>reader.look(name)), [null, null, null, null],
            `${order}: the oldest pack that could be emptied`);
        assert.deepEqual([...first, 'X0'].map(name=>reader.look(name)), ['cold', 'cold', 'cold', 'cold'],
            `${order}: the pack of the only copy kept whole`);
        assert.deepEqual(reader.with('X0', body=>[...body], { wait: true }),
            [...bodyOf(4000, '0'.charCodeAt(0))]);
        assert.equal(keeper.figures().evicted, 4, order);
        keeper.close();
    }
});

test('compaction passes over a pack it has emptied that an index still names an only copy in, and'
    + ' goes on to the packs mostly dead', async()=>{
    /** @type {number[]} */
    const compacted = [];
    for (const onlyCopy of [true, false])
    {
        const disk = memoryDisk();
        const { reader, keeper, step } = await cacheOf({ disk, packBytes: 32 * KIB, budget: 512 * KIB,
            goneAfterMs: 1e9 });
        reader.put('only', bodyOf(30 * KIB, 1), reserveFlags({ onlyCopy }));
        step(150);
        await settle();
        for (let p = 0; p < 4; p++)
        {
            for (let i = 0; i < 5; i++)
            {
                reader.put(`p${p}_${i}`, bodyOf(6 * KIB, p * 5 + i));
            }
            step(150);
            await settle();
        }
        keeper.save();
        keeper.save();
        await settle();
        reader.drop('only');
        for (let p = 0; p < 4; p++)
        {
            for (let i = 1; i < 5; i++)
            {
                reader.drop(`p${p}_${i}`);
            }
        }
        step(1);
        keeper.save();
        await settle();
        assert.equal('pack-0' in packFiles(disk.files), onlyCopy,
            'kept while both files name the only copy there');
        for (let s = 0; s < 8; s++)
        {
            step(1);
            await settle();
        }
        compacted.push(keeper.figures().compactedBytes);
        for (let p = 0; p < 4; p++)
        {
            assert.deepEqual(reader.with(`p${p}_0`, body=>[...body], { wait: true }),
                [...bodyOf(6 * KIB, p * 5)]);
        }
        keeper.close();
    }
    assert.ok(compacted[1] >= 3 * 6 * KIB, `${compacted[1]} bytes moved`);
    assert.equal(compacted[0], compacted[1], 'as much moved with the emptied pack still named');
});

/**
 * The pack files of `files`, and the packs the index they hold lists.
 *
 * @param {Map<string, Uint8Array>} files
 */
const packsOf = files=>({
    files: [...files.keys()].filter(name=>name.startsWith('pack-')).sort(),
    listed: (readSaved(INDEX_FILES.map(name=>files.get(name) ?? null))?.packs ?? [])
        .map(number=>`pack-${number}`).sort(),
});

/**
 * A run whose `pack-0` is compacted out of, `pack-1` in use: the next save
 * lets `pack-0` go.
 *
 * @param {ReturnType<typeof crashDisk>} disk
 */
async function packLetGo(disk){
    const cache = await cacheOf({ disk, packBytes: 64 * KIB });
    for (let i = 0; i < 6; i++)
    {
        cache.reader.put(`a${i}`, bodyOf(10 * KIB, i));
    }
    cache.step(150);
    await settle();
    cache.keeper.save();
    cache.keeper.save();
    cache.reader.put('b', bodyOf(10 * KIB, 9));
    cache.step(150);
    await settle();
    for (let i = 0; i < 5; i++)
    {
        cache.reader.drop(`a${i}`);
    }
    cache.step(1);
    assert.equal(cache.keeper.figures().compactedBytes, 10 * KIB);
    return cache;
}

test('a pack is listed until its file is gone: a crash before the removal a save started, a removal'
    + ' the disk failed, a cut not flushed, a pack opening during a save leave no file no index lists',
    async()=>{
    /**
     * Every pack file on the disk is listed, and so it is after a run over it.
     *
     * @param {Map<string, Uint8Array>} files @param {string} what
     */
    const noneLeft = async(files, what)=>{
        const { files: on, listed } = packsOf(files);
        assert.deepEqual(on.filter(file=>!listed.includes(file)), [], `${what}: on the disk, not listed`);
        const disk = crashDisk(files);
        const run = await cacheOf({ disk, packBytes: 64 * KIB });
        await settle();
        run.keeper.close();
        await settle();
        const after = packsOf(disk.current());
        assert.deepEqual(after.files.filter(file=>!after.listed.includes(file)), [],
            `${what}: after a run`);
        return after.files;
    };

    // A crash after the save that let pack-0 go, before its removal ran.
    const crashed = crashDisk();
    const a = await packLetGo(crashed);
    a.keeper.save();
    const left = crashed.crash(()=>true);
    assert.ok(left.has('pack-0'), 'the removal had not run');
    assert.ok(!(await noneLeft(left, 'crash before the removal')).includes('pack-0'));

    // A removal the disk failed: listed by the close after it.
    const failing = crashDisk();
    const b = await packLetGo(failing);
    failing.failing.remove.add('pack-0');
    b.keeper.save();
    await settle();
    assert.ok(b.keeper.figures().diskFailures > 0);
    b.keeper.close();
    await settle();
    assert.ok(!(await noneLeft(failing.current(), 'removal failed')).includes('pack-0'));

    // A disk that cuts rather than removes: the cut is flushed before the file is left.
    const cutting = crashDisk(new Map(), { remove: false });
    const c = await packLetGo(cutting);
    c.keeper.save();
    assert.equal(cutting.crash().get('pack-0')?.length, 0, 'cut, and the cut on the disk');
    c.keeper.close();

    // A save while the next pack opens: it is listed, so a body written there after, and a crash
    // before the next save, leave no file no index lists.
    const base = crashDisk();
    /** @type {(() => void) | null} */
    let release = null;
    const slow = { remove: base.remove, async open(/** @type {string} */ name){
        const file = await base.open(name);
        if (name === 'pack-1')
        {
            await new Promise(resolve=>{
                release = ()=>resolve(undefined);
            });
        }
        return file;
    } };
    const d = await cacheOf({ disk: slow, packBytes: 16 * KIB });
    d.reader.put('a', bodyOf(12 * KIB, 1));
    d.step(150);
    await settle();
    assert.ok(release !== null, 'pack-1 opening');
    assert.equal(d.keeper.save(), true);
    /** @type {() => void} */ (release)();
    await settle();
    d.reader.put('b', bodyOf(12 * KIB, 2));
    d.step(150);
    assert.equal(d.reader.look('b'), 'cold', 'in pack-1, flushed by the sweep');
    const opened = base.crash();
    assert.ok((opened.get('pack-1')?.length ?? 0) > 0);
    assert.ok(!(await noneLeft(opened, 'opening during a save')).includes('pack-1'));
});

/**
 * An index base of `entries`, each [name, pack, length] at the pack's start.
 *
 * @param {number} generation @param {number} nextPack @param {number[]} packs
 * @param {[string, number, number][]} entries
 */
function baseOf(generation, nextPack, packs, entries){
    const writer = chunkWriter();
    for (const [name, pack, length] of entries)
    {
        const units = Uint16Array.from(name, unit=>unit.charCodeAt(0));
        writer.entry(pack, 0, length, 0, units, 0, name.length);
    }
    return writer.finish({ kind: BASE, generation, nextPack, packs });
}

test('pack numbers are given from past the highest either index file names, not from the count the'
    + ' run before reached: a disk whose count reached what a run reads still takes bodies', async()=>{
    const full = crashDisk(new Map([['index-a', baseOf(5, 1 << 20, [], [])]]));
    const run = await cacheOf({ disk: full });
    run.reader.put('only', bodyOf(4000, 1), F_ONLY_COPY);
    run.reader.put('block', bodyOf(4000, 2));
    run.step(150);
    await settle();
    assert.deepEqual([run.reader.look('only'), run.reader.look('block')], ['cold', 'cold']);
    assert.equal(run.keeper.close(), true);
    assert.deepEqual(await nextRunReads(full.current(), ['only', 'block']),
        [[...bodyOf(4000, 1)], [...bodyOf(4000, 2)]]);

    // The older file names pack-7, the newer pack-2: neither number is given again.
    const disk = crashDisk(new Map([
        ['index-a', baseOf(3, 8, [7], [['x', 7, 100]])], ['pack-7', bodyOf(100, 3)],
        ['index-b', baseOf(4, 5, [2], [['y', 2, 100]])], ['pack-2', bodyOf(100, 4)],
    ]));
    const later = await cacheOf({ disk });
    assert.deepEqual(later.reader.with('y', body=>[...body], { wait: true }), [...bodyOf(100, 4)]);
    assert.deepEqual(packsOf(disk.current()).files, ['pack-2', 'pack-7', 'pack-8'], 'pack-8 opened ahead');
    later.keeper.close();

    // A file a crash left before any index listed it, on a disk that cannot
    // say what it holds: its number given again, what it held cut.
    const left = crashDisk(new Map([['pack-0', bodyOf(50 * KIB, 5)]]));
    const again = await cacheOf({ disk: { ...left, names: undefined } });
    again.reader.put('a', bodyOf(4000, 6));
    again.step(150);
    again.keeper.close();
    assert.equal(left.current().get('pack-0')?.length, 4000);
});

test('a pack file no index names is let go of as the keeper opens, where the disk says what it'
    + ' holds: removed, or cut where it cannot be removed, and its number not given again', async()=>{
    for (const remove of [true, false])
    {
        const left = crashDisk(new Map([['index-a', baseOf(3, 2, [1], [['x', 1, 100]])],
            ['pack-1', bodyOf(100, 3)], ['pack-4', bodyOf(50 * KIB, 5)], ['pack-x', bodyOf(10, 1)]]),
        { remove });
        const run = await cacheOf({ disk: left });
        await settle();
        assert.equal(run.keeper.figures().strayPacks, 1);
        assert.deepEqual(run.reader.with('x', body=>[...body], { wait: true }), [...bodyOf(100, 3)]);
        assert.equal(left.current().get('pack-4')?.length, remove ? undefined : 0, 'its bytes gone');
        assert.ok(left.current().has('pack-5'), 'the next pack opened past it');
        assert.ok(left.current().has('pack-x'), 'a file of no pack\'s name is not the keeper\'s');
        run.keeper.close();
    }
});

test('readSaved trusts no more than a keeper opening the index: an entry of 0.9.0 at a negative offset'
    + ' or of no bytes is not a body, and a chunk listing a pack twice is no index', ()=>{
    const json = new TextEncoder().encode(JSON.stringify({ version: 1, generation: 3, packs: 1,
        records: [['a', 0, 0, 10, 0], ['b', 0, -5, 10, 0], ['c', 0, 10, 0, 0]] }));
    assert.deepEqual([...(readSaved([json, null])?.bodies.keys() ?? [])], ['a']);
    assert.equal(readSaved([baseOf(1, 4, [2, 2], []), null]), null);
});

test('a sweep or a save flushes the packs written since their last flush, not every pack', async()=>{
    const disk = crashDisk();
    const { reader, keeper, step } = await cacheOf({ disk, packBytes: 16 * KIB });
    for (let i = 0; i < 4; i++)
    {
        reader.put(`n${i}`, bodyOf(12 * KIB, i));
        step(150);
        await settle();
    }
    assert.equal(keeper.figures().packs, 4);
    const packFlushes = ()=>disk.flushes.filter(name=>name.startsWith('pack-')).length;
    const before = packFlushes();
    step(1);
    step(1);
    assert.ok(keeper.save());
    assert.equal(packFlushes() - before, 0, 'nothing written: no pack flushed');
    reader.put('n4', bodyOf(2 * KIB, 4));
    step(150);
    assert.equal(packFlushes() - before, 1, 'the one the cooled body went to');
    step(1);
    assert.equal(packFlushes() - before, 1);
});

test('a sweep that cools many only copies flushes their pack once, and none leaves memory before'
    + ' it; a flush that fails keeps them all hot', async()=>{
    for (const failing of [false, true])
    {
        const disk = crashDisk();
        const { reader, keeper, step } = await cacheOf({ disk });
        await settle();
        for (let i = 0; i < 5; i++)
        {
            reader.put(`only${i}`, bodyOf(2 * KIB, i), F_ONLY_COPY);
        }
        if (failing)
        {
            disk.failing.flush.add('pack-0');
        }
        const before = disk.flushes.length;
        step(150);
        // A flush that failed is tried again by the sweep's own, once.
        assert.deepEqual(disk.flushes.slice(before), failing ? ['pack-0', 'pack-0'] : ['pack-0'],
            'one flush for five');
        for (let i = 0; i < 5; i++)
        {
            assert.equal(reader.look(`only${i}`), failing ? 'hot' : 'cold', `only${i}`);
        }
        assert.equal(keeper.figures().cooled, failing ? 0 : 5);
    }
});

test('a save flushes each pack once, not once a body; where that flush fails, no body it wrote counts'
    + ' as the disk\'s, so an only copy is written again before it leaves memory', async()=>{
    const disk = crashDisk();
    const { reader, keeper, step } = await cacheOf({ disk, budget: 1024 * KIB });
    for (let i = 0; i < 200; i++)
    {
        reader.put(`only${i}`, bodyOf(64, i), F_ONLY_COPY);
    }
    const before = disk.flushes.length;
    assert.equal(keeper.save(), true);
    const flushed = disk.flushes.slice(before).filter(name=>name.startsWith('pack-'));
    assert.deepEqual(flushed, ['pack-0'], 'one pack, one flush');

    // The pack's flush fails and loses what the save wrote: the copy there is not the body's.
    reader.put('lost', bodyOf(3000, 7), F_ONLY_COPY);
    disk.failing.losing.add('pack-0');
    assert.equal(keeper.save(), false);
    disk.failing.losing.clear();
    step(150);
    assert.equal(reader.look('lost'), 'cold');
    assert.equal(keeper.save(), true);
    assert.deepEqual(await nextRunReads(disk.crash(), ['lost', 'only0'], { budget: 1024 * KIB }),
        [[...bodyOf(3000, 7)], [...bodyOf(64, 0)]]);
});

test('a pack compacted that reads short keeps its only copy cold and counts the failure; a body that'
    + ' can be made again there is gone', async()=>{
    const base = crashDisk();
    let short = false;
    const disk = { remove: base.remove, async open(/** @type {string} */ name){
        const file = await base.open(name);
        return { ...file, read: (/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where)=>
            (short && name === 'pack-0' ? file.read(view.subarray(0, view.length >> 1), where)
                : file.read(view, where)) };
    } };
    const { reader, keeper, step } = await cacheOf({ disk, packBytes: 64 * KIB });
    reader.put('block', bodyOf(5 * KIB, 1));
    reader.put('only', bodyOf(5 * KIB, 2), F_ONLY_COPY);
    for (let i = 0; i < 5; i++)
    {
        reader.put(`a${i}`, bodyOf(10 * KIB, 3 + i));
    }
    step(150);
    await settle();
    reader.put('b', bodyOf(10 * KIB, 9));
    step(150);
    for (let i = 0; i < 5; i++)
    {
        reader.drop(`a${i}`);
    }
    short = true;
    const failures = keeper.figures().diskFailures;
    step(1);
    assert.equal(reader.look('block'), null);
    assert.equal(keeper.figures().lostOnDisk, 1);
    assert.equal(reader.look('only'), 'cold');
    assert.equal(keeper.figures().diskFailures, failures + 1);
    short = false;
    assert.deepEqual(reader.with('only', body=>[...body], { wait: true }), [...bodyOf(5 * KIB, 2)]);
});

/**
 * A body that says whose it is: the name's hash, its version and length, the
 * rest bytes of both.
 *
 * @param {string} name @param {number} version @param {number} length
 */
function taggedBody(name, version, length){
    const [hash] = hashName(name);
    const body = new Uint8Array(length);
    const view = new DataView(body.buffer);
    view.setInt32(0, hash, true);
    view.setUint32(4, version, true);
    view.setUint32(8, length, true);
    for (let at = 12; at < length; at++)
    {
        body[at] = (hash ^ version ^ at) & 255;
    }
    return body;
}

/**
 * The version a body of `name` says it is, or null where it is not one of its.
 *
 * @param {string} name @param {Uint8Array} body
 */
function versionOf(name, body){
    if (body.length < 12)
    {
        return null;
    }
    const version = new DataView(body.buffer, body.byteOffset, body.length).getUint32(4, true);
    const expected = taggedBody(name, version, body.length);
    return body.every((byte, at)=>byte === expected[at]) ? version : null;
}

test('seeded runs crashed at random points, each change a flush had not reached kept or not, index'
    + ' and pack flushes refused: the next run reads only bodies given under each name, and every only'
    + ' copy the last whole save held', { timeout: 600_000 }, async()=>{
    const options = { packBytes: 48 * KIB, budget: 192 * KIB, goneAfterMs: 1e9 };
    let crashes = 0;
    let promisesKept = 0;
    for (let seed = 1; seed <= 40; seed++)
    {
        const next = random(seed * 7919);
        let disk = crashDisk();
        let cache = await cacheOf({ disk, ...options });
        /**
         * The body each name has in this run.
         *
         * @type {Map<string, { version: number, onlyCopy: boolean }>}
         */
        const has = new Map();
        /** Only copies the last save that answered true held, by version. @type {Map<string, number>} */
        let promised = new Map();
        let version = 0;
        for (let step = 0; step < 400; step++)
        {
            const name = `n${Math.floor(next() * 24)}`;
            const roll = next();
            if (roll < 0.45)
            {
                const onlyCopy = next() < 0.35;
                const policy = next() < 0.12 ? 'run' : 'kept';
                const body = taggedBody(name, ++version, 16 + Math.floor(next() * 9 * KIB));
                if (cache.reader.put(name, body, reserveFlags({ onlyCopy, disk: policy })))
                {
                    has.set(name, { version, onlyCopy: onlyCopy && policy === 'kept' });
                }
            }
            else if (roll < 0.52)
            {
                cache.reader.drop(name);
                has.delete(name);
            }
            else if (roll < 0.62)
            {
                cache.reader.with(name, ()=>{}, { wait: true });
            }
            else if (roll < 0.8)
            {
                // Now and then a flush of the packs fails, losing what they took since the last.
                const losing = next() < 0.1;
                if (losing)
                {
                    packsOf(disk.current()).files.forEach(file=>disk.failing.losing.add(file));
                }
                cache.step(Math.floor(next() * 160));
                disk.failing.losing.clear();
            }
            else if (roll < 0.92)
            {
                const refused = next();
                if (refused < 0.3)
                {
                    disk.failing.flush.add(next() < 0.5 ? 'index-a' : 'index-b');
                }
                else if (refused < 0.4)
                {
                    packsOf(disk.current()).files.forEach(file=>disk.failing.losing.add(file));
                }
                if (cache.keeper.save())
                {
                    promised = new Map([...has].filter(([, body])=>body.onlyCopy)
                        .map(([body, { version: saved }])=>[body, saved]));
                }
                disk.failing.flush.clear();
                disk.failing.losing.clear();
            }
            else if (roll < 0.97)
            {
                await settle();
            }
            else
            {
                crashes++;
                const files = disk.crash(()=>next() < 0.5);
                const run = await cacheOf({ disk: crashDisk(files), ...options });
                const where = `seed ${seed}, step ${step}`;
                for (let i = 0; i < 24; i++)
                {
                    const body = run.reader.with(`n${i}`, read=>read.slice(), { wait: true });
                    assert.ok(body === undefined || versionOf(`n${i}`, body) !== null,
                        `${where}: n${i} read another's bytes`);
                }
                for (const [body, saved] of promised)
                {
                    if (has.get(body)?.version === saved)
                    {
                        assert.equal(run.reader.with(body, read=>versionOf(body, read), { wait: true }),
                            saved, `${where}: the only copy ${body} the last whole save held`);
                        promisesKept++;
                    }
                }
                const { skippedEntries, lostOnDisk } = run.keeper.figures();
                assert.deepEqual({ skippedEntries, lostOnDisk }, { skippedEntries: 0, lostOnDisk: 0 },
                    `${where}: the index named bytes the disk did not keep`);
                run.keeper.close();
                // The work goes on from the disk the crash left, as the next run would.
                cache.keeper.close();
                await settle();
                disk = crashDisk(files);
                cache = await cacheOf({ disk, ...options });
                for (const [body] of [...has])
                {
                    const read = cache.reader.with(body, bytes=>versionOf(body, bytes), { wait: true });
                    if (read === undefined || read === null)
                    {
                        has.delete(body);
                    }
                    else
                    {
                        has.set(body, { version: read, onlyCopy: false });
                    }
                }
                promised = new Map();
            }
            if (step % 20 === 0)
            {
                await settle();
            }
        }
        cache.keeper.close();
        await settle();
    }
    assert.ok(crashes > 30 && promisesKept > 20, `${crashes} crashes, ${promisesKept} only copies checked`);
});

test('a pack flush that fails may lose what the pack took since the flush before: a body there that'
    + ' can be made again goes, never read back as the bytes written after it', async()=>{
    const disk = crashDisk();
    const { reader, keeper, step } = await cacheOf({ disk });
    reader.put('kept', bodyOf(3000, 1));
    step(150);
    reader.put('block', bodyOf(3000, 2));
    disk.failing.losing.add('pack-0');
    step(150);
    disk.failing.losing.clear();
    assert.equal(reader.look('block'), null, 'its bytes may be gone with the flush');
    assert.equal(keeper.figures().lostOnDisk, 1);
    reader.put('later', bodyOf(6000, 3));
    step(150);
    assert.equal(reader.with('block', body=>[...body], { wait: true }), undefined);
    assert.equal(keeper.save(), true);
    assert.deepEqual(await nextRunReads(disk.crash(), ['kept', 'block', 'later']),
        [[...bodyOf(3000, 1)], null, [...bodyOf(6000, 3)]]);
});

test('a body being raised whose copy a failed flush let go of while room was made goes, rather than'
    + ' stay cold with no copy', async()=>{
    const disk = crashDisk();
    // Room for one body of a segment of its own.
    const { reader, keeper } = await cacheOf({ disk, budget: 64 * KIB });
    reader.put('block', bodyOf(40 * KIB, 1));
    // Room for the only copy cools the block: written, not flushed yet.
    reader.put('only', bodyOf(40 * KIB, 2), F_ONLY_COPY);
    assert.equal(reader.look('block'), 'cold');
    // The block's raise cools the only copy for room, whose flush fails and loses the block's bytes.
    disk.failing.losing.add('pack-0');
    assert.equal(keeper.raise('block'), false);
    disk.failing.losing.clear();
    assert.equal(reader.look('block'), null);
    assert.equal(reader.look('only'), 'hot', 'not let go on a failed flush');
    const failures = keeper.figures().diskFailures;
    assert.equal(reader.with('block', ()=>1, { wait: true }), undefined);
    assert.equal(keeper.figures().diskFailures, failures, 'nothing left to read from no pack');
});
