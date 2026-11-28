/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's hot part, one thread: names, records, reservations, room in the
 * segments, and what a reader reads while the keeper moves things.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNIT, grainsOf } from './buddy.js';
import { bodyOf, cacheOf, placeOf } from './cache.fixture.js';
import { bytesPerCall } from './allocation.fixture.js';
import { crashDisk } from './disk.fixture.js';
import { createReader } from './reader.js';
import {
    F_FOR_ROOM, F_HELD, F_NO_DISK, F_ONLY_COPY, F_THIS_RUN, HEADER_WORDS, HOT, H_NAMES, H_TICK, MOVING,
    RECORD_WORDS, R_STATE, reserveFlags, stateWord, viewIndex,
} from './shared.js';

const KIB = 1024;

/** The state word of record `id` in `keeper`'s records. @param {any} keeper @param {number} id */
const stateIndex = (keeper, id)=>{
    const words = new Int32Array(keeper.shared.records);
    return { words, at: HEADER_WORDS + id * RECORD_WORDS + R_STATE };
};

/** The record `name` leads to now. @param {any} keeper @param {string} name */
const recordOf = (keeper, name)=>viewIndex(keeper.shared).find(name);

/**
 * Units 2 to 7 of a segment of eight held by only copies that never leave:
 * units 0 and 1 the one block of two that can be formed.
 *
 * @param {import('./reader.js').Reader} reader
 */
const pinRest = reader=>{
    for (let i = 2; i < 8; i++)
    {
        assert.equal(reader.put(`pin${i}`, bodyOf(UNIT, i), F_ONLY_COPY | F_NO_DISK), true);
    }
};

test('a name that is not a string is refused by every call, and the names are left as they were',
    async()=>{
        const { keeper, reader } = await cacheOf();
        assert.equal(reader.put('blocks/1', bodyOf(100, 1)), true);
        const words = new Int32Array(keeper.shared.records);
        const names = words[H_NAMES];
        for (const name of [42, null, undefined, { length: 3 }, ['a']])
        {
            const odd = /** @type {any} */ (name);
            assert.throws(()=>placeOf(keeper, odd, 100), TypeError, 'keeper.reserve');
            assert.throws(()=>keeper.raise(odd), TypeError, 'keeper.raise');
            assert.throws(()=>keeper.drop(odd), TypeError, 'keeper.drop');
            assert.throws(()=>reader.reserve(odd, 100), TypeError, 'reader.reserve');
            assert.throws(()=>reader.put(odd, bodyOf(100, 2)), TypeError, 'reader.put');
            assert.throws(()=>reader.with(odd, ()=>1), TypeError, 'reader.with');
            assert.throws(()=>reader.look(odd), TypeError, 'reader.look');
            assert.throws(()=>reader.drop(odd), TypeError, 'reader.drop');
        }
        assert.equal(words[H_NAMES], names, 'nothing written into the names');
        assert.equal(reader.put('blocks/2', bodyOf(100, 3)), true);
        assert.deepEqual(reader.with('blocks/1', body=>[...body]), [...bodyOf(100, 1)]);
        assert.deepEqual(reader.with('blocks/2', body=>[...body]), [...bodyOf(100, 3)]);
    });

test('a body the keeper is moving is there: a wait reads it once the move is over, a look says cold',
    async()=>{
        const { keeper, reader } = await cacheOf();
        reader.put('doc', bodyOf(5000, 1), F_ONLY_COPY);
        const { words, at } = stateIndex(keeper, recordOf(keeper, 'doc'));
        /** @type {string[]} */
        const asked = [];
        // A reader in another thread: what it asks of the keeper is answered
        // once the keeper is done with the move it is in.
        const other = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(), keeper: {
            reserve: keeper.reserve,
            raise: (name, options)=>{
                asked.push(`raise ${name}`);
                Atomics.store(words, at, stateWord(HOT));
                return keeper.raise(name, options);
            },
            raiseLater: name=>{
                asked.push(`later ${name}`);
            },
            drop: ()=>{},
        } });
        assert.equal(other.with('doc', body=>body.length), 5000, 'known before the move');
        // The keeper takes the body out of its segment (a write to a slow disk).
        Atomics.store(words, at, stateWord(MOVING));
        assert.equal(other.look('doc'), 'cold', 'there, not to be read in place now');
        assert.equal(other.with('doc', body=>body.length), undefined, 'not read in place');
        assert.deepEqual(asked, ['later doc'], 'asked back for later');
        assert.equal(other.figures().moving, 1);
        assert.deepEqual(other.with('doc', body=>[...body], { wait: true }), [...bodyOf(5000, 1)],
            'waited for');
        assert.deepEqual(asked, ['later doc', 'raise doc']);
        // A reader that never found it before reads it the same.
        Atomics.store(words, at, stateWord(MOVING));
        asked.length = 0;
        const fresh = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(), keeper: {
            reserve: ()=>false,
            raise: (name, options)=>{
                asked.push(`raise ${name}`);
                Atomics.store(words, at, stateWord(HOT));
                return keeper.raise(name, options);
            },
            raiseLater: ()=>{}, drop: ()=>{},
        } });
        assert.equal(fresh.with('doc', body=>body[1], { wait: true }), (31 + 1) & 255);
        assert.deepEqual(asked, ['raise doc']);
    });

test('a name written anew while read gives its record back once read: the records and the table stay'
    + ' the size of the names', async()=>{
    const { keeper, reader, step, said } = await cacheOf({ budget: 4096 * KIB, segmentBytes: 1024 * KIB });
    reader.put('x', bodyOf(64, 0));
    const tables = said.filter(message=>message.table !== undefined).length;
    for (let i = 1; i <= 3000; i++)
    {
        // A reader inside x, as in another thread, while x is written anew.
        reader.with('x', ()=>{
            assert.equal(reader.put('x', bodyOf(64, i)), true);
        });
        // Records retired and not swept yet past the first table's half.
        if (i % 600 === 0)
        {
            step(1);
        }
    }
    step(1);
    const figures = keeper.figures();
    assert.equal(figures.replaced, 3000);
    assert.ok(figures.records <= 602, `${figures.records} records for one name`);
    assert.equal(figures.freeRecords, figures.records - 1, 'all but the name\'s kept for another');
    reader.put('y', bodyOf(64, 1));
    assert.equal(keeper.figures().records, figures.records, 'a new name takes a record given back');
    assert.equal(said.filter(message=>message.table !== undefined).length, tables,
        'no larger table for two names');
    assert.deepEqual(reader.with('x', body=>[...body]), [...bodyOf(64, 3000)]);
    assert.deepEqual(reader.with('y', body=>[...body]), [...bodyOf(64, 1)]);
    assert.equal(keeper.figures().hotBytes, 128, 'one body a name');
});

