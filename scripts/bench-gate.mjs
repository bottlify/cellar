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
 * slower where the lower quarter of this tree's rounds is above the upper
 * quarter of the reference's and the median by more than `SLOWER` - then
 * measured again, twice the rounds,
 * and slower only where it is again. One slower fails the gate. A workload
 * the machine moves more than the gate could tell (`RESOLUTION`) is said not
 * judged, by name, not passed.
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
/**
 * The most the middle half of the reference's own rounds may spread, a share
 * of their median, for a workload to be judged: past it the machine moves the
 * workload more than the gate could tell a change by (two threads' round
 * trip on a machine whose other work takes their cores), and the gate says
 * so rather than pass it.
 */
const RESOLUTION = 0.2;

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

/** The value a share `at` of the way up the sorted rounds. @param {number[]} values @param {number} at */
const quantile = (values, at)=>[...values].sort((a, b)=>a - b)[Math.round((values.length - 1) * at)];
/** @param {number[]} values */
const median = values=>quantile(values, 0.5);

/**
 * Slower: the lower quarter of this tree's rounds above the upper quarter of
 * the reference's, and the median by more than `SLOWER`. Quarters, not the
 * extremes: one round the machine held up, on either side, decides nothing.
 *
 * @param {{ now: number[], reference: number[] }} runs
 */
const slower = runs=>quantile(runs.now, 0.25) > quantile(runs.reference, 0.75)
    && median(runs.now) > median(runs.reference) * (1 + SLOWER);
/** How far the reference's middle half spreads, a share of its median. @param {{ reference: number[] }} runs */
const spreadOf = runs=>(quantile(runs.reference, 0.75) - quantile(runs.reference, 0.25)) / median(runs.reference);

try
{
    const first = rounds(ROUNDS, []);
    const doubtful = Object.keys(first).filter(name=>slower(first[name]));
    const again = doubtful.length > 0 ? rounds(ROUNDS * 2, doubtful) : {};
    const failed = [];
    const unjudged = [];
    console.log(`speed gate: this tree against ${reference.commit} (${reference.reason}), ${ROUNDS} rounds`);
    for (const [name, runs] of Object.entries(first))
    {
        const second = again[name];
        const shown = second ?? runs;
        const spread = spreadOf(shown);
        const verdict = spread > RESOLUTION ? `not judged: the reference moves ${(spread * 100).toFixed(0)}% here`
            : second === undefined ? 'ok' : slower(second) ? 'SLOWER' : 'ok, measured again';
        const ratio = median(shown.now) / median(shown.reference);
        console.log(`  ${name.padEnd(28)} ${median(shown.now).toFixed(1).padStart(9)} ns`
            + `  reference ${median(shown.reference).toFixed(1).padStart(9)} ns  ${(ratio * 100 - 100).toFixed(1).padStart(6)}%`
            + `  ${verdict}`);
        if (verdict === 'SLOWER')
        {
            failed.push(name);
        }
        else if (spread > RESOLUTION)
        {
            unjudged.push(name);
        }
    }
    if (unjudged.length > 0)
    {
        console.log(`speed gate: not judged on this machine now, its other work moving them: ${unjudged.join(', ')}`);
    }
    if (failed.length > 0)
    {
        console.error(`speed gate: slower than the reference: ${failed.join(', ')}`);
        process.exitCode = 1;
    }
    else
    {
        console.log(`speed gate: no workload judged slower than the reference`
            + ` (${Object.keys(first).length - unjudged.length} of ${Object.keys(first).length} judged)`);
    }
}
finally
{
    rmSync(tree, { recursive: true, force: true });
}
