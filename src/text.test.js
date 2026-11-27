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