test('a name written anew while read past 2^20 times still leaves room for a new name',
    { timeout: 300_000 }, async()=>{
        const { keeper, reader, step } = await cacheOf({ budget: 32 * 1024 * KIB,
            segmentBytes: 4096 * KIB });
        reader.put('x', bodyOf(64, 0));
        const body = bodyOf(64, 1);
        let written = 0;
        for (let i = 0; i < (1 << 20) + 16; i++)
        {
            reader.with('x', ()=>{
                written += reader.put('x', body) ? 1 : 0;
            });
            if (i % 4096 === 0)
            {
                step(1);
            }
        }
        assert.equal(written, (1 << 20) + 16);
        step(1);
        assert.equal(reader.put('fresh', bodyOf(64, 2)), true);
        assert.equal(reader.look('fresh'), 'hot');
        assert.ok(keeper.figures().records < 5000, `${keeper.figures().records} records`);
    });

test('a reader that remembers a record given since to another name reads its name\'s body, never'
    + ' the other\'s', async()=>{
    const { keeper, reader, step } = await cacheOf();
    reader.put('x', bodyOf(100, 1));
    // Readers of other threads, which found x before.
    const others = Array.from({ length: 4 }, ()=>createReader({ shared: keeper.shared,
        segments: keeper.segmentBuffers(),
        keeper: { reserve: ()=>false, raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{} } }));
    for (const other of others)
    {
        assert.equal(other.with('x', body=>body[1]), (31 + 1) & 255);
    }
    const first = recordOf(keeper, 'x');
    reader.with('x', ()=>{
        reader.put('x', bodyOf(200, 2));
    });
    step(1);
    // The record x left goes to the next name written.
    reader.put('y', bodyOf(300, 3));
    assert.equal(recordOf(keeper, 'y'), first, 'y took the record x had');
    assert.deepEqual(others[0].with('x', body=>[...body]), [...bodyOf(200, 2)], 'x\'s body, not y\'s');
    assert.equal(others[0].look('x'), 'hot');
    assert.deepEqual(others[0].with('y', body=>[...body]), [...bodyOf(300, 3)]);
    // y's body being moved by the keeper: what a reader remembering x finds
    // there is y's, which says nothing of x.
    const { words, at } = stateIndex(keeper, first);
    Atomics.store(words, at, stateWord(MOVING));
    assert.equal(others[1].look('x'), 'hot', 'x\'s own state, not y\'s');
    assert.deepEqual(others[2].with('x', body=>[...body]), [...bodyOf(200, 2)], 'not a miss for y\'s move');
    Atomics.store(words, at, stateWord(HOT));
    // x gone, y there: x is no body.
    reader.drop('x');
    assert.equal(others[3].look('x'), null);
    assert.equal(others[0].look('x'), null);
    assert.equal(others[0].with('x', body=>body.length), undefined);
});

test('a record given to another name between a reader\'s lookup and its entering is not read as the'
    + ' name\'s', async()=>{
    const { keeper, reader, step } = await cacheOf();
    reader.put('x', bodyOf(100, 1));
    const first = recordOf(keeper, 'x');
    const fresh = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: { reserve: ()=>false, raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{} } });
    const { at } = stateIndex(keeper, first);
    const compareExchange = Atomics.compareExchange;
    let armed = true;
    // The reader has found x's record and is about to enter it: meanwhile, in
    // other threads, x is written anew while read, the record it left goes
    // back, and y takes it.
    Atomics.compareExchange = /** @type {any} */ ((/** @type {any} */ array, /** @type {number} */ index,
        /** @type {number} */ expected, /** @type {number} */ value)=>{
        if (armed && array.buffer === keeper.shared.records && index === at
            && expected === stateWord(HOT))
        {
            armed = false;
            reader.with('x', ()=>{
                reader.put('x', bodyOf(200, 2));
            });
            step(1);
            reader.put('y', bodyOf(100, 3));
        }
        return compareExchange(array, index, expected, value);
    });
    /** @type {number[] | undefined} */
    let read;
    try
    {
        read = fresh.with('x', body=>[...body]);
    }
    finally
    {
        Atomics.compareExchange = compareExchange;
    }
    assert.equal(armed, false, 'the reader entered the record after it changed hands');
    assert.equal(recordOf(keeper, 'y'), first, 'y took the record x had');
    assert.equal(read, undefined, 'a miss, not y\'s body');
    assert.deepEqual(fresh.with('x', body=>[...body]), [...bodyOf(200, 2)]);
});

test('memory held is never taken back: written and read in place by its holder for as long as it '
    + 'holds it, counted under its name, its room given back when it lets go', async()=>{
    // A segment for the bodies, and the held memory's own room beside it.
    const { keeper, reader, step } = await cacheOf({ abandonAfterMs: 1000, coldAfterMs: 10,
        goneAfterMs: 20, budget: 10 * UNIT, segmentBytes: 8 * UNIT });
    const held = reader.hold('sound/table', 2 * UNIT);
    assert.ok(held, 'room for it');
    // Three quarters of the segment held by bodies that never leave.
    for (const name of ['pin1', 'pin2', 'pin3'])
    {
        assert.equal(reader.put(name, bodyOf(2 * UNIT, 9), F_ONLY_COPY | F_NO_DISK), true);
    }
    held.set(bodyOf(2 * UNIT, 5));
    step(5000);
    assert.equal(keeper.figures().takenBack, 0, 'held five times abandonAfterMs');
    held[0] = 77;
    assert.equal(held[0], 77, 'still its holder\'s to write');
    assert.deepEqual(keeper.under('sound/'), { bodies: 1, bytes: 2 * UNIT, hotBytes: 2 * UNIT,
        placedBytes: 2 * UNIT }, 'counted where the run weighs its spaces');
    assert.equal(reader.look('sound/table'), null, 'nothing anyone reads: memory, not a body');
    // Room for others is made around it, never from it.
    assert.equal(reader.put('a', bodyOf(2 * UNIT, 1)), true);
    assert.equal(reader.put('b', bodyOf(2 * UNIT, 2)), true, 'a goes for b, the held memory stays');
    assert.equal(reader.look('a'), null);
    assert.equal(held[0], 77);
    // Let go of, its room is the budget's again.
    assert.equal(keeper.figures().segmentBytes, 10 * UNIT);
    reader.abandon('sound/table');
    step(1);
    step(50);
    assert.equal(keeper.figures().segmentBytes, 8 * UNIT, 'its room given back, its segment let go');
    assert.deepEqual(keeper.under('sound/').bodies, 0);
});

