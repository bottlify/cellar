/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread's blocking calls to the keeper, for the tests: method calls as
 * JSON over a channel (`channel.js`). A program wires the keeper's calls
 * through whatever link its threads already have; the cache itself asks only
 * for `KeeperCalls`.
 */

import { ChannelClosed, createChannel, openClient, openServer } from './channel.js';

/** The memory of one thread's link. */
export const channelMemory = ()=>createChannel({ slots: 1, slotBytes: 16 * 1024 });

/** @param {any} value */
const encode = value=>new TextEncoder().encode(JSON.stringify(value ?? null));
/** @param {Uint8Array} bytes */
const decode = bytes=>JSON.parse(new TextDecoder().decode(bytes));

/**
 * The calling side, in a thread that may block: `call(method, ...args)`
 * answers what the serving side's handler returned.
 *
 * @param {SharedArrayBuffer} memory
 */
export function caller(memory){
    const client = openClient(memory);
    return {
        /** @param {string} method @param {any[]} args */
        call: (method, ...args)=>client.ask(encode({ method, args }), { read: decode }),
    };
}

/**
 * The serving side, in a thread that must not block: answers each call by
 * `handlers[method](...args)` until `stop`.
 *
 * @param {SharedArrayBuffer} memory @param {Record<string, (...args: any[]) => any>} handlers
 */
export function serve(memory, handlers){
    const server = openServer(memory);
    (async()=>{
        for (;;)
        {
            await server.serveAsync(request=>{
                const { method, args } = decode(request);
                return encode(handlers[method](...args));
            });
        }
    })().catch(reason=>{
        if (!(reason instanceof ChannelClosed))
        {
            throw reason;
        }
    });
    return {
        stop: ()=>server.close(),
    };
}
