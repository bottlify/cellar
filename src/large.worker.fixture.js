/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread reading the cache for `large.test.js`: it joins over the index and
 * the segments it is handed, hears of segments made and let go after, and
 * reads a body on each `{ read, wait }` asked of it, answering what it found
 * there, its calls to the keeper across a channel.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { caller } from './channel.fixture.js';
import { createReader } from './reader.js';

const { channel, shared, segments } = workerData;
const keeper = caller(channel);
const reader = createReader({
    shared, segments,
    keeper: {
        reserve: (name, length, options)=>keeper.call('reserve', name, length, options),
        raise: (name, options)=>keeper.call('raise', name, options),
        raiseLater: ()=>{},
        drop: ()=>{},
    },
});

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
