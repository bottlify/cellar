/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Draws the README's charts into docs/: bars of what the examples measured,
 * each pair postMessage against Cellar. The numbers are the README's tables
 * (`examples/call-a-worker.mjs`, `examples/memory.mjs`, `examples/ring.mjs`,
 * node 22, a 4-core x86 VM, medians of 3 runs); measured again, they are
 * changed here and in the tables together.
 *
 *   node scripts/charts.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DOCS = join(ROOT, 'docs');

/**
 * @typedef {Object} Pair
 * @property {string} what
 * @property {number} plain  postMessage's
 * @property {number} cellar
 */

/** @param {string} text */
const escape = text=>text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * A chart of pairs of bars, each pair on its own scale, the ratio beside it.
 *
 * @param {{ title: string, note: string, unit: string, pairs: Pair[], better: string }} chart
 */
function chartOf({ title, note, unit, pairs, better }){
    const width = 720;
    const left = 120;
    const barMax = 470;
    const rowHeight = 28;
    const heading = 26;
    const pairGap = 16;
    const top = 72;
    const pairHeight = heading + 2 * rowHeight + pairGap;
    const height = top + pairs.length * pairHeight;
    /** @type {string[]} */
    const parts = [];
    pairs.forEach((pair, index)=>{
        const y = top + index * pairHeight;
        const scale = Math.max(pair.plain, pair.cellar);
        const ratio = pair.cellar === 0 ? `${pair.plain} to 0`
            : pair.plain >= pair.cellar ? `${(pair.plain / pair.cellar).toFixed(pair.plain / pair.cellar >= 10 ? 0 : 1)}x less`
                : `${(pair.cellar / pair.plain).toFixed(1)}x more`;
        parts.push(`<text class="what" x="16" y="${y + 16}">${escape(pair.what)}`
            + `<tspan class="ratio" dx="10">${escape(ratio)}</tspan></text>`);
        [['postMessage', pair.plain, 'plain'], ['Cellar', pair.cellar, 'cellar']]
            .forEach(([name, value, kind], row)=>{
                const barY = y + heading + row * rowHeight;
                const length = Math.max(2, Math.round(barMax * Number(value) / scale));
                parts.push(`<text class="arm" x="${left - 8}" y="${barY + 16}" text-anchor="end">${name}</text>`);
                parts.push(`<rect class="${kind}" x="${left}" y="${barY}" width="${length}" height="${rowHeight - 10}" rx="3"/>`);
                parts.push(`<text class="value" x="${left + length + 8}" y="${barY + 16}">${value} ${escape(unit)}</text>`);
            });
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(title)}">
<style>
  .bg { fill: #ffffff; } .title { fill: #1c2421; font: 600 17px system-ui, sans-serif; }
  .note, .arm, .ratio { fill: #5d6a65; font: 13px system-ui, sans-serif; }
  .what { fill: #1c2421; font: 600 14px system-ui, sans-serif; }
  .value { fill: #1c2421; font: 13px ui-monospace, monospace; }
  .plain { fill: #a3aaa6; } .cellar { fill: #0f7a5c; }
  @media (prefers-color-scheme: dark) {
    .bg { fill: #0d1117; } .title, .what, .value { fill: #e4ebe7; }
    .note, .arm, .ratio { fill: #93a39c; } .plain { fill: #4b5551; } .cellar { fill: #43c59b; }
  }
</style>
<rect class="bg" width="100%" height="100%" rx="8"/>
<text class="title" x="16" y="30">${escape(title)}</text>
<text class="note" x="16" y="52">${escape(note)} · ${escape(better)}</text>
${parts.join('\n')}
</svg>
`;
}

await mkdir(DOCS, { recursive: true });
await writeFile(join(DOCS, 'latency.svg'), chartOf({
    title: 'A round trip between two threads',
    note: 'node 22, a 4-core x86 VM, medians of 3 runs',
    better: 'lower is better',
    unit: 'us',
    pairs: [
        { what: 'A small call', plain: 40, cellar: 2.1 },
        { what: 'An event and its answer', plain: 50, cellar: 1.6 },
    ],
}));
await writeFile(join(DOCS, 'memory.svg'), chartOf({
    title: 'Summing 8 MiB of samples in a worker, 200 times',
    note: 'node 22, a 4-core x86 VM, medians of 3 runs',
    better: 'lower is better',
    unit: '',
    pairs: [
        { what: 'Peak resident (MiB)', plain: 140, cellar: 77 },
        { what: 'Worker collections', plain: 52, cellar: 0 },
        { what: 'Time a sum (ms)', plain: 5.6, cellar: 1.3 },
    ],
}));
console.log('charts: docs/latency.svg, docs/memory.svg');