test('a hot body read again is read through the same view, made anew only where the body moved'
    + ' or the name was written again', async()=>{
    const { reader } = await cacheOf({ coldAfterMs: 1e6, goneAfterMs: 1e6 });
    assert.ok(reader.put('glyphs', bodyOf(300, 3)));
    const first = reader.with('glyphs', body=>body);
    const second = reader.with('glyphs', body=>body);
    assert.equal(second, first, 'one view, not one a read');
    assert.deepEqual([.../** @type {Uint8Array} */ (second)], [...bodyOf(300, 3)]);
    assert.ok(reader.put('glyphs', bodyOf(500, 7)), 'written again, elsewhere');
    const third = reader.with('glyphs', body=>body);
    assert.notEqual(third, first);
    assert.deepEqual([.../** @type {Uint8Array} */ (third)], [...bodyOf(500, 7)],
        'the new body, not the old view');
    // A read of a hot body makes nothing of its own: a view a read was about
    // 96 bytes, garbage on every per-item read (a glyph, a table entry).
    let sum = 0;
    /** @param {Uint8Array} body */
    const first8 = body=>body[0];
    let around = 0;
    // Against the same loop with an empty synchronous body: the fixture
    // awaits each call, which a synchronous body's undefined pays for too.
    const bytes = await bytesPerCall(()=>{
        sum += reader.with('glyphs', first8) ?? 0;
        return undefined;
    }, { calls: 4000, empty: ()=>{
        around++;
        return undefined;
    } });
    assert.ok(sum > 0 && around > 0);
    assert.ok(bytes < 16, `${bytes.toFixed(1)} bytes a read`);
});

test('a put makes no object of its own, its flags a word and its place the reader\'s; a reserve'
    + ' makes only the view it hands out, read again through the same view', async()=>{
    const { reader } = await cacheOf({ budget: 1 << 20, segmentBytes: 256 * KIB, coldAfterMs: 1e6,
        goneAfterMs: 1e6 });
    const names = Array.from({ length: 64 }, (_, i)=>`bodies/${i}`);
    const body = bodyOf(256, 1);
    const flags = reserveFlags({ onlyCopy: true, disk: 'never', idle: 'stay' });
    let n = 0;
    let around = 0;
    const empty = ()=>{
        around++;
        return undefined;
    };
    // The options and the place a put made were about 130 bytes, with the
    // context its room search made at each call; a reserve's, with its map
    // entry made and deleted, about 470. A keeper on a clock of doubles
    // (`performance.now`) adds the 16 of one boxed; this one's counts in
    // whole numbers.
    const put = await bytesPerCall(()=>{
        reader.put(names[n++ & 63], body, flags);
        return undefined;
    }, { calls: 4000, empty });
    assert.ok(put < 16, `${put.toFixed(1)} bytes a put`);
    /** @param {Uint8Array} read */
    const length = read=>read.length;
    const reserved = await bytesPerCall(()=>{
        const name = names[n++ & 63];
        const view = reader.reserve(name, 256, flags);
        if (view === null || !reader.commit(name) || reader.with(name, length) !== 256)
        {
            throw new Error('not reserved, committed and read');
        }
        return undefined;
    }, { calls: 4000, empty });
    assert.ok(around > 0);
    // The view a reserve hands out is about 96 bytes, and the read finds it.
    assert.ok(reserved < 128, `${reserved.toFixed(1)} bytes a reserve, commit and read`);
});

test('a reader that reserved many names keeps the reservations still open and the memory it'
    + ' holds when it forgets the names it ended', async()=>{
    const { reader } = await cacheOf({ budget: 8 << 20, segmentBytes: 1 << 20, coldAfterMs: 1e6,
        goneAfterMs: 1e6 });
    const open = reader.reserve('open', 100);
    const held = reader.hold('held', 100);
    assert.ok(open && held);
    open.fill(7);
    held.fill(9);
    for (let i = 0; i < 6000; i++)
    {
        const view = reader.reserve(`n${i}`, 10);
        assert.ok(view);
        view.fill(i & 255);
        assert.ok(reader.commit(`n${i}`));
    }
    assert.equal(reader.commit('open'), true, 'still reserved past the names forgotten');
    assert.deepEqual(reader.with('open', body=>[...body]), Array(100).fill(7));
    assert.deepEqual([...held], Array(100).fill(9));
    assert.deepEqual(reader.with('n5999', body=>[...body]), Array(10).fill(5999 & 255));
    assert.throws(()=>reader.commit('n0'), /not reserved here/, 'an ended reservation is none');
    reader.abandon('held');
});

test('an owner released takes its held memory with it: the room is the next body\'s at once, its'
    + ' holder\'s view no longer the cache\'s', async()=>{
    const { keeper, reader, step } = await cacheOf({ abandonAfterMs: 1000, coldAfterMs: 1e6,
        goneAfterMs: 1e6, budget: 12 * UNIT, segmentBytes: 8 * UNIT });
    // An owner - a worker, a process - that went without letting its holds go.
    assert.ok(reader.hold('scratch/7/rows', 2 * UNIT));
    assert.ok(reader.hold('scratch/7/texels', 2 * UNIT));
    assert.ok(reader.put('other', bodyOf(2 * UNIT, 1)));
    assert.ok(reader.put('more', bodyOf(2 * UNIT, 3)));
    assert.deepEqual(keeper.release('scratch/7/'), { bodies: 2, bytes: 4 * UNIT, waiting: 0 },
        'both held, none waiting on a reader');
    assert.deepEqual(keeper.under('scratch/'), { bodies: 0, bytes: 0, hotBytes: 0, placedBytes: 0 });
    step(1);
    assert.equal(reader.put('next', bodyOf(2 * UNIT, 2)), true, 'their room given back');
    assert.equal(reader.put('after', bodyOf(2 * UNIT, 4)), true);
    assert.deepEqual(reader.with('other', body=>[...body]), [...bodyOf(2 * UNIT, 1)], 'the rest kept');
    assert.deepEqual(reader.with('more', body=>[...body]), [...bodyOf(2 * UNIT, 3)]);
});

