/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { HEAD_WORD, WRITTEN_WORD, createJournalMemory, openJournal } from './journal.js';

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
const copy = (/** @type {DataView} */ view, /** @type {number} */ length)=>
    new Uint8Array(view.buffer, view.byteOffset, length).slice();

/**
 * Writes `bytes` as a record: drafted, filled, committed.
 *
 * @param {import('./journal.js').Journal} journal @param {Uint8Array} bytes
 */
const put = (journal, bytes)=>{
    const view = journal.draft(bytes.length);
    new Uint8Array(view.buffer, view.byteOffset, bytes.length).set(bytes);
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
        // written, and how many bytes it takes.
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
                const got = journal.read(sequence, (view, length)=>{
                    handed++;
                    return copy(view, length);
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

test('a record is handed on as a copy of the reader\'s own, made before take sees it: the writer '
    + 'lapping it while take reads changes nothing take was handed', ()=>{
    const memory = createJournalMemory({ records: 8, bytes: 64 });
    const journal = openJournal(memory);
    journal.draft(8).setFloat64(0, 1.5, true);
    const first = journal.commit();
    assert.equal(journal.read(first, view=>view.getFloat64(0, true)), 1.5);
    const got = journal.read(first, (view, length)=>{
        assert.notEqual(view.buffer, memory.buffer, 'not the journal\'s memory');
        for (let n = 0; n < 8; n++)
        {
            put(journal, record(n, 24));
        }
        return [view.getFloat64(0, true), length];
    });
    assert.deepEqual(got, [1.5, 8], 'the copy was whole when it was handed on');
    assert.equal(journal.read(first, copy), undefined, 'and the record is gone after');
});

/**
 * Runs `work` with every `Atomics.load` of `buffer` counted, and `inject`
 * run once, just after the load numbered `at` (from 1) took its value: as
 * the writer on another thread would run between two loads of a reader.
 * Answers how many loads `work` made.
 *
 * @param {ArrayBufferLike} buffer @param {number} at @param {() => void} inject
 * @param {() => void} work
 */
function injectAfterLoad(buffer, at, inject, work){
    const load = Atomics.load;
    let loads = 0;
    /** @type {any} */ (Atomics).load = (/** @type {any} */ array, /** @type {number} */ index)=>{
        const value = load(array, index);
        if (array.buffer === buffer && ++loads === at)
        {
            inject();
        }
        return value;
    };
    try
    {
        work();
    }
    finally
    {
        Atomics.load = load;
    }
    return loads;
}

test('a writer lapping a record between any two loads of its read: the read answers it whole or '
    + 'not at all, and take is handed only the whole record, at its own length', ()=>{
    // 64 bytes: X at 0 (16), A at 16 (32), Y at 48 (16). C, 48 bytes from 64,
    // lies over X and A, and its bytes 8..15 are where A's header was: made to
    // read as a length past the buffer or past what a count of words can say,
    // or one that fits, and A's sequence.
    for (const planted of [4096, 0x7fffffff, 24, 40])
    {
        const answers = new Set();
        for (let at = 1; ; at++)
        {
            const memory = createJournalMemory({ records: 8, bytes: 64 });
            const journal = openJournal(memory);
            put(journal, record(0, 8));
            const wanted = record(1, 24);
            const a = put(journal, wanted);
            put(journal, record(2, 8));
            const lap = ()=>{
                const view = journal.draft(40);
                new Uint8Array(view.buffer, view.byteOffset, 40).fill(0xee);
                view.setUint32(8, planted, true);
                view.setUint32(12, a, true);
                journal.commit();
            };
            /** @type {Uint8Array | undefined} */
            let got;
            const loads = injectAfterLoad(memory.buffer, at, lap, ()=>{
                got = journal.read(a, (view, length)=>{
                    const bytes = copy(view, length);
                    assert.deepEqual(bytes, wanted, `${planted}: handed only A, whole (lap after load ${at})`);
                    return bytes;
                });
            });
            if (got !== undefined)
            {
                assert.deepEqual(got, wanted, `${planted}: the answer is A (lap after load ${at})`);
            }
            answers.add(got === undefined ? 'gone' : 'whole');
            if (loads < at)
            {
                break;
            }
        }
        assert.deepEqual([...answers].sort(), ['gone', 'whole'],
            'a lap before the last load loses the record, one after it does not');
    }
});

test('every word of a record goes into the journal by Atomics.store after the count of bytes, '
    + 'and comes out by Atomics.load before the check of it', ()=>{
    // What makes the check honest on a processor that reorders plain accesses
    // (arm64): an x86 machine cannot show the reordering, so the order the
    // journal relies on is what this pins.
    const memory = createJournalMemory({ records: 16, bytes: 256 });
    const words = new Int32Array(memory.buffer);
    const journal = openJournal(memory);
    const reader = openJournal(memory);
    const load = Atomics.load;
    const store = Atomics.store;
    /** @type {{ op: string, index: number }[]} */
    const log = [];
    /** @type {any} */ (Atomics).load = (/** @type {any} */ array, /** @type {number} */ index)=>{
        if (array.buffer === memory.buffer)
        {
            log.push({ op: 'load', index: index + array.byteOffset / 4 });
        }
        return load(array, index);
    };
    /** @type {any} */ (Atomics).store = (/** @type {any} */ array, /** @type {number} */ index,
        /** @type {number} */ value)=>{
        if (array.buffer === memory.buffer)
        {
            log.push({ op: 'store', index: index + array.byteOffset / 4 });
        }
        return store(array, index, value);
    };
    try
    {
        for (let n = 0; n < 60; n++)
        {
            const length = 1 + (n * 13) % 40;
            // Records poisoned with words no commit writes: a store the
            // journal made plainly shows as a word changed and not logged.
            words.fill(0x7f7f7f7f, 8 + 16);
            const before = words.slice();
            log.length = 0;
            const view = journal.draft(length);
            assert.notEqual(view.buffer, memory.buffer, 'drafted in the writer\'s own memory');
            assert.equal(log.length, 0, 'a draft touches nothing of the journal');
            for (let at = 0; at < length; at++)
            {
                view.setUint8(at, (n * 7 + at + 1) & 0xff ^ 0x5a);
            }
            const sequence = journal.commit();
            const stores = log.filter(entry=>entry.op === 'store').map(entry=>entry.index);
            const changed = [...words.keys()].filter(index=>words[index] !== before[index]);
            assert.deepEqual(changed.filter(index=>!stores.includes(index)), [],
                `commit ${n}: every word it changed was stored atomically`);
            const head = stores.indexOf(HEAD_WORD);
            const recordWords = stores.filter(index=>index >= 8 + 16);
            assert.ok(head >= 0 && recordWords.length >= 2 + Math.ceil(length / 4),
                `commit ${n}: the header and every word of the record stored`);
            assert.ok(recordWords.every(index=>stores.indexOf(index) > head),
                `commit ${n}: the count of bytes moved before any word of a record`);
            const written = stores.indexOf(WRITTEN_WORD);
            assert.ok(written > Math.max(...recordWords.map(index=>stores.indexOf(index))),
                `commit ${n}: the count of records moved after every word`);
            // The read: every word of the record, header included, loaded
            // atomically, and all of them before the last load of the count of bytes.
            log.length = 0;
            /** @type {number[]} */
            let handed = [];
            const got = reader.read(sequence, (record, got)=>{
                assert.notEqual(record.buffer, memory.buffer, 'take reads a copy of its own');
                handed = log.filter(entry=>entry.op === 'load').map(entry=>entry.index);
                return got;
            });
            assert.equal(got, length);
            const lastHead = handed.lastIndexOf(HEAD_WORD);
            const place = recordWords[0];
            for (let index = place; index < place + 2 + Math.ceil(length / 4); index++)
            {
                const loaded = handed.indexOf(index);
                assert.ok(loaded >= 0 && loaded < lastHead,
                    `read ${n}: word ${index - place} of the record loaded atomically before the check`);
            }
            assert.equal(lastHead, handed.length - 1, `read ${n}: the check is the last load`);
        }
    }
    finally
    {
        Atomics.load = load;
        Atomics.store = store;
    }
});

test('one record drafted at a time, no commit without one, none longer than the buffer holds',
    ()=>{
    const journal = openJournal(createJournalMemory({ records: 4, bytes: 64 }));
    assert.throws(()=>journal.commit(), /nothing drafted/);
    journal.draft(4);
    assert.throws(()=>journal.draft(4), /drafted again/);
    assert.equal(journal.read(0, copy), undefined, 'not readable before its commit');
    journal.commit();
    for (const length of [journal.maxRecord + 1, -1, 1.5, NaN])
    {
        assert.throws(()=>journal.draft(length), RangeError);
    }
    assert.ok(journal.draft(journal.maxRecord).byteLength >= journal.maxRecord, 'the longest fits');
    journal.commit();
    assert.equal(journal.read(1, (_view, length)=>length), journal.maxRecord);
    assert.throws(()=>createJournalMemory({ records: 0 }), RangeError);
    assert.throws(()=>createJournalMemory({ bytes: (1 << 30) + 1 }), RangeError);
    assert.throws(()=>createJournalMemory({ first: -1 }), RangeError);
    assert.throws(()=>openJournal({ buffer: new ArrayBuffer(64) }), /not a journal/);
    const memory = createJournalMemory({ records: 4, bytes: 64 });
    assert.throws(()=>openJournal({ buffer: memory.buffer.slice(0, 100) }), /not a journal/,
        'a memory cut short is no journal either');
});

test('a draft or a copy grows for a record longer than any before, and a view of it kept past '
    + 'that fails where it is used', ()=>{
    const journal = openJournal(createJournalMemory({ records: 8, bytes: 1024 }));
    const small = journal.draft(8);
    small.setFloat64(0, 2.5, true);
    const first = journal.commit();
    /** @type {DataView | undefined} */
    let kept;
    assert.equal(journal.read(first, view=>{
        kept = view;
        return view.getFloat64(0, true);
    }), 2.5);
    const long = record(7, 300);
    const second = put(journal, long);
    assert.throws(()=>small.setFloat64(0, 1, true), TypeError, 'the writer\'s old draft is gone');
    assert.deepEqual(journal.read(second, copy), long, 'a longer record read whole');
    assert.throws(()=>kept?.getFloat64(0, true), TypeError, 'and the reader\'s old copy');
    const grownDraft = journal.draft(8);
    journal.commit();
    assert.equal(journal.draft(300), grownDraft, 'no longer than before: the same draft');
    journal.commit();
});

test('sequences and the count of bytes wrap at 2^32 and read as a journal that just began',
    ()=>{
    const memory = createJournalMemory({ records: 16, bytes: 256, first: 0xffffff00 });
    // Bytes ever written a little short of 2^32: the next records cross it.
    new Int32Array(memory.buffer)[HEAD_WORD] = -104;
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

test('past 2^32 records committed, the records just before the count wrapped are found', ()=>{
    const memory = createJournalMemory({ records: 4096, bytes: 1 << 16, shared: false });
    // The state of a journal that committed 2^32 - 3 records.
    new Int32Array(memory.buffer)[WRITTEN_WORD] = -3;
    const journal = openJournal(memory);
    /** @type {number[]} */
    const sequences = [];
    for (let n = 1; n <= 6; n++)
    {
        sequences.push(put(journal, Uint8Array.of(n)));
    }
    assert.deepEqual(sequences, [2 ** 32 - 3, 2 ** 32 - 2, 2 ** 32 - 1, 0, 1, 2]);
    assert.deepEqual(sequences.map(sequence=>journal.read(sequence, view=>view.getUint8(0))),
        [1, 2, 3, 4, 5, 6]);
    assert.equal(journal.oldest(), (3 - 4096) >>> 0, 'the index is full: it holds 4096');
});

test('records that are not a power of two keep a slot each across the sequence\'s wrap', ()=>{
    for (const [records, first] of [[3, 2 ** 32 - 2], [3000, 2 ** 32 - 10], [1023, 2 ** 32 - 512]])
    {
        const journal = openJournal(createJournalMemory({ records, bytes: 1 << 20, first }));
        for (let n = 0; n < records; n++)
        {
            journal.draft(4).setUint32(0, n, true);
            journal.commit();
        }
        assert.equal(journal.oldest(), first, `${records} records: the first is still held`);
        let lost = 0;
        for (let n = 0; n < records; n++)
        {
            if (journal.read((first + n) >>> 0, view=>view.getUint32(0, true)) !== n)
            {
                lost++;
            }
        }
        assert.equal(lost, 0, `${records} records from ${first}: every one found, its own`);
    }
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
    // Before any commit, the index and the records are zeros: a header of no
    // length and sequence 0, which a journal counting from 1 never wrote.
    const empty = openJournal(createJournalMemory({ records: 4, bytes: 64, first: 1 }));
    assert.equal(empty.read(0, ()=>'handed'), undefined, 'a header never written is no record');
    assert.equal(empty.oldest(), 1);
});

test('a read inside take copies into a view of its own: the outer read\'s copy stays whole', ()=>{
    const journal = openJournal(createJournalMemory({ records: 16, bytes: 64, shared: false }));
    const fill = (/** @type {number} */ value)=>{
        new Uint8Array(journal.draft(8).buffer, 0, 8).fill(value);
        return journal.commit();
    };
    const old = fill(1);
    /** @type {number | undefined} */
    let inner;
    const got = journal.read(old, view=>{
        const first = view.getUint8(0);
        // The writer laps the record, and a record of the same opening is read inside.
        for (let n = 0; n < 4; n++)
        {
            fill(9);
        }
        inner = journal.read((journal.written() - 1) >>> 0, record=>record.getUint8(0));
        return [first, view.getUint8(7)];
    });
    assert.deepEqual(got, [1, 1], 'the outer record whole: the inner read copied elsewhere');
    assert.equal(inner, 9);
    assert.equal(journal.read(old, ()=>'handed'), undefined, 'and gone now');
    // A take that throws leaves the next read at the first depth again.
    assert.throws(()=>journal.read((journal.written() - 1) >>> 0, ()=>{
        throw new Error('take failed');
    }), /take failed/);
    assert.equal(journal.read((journal.written() - 1) >>> 0, record=>record.getUint8(0)), 9);
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
    // newest records over and over. Whatever take is handed must be whole.
    const memory = createJournalMemory({ records: 64, bytes: 4096 });
    const COUNT = 200_000;
    const writer = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.url).then(({ openJournal })=>{
            const journal = openJournal(workerData.memory);
            for (let n = 0; n < workerData.count; n++)
            {
                const length = 8 + (n % 7) * 8;
                const view = journal.draft(length);
                for (let i = 0; i < length; i += 4) view.setUint32(i, n, true);
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
    let torn = 0;
    /** Whether every word of a record says its sequence, and its length is its own. */
    const whole = (/** @type {DataView} */ view, /** @type {number} */ length)=>{
        const first = view.getUint32(0, true);
        if (length !== 8 + (first % 7) * 8)
        {
            torn++;
        }
        for (let i = 4; i < length; i += 4)
        {
            if (view.getUint32(i, true) !== first)
            {
                torn++;
            }
        }
        return first;
    };
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
    assert.equal(torn, 0, 'every record handed on whole and the one asked for');
    assert.equal(journal.written(), COUNT);
    assert.equal(journal.read(COUNT - 1, whole), COUNT - 1, 'the last record is there');
});
