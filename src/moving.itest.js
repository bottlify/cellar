/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A body the keeper is in the middle of moving, read from another thread: the
 * keeper cools an only copy to a disk whose write holds until the reading
 * thread has looked at the body and asked to wait for it. The body is there
 * all along, so the look must say so and the wait must read it once the move
 * is over (`moving.worker.fixture.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createChannel } from './channel.js';
import { answerKeeper, serveKeeperChannel } from './remote.js';
import { memoryDisk } from './disk.fixture.js';
import { openKeeper } from './keeper.js';
import { createReader } from './reader.js';
import { F_ONLY_COPY, reserveFlags } from './shared.js';

/** Waits of 50 ms a side gives the other at most: a minute. */
const WAITS = 1200;

test('a thread waiting on a body the keeper is moving to the disk reads it once the move is over',
    { timeout: 300_000 }, async()=>{
        /** 1: the keeper is moving the body; 2: the reader asked to wait for it. */
        const phase = new Int32Array(new SharedArrayBuffer(4));
        let holding = false;
        const base = memoryDisk();
        const disk = {
            files: base.files,
            remove: base.remove,
            async open(/** @type {string} */ name){
                const file = await base.open(name);
                return !name.startsWith('pack-') ? file : { ...file,
                    write(/** @type {Uint8Array} */ view, /** @type {{ at: number }} */ where){
                        if (holding)
                        {
                            Atomics.store(phase, 0, 1);
                            Atomics.notify(phase, 0);
                            for (let i = 0; i < WAITS && Atomics.load(phase, 0) !== 2; i++)
                            {
                                Atomics.wait(phase, 0, 1, 50);
                            }
                        }
                        return file.write(view, where);
                    } };
            },
        };
        let clock = 0;
        /** @type {Worker | null} */
        let worker = null;
        const keeper = await openKeeper({ budget: 1024 * 1024, segmentBytes: 64 * 1024, disk,
            coldAfterMs: 10, goneAfterMs: 1e9, releaseAfterMs: 1e9, now: ()=>clock,
            announce: message=>worker?.postMessage(message) });
        // The first pack opens behind a promise.
        await new Promise(resolve=>setTimeout(resolve, 0));
        const reader = createReader({ shared: keeper.shared, segments: keeper.segmentBuffers(), keeper: {
            reserve: keeper.reserve,
            raise: (name, options)=>keeper.raise(name, options),
            raiseLater: ()=>{}, drop: ()=>{},
        } });
        const body = Uint8Array.from({ length: 30_000 }, (_, i)=>(i * 7 + 3) & 255);
        assert.equal(reader.put('doc', body, F_ONLY_COPY), true);
        const channel = createChannel();
        const link = serveKeeperChannel(channel, answerKeeper({ keeper }));
        worker = new Worker(new URL('./moving.worker.fixture.js', import.meta.url), {
            workerData: { channel, shared: keeper.shared, segments: keeper.segmentBuffers(),
                phase: phase.buffer, waits: WAITS },
        });
        const messages = /** @type {Worker} */ (worker);
        /** @param {string} key @returns {Promise<any>} */
        const heard = key=>new Promise((resolve, reject)=>{
            const listen = (/** @type {any} */ message)=>{
                if (message[key] !== undefined)
                {
                    messages.off('message', listen);
                    resolve(message);
                }
            };
            messages.on('message', listen);
            messages.once('error', reject);
        });
        try
        {
            const ready = await heard('ready');
            assert.equal(ready.ready, 'hot', 'read in place before the move');
            const result = heard('done');
            // Idle long enough: the sweep cools it, the write to the disk held.
            clock += 100;
            holding = true;
            keeper.sweep();
            holding = false;
            const { done } = await result;
            assert.equal(done.look, 'cold', 'there while moved');
            assert.equal(done.read, body.reduce((sum, byte)=>sum + byte, 0), 'read once moved');
            assert.equal(done.moving, 0, 'not counted as a miss');
            assert.equal(done.asked, true, 'it asked the keeper while the move was under way');
            const figures = keeper.figures();
            assert.equal(figures.cooled, 1);
            assert.equal(figures.raised, 1);
        }
        finally
        {
            link.close();
            await worker.terminate();
        }
    });