test('a reservation never committed is taken back after abandonAfterMs, and its commit then fails',
    async()=>{
        const { keeper, reader, step } = await cacheOf({ abandonAfterMs: 1000, coldAfterMs: 1e6,
            goneAfterMs: 1e6 });
        reader.put('kept', bodyOf(100, 1));
        // Its writer gone: terminated, or its answer lost on the way.
        assert.ok(reader.reserve('frame', 9000));
        assert.equal(keeper.figures().placedBytes, grainsOf(9000) + grainsOf(100));
        step(999);
        assert.equal(keeper.figures().placedBytes, grainsOf(9000) + grainsOf(100), 'not yet');
        step(1);
        assert.equal(keeper.figures().placedBytes, grainsOf(100), 'its room back');
        assert.equal(keeper.figures().takenBack, 1);
        assert.equal(reader.commit('frame'), false, 'too late');
        assert.equal(reader.figures().late, 1);
        assert.equal(reader.look('frame'), null);
        assert.equal(reader.put('frame', bodyOf(9000, 2)), true, 'the name written again');
        assert.deepEqual(reader.with('frame', body=>[...body]), [...bodyOf(9000, 2)]);
        // A writer slower than the span, its record now another reservation's.
        const late = reader.reserve('late', 100);
        assert.ok(late);
        step(1000);
        const next = placeOf(keeper, 'late', 200);
        assert.ok(next);
        assert.equal(reader.commit('late'), false, 'the next reservation\'s mark is not this one\'s');
        assert.equal(reader.look('late'), null, 'the next one is not written yet');
        step(1);
        assert.equal(keeper.figures().placedBytes, grainsOf(100) + grainsOf(9000) + grainsOf(200),
            'kept, frame, the next late');
    });

test('a place granted ahead and handed to the writer after it was taken back is refused, not'
    + ' written into', async()=>{
    const { keeper, reader, step } = await cacheOf({ abandonAfterMs: 1000, coldAfterMs: 1e6,
        goneAfterMs: 1e6 });
    // Room asked for ahead (a reader's link keeps the answer for its next reserve).
    const granted = placeOf(keeper, 'texels', 9000);
    assert.ok(granted);
    step(1000);
    assert.equal(keeper.figures().takenBack, 1);
    // The room goes to another body meanwhile.
    assert.equal(reader.put('other', bodyOf(9000, 5)), true);
    const late = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(), keeper: {
        reserve: (name, length, flags, known, place)=>{
            place.set([granted?.id ?? 0, granted?.segment ?? 0, granted?.offset ?? 0, granted?.mark ?? 0]);
            return granted !== null;
        }, raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{},
    } });
    assert.equal(late.reserve('texels', 9000), null, 'no view into room another body may have');
    assert.equal(late.figures().late, 1);
    assert.deepEqual(reader.with('other', body=>[...body]), [...bodyOf(9000, 5)]);
});

test('a reservation written anew before its commit, its writer gone, gives its room and record back',
    async()=>{
        const { keeper, reader, step } = await cacheOf({ abandonAfterMs: 1000, coldAfterMs: 1e6,
            goneAfterMs: 1e6 });
        assert.ok(placeOf(keeper, 'frame', 9000), 'a writer that never commits');
        assert.equal(reader.put('frame', bodyOf(100, 1)), true, 'the next writer');
        step(1);
        assert.equal(keeper.figures().placedBytes, grainsOf(9000) + grainsOf(100), 'the first held for its writer');
        step(1000);
        const figures = keeper.figures();
        assert.equal(figures.placedBytes, grainsOf(100), 'the first one\'s room back');
        assert.equal(figures.takenBack, 1);
        assert.equal(figures.freeRecords, 1, 'its record kept for another name');
        assert.deepEqual(reader.with('frame', body=>[...body]), [...bodyOf(100, 1)]);
    });

test('a drop that reaches a name being written takes the body written, once committed', async()=>{
    const { keeper, reader, step } = await cacheOf();
    // Built from its source, which then changes, and the name is dropped.
    const into = reader.reserve('w', 100);
    assert.ok(into);
    into.set(bodyOf(100, 1));
    assert.equal(keeper.drop('w'), false, 'being written');
    assert.equal(reader.commit('w'), true);
    step(1);
    assert.equal(reader.look('w'), null, 'the stale body went');
    assert.equal(keeper.figures().placedBytes, 0);
    // The write the drop reached, then a newer one of the name: the newer stays.
    assert.ok(reader.reserve('v', 100));
    assert.equal(keeper.drop('v'), false);
    const later = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: { reserve: keeper.reserve,
            raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{} } });
    assert.equal(later.put('v', bodyOf(300, 3)), true);
    assert.equal(reader.commit('v'), true, 'written, and written anew since');
    step(1);
    assert.deepEqual(reader.with('v', body=>[...body]), [...bodyOf(300, 3)]);
    assert.equal(keeper.figures().placedBytes, grainsOf(300), 'the first one\'s room went');
});

test('a reserve no block can be formed for cools nothing', async()=>{
    // One segment, an only copy at the end of each quarter that cannot leave:
    // no 16 KiB block can form.
    const { keeper, reader } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
    for (let i = 0; i < 16; i++)
    {
        reader.put(`n${i}`, bodyOf(UNIT, i + 1), reserveFlags({ onlyCopy: i % 4 === 3 }));
    }
    assert.equal(reader.reserve('big', 16 * KIB), null);
    assert.equal(keeper.figures().refusedRoom, 1);
    assert.equal(keeper.figures().gone, 0, 'nothing taken away for it');
    for (let i = 0; i < 16; i++)
    {
        assert.equal(reader.look(`n${i}`), 'hot', `n${i}`);
    }
    // Past what the budget holds: refused before anything is looked at.
    assert.equal(reader.reserve('larger', 64 * KIB + 1), null);
    assert.equal(keeper.figures().refusedLarge, 1);
});

test('room is made in a block the body fits, not by cooling the oldest bodies around one that stays',
    async()=>{
        const { keeper, reader, step } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
        // Units 0 to 7: the oldest bodies, an only copy that cannot leave in
        // each block of four.
        for (let i = 0; i < 8; i++)
        {
            reader.put(`old${i}`, bodyOf(UNIT, i), reserveFlags({ onlyCopy: i % 4 === 3 }));
        }
        step(10);
        // Units 8 to 15: newer ones.
        for (let i = 8; i < 16; i++)
        {
            reader.put(`new${i}`, bodyOf(UNIT, i));
        }
        assert.equal(reader.put('big', bodyOf(16 * KIB, 99)), true);
        for (let i = 0; i < 8; i++)
        {
            assert.equal(reader.look(`old${i}`), 'hot', `old${i}: in a block that cannot form`);
        }
        for (let i = 8; i < 16; i++)
        {
            assert.equal(reader.look(`new${i}`), i < 12 ? null : 'hot', `new${i}`);
        }
        assert.equal(keeper.figures().gone, 4);
        assert.deepEqual(reader.with('big', body=>[...body]), [...bodyOf(16 * KIB, 99)]);
    });

