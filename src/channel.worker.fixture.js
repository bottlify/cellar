/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The other thread of the channel's gate (`channel.itest.js`): serves a
 * channel until it closes, or asks it by a seed, blocking and not, and checks
 * every answer.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { ChannelClosed, openClient, openServer } from './channel.js';
import { answerTo, requestOf } from './channel-gate.fixture.js';

const { role, memory, seed, count, holdMs = 0 } = workerData;

/** Holds the thread `holdMs`, as a handler with work to do does. */
const hold = ()=>{
    const until = performance.now() + holdMs;
    while (performance.now() < until)
    {
        // Working.
    }
};

if (role === 'server')
{
    const server = openServer(memory);
    let served = 0;
    try
    {
        for (;;)
        {
            served += server.serve(holdMs > 0 ? request=>{
                hold();
                return answerTo(request);
            } : answerTo);
        }
    }
    catch (e){
        if (!(e instanceof ChannelClosed))
        {
            throw e;
        }
    }
    parentPort?.postMessage({ served });
}
else
{
    const client = openClient(memory);
    /** @type {string[]} */
    const failures = [];
    /** @type {Promise<void>[]} */
    const calls = [];
    for (let n = 0; n < count; n++)
    {
        const request = requestOf(seed, n);
        const expected = answerTo(request);
        /** @param {Uint8Array} answer */
        const check = answer=>{
            if (answer.length !== expected.length || answer.some((value, at)=>value !== expected[at]))
            {
                failures.push(`request ${n}: answered another`);
            }
        };
        // Blocking asks and calls left out between them, so an ask takes the
        // answers of calls before its own and both wait at once.
        if (n % 3 === 0)
        {
            check(client.ask(request));
        }
        else
        {
            calls.push(client.call(request).then(check));
        }
        if (calls.length > 64)
        {
            await Promise.all(calls.splice(0));
        }
    }
    await Promise.all(calls);
    parentPort?.postMessage({ failures });
}
