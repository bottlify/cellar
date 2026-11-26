/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, DELTA, chunkWriter, readChunk, readIndexFile } from './index-file.js';

const ONLY = 1;
const MAX = 1 << 20;

/** @param {string} name */
const unitsOf = name=>Uint16Array.from({ length: name.length }, (_, at)=>name.charCodeAt(at));

/**
 * A chunk of `entries`, each [name, pack, offset, length, flags].
 *
 * @param {number} kind @param {number} generation @param {[string, number, number, number, number][]} entries
 * @param {{ nextPack?: number, packs?: number[] }} [head]
 */
function chunk(kind, generation, entries, { nextPack = 4, packs = [0, 1, 3] } = {}){
    const writer = chunkWriter();
    for (const [name, pack, offset, length, flags] of entries)
    {
        // Each name from the middle of a longer run of units, as the shared names are.
        const units = unitsOf(`..${name}..`);
        writer.entry(pack, offset, length, flags, units, 2, name.length);
    }
    return writer.finish({ kind, generation, nextPack, packs });
}

/** @param {Uint8Array[]} chunks */
const joined = chunks=>{
    const out = new Uint8Array(chunks.reduce((sum, one)=>sum + one.length, 0));
    let at = 0;
    for (const one of chunks)
    {
        out.set(one, at);
        at += one.length;
    }
    return out;
};

test('a chunk reads back as written: names of one byte a unit and of two, a name with no body',
    ()=>{
    const wide = `blocks/Ж\u{1F600}/${'x'.repeat(20000)}`;
    const bytes = chunk(BASE, 7, [['blocks/0', 0, 100, 4096, 0], [wide, 3, 0, 9, ONLY],
        ['gone', -1, 0, 0, 0], ['', 1, 5, 1, 0]]);
    const read = readChunk(bytes, 0, MAX);
    assert.ok(read !== null);
    assert.equal(read.kind, BASE);
    assert.equal(read.generation, 7);
    assert.equal(read.nextPack, 4);
    assert.deepEqual(read.packs, [0, 1, 3]);
    assert.equal(read.end, bytes.length);
    assert.deepEqual(read.entries, [
        ['blocks/0', { pack: 0, offset: 100, length: 4096, flags: 0 }],
        [wide, { pack: 3, offset: 0, length: 9, flags: ONLY }],
        ['gone', { pack: -1, offset: 0, length: 0, flags: 0 }],
        ['', { pack: 1, offset: 5, length: 1, flags: 0 }],
    ]);
    // One byte a unit where every unit fits one: the narrow name costs its length.
    const narrow = chunk(BASE, 1, [['a'.repeat(100), 0, 0, 1, 0]]).length;
    const twice = chunk(BASE, 1, [['Ā'.repeat(100), 0, 0, 1, 0]]).length;
    assert.equal(twice - narrow, 100);
});

test('a chunk cut short, of a byte changed, or of a field past what a run counts to is not read',
    ()=>{
    const bytes = chunk(BASE, 3, [['a', 0, 0, 10, 0], ['b', 1, 0, 10, 0]]);
    for (let cut = 0; cut < bytes.length; cut++)
    {
        assert.equal(readChunk(bytes.subarray(0, cut), 0, MAX), null, `cut at ${cut}`);
    }
    for (let at = 0; at < bytes.length; at++)
    {
        const changed = bytes.slice();
        changed[at] ^= 0x10;
        assert.equal(readChunk(changed, 0, MAX), null, `byte ${at} changed`);
    }
    assert.equal(readChunk(chunk(BASE, 2 ** 60, []), 0, MAX), null, 'an unsafe generation');
    assert.equal(readChunk(chunk(BASE, Number.MAX_SAFE_INTEGER, []), 0, MAX), null,
        'a generation the next save cannot count on from');
    assert.equal(readChunk(chunk(BASE, 1, [], { nextPack: MAX + 1, packs: [] }), 0, MAX), null,
        'more packs than a run opens');
    assert.equal(readChunk(chunk(BASE, 1, [], { nextPack: 2, packs: [2] }), 0, MAX), null,
        'a pack past the numbers given');
    assert.equal(readChunk(chunk(3, 1, []), 0, MAX), null, 'a kind of no meaning');
});