test('a full cache walks its records once for many reserves, and a body read since it was listed is'
    + ' not taken for old', async()=>{
    const { keeper, reader, step } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
    for (let i = 0; i < 16; i++)
    {
        reader.put(`n${i}`, bodyOf(UNIT, i));
    }
    step(10);
    assert.equal(reader.put('a', bodyOf(UNIT, 20)), true);
    assert.equal(reader.look('n0'), null, 'the oldest went');
    // Read since the list was made: not old any more.
    reader.with('n1', ()=>{});
    assert.equal(reader.put('b', bodyOf(UNIT, 21)), true);
    assert.equal(reader.look('n1'), 'hot', 'read since');
    assert.equal(reader.look('n2'), null, 'the next oldest instead');
    const listed = keeper.figures().oldestListed;
    for (let i = 0; i < 100; i++)
    {
        assert.equal(reader.put(`m${i}`, bodyOf(UNIT, i)), true);
    }
    assert.ok(keeper.figures().oldestListed - listed <= 100 / 15 + 1,
        `${keeper.figures().oldestListed - listed} walks for 100 reserves of 16 bodies`);
});

test('a reservation made long after the last sweep counts its age from when it was made', async()=>{
    // The keeper's last sweep was long ago: a reservation made now is not
    // taken back by the next sweep, its room is no one else's, its commit
    // publishes what its writer wrote.
    const { keeper, reader, step, wait } = await cacheOf({ budget: UNIT, segmentBytes: UNIT,
        abandonAfterMs: 10 });
    wait(100);
    const a = reader.reserve('a', UNIT);
    assert.ok(a);
    a[0] = 11;
    step(0);
    assert.equal(keeper.figures().takenBack, 0, 'held 0 ms of its 10');
    assert.equal(reader.reserve('b', UNIT), null, 'its room is still its own');
    a[0] = 99;
    assert.equal(reader.commit('a'), true);
    assert.equal(reader.with('a', body=>body[0]), 99);
    // Past its age it is taken back, from when it was made, and a late
    // commit publishes nothing.
    const later = await cacheOf({ budget: 2 * UNIT, segmentBytes: UNIT, abandonAfterMs: 10 });
    later.wait(100);
    assert.ok(later.reader.reserve('c', 16));
    later.step(9);
    assert.equal(later.keeper.figures().takenBack, 0, 'held 9 ms of its 10');
    later.step(1);
    assert.equal(later.keeper.figures().takenBack, 1, 'held its 10');
    assert.equal(later.reader.commit('c'), false);
    assert.equal(later.reader.look('c'), null);
});

/**
 * Runs `act` with the keeper's work `between` done where a writer's commit
 * loads the clock to stamp its body and before it stores the stamp: the
 * interleaving of a writer descheduled there, made in one thread. `between`
 * runs once, after `act` where the commit stamped nothing.
 *
 * @param {() => unknown} act @param {() => void} between
 */
const stampedAfter = (act, between)=>{
    const load = Atomics.load;
    let armed = true;
    /** @type {any} */ (Atomics).load = (/** @type {any} */ array, /** @type {number} */ index)=>{
        const value = load(array, index);
        if (armed && index === H_TICK)
        {
            armed = false;
            between();
        }
        return value;
    };
    try
    {
        return act();
    }
    finally
    {
        Atomics.load = load;
        if (armed)
        {
            between();
        }
    }
};

test('a commit\'s stamp lands on its own body, not on the reservation its record is given to next',
    async()=>{
    for (const retired of [false, true])
    {
        const label = retired ? 'replaced while written' : 'published';
        const { keeper, reader, step, wait } = await cacheOf({ abandonAfterMs: 10, coldAfterMs: 1e6 });
        // Another thread's reader of the same cache: the other writer.
        const other = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(),
            keeper: { reserve: keeper.reserve,
                raise: name=>keeper.raise(name), raiseLater(){}, drop(){} } });
        const into = reader.reserve('a', 16);
        assert.ok(into, label);
        into.set(bodyOf(16, 1));
        if (retired)
        {
            // Another writer's body for the name: this one's record retired as it is written.
            assert.equal(other.put('a', bodyOf(16, 2)), true, label);
        }
        // The keeper's last sweep long ago: the clock a stamp loads is 100 ms old.
        wait(100);
        /** @type {Uint8Array | null} */
        let next = null;
        // The next reservation: of the name again, which takes the record
        // in place where no one reads its body; or, the record retired, of
        // another name, which takes the record a sweep let go of.
        const name = retired ? 'c' : 'a';
        const committed = stampedAfter(()=>reader.commit('a'), ()=>{
            if (retired)
            {
                step(0);
            }
            next = other.reserve(name, 16);
        });
        assert.equal(committed, true, label);
        assert.ok(next, label);
        /** @type {Uint8Array} */ (next).set(bodyOf(16, 4));
        step(9);
        assert.equal(keeper.figures().takenBack, 0, `${label}: the next reservation held 9 ms of its 10`);
        assert.equal(other.commit(name), true, label);
        assert.deepEqual(reader.with(name, body=>[...body]), [...bodyOf(16, 4)], label);
        if (retired)
        {
            assert.deepEqual(reader.with('a', body=>[...body]), [...bodyOf(16, 2)], label);
        }
    }
});

