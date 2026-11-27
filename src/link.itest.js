/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The link's gates. Trees of calls made from seeds cross two threads - each
 * call answered while the side that answers it waits on a call of its own,
 * values, failures, word calls and values in parts - and every answer, and the
 * order each side answered in, is held to the tree answered in one thread
 * (`link-gate.fixture.js`). And word calls handed back and forth thousands of
 * times wake the other side only when it sleeps, and lose no wake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { handlersOf, reference, treeOf } from './link-gate.fixture.js';
import { createLinkMemory, openLink } from './link.js';

const WORKER = new URL('./link.worker.fixture.js', import.meta.url);
const SEEDS = 24;

/** @param {Worker} worker @returns {Promise<any>} */
const resultOf = worker=>new Promise((resolve, reject)=>{
    worker.once('message', resolve);
    worker.once('error', reject);
});

/** What the tree of `seed` is to answer, as JSON compares it. @param {number} seed @param {boolean} wordsFromB */
const expected = (seed, wordsFromB)=>{
    const { root } = treeOf(seed, wordsFromB);
    const { answer, log } = reference(root);
    return { answer: { value: JSON.parse(JSON.stringify(answer)) }, log };
};

test('trees of calls between two blocking threads are answered as in one thread, in its order',
    { timeout: 300_000 }, async()=>{
        for (let seed = 1; seed <= SEEDS; seed++)
        {
            const { a, b } = createLinkMemory({ capacity: 16 * 1024 });
            const sideB = new Worker(WORKER, { workerData: { role: 'b', end: a, seed, wordsFromB: true } });
            const served = resultOf(sideB);
            const sideA = new Worker(WORKER, { workerData: { role: 'a', end: b, seed, wordsFromB: true } });
            const asked = await resultOf(sideA);
            const { log } = await served;
            const want = expected(seed, true);
            assert.deepEqual(asked.answer, want.answer, `seed ${seed}: the root's answer`);
            assert.deepEqual(asked.log, want.log.a, `seed ${seed}: what A answered, in order`);
            assert.deepEqual(log, want.log.b, `seed ${seed}: what B answered, in order`);
            await Promise.all([sideA.terminate(), sideB.terminate()]);
        }
    });

test('trees of calls between a blocking thread and one serving on its event loop are answered as'
    + ' in one thread', { timeout: 300_000 }, async()=>{
    for (let seed = 101; seed <= 100 + SEEDS; seed++)
    {
        const { a, b } = createLinkMemory({ capacity: 16 * 1024 });
        const { nodes } = treeOf(seed, false);
        /** @type {number[]} */
        const log = [];
        /** @type {any} */
        let link = null;
        const { handlers, words } = handlersOf(nodes, ()=>link, log, false);
        link = openLink(a, handlers, { words });
        const serving = link.serve();
        const sideA = new Worker(WORKER, { workerData: { role: 'a', end: b, seed, wordsFromB: false } });
        const asked = await resultOf(sideA);
        await serving;
        const want = expected(seed, false);
        assert.deepEqual(asked.answer, want.answer, `seed ${seed}: the root's answer`);
        assert.deepEqual(asked.log, want.log.a, `seed ${seed}: what A answered, in order`);
        assert.deepEqual(log, want.log.b, `seed ${seed}: what B answered, in order`);
        await sideA.terminate();
    }
});

/**
 * Hands `rounds` word calls to a worker and takes their answers, each side
 * looking `…Ms` before it sleeps.
 *
 * @param {number} rounds @param {number} mineMs @param {number} theirsMs
 */
async function handTurns(rounds, mineMs, theirsMs){
    const { a, b } = createLinkMemory({ capacity: 4096, words: 1 });
    const link = openLink(a, {}, { spinMs: mineMs });
    const worker = new Worker(WORKER, { workerData: { role: 'words', end: b, rounds, spinMs: theirsMs } });
    const theirs = resultOf(worker);
    const began = performance.now();
    for (let round = 0; round < rounds; round++)
    {
        link.request[0] = round;
        link.sendWords();
        link.waitWords();
        assert.equal(link.answer[0], round + 1, `round ${round}`);
    }
    const counts = await theirs;
    const elapsedMs = performance.now() - began;
    await worker.terminate();
    const sleeps = new Int32Array(a.in.bell.buffer)[a.in.bell.index + 1];
    assert.equal(sleeps, 0, 'no sleeper left counted');
    return { mine: link.diagnostics(), theirs: counts, elapsedMs };
}

/**
 * What holds of a hand-over whatever the load: no side sleeps before it has
 * looked `…Ms` (so its sleeps fit in the time the run took), and no side
 * notifies the other more often than the other slept.
 *
 * @param {Awaited<ReturnType<typeof handTurns>>} run @param {number} mineMs @param {number} theirsMs
 */
function assertLooksFirst(run, mineMs, theirsMs){
    const said = JSON.stringify(run);
    if (mineMs > 0)
    {
        assert.ok(run.mine.slept <= run.elapsedMs / mineMs, `a sleep with no look before it: ${said}`);
    }
    if (theirsMs > 0)
    {
        assert.ok(run.theirs.slept <= run.elapsedMs / theirsMs, `a sleep with no look before it: ${said}`);
    }
    assert.ok(run.mine.woke <= run.theirs.slept, `a notify with nobody asleep: ${said}`);
    assert.ok(run.theirs.woke <= run.mine.slept, `a notify with nobody asleep: ${said}`);
}

test('a word call answered while the other side looks wakes nothing, and one it sleeps through'
    + ' wakes it', { timeout: 120_000 }, async()=>{
    // Both always asleep by the other's turn: every turn wakes the other, or
    // the hand-over would stop for good.
    const asleep = await handTurns(2000, 0, 0);
    assert.equal(asleep.mine.sent, 2000);
    assert.equal(asleep.theirs.sent, 2000);
    assert.ok(asleep.mine.slept > 0 && asleep.theirs.slept > 0, JSON.stringify(asleep));
    assert.ok(asleep.mine.woke > 0 && asleep.theirs.woke > 0, JSON.stringify(asleep));
    // Both looking longer than the other takes: a side sleeps only after a
    // whole look, and is notified only when it sleeps, however long a loaded
    // machine keeps the other off its core.
    assertLooksFirst(await handTurns(2000, 1000, 1000), 1000, 1000);
    // One sleeping, one looking: the sleeper is woken.
    const mixed = await handTurns(2000, 1000, 0);
    assertLooksFirst(mixed, 1000, 0);
    assert.ok(mixed.mine.woke > 0, JSON.stringify(mixed));
});
