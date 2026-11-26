/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { HEAD_WORD, createJournalMemory, openJournal } from './journal.js';

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

/** A record whose bytes say which it is. @param {number} n @param {number} length */
function record(n, length){
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length; at++)
    {
        bytes[at] = at < 4 ? (n >>> (at * 8)) & 0xff : (n + at) & 0xff;
    }
    return bytes;
}

/** A copy of what a read was handed. */
const copy = (/** @type {Uint8Array} */ bytes, /** @type {number} */ at, /** @type {number} */ length)=>
    bytes.slice(at, at + length);

/**
 * Writes `bytes` as a record: reserved, filled in place, committed.
 *
 * @param {import('./journal.js').Journal} journal @param {Uint8Array} bytes
 */
const put = (journal, bytes)=>{
    const at = journal.reserve(bytes.length);
    journal.bytes.set(bytes, at);
    return journal.commit();
};

test('a reader finds exactly the records the writer has not written over, whole, across every '
    + 'wrap of the buffer', ()=>{
    for (let seed = 1; seed <= 40; seed++)
    {
        const next = random(seed);
        const records = 1 + Math.floor(next() * 12);
        const journal = openJournal(createJournalMemory({ records, bytes: 256 }));
        // The model: each record's bytes, where it starts in bytes ever
        // reserved, and how many bytes it takes.
        /** @type {{ bytes: Uint8Array, start: number, need: number }[]} */
        const sent = [];
        let head = 0;
        for (let step = 0; step < 400; step++)
        {
            const length = Math.floor(next() * (journal.maxRecord + 1));
            const need = 8 + Math.ceil(length / 8) * 8;
            let start = head;
            if ((start % 256) + need > 256)
            {
                start += 256 - (start % 256);
            }
            head = start + need;
            const bytes = record(sent.length, length);
            assert.equal(put(journal, bytes), sent.length, 'sequences count from the first');
            sent.push({ bytes, start, need });
            assert.equal(journal.written(), sent.length);
            for (let sequence = Math.max(0, sent.length - 20); sequence <= sent.length; sequence++)
            {
                const kept = sequence < sent.length && sent.length - sequence <= records
                    && head - sent[sequence].start <= 256;
                let handed = 0;
                const got = journal.read(sequence, (bytes, at, length)=>{
                    handed++;
                    return copy(bytes, at, length);
                });
                assert.deepEqual(got, kept ? sent[sequence].bytes : undefined,
                    `seed ${seed}, step ${step}, sequence ${sequence}`);
                assert.equal(handed, kept ? 1 : 0, 'a record not there is handed to nobody');
            }
            const oldest = journal.oldest();
            assert.equal(oldest, Math.max(0, sent.length - records));
        }
    }
});

test('a record is read in place, eight-aligned, and one the writer reaches while it is read is '
    + 'not answered', ()=>{
    const journal = openJournal(createJournalMemory({ records: 8, bytes: 64 }));
    const at = journal.reserve(8);
    assert.equal(at % 8, 0);
    new Float64Array(journal.bytes.buffer, at, 1)[0] = 1.5;
    const first = journal.commit();
    assert.equal(journal.read(first, (bytes, where)=>new Float64Array(bytes.buffer, where, 1)[0]), 1.5);
    // The writer laps the record while a reader is inside it.
    const got = journal.read(first, (bytes, where, length)=>{
        for (let n = 0; n < 8; n++)
        {
            put(journal, record(n, 24));
        }
        return copy(bytes, where, length);
    });
    assert.equal(got, undefined, 'written over during the read');
    assert.equal(journal.read(first, copy), undefined, 'and gone after');
});

test('a record whose header the writer covered with bytes that read as it is still not answered, '
    + 'during a read or after, and not while the writer has only reserved over it', ()=>{
    // 64 bytes: X at 0 (16), A at 16 (32), Y at 48 (16). C, 48 bytes from 64,
    // lies over X and A, and its bytes 8..15 are where A's header was: made to
    // read as A's length and sequence.
    const journal = openJournal(createJournalMemory({ records: 8, bytes: 64 }));
    put(journal, record(0, 8));
    const a = put(journal, record(1, 24));
    put(journal, record(2, 8));
    const writeC = (/** @type {boolean} */ commit)=>{
        const at = journal.reserve(40);
        const view = new DataView(journal.bytes.buffer);
        journal.bytes.fill(0xee, at, at + 40);
        view.setUint32(at + 8, 24, true);
        view.setUint32(at + 12, a, true);
        if (commit)
        {
            journal.commit();
        }
    };
    let handed = 0;
    assert.equal(journal.read(a, (bytes, at, length)=>{
        handed++;
        writeC(false);
        return copy(bytes, at, length);
    }), undefined, 'reserved over while read: the bytes are not A\'s any more');
    assert.equal(handed, 1);
    journal.commit();
    assert.equal(journal.read(a, ()=>{
        handed++;
        return 'A';
    }), undefined, 'covered before the read');
    assert.equal(handed, 1, 'and not handed to the reader at all');
});

