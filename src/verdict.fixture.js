/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a case run on more than one host answers (`ordering.cases.fixture.js`,
 * `hosts.cases.fixture.js`): what it saw, and a failure or a reason it could
 * not answer. Each host turns it into its own pass, failure or skip; this is
 * node's.
 */

/** @typedef {{ said: string[], fail?: string, notMeasured?: string }} Verdict */

/**
 * Set where the machine is known to move plain accesses (CI's ARM64 jobs):
 * there "not measured" is a gate failing to see what it is for, not an
 * answer.
 */
export const MUST_MEASURE = typeof process === 'object' && process.env?.CELLAR_EXPECT_REORDERING === '1';

/**
 * A verdict as a node test: its diagnostics, then a failure, a skip, or a
 * failure where the machine must answer.
 *
 * @param {import('node:test').TestContext} t @param {Verdict} verdict
 */
export function judge(t, verdict){
    for (const line of verdict.said)
    {
        t.diagnostic(line);
    }
    if (verdict.fail !== undefined)
    {
        throw new Error(verdict.fail);
    }
    if (verdict.notMeasured !== undefined)
    {
        if (MUST_MEASURE)
        {
            throw new Error(`CELLAR_EXPECT_REORDERING is set: ${verdict.notMeasured}`);
        }
        t.skip(verdict.notMeasured);
    }
}
