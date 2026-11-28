/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The speed gate: every workload of `bench-workloads.mjs` on this tree and
 * on the reference commit `bench/reference.json` names, on this machine, in
 * one run, the two alternated round by round so that what the machine does
 * meanwhile falls on both alike. A number of nanoseconds is the machine's;
 * which tree is slower on it is the code's. Each workload is judged alone:
 * slower where this tree's median is past every one of the reference's
 * rounds and by more than `SLOWER` - then measured again, twice the rounds,
 * and slower only where it is again. One slower fails the gate.
 *
 * A change slower on purpose (a check the code must make) moves the
 * reference to the commit that made it, its reason written beside it; a
 * change slower otherwise is not merged. The gate runs on the machine the
 * change is made on, before it is pushed (`npm run check`), not on CI's
 * shared runners, whose neighbours a gate of speed would measure.
 *
 *   node scripts/bench-gate.mjs [rounds]
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const here = new URL('..', import.meta.url).pathname;
const ROUNDS = Number(process.argv[2] ?? 7);
/** Slower by less than this is no slower, whatever the rounds say. */
const SLOWER = 0.03;

const reference = JSON.parse(readFileSync(join(here, 'bench/reference.json'), 'utf8'));
/** @type {string} */
let tree = '';
try
{
    tree = mkdtempSync(join(tmpdir(), 'cellar-reference-'));
    execFileSync('sh', ['-c', `git -C "${here}" archive ${reference.commit} src | tar -x -C "${tree}"`]);
}
catch (error)
{
    // No reference to weigh against is no answer, not a pass.
    console.error(`speed gate: not measured - the reference ${reference.commit} could not be read: ${error}`);
    process.exit(1);
}

/** @param {string} root @param {string[]} only @returns {Record<string, number>} */
const measure = (root, only)=>JSON.parse(execFileSync(process.execPath,
    [join(here, 'scripts/bench-workloads.mjs'), root, ...only], { encoding: 'utf8' }).trim().split('\n').at(-1) ?? '{}');

/** @param {number} rounds @param {string[]} only */
const rounds = (rounds, only)=>{
    /** @type {Record<string, { now: number[], reference: number[] }>} */
    const runs = {};
    for (let round = 0; round < rounds; round++)
    {
        const order = round % 2 === 0 ? [here, tree] : [tree, here];
        for (const root of order)
        {
            for (const [name, ns] of Object.entries(measure(root, only)))
            {
                (runs[name] ??= { now: [], reference: [] })[root === here ? 'now' : 'reference'].push(ns);
            }
        }
    }
    return runs;
};

/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];

/** @param {{ now: number[], reference: number[] }} runs */
const slower = runs=>median(runs.now) > Math.max(...runs.reference)
    && median(runs.now) > median(runs.reference) * (1 + SLOWER);

try
{
    const first = rounds(ROUNDS, []);
    const doubtful = Object.keys(first).filter(name=>slower(first[name]));
    const again = doubtful.length > 0 ? rounds(ROUNDS * 2, doubtful) : {};
    const failed = [];
    console.log(`speed gate: this tree against ${reference.commit} (${reference.reason}), ${ROUNDS} rounds`);
    for (const [name, runs] of Object.entries(first))
    {
        const second = again[name];
        const verdict = second === undefined ? 'ok' : slower(second) ? 'SLOWER' : 'ok, measured again';
        const shown = second ?? runs;
        const ratio = median(shown.now) / median(shown.reference);
        console.log(`  ${name.padEnd(28)} ${median(shown.now).toFixed(1).padStart(9)} ns`
            + `  reference ${median(shown.reference).toFixed(1).padStart(9)} ns  ${(ratio * 100 - 100).toFixed(1).padStart(6)}%`
            + `  ${verdict}`);
        if (verdict === 'SLOWER')
        {
            failed.push(name);
        }
    }
    if (failed.length > 0)
    {
        console.error(`speed gate: slower than the reference: ${failed.join(', ')}`);
        process.exitCode = 1;
    }
    else
    {
        console.log('speed gate: no workload slower than the reference');
    }
}
finally
{
    rmSync(tree, { recursive: true, force: true });
}