test('one record reserved at a time, no commit without one, none longer than the buffer holds',
    ()=>{
    const journal = openJournal(createJournalMemory({ records: 4, bytes: 64 }));
    assert.throws(()=>journal.commit(), /nothing reserved/);
    journal.reserve(4);
    assert.throws(()=>journal.reserve(4), /reserved again/);
    assert.equal(journal.read(0, copy), undefined, 'not readable before its commit');
    journal.commit();
    for (const length of [journal.maxRecord + 1, -1, 1.5, NaN])
    {
        assert.throws(()=>journal.reserve(length), RangeError);
    }
    assert.ok(journal.reserve(journal.maxRecord) >= 0, 'the longest fits');
    journal.commit();
    assert.throws(()=>createJournalMemory({ records: 0 }), RangeError);
    assert.throws(()=>createJournalMemory({ bytes: (1 << 30) + 1 }), RangeError);
    assert.throws(()=>createJournalMemory({ first: -1 }), RangeError);
    assert.throws(()=>openJournal({ buffer: new ArrayBuffer(64) }), /not a journal/);
});

test('sequences and the count of bytes wrap at 2^32 and read as a journal that just began',
    ()=>{
    const memory = createJournalMemory({ records: 16, bytes: 256, first: 0xffffff00 });
    // Bytes ever reserved a little short of 2^32: the next records cross it.
    new Int32Array(memory.buffer)[HEAD_WORD] = -100;
    const journal = openJournal(memory);
    /** @type {Uint8Array[]} */
    const sent = [];
    for (let n = 0; n < 1000; n++)
    {
        const bytes = record(n, 4 + (n % 40));
        const sequence = put(journal, bytes);
        assert.equal(sequence, (0xffffff00 + n) >>> 0);
        sent.push(bytes);
        const back = journal.read(sequence, copy);
        assert.deepEqual(back, bytes, `record ${n}`);
        if (n >= 1)
        {
            assert.deepEqual(journal.read((sequence - 1) >>> 0, copy), sent[n - 1]);
        }
    }
    assert.equal(journal.written(), (0xffffff00 + 1000) >>> 0);
    assert.equal(journal.oldest(), (0xffffff00 + 1000 - 16) >>> 0);
});

test('a sequence before the first, or not committed yet, is no record', ()=>{
    const journal = openJournal(createJournalMemory({ records: 4, bytes: 64, first: 100 }));
    for (const sequence of [0, 99, 100, 101, 0xffffffff])
    {
        assert.equal(journal.read(sequence, ()=>'handed'), undefined, `sequence ${sequence}`);
    }
    put(journal, Uint8Array.of(1));
    assert.deepEqual(journal.read(100, copy), Uint8Array.of(1));
    assert.equal(journal.read(0, ()=>'handed'), undefined);
    assert.equal(journal.read(101, ()=>'handed'), undefined);
    assert.equal(journal.oldest(), 100);
});

test('a journal over memory of its own is read on its writer\'s thread the same way', ()=>{
    const memory = createJournalMemory({ records: 4, bytes: 64, shared: false });
    assert.equal(memory.buffer instanceof SharedArrayBuffer, false);
    const journal = openJournal(memory);
    const sequence = put(journal, Uint8Array.of(7, 8, 9));
    assert.deepEqual(journal.read(sequence, copy), Uint8Array.of(7, 8, 9));
    assert.deepEqual(openJournal(memory).read(sequence, copy), Uint8Array.of(7, 8, 9),
        'and by another opening of it');
});

test('a reader on another thread is never handed a torn record, and finds the last one',
    { timeout: 120_000 }, async()=>{
    // The writer in a worker writes as fast as it can; this thread reads the
    // newest records over and over. Whatever a read answers must be whole.
    const memory = createJournalMemory({ records: 64, bytes: 4096 });
    const COUNT = 200_000;
    const writer = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(({ openJournal })=>{
            const journal = openJournal(workerData.memory);
            const view = new DataView(journal.bytes.buffer);
            for (let n = 0; n < workerData.count; n++)
            {
                const length = 8 + (n % 7) * 8;
                const at = journal.reserve(length);
                for (let i = 0; i < length; i += 4) view.setUint32(at + i, n, true);
                journal.commit();
            }
            parentPort.postMessage('done');
        });`, { eval: true, workerData: { url: new URL('./journal.js', import.meta.url).href,
        memory, count: COUNT } });
    const done = new Promise((resolve, reject)=>{
        writer.once('message', resolve);
        writer.once('error', reject);
    });
    const journal = openJournal(memory);
    let finished = false;
    done.then(()=>{
        finished = true;
    });
    /** Whether every word of a record says its sequence. */
    const whole = (/** @type {Uint8Array} */ bytes, /** @type {number} */ at,
        /** @type {number} */ length)=>{
        const view = new DataView(bytes.buffer);
        const first = view.getUint32(at, true);
        for (let i = 4; i < length; i += 4)
        {
            if (view.getUint32(at + i, true) !== first)
            {
                return -1;
            }
        }
        return first;
    };
    let torn = 0;
    while (!finished)
    {
        const next = journal.written();
        for (let back = 1; back <= 8; back++)
        {
            const sequence = (next - back) >>> 0;
            const got = journal.read(sequence, whole);
            if (got !== undefined && got !== sequence)
            {
                torn++;
            }
        }
        await new Promise(resolve=>setImmediate(resolve));
    }
    await writer.terminate();
    assert.equal(torn, 0, 'every answer whole and the record asked for');
    assert.equal(journal.written(), COUNT);
    assert.equal(journal.read(COUNT - 1, whole), COUNT - 1, 'the last record is there');
});
