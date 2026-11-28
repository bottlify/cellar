/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gates whose answer depends on the engine, in a headless Chrome: the
 * ordering gate and its mutants (`src/ordering.cases.fixture.js`), and the
 * host cases (`src/hosts.cases.fixture.js`) on a page's own thread and in a
 * worker. The bodies are the ones node runs; this serves `src/` cross-origin
 * isolated (shared memory takes it), opens it in Chrome and drives the page
 * over the DevTools protocol, so the gate needs a Chrome and nothing else:
 * no package, no driver.
 *
 *   node scripts/browser-gate.mjs
 *
 * `CHROME` names the browser (by default the first of a few usual places);
 * `CELLAR_ORDERING_MS` how long each ordering shape races; and, as for
 * `ordering-mutants.mjs`, `CELLAR_EXPECT_REORDERING=1` says this machine
 * moves plain accesses, so "not measured" fails. The mutants run only where
 * the control tears, as in node. Exits 1 on any failure, a mutant that
 * survives where it must not, or a host case a worker skips.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostCases } from '../src/hosts.cases.fixture.js';
import { MUTANT_RACE_MS, RACE_MS, cutJournal, mutants, orderingCases } from '../src/ordering.cases.fixture.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mustMeasure = process.env.CELLAR_EXPECT_REORDERING === '1';
const raceMs = Number(process.env.CELLAR_ORDERING_MS ?? RACE_MS);