test('a reserve refused in a tick does not refuse one of more segments known, or one its own '
    + 'body could make room for', async()=>{
    // Segments known: an only copy fills the one a writer has; a body that
    // can leave lies in the one it has not heard of yet.
    const known = await cacheOf({ budget: 2 * UNIT, segmentBytes: UNIT });
    assert.equal(known.reader.put('pin', bodyOf(UNIT, 1), F_ONLY_COPY | F_NO_DISK), true);
    assert.equal(known.reader.put('free', bodyOf(UNIT, 2), F_NO_DISK | F_FOR_ROOM), true);
    assert.equal(placeOf(known.keeper, 'x', UNIT, 0, 1),
        null, 'no room in the first segment');
    assert.ok(known.reader.reserve('y', UNIT), 'a writer of both makes it from the second');

    // The record spared: a name's own body is not cooled for its own
    // reserve, and is held while room is looked for; for another name's it
    // is the body that can leave. Its block grows over the body beside it
    // where that one can leave.
    /** @param {number} besideFlags */
    const spared = async besideFlags=>{
        const cache = await cacheOf({ budget: 8 * UNIT, segmentBytes: 8 * UNIT });
        assert.equal(cache.reader.put('a', bodyOf(UNIT, 3), F_NO_DISK | F_FOR_ROOM), true);
        assert.equal(cache.reader.put('c', bodyOf(UNIT, 4), besideFlags), true);
        pinRest(cache.reader);
        return cache;
    };
    const pinned = await spared(F_ONLY_COPY | F_NO_DISK);
    assert.equal(pinned.reader.reserve('a', 2 * UNIT), null, 'its own body is not cooled for it');
    assert.equal(pinned.reader.look('a'), 'hot', 'and stays as it was');
    const beside = await spared(reserveFlags({ disk: 'never' }));
    assert.ok(beside.reader.reserve('a', 2 * UNIT), 'written over in its block, the body beside it gone');
    assert.equal(beside.reader.look('c'), null);
    const other = await spared(reserveFlags({ disk: 'never' }));
    assert.ok(other.reader.reserve('b', 2 * UNIT), 'another name\'s takes its room');
    assert.equal(other.reader.look('a'), null);
});

test('a large reserve refused in a tick does not refuse a small one the same tick could place', async()=>{
    // The refusal of a block of 8 KiB, whose other half holds an only copy,
    // says nothing of a block of 4 KiB: a body that can leave makes it.
    const { keeper, reader } = await cacheOf({ budget: 8 * UNIT, segmentBytes: 8 * UNIT });
    assert.equal(reader.put('pin', bodyOf(UNIT, 1), F_ONLY_COPY | F_NO_DISK), true);
    assert.equal(reader.put('free', bodyOf(UNIT, 2), F_NO_DISK | F_FOR_ROOM), true);
    pinRest(reader);
    assert.equal(reader.reserve('big', 2 * UNIT), null, 'no block of 8 KiB can be formed');
    // The same refusal asked again in the tick costs one look, not a walk.
    const listed = keeper.figures().oldestListed;
    for (let i = 0; i < 100; i++)
    {
        assert.equal(reader.reserve('big', 2 * UNIT), null);
    }
    assert.equal(keeper.figures().oldestListed, listed, 'the same request, refused for a look');
    assert.ok(reader.reserve('small', UNIT), 'one of 4 KiB can, from the body that can leave');
    assert.equal(reader.look('pin'), 'hot', 'and the only copy stayed');
});

test('a block that cannot be made whole moves no body of it: a failed write leaves its neighbour too',
    async()=>{
        // The 8 KiB block is two bodies: one that may go away, one only copy
        // whose write to the disk fails. Neither may leave for a block that
        // is not formed.
        const disk = crashDisk();
        const { keeper, reader, wait } = await cacheOf({ budget: 8 * UNIT, segmentBytes: 8 * UNIT,
            packBytes: 2 * UNIT, disk });
        assert.equal(reader.put('a', bodyOf(UNIT, 1), reserveFlags({ disk: 'never' })), true);
        assert.equal(reader.put('b', bodyOf(UNIT, 2), F_ONLY_COPY), true);
        pinRest(reader);
        for (const name of disk.current().keys())
        {
            disk.failing.write.add(name);
        }
        assert.equal(reader.reserve('big', 2 * UNIT), null, 'the only copy could not be written');
        assert.equal(reader.with('a', body=>body[1]), bodyOf(UNIT, 1)[1], 'the one that may go stayed');
        assert.equal(reader.with('b', body=>body[1]), bodyOf(UNIT, 2)[1], 'the only copy stayed');
        assert.equal(keeper.figures().gone, 0);
        // The disk taking writes again, the block is made (in the next
        // millisecond: the same request refused is remembered within one).
        disk.failing.write.clear();
        wait(1);
        assert.ok(reader.reserve('big', 2 * UNIT));
        assert.equal(reader.look('b'), 'cold', 'the only copy went to the disk for it');
    });

test('a block that cannot be made whole moves no body of it: a reader entering one after it was '
    + 'judged free to leave, or a flush failing as the block is made', async()=>{
    // A reader enters the second body between the keeper's look and its
    // hold: the first, held already, is let go of as it was.
    const entered = await cacheOf({ budget: 8 * UNIT, segmentBytes: 8 * UNIT });
    assert.equal(entered.reader.put('a', bodyOf(UNIT, 1), reserveFlags({ disk: 'never' })), true);
    assert.equal(entered.reader.put('b', bodyOf(UNIT, 2), reserveFlags({ disk: 'never' })), true);
    pinRest(entered.reader);
    const exchange = Atomics.compareExchange;
    let holds = 0;
    /** The reader that entered, leaving. */
    let leave = ()=>{};
    /** @type {any} */ (Atomics).compareExchange = (/** @type {any} */ array, /** @type {number} */ index,
        /** @type {number} */ expected, /** @type {number} */ replacement)=>{
        if (expected === stateWord(HOT) && replacement === stateWord(MOVING) && ++holds === 2)
        {
            Atomics.add(array, index, 1);
            leave = ()=>{
                Atomics.sub(array, index, 1);
            };
        }
        return exchange(array, index, expected, replacement);
    };
    try
    {
        assert.equal(entered.reader.reserve('big', 2 * UNIT), null, 'a body read meanwhile');
    }
    finally
    {
        Atomics.compareExchange = exchange;
    }
    assert.equal(holds, 2, 'both held, the second too late');
    assert.deepEqual([entered.reader.look('a'), entered.reader.look('b')], ['hot', 'hot']);
    assert.equal(entered.reader.with('a', body=>body[1]), bodyOf(UNIT, 1)[1], 'the one held, let go of');
    assert.equal(entered.keeper.figures().gone, 0);
    leave();
    entered.wait(1);
    assert.ok(entered.reader.reserve('big', 2 * UNIT), 'the reader out, the block is made');

    // An only copy's write lands and its flush fails: the disk may not hold
    // it, so it stays, and its neighbour with it.
    const disk = crashDisk();
    const flushed = await cacheOf({ budget: 8 * UNIT, segmentBytes: 8 * UNIT, packBytes: 2 * UNIT, disk });
    assert.equal(flushed.reader.put('a', bodyOf(UNIT, 3), reserveFlags({ disk: 'never' })), true);
    assert.equal(flushed.reader.put('b', bodyOf(UNIT, 4), F_ONLY_COPY), true);
    pinRest(flushed.reader);
    for (let number = 0; number < 8; number++)
    {
        disk.failing.flush.add(`pack-${number}`);
    }
    assert.equal(flushed.reader.reserve('big', 2 * UNIT), null, 'the only copy\'s flush failed');
    assert.equal(flushed.reader.with('a', body=>body[1]), bodyOf(UNIT, 3)[1], 'the one that may go stayed');
    assert.equal(flushed.reader.with('b', body=>body[1]), bodyOf(UNIT, 4)[1], 'the only copy stayed');
    assert.equal(flushed.keeper.figures().gone, 0);
    disk.failing.flush.clear();
    flushed.wait(1);
    assert.ok(flushed.reader.reserve('big', 2 * UNIT));
    assert.equal(flushed.reader.look('b'), 'cold', 'the only copy went to the disk for it');
});

