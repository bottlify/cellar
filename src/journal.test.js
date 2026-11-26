/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { EPOCH_WORDS, HEAD_WORD, WRITTEN_WORD, createJournalMemory, openJournal } from './journal.js';

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

test('the writer moves the count of bytes and loads it again before a word of a record changes, '
    + 'and the count of records after the last; a reader, its copy whole, stores a word of its own '
    + 'and then loads the count of bytes', ()=>{
    // What makes the check honest on a processor that reorders plain accesses
    // around atomic ones (arm64): an x86 machine cannot show the reordering,
    // so the pairs the journal relies on are what this pins.
    const memory = createJournalMemory({ records: 16, bytes: 256 });
    const words = new Int32Array(memory.buffer);
    const journal = openJournal(memory);
    const reader = openJournal(memory);
    const load = Atomics.load;
    const store = Atomics.store;
    /** @type {{ op: string, journal: boolean, index: number, changed: number[] }[]} */
    const log = [];
    /** @type {Int32Array} */
    let before = words.slice();
    /** Run once at the reader's store of its own word: a writer's word landing then. */
    let atOwnStore = ()=>{};
    const changed = ()=>[...words.keys()].filter(index=>index >= 8 + 16 && words[index] !== before[index]);
    /** @type {any} */ (Atomics).load = (/** @type {any} */ array, /** @type {number} */ index)=>{
        const journalWord = array.buffer === memory.buffer;
        log.push({ op: 'load', journal: journalWord, index: index + array.byteOffset / 4, changed: changed() });
        return load(array, index);
    };
    /** @type {any} */ (Atomics).store = (/** @type {any} */ array, /** @type {number} */ index,
        /** @type {number} */ value)=>{
        const journalWord = array.buffer === memory.buffer;
        log.push({ op: 'store', journal: journalWord, index: index + array.byteOffset / 4, changed: changed() });
        if (!journalWord)
        {
            atOwnStore();
        }
        return store(array, index, value);
    };
    try
    {
        for (let n = 0; n < 60; n++)
        {
            const length = 1 + (n * 13) % 40;
            // Records poisoned with words no commit writes, so a word the
            // commit wrote shows as changed.
            words.fill(0x7f7f7f7f, 8 + 16);
            before = words.slice();
            log.length = 0;
            const view = journal.draft(length);
            assert.notEqual(view.buffer, memory.buffer, 'drafted in the writer\'s own memory');
            assert.equal(log.length, 0, 'a draft touches nothing of the journal');
            for (let at = 0; at < length; at++)
            {
                view.setUint8(at, (n * 7 + at + 1) & 0xff ^ 0x5a);
            }
            const sequence = journal.commit();
            const ops = log.filter(entry=>entry.journal);
            assert.deepEqual([ops[0].op, ops[0].index], ['store', HEAD_WORD], `commit ${n}: the count of bytes first`);
            assert.deepEqual([ops[1].op, ops[1].index], ['load', HEAD_WORD], `commit ${n}: loaded again at once`);
            assert.deepEqual(ops[1].changed, [], `commit ${n}: no word of a record changed before the pair`);
            const written = ops.findIndex(entry=>entry.op === 'store' && entry.index === WRITTEN_WORD);
            assert.ok(written > 1, `commit ${n}: the count of records stored`);
            assert.deepEqual(ops[written].changed, changed(),
                `commit ${n}: every word of the record written before the count of records`);
            assert.ok(changed().length >= 2 + Math.ceil(length / 4), `commit ${n}: the header and the record written`);

            // The read: its copy whole when its own word is stored, the check after.
            const whole = words.slice();
            before = words.slice();
            atOwnStore = ()=>words.fill(0x11111111, 8 + 16);
            log.length = 0;
            const got = reader.read(sequence, (record, got)=>{
                assert.notEqual(record.buffer, memory.buffer, 'take reads a copy of its own');
                return copy(record, got);
            });
            atOwnStore = ()=>{};
            words.set(whole);
            assert.equal(got?.length, length, `read ${n}: answered`);
            const expected = Uint8Array.from({ length }, (_, at)=>(n * 7 + at + 1) & 0xff ^ 0x5a);
            assert.deepEqual(got, expected, `read ${n}: copied whole before its own word was stored`);
            const own = log.findIndex(entry=>entry.op === 'store' && !entry.journal);
            const last = log.slice(own, own + 2).map(entry=>[entry.op, entry.journal, entry.journal ? entry.index : -1]);
            assert.deepEqual(last, [['store', false, -1], ['load', true, HEAD_WORD]],
                `read ${n}: its own word stored, then the count of bytes loaded`);
            assert.ok(log.slice(own + 2).every(entry=>entry.op === 'load' && EPOCH_WORDS.includes(entry.index)),
                `read ${n}: after them, only the marks of the count's wraps`);
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

test('a record the skipped tail of the buffer takes past 2^32 bytes is read, and the one before it',
    ()=>{
    const memory = createJournalMemory({ records: 16, bytes: 64, shared: false });
    // 8 bytes short of 2^32, 8 short of the buffer's end: a record of 16
    // starts the buffer again, and its start is the first past the wrap.
    new Int32Array(memory.buffer)[HEAD_WORD] = -24;
    const journal = openJournal(memory);
    const before = put(journal, Uint8Array.of(1));
    const after = put(journal, Uint8Array.of(2));
    assert.deepEqual([journal.read(before, copy), journal.read(after, copy)],
        [Uint8Array.of(1), Uint8Array.of(2)]);
});

test('past 2^32 records committed, the records just before the count wrapped are found', ()=>{
    const memory = createJournalMemory({ records: 4096, bytes: 1 << 16, shared: false });
    // The state of a journal that committed 2^32 - 3 records, its count of
    // bytes last wrapped at the next.
    const words = new Int32Array(memory.buffer);
    words[WRITTEN_WORD] = -3;
    for (const word of EPOCH_WORDS)
    {
        words[word] = -3;
    }
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

test('a record whose bytes the count of bytes wrapped past is gone, though the index still names it',
    ()=>{
        // Few records, 4 GiB of bytes: record 1's index entry is never
        // reused, while the count of bytes comes back round to where record 1
        // began. The bytes there now are a later record's, made to look like
        // record 1's header; the read must say record 1 is gone.
        const capacity = 1 << 20;
        const journal = openJournal(createJournalMemory({ records: 8192, bytes: capacity,
            shared: false }));
        journal.draft(8).setUint32(0, 100, true);
        journal.commit();
        journal.draft(8).setUint32(0, 123, true);
        const sequence = journal.commit();
        const read = ()=>journal.read(sequence, view=>view.getUint32(0, true));
        assert.equal(read(), 123);
        for (let n = 0; n < 4095; n++)
        {
            const draft = journal.draft(capacity - 8);
            // At record 1's place, past this record's own header: a header
            // naming record 1 and its value.
            draft.setUint32(8, 8, true);
            draft.setUint32(12, sequence, true);
            draft.setUint32(16, 999, true);
            journal.commit();
        }
        assert.equal(read(), undefined, 'written over');
        journal.draft(8).setUint32(0, 777, true);
        journal.commit();
        assert.equal(read(), undefined, 'and still gone once the count of bytes is back round');
        assert.equal(journal.read(journal.written() - 1, view=>view.getUint32(0, true)), 777,
            'the newest record read as it was');
    });

test('a record that starts before the wrap of the count of bytes before last is gone, though '
    + 'it starts just past the count', ()=>{
    // Record 0 starts 16 bytes short of 2^32 and ends on it; 4 GiB later the
    // count is round again, 16 bytes past where record 0 began, the record
    // ending there made to look like record 0 at its place. By the bytes
    // alone it starts after the count, as a record of the last wrap would.
    const capacity = 1 << 20;
    const memory = createJournalMemory({ records: 8192, bytes: capacity, shared: false });
    new Int32Array(memory.buffer)[HEAD_WORD] = -16;
    const journal = openJournal(memory);
    journal.draft(8).setUint32(0, 123, true);
    const sequence = journal.commit();
    const read = ()=>journal.read(sequence, view=>view.getUint32(0, true));
    assert.equal(read(), 123);
    for (let n = 0; n < 4096; n++)
    {
        const draft = journal.draft(capacity - 8);
        draft.setUint32(capacity - 24, 8, true);
        draft.setUint32(capacity - 20, sequence, true);
        draft.setUint32(capacity - 16, 999, true);
        journal.commit();
    }
    assert.equal(read(), undefined, 'two wraps ago');
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