const CHROMES = [
    '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
const chrome = process.env.CHROME ?? CHROMES.find(path=>existsSync(path));
if (chrome === undefined)
{
    console.error(`browser gate: no Chrome found - set CHROME (looked in ${CHROMES.join(', ')})`);
    process.exit(1);
}

/**
 * The page and its worker: each runs one case of a cases module, by the
 * module's path, its export and the case's name, and answers its verdict.
 */
const RUN = `const run = async ({ module, cases, name, arg })=>(await import(module))[cases][name](arg);`;
const PAGE = `<!doctype html><meta charset="utf-8"><title>Cellar browser gate</title><script type="module">
${RUN}
window.gate = (task, inWorker)=>!inWorker ? run(task) : new Promise((resolve, reject)=>{
    const worker = new Worker('/gate.worker.js', { type: 'module' });
    worker.onmessage = ({ data })=>{
        worker.terminate();
        data.error === undefined ? resolve(data.verdict) : reject(new Error(data.error));
    };
    worker.onerror = event=>reject(new Error(event.message));
    worker.postMessage(task);
});
</script>`;
const WORKER = `${RUN}
self.onmessage = async ({ data })=>{
    try { postMessage({ verdict: await run(data) }); }
    catch (e) { postMessage({ error: String(e?.stack ?? e) }); }
};`;

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
/** `/src/<file>`, or `/mutant/<n>/<file>`: `src/` with the journal of mutant n. */
const server = createServer((request, response)=>{
    const path = new URL(request.url ?? '/', 'http://here').pathname;
    const mutant = /^\/mutant\/(\d+)\//.exec(path);
    const file = mutant ? normalize(path.slice(mutant[0].length)) : normalize(path.slice('/src/'.length));
    /** @type {string | undefined} */
    let body;
    if (path === '/')
    {
        body = PAGE;
    }
    else if (path === '/gate.worker.js')
    {
        body = WORKER;
    }
    else if ((mutant || path.startsWith('/src/')) && !file.startsWith('..') && existsSync(join(root, 'src', file)))
    {
        body = readFileSync(join(root, 'src', file), 'utf8');
        body = mutant && file === 'journal.js' ? cutJournal(body, mutants[Number(mutant[1])]) : body;
    }
    response.writeHead(body === undefined ? 404 : 200, {
        'content-type': path === '/' ? TYPES['.html'] : TYPES['.js'],
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cache-control': 'no-store',
    });
    response.end(body ?? 'not here');
});
await new Promise(resolve=>server.listen(0, '127.0.0.1', ()=>resolve(null)));
const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

const profile = mkdtempSync(join(os.tmpdir(), 'cellar-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', ...process.getuid?.() === 0 ? ['--no-sandbox'] : [], `${origin}/`],
{ stdio: ['ignore', 'ignore', 'pipe'] });
const started = performance.now();
let failures = 0;
try
{
    const endpoint = await new Promise((resolve, reject)=>{
        let said = '';
        browser.stderr.on('data', chunk=>{
            said += chunk;
            const found = /DevTools listening on (ws:\/\/\S+)/.exec(said);
            if (found)
            {
                resolve(found[1]);
            }
        });
        browser.once('exit', code=>reject(new Error(`browser gate: ${chrome} exited (${code}): ${said}`)));
    });
    const { host } = new URL(endpoint);
    const page = await waitForPage(host);
    const version = await (await fetch(`http://${host}/json/version`)).json();
    console.log(`browser gate: ${version.Browser} on ${os.platform()} ${os.arch()}, ${raceMs} ms a race`);
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp('Runtime.enable');
    /**
     * One case's verdict, on the page or in a worker.
     *
     * @param {{ module: string, cases: string, name: string, arg?: unknown }} task @param {boolean} inWorker
     * @returns {Promise<{ said: string[], fail?: string, notMeasured?: string, skip?: string }>}
     */
    const gate = async(task, inWorker)=>{
        for (let tries = 0; ; tries++)
        {
            const got = await cdp('Runtime.evaluate', { expression: `window.gate(${JSON.stringify(task)}, ${inWorker})`,
                awaitPromise: true, returnByValue: true });
            if (!got.exceptionDetails)
            {
                return got.result.value;
            }
            // The page's module may not have run yet: window.gate is not there.
            if (tries < 50 && /window\.gate is not a function/.test(got.exceptionDetails.exception?.description ?? ''))
            {
                await new Promise(resolve=>setTimeout(resolve, 100));
                continue;
            }
            return { said: [], fail: `threw: ${got.exceptionDetails.exception?.description ?? got.exceptionDetails.text}` };
        }
    };
    const report = (/** @type {string} */ name, /** @type {string} */ where, /** @type {any} */ verdict,
        /** @type {boolean} */ mayLeave)=>{
        const left = verdict.notMeasured ?? verdict.skip;
        const failed = verdict.fail !== undefined || left !== undefined && !mayLeave;
        failures += failed ? 1 : 0;
        const how = verdict.fail !== undefined ? `FAIL: ${verdict.fail}` : left !== undefined
            ? `${failed ? 'FAIL, ' : ''}skip: ${left}` : 'pass';
        console.log(`  ${where}: ${name}: ${how}${verdict.said.length ? ` (${verdict.said.join('; ')})` : ''}`);
        return verdict;
    };

    console.log('ordering, on the page:');
    const ordering = { module: '/src/ordering.cases.fixture.js', cases: 'orderingCases' };
    const [journalCase, controlCase] = Object.keys(orderingCases);
    report(journalCase, 'page', await gate({ ...ordering, name: journalCase, arg: raceMs }, false), true);
    const control = report(controlCase, 'page', await gate({ ...ordering, name: controlCase, arg: raceMs }, false),
        !mustMeasure);

    console.log(`ordering mutants, ${MUTANT_RACE_MS} ms a race:`);
    if (control.notMeasured !== undefined)
    {
        console.log('  not measured - this machine does not tear unbracketed copies here');
    }
    else
    {
        for (const [n, mutant] of mutants.entries())
        {
            const verdict = await gate({ module: `/mutant/${n}/ordering.cases.fixture.js`, cases: 'orderingCases',
                name: journalCase, arg: MUTANT_RACE_MS }, false);
            const killed = verdict.fail !== undefined;
            failures += !killed && mutant.required ? 1 : 0;
            console.log(`  ${mutant.name}: ${killed ? 'killed' : mutant.required ? 'SURVIVED' : 'survived (not required)'}`
                + ` (${verdict.said.join('; ')})`);
        }
    }

    console.log('hosts, on the page and in a worker:');
    const hosts = { module: '/src/hosts.cases.fixture.js', cases: 'hostCases' };
    for (const name of Object.keys(hostCases))
    {
        report(name, 'page', await gate({ ...hosts, name }, false), true);
        // A worker has every part a case asks for: a skip there is the case not run.
        report(name, 'worker', await gate({ ...hosts, name }, true), false);
    }
}
catch (e){
    console.error(`browser gate: ${/** @type {Error} */ (e).stack ?? e}`);
    failures++;
}
finally
{
    browser.kill();
    server.close();
    await new Promise(resolve=>setTimeout(resolve, 200));
    rmSync(profile, { recursive: true, force: true });
}
console.log(`browser gate: ${failures === 0 ? 'passed' : `${failures} failed`} in `
    + `${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(failures === 0 ? 0 : 1);

/**
 * The page Chrome opened, once it is listed.
 *
 * @param {string} host
 * @returns {Promise<{ webSocketDebuggerUrl: string }>}
 */
async function waitForPage(host){
    for (let tries = 0; tries < 100; tries++)
    {
        const targets = await (await fetch(`http://${host}/json/list`)).json();
        const page = targets.find((/** @type {any} */ target)=>target.type === 'page' && target.url.startsWith(origin));
        if (page)
        {
            return page;
        }
        await new Promise(resolve=>setTimeout(resolve, 100));
    }
    throw new Error('browser gate: the page did not open');
}

/**
 * A DevTools protocol session over `url`: a call answers its result, or
 * throws the protocol's error.
 *
 * @param {string} url
 * @returns {Promise<(method: string, params?: object) => Promise<any>>}
 */
async function connect(url){
    const socket = new WebSocket(url);
    await new Promise((resolve, reject)=>{
        socket.onopen = resolve;
        socket.onerror = ()=>reject(new Error(`browser gate: no DevTools session at ${url}`));
    });
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    const waiting = new Map();
    socket.onmessage = ({ data })=>{
        const message = JSON.parse(String(data));
        if (message.method === 'Runtime.exceptionThrown')
        {
            console.error(`  page: ${message.params.exceptionDetails.exception?.description
                ?? message.params.exceptionDetails.text}`);
        }
        const call = waiting.get(message.id);
        waiting.delete(message.id);
        message.error ? call?.reject(new Error(message.error.message)) : call?.resolve(message.result);
    };
    let id = 0;
    return (method, params = {})=>new Promise((resolve, reject)=>{
        waiting.set(++id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}
