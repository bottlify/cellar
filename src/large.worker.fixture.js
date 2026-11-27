/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread reading the cache for `large.test.js`: it joins over the index and
 * the segments it is handed, hears of segments made and let go after, and
 * reads a body on each `{ read, wait }` asked of it, answering what it found
 * there, its calls to the keeper the remote keeper's, across a channel.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { openClient } from './channel.js';
import { openKeeperClient } from './remote.js';
import { createReader } from './reader.js';

const { channel, shared, segments } = workerData;
// A reader that asks the keeper only what it waits for: a read that misses
// raises nothing behind it, so each raise the tests count is one they asked.
const { reserve, raise } = openKeeperClient(openClient(channel)).keeper;
const reader = createReader({ shared, segments, keeper: { reserve, raise, raiseLater: ()=>{}, drop: ()=>{} } });

parentPort?.on('message', message=>{
    if (message.read === undefined)
    {
        reader.adopt(message);
        return;
    }
    const found = reader.with(message.read, body=>{
        let sum = 0;
        for (let i = 0; i < body.length; i += 4093)
        {
            sum = (sum + body[i] * (i + 1)) % 0x7fffffff;
        }
        return { length: body.length, sum, shared: body.buffer instanceof SharedArrayBuffer };
    }, { wait: message.wait });
    parentPort?.postMessage({ found: found ?? null, hits: reader.figures().hits });
});