test('a body put to stay when idle stays hot past coldAfterMs, and leaves for room as any other', async()=>{
    // A body read again only long after it was written (a translator's
    // function, at a relink): the keeper's idle rule would take exactly
    // those. With no disk an idle body goes away, so the two differ at once.
    const { keeper, reader, step } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
    assert.equal(reader.put('stays', bodyOf(UNIT, 1), reserveFlags({ idle: 'stay' })), true);
    assert.equal(reader.put('goes', bodyOf(UNIT, 2)), true);
    step(200);
    assert.equal(reader.look('goes'), null, 'idle past coldAfterMs, with no disk: gone');
    assert.equal(reader.look('stays'), 'hot', 'idle as long, and still there');
    // Fifteen more fill the sixteen blocks: room for the last is made from it.
    for (let i = 0; i < 16; i++)
    {
        assert.equal(reader.put(`n${i}`, bodyOf(UNIT, 10 + i)), true, `n${i}`);
    }
    assert.equal(reader.look('stays'), null, 'the least recently used, it left for room');
    assert.throws(()=>reserveFlags({ idle: /** @type {any} */ ('maybe') }), RangeError);
    for (const flags of [1 << 7, F_THIS_RUN | F_NO_DISK, 0.5])
    {
        assert.throws(()=>placeOf(keeper, 'x', UNIT, flags), RangeError, `flags ${flags}`);
        assert.throws(()=>reader.put('x', bodyOf(8, 1), flags), RangeError, `flags ${flags}`);
    }
    assert.throws(()=>reader.put('x', bodyOf(8, 1), F_HELD), RangeError, 'held memory is no body');
});

test('a cache nothing in can leave walks its records once a tick for reserves it refuses, not once each',
    async()=>{
    const { keeper, reader, step } = await cacheOf({ budget: 64 * KIB, segmentBytes: 64 * KIB });
    // Every block reserved and none committed: nothing can be cooled for room.
    for (let i = 0; i < 16; i++)
    {
        assert.ok(reader.reserve(`w${i}`, UNIT) !== null);
    }
    const listed = keeper.figures().oldestListed;
    for (let i = 0; i < 100; i++)
    {
        assert.equal(placeOf(keeper, `x${i}`, UNIT), null, 'no room');
    }
    assert.ok(keeper.figures().oldestListed - listed <= 1,
        `${keeper.figures().oldestListed - listed} walks for 100 refused reserves in one tick`);
    // A body committed since: a later tick looks again and finds it.
    reader.commit('w0');
    step(1);
    assert.ok(placeOf(keeper, 'y', UNIT) !== null, 'room made from the body committed since');
});

test('segments let go and made again keep their numbers apart, the budget and every body', async()=>{
    // Each body in a segment of its own, beside the shared spare.
    const { keeper, reader, step, said } = await cacheOf({ budget: 256 * KIB, segmentBytes: 64 * KIB,
        coldAfterMs: 1e6, goneAfterMs: 1e6 });
    for (let round = 0; round < 30; round++)
    {
        for (let i = 0; i < 3; i++)
        {
            assert.equal(reader.put(`r${round}-${i}`, bodyOf(60 * KIB, round + i)), true);
        }
        const figures = keeper.figures();
        assert.ok(figures.segmentBytes <= 256 * KIB, JSON.stringify(figures));
        for (let i = 0; i < 3; i++)
        {
            assert.deepEqual(reader.with(`r${round}-${i}`, body=>body[1]), (31 + round + i) & 255);
            reader.drop(`r${round}-${i}`);
        }
        step(1);
        step(60);
    }
    const made = said.filter(message=>message.buffer).map(message=>message.segment);
    assert.deepEqual(made, [...made].sort((a, b)=>a - b), 'numbers only grow');
    assert.equal(new Set(made).size, made.length, 'none given twice');
    assert.ok(keeper.figures().segmentsLetGo > 30);
    assert.equal(keeper.segmentBuffers().length, made.length);
});

test('a reader made before the index grew finds, reads and writes names past its first views',
    async()=>{
        const { keeper, reader, said } = await cacheOf({ budget: 16 * 1024 * KIB,
            segmentBytes: 1024 * KIB });
        const early = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(), keeper: {
            reserve: keeper.reserve,
            raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{},
        } });
        const records = keeper.shared.records.byteLength;
        const names = keeper.shared.names.byteLength;
        // Past the first records, names and table.
        for (let i = 0; i < 3000; i++)
        {
            reader.put(`a name of some length, ${i}`, bodyOf(16, i));
        }
        assert.ok(keeper.shared.records.byteLength > records && keeper.shared.names.byteLength > names);
        // The segments and tables made since, as they reach a thread.
        for (const message of said)
        {
            early.adopt(message);
        }
        // A reservation past every record this reader has looked at, let go of.
        assert.ok(early.reserve('given back', 16));
        early.abandon('given back');
        assert.equal(early.look('given back'), null);
        for (const i of [0, 1500, 2999])
        {
            assert.deepEqual(early.with(`a name of some length, ${i}`, body=>[...body]), [...bodyOf(16, i)]);
        }
        assert.equal(early.put('written late', bodyOf(16, 7)), true);
        assert.deepEqual(reader.with('written late', body=>[...body]), [...bodyOf(16, 7)]);
    });

