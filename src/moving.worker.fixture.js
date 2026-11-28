/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The reading thread of `moving.itest.js`: finds `doc` hot, waits until the
 * keeper is moving it, then looks at it and reads it with `wait`, saying
 * when it asked the keeper (which lets the keeper's move go on).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { openClient } from './channel.js';
import { openKeeperClient } from './remote.js';
import { createReader } from './reader.js';

const { channel, shared, segments, phase: phaseBuffer, waits } = workerData;
const phase = new Int32Array(phaseBuffer);
const keeper = openKeeperClient(openClient(channel)).keeper;
let asked = false;
const reader = createReader({
    shared, segments,
    keeper: {
        reserve: ()=>false,
        raise: (name, options)=>{
            asked = Atomics.load(phase, 0) === 1;
            Atomics.store(phase, 0, 2);
            Atomics.notify(phase, 0);
            return keeper.raise(name, options);
        },
        raiseLater: ()=>{},
        drop: ()=>{},
    },
});
parentPort?.on('message', message=>reader.adopt(message));

parentPort?.postMessage({ ready: reader.look('doc') });
for (let i = 0; i < waits && Atomics.load(phase, 0) !== 1; i++)
{
    Atomics.wait(phase, 0, 0, 50);
}
const look = reader.look('doc');
const read = reader.with('doc', body=>body.reduce((sum, byte)=>sum + byte, 0), { wait: true });
parentPort?.postMessage({ done: { look, read, moving: reader.figures().moving, asked } });
