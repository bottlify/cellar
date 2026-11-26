/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesOf } from './bytes.js';

test('bytes over a buffer that cannot grow are copied as they are, nothing made for them', ()=>{
    const plain = new Uint8Array(8);
    const shared = new Uint8Array(new SharedArrayBuffer(8));
    const numbers = [1, 2, 3];
    assert.equal(bytesOf(plain, 'test'), plain);
    assert.equal(bytesOf(shared, 'test'), shared);
    assert.equal(bytesOf(numbers, 'test'), numbers);
    // Only a view another thread can grow is cut to a view of its own.
    const growing = new Uint8Array(new /** @type {any} */ (SharedArrayBuffer)(8, { maxByteLength: 64 }));
    const taken = bytesOf(growing, 'test');
    assert.notEqual(taken, growing);
    assert.equal(taken.length, 8);
});

test('bytes are a view of one-byte elements or an array of integers from 0 to 255; nothing else '
    + 'passes as bytes', ()=>{
    for (const bytes of [Uint8Array.of(1), Int8Array.of(-1), Uint8ClampedArray.of(255), [],
        [0, 255, 7], [-0]])
    {
        assert.equal(bytesOf(/** @type {any} */ (bytes), 'test'), bytes);
    }
    // A string and an object with a length were written as zeros, a number
    // past a byte as its low byte; an array with a hole has `undefined` in it.
    for (const bytes of ['hello', new String('hi'), { length: 3 }, { length: 0 }, [256], [-1], [1.5],
        [NaN], ['1'], [true], [1, , 3], Uint16Array.of(1), new BigUint64Array(1),
        new DataView(new ArrayBuffer(4)), new ArrayBuffer(4), null, undefined, 3])
    {
        assert.throws(()=>bytesOf(/** @type {any} */ (bytes), 'test'),
            /test: bytes are a Uint8Array or an array of integers from 0 to 255/, String(bytes));
    }
});
