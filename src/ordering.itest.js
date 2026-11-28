/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ordering gate under node: the cases of `ordering.cases.fixture.js`,
 * which `scripts/browser-gate.mjs` runs in a browser as well.
 * `CELLAR_ORDERING_MS` sets how long each shape races.
 */

import { test } from 'node:test';
import { RACE_MS, orderingCases } from './ordering.cases.fixture.js';
import { judge } from './verdict.fixture.js';

const ms = Number(process.env.CELLAR_ORDERING_MS ?? RACE_MS);

for (const [name, body] of Object.entries(orderingCases))
{
    test(name, { timeout: 60_000 }, async t=>judge(t, await body(ms)));
}
