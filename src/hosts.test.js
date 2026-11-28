/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The host cases under node (`hosts.cases.fixture.js`), which
 * `scripts/browser-gate.mjs` runs in a browser as well.
 */

import { test } from 'node:test';
import { hostCases } from './hosts.cases.fixture.js';
import { judge } from './verdict.fixture.js';

for (const [name, body] of Object.entries(hostCases))
{
    test(name, async t=>{
        const verdict = await body();
        if (verdict.skip !== undefined)
        {
            t.skip(verdict.skip);
            return;
        }
        judge(t, verdict);
    });
}