test('a reader is refused over memory that is not a cache of this layout', async()=>{
    const { keeper } = await cacheOf();
    const keeperCalls = { reserve: ()=>false, raise: ()=>false, raiseLater: ()=>{}, drop: ()=>{} };
    // Zeroed words would read as an empty cache whose every lookup misses.
    const zeroed = /** @type {any} */ ({ records: new SharedArrayBuffer(keeper.shared.records.byteLength),
        names: keeper.shared.names, table: keeper.shared.table });
    assert.throws(()=>createReader({ shared: zeroed, keeper: keeperCalls }), /not a cache of this layout/);
    assert.throws(()=>createReader({ shared: /** @type {any} */ ({}), keeper: keeperCalls }),
        /not a cache of this layout/);
    assert.doesNotThrow(()=>createReader({ shared: keeper.shared, keeper: keeperCalls }));
});

test('an announce whose promise rejects is counted, not left an unhandled rejection', async()=>{
    /** @type {unknown[]} */
    const unhandled = [];
    /** @param {unknown} reason */
    const onUnhandled = reason=>unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try
    {
        const { keeper, reader } = await cacheOf({
            budget: 256 * KIB, segmentBytes: 64 * KIB,
            announce: ()=>Promise.reject(new Error('the thread is gone')),
        });
        // More than a segment's bodies: the keeper makes segments and tells of them.
        for (let i = 0; i < 6; i++)
        {
            reader.put(`blocks/${i}`, bodyOf(32 * KIB, i));
        }
        await new Promise(resolve=>setTimeout(resolve, 0));
        assert.ok(keeper.figures().announceFailures > 0);
        assert.deepEqual(unhandled, []);
    }
    finally
    {
        process.off('unhandledRejection', onUnhandled);
    }
});

test('a reservation let go of without a body is counted as its room goes back', async()=>{
    const { keeper, reader } = await cacheOf();
    assert.ok(reader.reserve('blocks/1', 1000));
    reader.abandon('blocks/1');
    assert.equal(keeper.figures().abandoned, 0);
    keeper.sweep();
    assert.equal(keeper.figures().abandoned, 1);
    // Let go of again by a reserve of the name: given back there.
    assert.ok(reader.reserve('blocks/2', 1000));
    reader.abandon('blocks/2');
    assert.ok(reader.reserve('blocks/2', 1000));
    assert.equal(keeper.figures().abandoned, 2);
});

test('an owner\'s names are let go together: what was under its prefix, and what is still read goes '
    + 'once no one reads it; what it reserved comes back at once; names of another prefix stay', async()=>{
    const { keeper, reader } = await cacheOf();
    for (const name of ['texels/1/a', 'texels/1/b', 'texels/10/a', 'texels/2/a', 'reads/x'])
    {
        assert.equal(reader.put(name, bodyOf(1000, name.length), F_ONLY_COPY), true, name);
    }
    // One being written, one being read, as the owner goes.
    assert.ok(reader.reserve('texels/1/c', 500, F_ONLY_COPY));
    // Each body of 1000 or 500 bytes takes its length rounded to a grain in memory.
    assert.deepEqual(keeper.under('texels/1/'), { bodies: 3, bytes: 2500, hotBytes: 2500,
        placedBytes: 2 * grainsOf(1000) + grainsOf(500) });
    let released = null;
    reader.with('texels/1/a', ()=>{
        released = keeper.release('texels/1/');
    });
    assert.deepEqual(released, { bodies: 3, bytes: 2500, waiting: 1 },
        'the one read waits for its reader; the one reserved is taken back');
    assert.equal(reader.look('texels/1/b'), null, 'one no one held is gone at once');
    assert.equal(keeper.under('texels/1/').placedBytes, grainsOf(1000), 'the reservation\'s room back');
    assert.equal(reader.commit('texels/1/c'), false, 'its owner went: a late commit fails');
    assert.equal(reader.look('texels/1/c'), null);
    keeper.sweep();
    assert.deepEqual(keeper.under('texels/1/'), { bodies: 0, bytes: 0, hotBytes: 0, placedBytes: 0 },
        'no tail once they are let go of');
    for (const name of ['texels/10/a', 'texels/2/a', 'reads/x'])
    {
        assert.equal(reader.look(name), 'hot', `${name} is another owner's`);
    }
    assert.equal(keeper.figures().released, 3);
    assert.throws(()=>keeper.release(/** @type {any} */ (7)), TypeError);
});

test('memory let go of gives its room back at the next reserve of any name, not at the sweep', async()=>{
    const { keeper, reader } = await cacheOf({ budget: 64 * 1024, segmentBytes: 64 * 1024 });
    for (let i = 0; i < 4; i++)
    {
        assert.ok(reader.hold(`rows/${i}`, 16 * 1024));
    }
    assert.equal(reader.hold('frame/2', 16 * 1024), null, 'the budget held whole');
    reader.abandon('rows/0');
    assert.ok(reader.hold('frame/2', 16 * 1024), 'the room rows/0 let go of, with no sweep between');
    assert.equal(keeper.figures().abandoned, 1);
    for (const name of ['rows/1', 'rows/2', 'rows/3', 'frame/2'])
    {
        reader.abandon(name);
    }
    assert.ok(reader.reserve('frame/3', 1000), 'a reserve too');
    assert.equal(keeper.figures().placedBytes, grainsOf(1000), 'frame/3 alone is placed');
});

test('a reserve made while another waits for the keeper, growing the places held, leaves the '
    + 'waiting one its own room', async()=>{
    // A remote keeper's reserve waits on a link that serves calls meanwhile,
    // and one of them may reserve here too: enough of them to outgrow the
    // reader's places, and the outer answer must still be the outer's.
    const { keeper } = await cacheOf();
    let nested = /** @type {(() => void) | null} */ (null);
    const reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, flags, known, place)=>{
                const inner = nested;
                nested = null;
                inner?.();
                return keeper.reserve(name, length, flags, known, place);
            },
            raise: name=>keeper.raise(name),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    /** @type {Uint8Array[]} */
    const inner = [];
    nested = ()=>{
        for (let i = 0; i < 12; i++)
        {
            inner.push(/** @type {Uint8Array} */ (reader.reserve(`inner-${i}`, 512)));
        }
    };
    const outer = /** @type {Uint8Array} */ (reader.reserve('outer', 512));
    for (const view of inner)
    {
        assert.notEqual(view.byteOffset, outer.byteOffset, 'the outer view is no inner one\'s room');
    }
    outer.fill(7);
    assert.equal(reader.commit('outer'), true);
    inner.forEach((view, i)=>{
        view.fill(i);
        assert.equal(reader.commit(`inner-${i}`), true);
    });
    assert.deepEqual([.../** @type {any} */ (reader.with('outer', body=>body.slice()))], Array(512).fill(7));
});
