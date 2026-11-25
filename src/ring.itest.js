/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A ring's counts are bytes ever written and ever read, kept in 32-bit words:
 * past 4 GiB they wrap, and a ring that ran that long must read as one that
 * just began. Five gibibytes through a ring of 1 MiB, every record checked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingMemory, openRing } from './ring.js';

test('records come out whole and in order past 4 GiB through the ring', { timeout: 600_000 }, ()=>{
    const ring = openRing(createRingMemory(1 << 20));
    // Not a divisor of the ring: records fall at every offset of it and wrap there.
    const length = 48_000 - 4;
    const record = new Uint8Array(length);
    const view = new DataView(record.buffer);
    const total = 5 * 2 ** 30;
    let sent = 0;
    let got = 0;
    let bytes = 0;
    /** @param {Uint8Array} taken */
    const check = taken=>{
        const at = new DataView(taken.buffer, taken.byteOffset, taken.length);
        assert.equal(taken.length, length);
        assert.equal(at.getUint32(0, true), got >>> 0, `record ${got}`);
        assert.equal(at.getUint32(length - 4, true), ~got >>> 0, `record ${got} whole`);
        got++;
    };
    while (bytes < total)
    {
        view.setUint32(0, sent, true);
        view.setUint32(length - 4, ~sent, true);
        if (ring.write(record))
        {
            sent++;
            bytes += length;
            continue;
        }
        ring.drain(check);
    }
    ring.drain(check);
    assert.equal(got, sent);
    assert.ok(bytes > 2 ** 32, 'the counts wrapped');
});