test('a file is its base and every delta after it of the next generation, up to the first not whole',
    ()=>{
    const base = chunk(BASE, 5, [['a', 0, 0, 10, ONLY], ['b', 0, 10, 10, 0]]);
    const first = chunk(DELTA, 6, [['b', -1, 0, 0, 0], ['c', 1, 0, 20, 0]],
        { nextPack: 5, packs: [0, 1, 4] });
    const second = chunk(DELTA, 7, [['a', 4, 0, 10, ONLY]], { nextPack: 5, packs: [1, 4] });
    const whole = readIndexFile(joined([base, first, second]), MAX, ONLY);
    assert.ok(whole !== null);
    assert.equal(whole.generation, 7);
    assert.equal(whole.nextPack, 5);
    assert.deepEqual(whole.packs, [1, 4]);
    assert.deepEqual([...whole.entries], [
        ['a', { pack: 4, offset: 0, length: 10, flags: ONLY }],
        ['c', { pack: 1, offset: 0, length: 20, flags: 0 }],
    ]);
    assert.deepEqual([...whole.onlyCopies].sort(), [0, 4], 'every pack an only copy was named in');
    assert.equal(whole.end, base.length + first.length + second.length);

    // The second delta torn: the file says what it said after the first.
    const torn = readIndexFile(joined([base, first, second.subarray(0, second.length - 3)]), MAX,
        ONLY);
    assert.equal(torn?.generation, 6);
    assert.deepEqual([...(torn?.entries.keys() ?? [])], ['a', 'c']);
    assert.equal(torn?.entries.get('a')?.pack, 0);
    assert.equal(torn?.end, base.length + first.length);

    // A delta of a generation not the next one is no part of this chain.
    const stale = readIndexFile(joined([base, second]), MAX, ONLY);
    assert.equal(stale?.generation, 5);
    assert.equal(readIndexFile(joined([first, second]), MAX, ONLY), null, 'no base, no index');
    assert.equal(readIndexFile(new Uint8Array(0), MAX, ONLY), null);
});

test('an index of Cellar 0.9.0 is read as a base, its entries that do not say a body skipped', ()=>{
    const json = JSON.stringify({ version: 1, generation: 4, packs: 2, records: [
        ['a', 0, 0, 10, 1], ['b', 1, 5, 7, 0], ['c', 2, 0, 1, 0], ['d', 0, 0, 1], null, [3, 0, 0, 1, 0],
    ] });
    const read = readIndexFile(new TextEncoder().encode(json), MAX, ONLY);
    assert.ok(read !== null);
    assert.equal(read.generation, 4);
    assert.equal(read.nextPack, 2);
    assert.deepEqual(read.packs, [0, 1]);
    assert.deepEqual([...read.entries.keys()], ['a', 'b']);
    assert.equal(read.skipped, 4, 'a pack past its count, three that are no entry');
    assert.deepEqual([...read.onlyCopies], [0]);
    assert.equal(readIndexFile(new TextEncoder().encode(json.slice(0, -3)), MAX, ONLY), null,
        'torn');
    assert.equal(readIndexFile(new TextEncoder().encode(JSON.stringify({ version: 1, generation: 1,
        packs: MAX + 1, records: [] })), MAX, ONLY), null, 'more packs than a run opens');
});

test('a chunk listing a pack twice is not read, and an entry that does not say a body is skipped and'
    + ' counted, of either layout', ()=>{
    assert.equal(readChunk(chunk(BASE, 1, [], { nextPack: 4, packs: [0, 3, 0] }), 0, MAX), null);
    assert.equal(readIndexFile(chunk(BASE, 1, [], { nextPack: 4, packs: [1, 1] }), MAX, ONLY), null);
    const read = readIndexFile(chunk(BASE, 2, [['kept', 0, 0, 10, ONLY], ['unlisted', 2, 0, 10, 0],
        ['empty', 1, 0, 0, 0], ['past', 1, 2 ** 31 - 4, 8, 0], ['end', 1, 2 ** 31 - 8, 8, 0]],
    { nextPack: 4, packs: [0, 1, 3] }), MAX, ONLY);
    assert.deepEqual([...(read?.entries.keys() ?? [])], ['kept', 'end']);
    assert.equal(read?.skipped, 3);
    const json = JSON.stringify({ version: 1, generation: 4, packs: 2, records: [
        ['a', 0, 0, 10, 0], ['negative', 0, -1, 10, 0], ['empty', 1, 5, 0, 0],
        ['past', 1, 2 ** 40, 10, 0],
    ] });
    const old = readIndexFile(new TextEncoder().encode(json), MAX, ONLY);
    assert.deepEqual([...(old?.entries.keys() ?? [])], ['a']);
    assert.equal(old?.skipped, 3);
});
