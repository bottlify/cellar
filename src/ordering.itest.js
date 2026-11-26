/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The journal's copies are plain loads and stores held in order by an atomic
 * store and load on each side (docs/journal.md, "Memory ordering"). Whether
 * that holds is a question for the processor and the engine, not for this
 * code alone, so the gate asks the machine it runs on three things, each
 * with one writer and two readers racing for a while:
 *
 * - plain words and a plain flag, no atomic at all: does this machine move
 *   plain accesses here at all? On x86 it does not, and then the rest can
 *   show nothing; the gate says so rather than pass on it.
 * - a sequence check with no bracket, the copy the journal made before
 *   0.12.2: on a machine that moves loads, it hands on torn copies, which
 *   shows this gate can see what the bracket is for.
 * - the journal itself: it must never hand on a torn record, anywhere.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createJournalMemory } from './journal.js';

/** How long each shape races: enough on an M4 Pro for thousands of torn bare copies. */
const RACE_MS = 3000;
const READERS = 2;
/**
 * Set where the machine is known to move plain accesses (CI's ARM64 jobs):
 * there "not measured" is this gate failing to see what it is for, not an
 * answer.
 */
const MUST_MEASURE = process.env.CELLAR_EXPECT_REORDERING === '1';

/** Skips with `why`, or fails with it where the machine must answer. */
const notMeasured = (/** @type {import('node:test').TestContext} */ t, /** @type {string} */ why)=>{
    if (MUST_MEASURE)
    {
        assert.fail(`CELLAR_EXPECT_REORDERING is set: ${why}`);
    }
    t.skip(why);
};

/**
 * One writer and the readers of a shape over `memory`, for `RACE_MS`.
 *
 * @param {string} shape @param {unknown} memory
 * @returns {Promise<{ written: number, read: number, torn: number }>}
 */
async function race(shape, memory){
    const control = new SharedArrayBuffer(4);
    const start = (/** @type {string} */ role)=>new Promise((resolve, reject)=>{
        const worker = new Worker(new URL('./ordering.worker.fixture.js', import.meta.url),
            { workerData: { role, memory, control } });
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    const readers = Array.from({ length: READERS }, ()=>start(`${shape}Reader`));
    const writer = start(`${shape}Writer`);
    await new Promise(resolve=>setTimeout(resolve, RACE_MS));
    Atomics.store(new Int32Array(control), 0, 1);
    const [w, ...r] = /** @type {any[]} */ (await Promise.all([writer, ...readers]));
    return { written: w.written, read: r.reduce((n, x)=>n + x.read, 0), torn: r.reduce((n, x)=>n + x.torn, 0) };
}

test('the journal never hands on a torn record to readers racing its writer', { timeout: 60_000 }, async t=>{
    const journal = await race('journal', createJournalMemory({ records: 64, bytes: 1 << 12 }));
    t.diagnostic(`journal: ${journal.torn} torn of ${journal.read} records read, ${journal.written} written`);
    assert.ok(journal.read > 0, 'the readers read records');
    assert.equal(journal.torn, 0, 'no record handed on torn');
});

test('this machine tears unbracketed copies, so the journal\'s 0 above shows its bracket holding',
    { timeout: 60_000 }, async t=>{
    const plain = await race('plain', new SharedArrayBuffer(4096));
    t.diagnostic(`plain words: ${plain.torn} reordered of ${plain.read}`);
    if (plain.torn === 0)
    {
        notMeasured(t, 'not measured: this machine moved no plain access in the control (x86 does not), so '
            + 'the journal\'s 0 does not show its bracket is what holds it');
        return;
    }
    const bare = await race('bare', new SharedArrayBuffer(4096));
    t.diagnostic(`no bracket: ${bare.torn} torn of ${bare.read} copies kept`);
    if (bare.torn === 0)
    {
        notMeasured(t, `not measured: this machine reorders plain accesses, but no unbracketed copy tore in `
            + `${bare.read}`);
    }
});
