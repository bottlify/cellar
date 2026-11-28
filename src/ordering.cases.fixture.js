/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ordering gate's bodies, one copy for both hosts: node's `node:test`
 * (`ordering.itest.js`, `scripts/ordering-mutants.mjs`) and a cross-origin
 * isolated page in a browser (`scripts/browser-gate.mjs`), whose engine may
 * move what node's does not. The journal's copies are plain loads and stores
 * held in order by an atomic store and load on each side (docs/journal.md,
 * "Memory ordering"). Whether that holds is a question for the processor and
 * the engine, not for this code alone, so the gate asks the machine three
 * things, each with one writer and two readers racing for a while:
 *
 * - plain words and a plain flag, no atomic at all: does this machine move
 *   plain accesses here at all? On x86 it does not, and then the rest can
 *   show nothing; the gate says so rather than pass on it.
 * - a sequence check with no bracket, the copy the journal made before
 *   0.12.2: on a machine that moves loads, it hands on torn copies, which
 *   shows this gate can see what the bracket is for.
 * - the journal itself: it must never hand on a torn record, anywhere.
 *
 * A case answers `{ said, fail?, notMeasured? }` and each host turns that
 * into its own pass, failure or skip.
 */

import { createJournalMemory } from './journal.js';

/** @typedef {import('./verdict.fixture.js').Verdict} Verdict */

/**
 * How long each shape races by default: 3 s, enough on an M4 Pro for
 * thousands of torn bare copies. The mutants run it longer: a macOS runner
 * tore a journal with no bracket 3 times in one 3 s race, 3,303 in another.
 */
export const RACE_MS = 3000;
/** How long a mutant's race runs. */
export const MUTANT_RACE_MS = 10_000;
const READERS = 2;

/**
 * The journal with its bracket taken out, on each side and on both: the
 * lines cut from `journal.js`. The journal without its bracket must be
 * killed; one side alone is reported, not required, since which side a
 * machine tears without depends on the machine (docs/journal.md).
 */
export const mutants = [
    { name: 'no bracket', cut: ['reader', 'writer'], required: true },
    { name: 'no reader side', cut: ['reader'], required: false },
    { name: 'no writer side', cut: ['writer'], required: false },
];
/** @type {Record<string, string>} */
const SIDES = {
    reader: '            Atomics.store(this.#ownWord, 0, 0);\n',
    writer: '            Atomics.load(words, HEAD);\n',
};

/**
 * `journal.js`'s source with `mutant`'s sides cut; throws where a side is
 * not there any more, so a mutant is never the journal as it is.
 *
 * @param {string} code @param {{ cut: string[] }} mutant
 */
export function cutJournal(code, mutant){
    for (const side of mutant.cut)
    {
        if (!code.includes(SIDES[side]))
        {
            throw new Error(`ordering mutants: "${SIDES[side].trim()}" is not in journal.js any more - `
                + 'the mutant cuts what is not there');
        }
        code = code.replace(SIDES[side], '');
    }
    return code;
}

const NODE = typeof process === 'object' && Boolean(process.versions?.node);
const WORKER = new URL('./ordering.worker.fixture.js', import.meta.url);

/**
 * One thread of a race, its answer when it stops: a node worker, or a
 * browser's module worker.
 *
 * @param {{ role: string, memory: unknown, control: SharedArrayBuffer }} data
 * @returns {Promise<any>}
 */
async function start(data){
    if (NODE)
    {
        const { Worker } = await import('node:worker_threads');
        return new Promise((resolve, reject)=>{
            const worker = new Worker(WORKER, { workerData: data });
            worker.once('message', resolve);
            worker.once('error', reject);
        });
    }
    return new Promise((resolve, reject)=>{
        const worker = new Worker(WORKER, { type: 'module' });
        worker.onmessage = ({ data: answer })=>{
            worker.terminate();
            resolve(answer);
        };
        worker.onerror = event=>reject(new Error(`ordering worker: ${event.message}`));
        worker.postMessage(data);
    });
}

/**
 * One writer and the readers of a shape over `memory`, for `ms`.
 *
 * @param {string} shape @param {unknown} memory @param {number} ms
 * @returns {Promise<{ written: number, read: number, torn: number }>}
 */
async function race(shape, memory, ms){
    const control = new SharedArrayBuffer(4);
    const readers = Array.from({ length: READERS }, ()=>start({ role: `${shape}Reader`, memory, control }));
    const writer = start({ role: `${shape}Writer`, memory, control });
    await new Promise(resolve=>setTimeout(resolve, ms));
    Atomics.store(new Int32Array(control), 0, 1);
    const [w, ...r] = await Promise.all([writer, ...readers]);
    return { written: w.written, read: r.reduce((n, x)=>n + x.read, 0), torn: r.reduce((n, x)=>n + x.torn, 0) };
}

/** The cases, by name: each races for `ms`. @type {Record<string, (ms: number) => Promise<Verdict>>} */
export const orderingCases = {
    async 'the journal never hands on a torn record to readers racing its writer'(ms){
        const journal = await race('journal', createJournalMemory({ records: 64, bytes: 1 << 12 }), ms);
        const said = [`journal: ${journal.torn} torn of ${journal.read} records read, ${journal.written} written`];
        return { said, fail: journal.read === 0 ? 'the readers read no record'
            : journal.torn > 0 ? `${journal.torn} records handed on torn` : undefined };
    },
    async 'this machine tears unbracketed copies, so the journal\'s 0 above shows its bracket holding'(ms){
        const plain = await race('plain', new SharedArrayBuffer(4096), ms);
        const said = [`plain words: ${plain.torn} reordered of ${plain.read}`];
        if (plain.torn === 0)
        {
            return { said, notMeasured: 'not measured: this machine moved no plain access in the control (x86 '
                + 'does not), so the journal\'s 0 does not show its bracket is what holds it' };
        }
        const bare = await race('bare', new SharedArrayBuffer(4096), ms);
        said.push(`no bracket: ${bare.torn} torn of ${bare.read} copies kept`);
        return bare.torn > 0 ? { said } : { said, notMeasured: 'not measured: this machine reorders plain '
            + `accesses, but no unbracketed copy tore in ${bare.read}` };
    },
};
