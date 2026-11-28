/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readText, readUnits, textOf, wellFormed, writeText } from './text.js';

test('text written as UTF-8 where it goes, shared memory included, and read back where it lies', ()=>{
    for (const text of ['', 'blocks/42', 'texels/é/ünï', '名前/𝄞', 'a'.repeat(9000) + 'ж'])
    {
        const bytes = new Uint8Array(new SharedArrayBuffer(text.length * 3 + 8));
        const written = writeText(bytes, 3, text);
        assert.equal(written, new TextEncoder().encode(text).length);
        assert.deepEqual([...bytes.subarray(3, 3 + written)], [...new TextEncoder().encode(text)]);
        assert.equal(readText(bytes, 3, written), text);
        assert.equal(textOf(bytes.subarray(3, 3 + written)), text);
    }
});

test('text past its room is cut at a whole character', ()=>{
    const bytes = new Uint8Array(16);
    assert.equal(writeText(bytes, 0, 'abcdef', 4), 4);
    assert.equal(readText(bytes, 0, 4), 'abcd');
    assert.equal(writeText(bytes, 0, 'abéé', 5), 4, 'the second é does not fit');
    assert.equal(readText(bytes, 0, 4), 'abé');
    assert.equal(writeText(bytes, 0, '𝄞', 3), 0);
});

test('text written as TextEncoder.encodeInto writes it, for any text and any room', ()=>{
    // Seeded: one byte, two, three and four, and surrogates alone or out of order.
    let seed = 0x2545f491;
    const next = ()=>(seed = seed * 1103515245 + 12345 >>> 0) >>> 8;
    const picks = [0x41, 0x7f, 0x80, 0xe9, 0x7ff, 0x800, 0x540d, 0xfffd, 0xffff, 0xd834, 0xdd1e, 0xdbff, 0xdc00];
    const encoder = new TextEncoder();
    for (let round = 0; round < 2000; round++)
    {
        const text = String.fromCharCode(...Array.from({ length: next() % 12 }, ()=>picks[next() % picks.length]));
        const room = next() % 40;
        const want = new Uint8Array(room);
        const { written } = encoder.encodeInto(text, want);
        const got = new Uint8Array(new SharedArrayBuffer(room + 2));
        assert.equal(writeText(got, 1, text, room + 1), written, JSON.stringify(text));
        assert.deepEqual([...got.subarray(1, 1 + written)], [...want.subarray(0, written)], JSON.stringify(text));
    }
});

test('units, one byte each or two, as many as a string is made from at once and more', ()=>{
    const narrow = Uint8Array.from({ length: 20_000 }, (_, i)=>32 + i % 200);
    assert.equal(readUnits(narrow, 0, 20_000, false),
        String.fromCharCode(...Array.from(narrow)).slice(0, 20_000));
    const text = 'x\uD800y'.repeat(4000);
    const wide = new Uint8Array(text.length * 2 + 1);
    for (let i = 0; i < text.length; i++)
    {
        wide[1 + i * 2] = text.charCodeAt(i) & 255;
        wide[2 + i * 2] = text.charCodeAt(i) >>> 8;
    }
    assert.equal(readUnits(wide, 1, text.length, true), text, 'a lone surrogate kept as it was');
});

test('whether text is whole UTF-16', ()=>{
    assert.equal(wellFormed('a𝄞b'), true);
    assert.equal(wellFormed('a\uD800'), false);
    assert.equal(wellFormed('\uDC00a'), false);
});
