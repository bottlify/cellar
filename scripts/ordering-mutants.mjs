/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether the ordering gate can fail: the journal with its bracket taken
 * out, on each side and on both, run under the gate's first test. A mutant
 * the gate lets through is a bracket the gate does not hold the journal to.
 * Only a machine that moves plain accesses can kill one (ARM64; x86 lets
 * every one through), so off such a machine this says "not measured" and
 * exits 0, unless CELLAR_EXPECT_REORDERING=1 says the machine must answer.
 *
 *   node scripts/ordering-mutants.mjs
 *
 * The mutants and the bodies they run under are the ones
 * `scripts/browser-gate.mjs` runs in a browser (`ordering.cases.fixture.js`).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANT_RACE_MS, cutJournal, mutants } from '../src/ordering.cases.fixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mustMeasure = process.env.CELLAR_EXPECT_REORDERING === '1';

/** Runs the gate's first test over `src` as given; whether it failed, and its diagnostics. */
const gate = (/** @type {string} */ src)=>{
    const got = spawnSync(process.execPath, ['--test', '--test-reporter=spec',
        '--test-name-pattern=never hands on a torn', join(src, 'ordering.itest.js')],
    { encoding: 'utf8', timeout: 120_000, env: { ...process.env, CELLAR_ORDERING_MS: String(MUTANT_RACE_MS) } });
    const lines = (got.stdout + got.stderr).split('\n').filter(line=>/journal: |plain words: /.test(line));
    return { failed: got.status !== 0, said: lines.map(line=>line.trim()).join('; ') };
};

const control = spawnSync(process.execPath, ['--test', '--test-reporter=spec',
    '--test-name-pattern=this machine tears', join(root, 'src', 'ordering.itest.js')], { encoding: 'utf8',
    timeout: 120_000, env: { ...process.env, CELLAR_EXPECT_REORDERING: '' } });
if (/# not measured/.test(control.stdout))
{
    console.log('ordering mutants: not measured - this machine does not tear unbracketed copies');
    process.exit(mustMeasure ? 1 : 0);
}

let survived = 0;
for (const mutant of mutants)
{
    const stage = mkdtempSync(join(os.tmpdir(), 'cellar-mutant-'));
    const src = join(stage, 'src');
    cpSync(join(root, 'src'), src, { recursive: true });
    writeFileSync(join(src, 'journal.js'), cutJournal(readFileSync(join(src, 'journal.js'), 'utf8'), mutant));
    const { failed, said } = gate(src);
    rmSync(stage, { recursive: true, force: true });
    const verdict = failed ? 'killed' : mutant.required ? 'SURVIVED' : 'survived (not required)';
    console.log(`ordering mutants: ${mutant.name}: ${verdict} (${said})`);
    survived += !failed && mutant.required ? 1 : 0;
}
process.exit(survived === 0 ? 0 : 1);
