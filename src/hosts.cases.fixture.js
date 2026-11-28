/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a browser answers otherwise than node, for the platform calls
 * Cellar makes over shared memory: one copy of each case for both hosts,
 * run by `hosts.test.js` under node and by `scripts/browser-gate.mjs` on a
 * page's own thread and in a worker. Measured in Chrome 158, 2026-11-28:
 * `TextEncoder.encodeInto` and `TextDecoder.decode` refuse a view of a
 * `SharedArrayBuffer` (node takes one), `Atomics.wait` throws on a page's
 * own thread, and OPFS's synchronous handles read and write shared views.
 * Cellar hands no shared view to `crypto.subtle`, a `Blob` or `postMessage`.
 *
 * A case answers a verdict (`verdict.fixture.js`); `skip` is a case this
 * thread has no part in (no OPFS under node, none on a page's own thread).
 */

import { createDoorbell, mayWait, openDoorbell } from './bell.js';
import { bodyOf, cacheOf } from './cache.fixture.js';
import { F_ONLY_COPY } from './shared.js';
import { readText, writeText } from './text.js';

/** @typedef {import('./verdict.fixture.js').Verdict & { skip?: string }} HostVerdict */

/** A page's own thread: the one that may not block. */
const PAGE = typeof window === 'object';

/** @param {Uint8Array} a @param {Uint8Array} b */
const same = (a, b)=>a.length === b.length && a.every((x, i)=>x === b[i]);

/** Whether `call` refuses a view of shared memory here. @param {(view: Uint8Array) => unknown} call */
const refuses = call=>{
    try
    {
        call(new Uint8Array(new SharedArrayBuffer(8)));
        return false;
    }
    catch {
        return true;
    }
};

/** @type {Record<string, () => Promise<HostVerdict>>} */
export const hostCases = {
    async 'text in shared memory is written and read where it lies, as TextEncoder makes it'(){
        const said = [`this host's own encodeInto ${refuses(view=>new TextEncoder().encodeInto('é', view))
            ? 'refuses' : 'takes'} a shared view, its decode ${refuses(view=>new TextDecoder().decode(view))
            ? 'refuses' : 'takes'} one`];
        const bytes = new Uint8Array(new SharedArrayBuffer(64));
        for (const text of ['names/ascii', 'texels/é/ünï', '名前/𝄞', 'lone \uD800 and \uDC00'])
        {
            const want = new TextEncoder().encode(text);
            const written = writeText(bytes, 3, text);
            if (!same(bytes.subarray(3, 3 + written), want))
            {
                return { said, fail: `"${text}" written as ${[...bytes.subarray(3, 3 + written)]}, not ${[...want]}` };
            }
            const back = readText(bytes, 3, written);
            if (back !== new TextDecoder().decode(want))
            {
                return { said, fail: `"${text}" read back as "${back}"` };
            }
        }
        const cut = writeText(bytes, 0, 'abéé', 5);
        return cut === 4 ? { said } : { said, fail: `text past its room cut at ${cut} bytes, not 4` };
    },
    async 'a doorbell wakes a wait on the event loop, with Atomics.waitAsync and without, and blocks only where it may'(){
        const said = [`Atomics.waitAsync is ${typeof (/** @type {any} */ (Atomics).waitAsync)}, mayWait() ${mayWait()}`];
        if (mayWait() === PAGE)
        {
            return { said, fail: `mayWait() is ${mayWait()} on ${PAGE ? 'a page\'s own thread' : 'a thread that may block'}` };
        }
        const atomics = /** @type {any} */ (Atomics);
        const waitAsync = atomics.waitAsync;
        for (const without of [false, true])
        {
            const bell = openDoorbell(createDoorbell());
            const seen = bell.seen();
            if (without)
            {
                delete atomics.waitAsync;
            }
            try
            {
                setTimeout(()=>bell.ring(), 5);
                const end = await bell.waitAsync(seen, 2000);
                if (end !== 'woke' && end !== 'moved')
                {
                    return { said, fail: `a wait ${without ? 'without' : 'with'} Atomics.waitAsync ended ${end}` };
                }
            }
            finally
            {
                atomics.waitAsync = waitAsync;
            }
        }
        const bell = openDoorbell(createDoorbell());
        /** @type {string} */
        let blocked;
        try
        {
            blocked = bell.wait(bell.seen(), 1, 0);
        }
        catch (e){
            blocked = `throws ${/** @type {Error} */ (e).name}`;
        }
        said.push(`a blocking wait here: ${blocked}`);
        const want = PAGE ? 'throws TypeError' : 'timed-out';
        return blocked === want ? { said } : { said, fail: `a blocking wait here ended "${blocked}", not "${want}"` };
    },
    async 'the keeper\'s disk over OPFS synchronous handles takes the shared views it writes and reads'(){
        const storage = typeof navigator === 'object' ? navigator.storage : undefined;
        if (typeof storage?.getDirectory !== 'function')
        {
            return { said: [], skip: 'no OPFS here' };
        }
        if (typeof (/** @type {any} */ (globalThis).FileSystemSyncAccessHandle) !== 'function')
        {
            return { said: [], skip: 'no OPFS synchronous handles on this thread (a worker has them)' };
        }
        const root = await storage.getDirectory();
        const name = `cellar-gate-${Math.random().toString(36).slice(2)}`;
        const dir = await root.getDirectoryHandle(name, { create: true });
        const { keeper, reader, step } = await cacheOf({
            disk: {
                open: async file=>/** @type {any} */ (await dir.getFileHandle(file, { create: true }))
                    .createSyncAccessHandle(),
                remove: file=>dir.removeEntry(file),
            },
        });
        /** @type {HostVerdict} */
        let verdict;
        try
        {
            const body = bodyOf(5000, 7);
            reader.put('doc', body, F_ONLY_COPY);
            // Idle past coldAfterMs, it goes once the keeper's first pack is
            // open: opening one on OPFS answers a promise some turns later.
            for (let tries = 0; tries < 100 && reader.look('doc') === 'hot'; tries++)
            {
                await new Promise(resolve=>setTimeout(resolve, 20));
                step(1000);
            }
            const look = reader.look('doc');
            const back = reader.with('doc', got=>got.slice(), { wait: true });
            const said = [`idle, the body was ${look}; read back ${back?.length ?? 'nothing'}`];
            verdict = look === 'cold' && back !== undefined && same(back, body) ? { said }
                : { said, fail: 'the only copy did not go to OPFS and come back whole' };
        }
        finally
        {
            keeper.close();
        }
        // The pack opened ahead is let go of once its opening answers: until
        // then the directory is not to be removed.
        for (let tries = 0; ; tries++)
        {
            try
            {
                await root.removeEntry(name, { recursive: true });
                return verdict;
            }
            catch (e){
                if (tries === 50)
                {
                    return { said: verdict.said, fail: `a file the closed keeper kept open: ${e}` };
                }
                await new Promise(resolve=>setTimeout(resolve, 20));
            }
        }
    },
};
