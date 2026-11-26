/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A cache in one thread for the tests: a keeper and a reader beside it, the
 * keeper's clock stepped by hand.
 */

import { openKeeper } from './keeper.js';
import { createReader } from './reader.js';

const KIB = 1024;

/** @param {Partial<import('./keeper.js').KeeperOptions>} [options] */
export async function cacheOf(options = {}){
    let clock = 0;
    /** @type {any[]} */
    const said = [];
    /** @type {import('./reader.js').Reader | null} */
    let reader = null;
    const keeper = await openKeeper({
        budget: 256 * KIB, segmentBytes: 64 * KIB, coldAfterMs: 100, goneAfterMs: 1000,
        releaseAfterMs: 50, now: ()=>clock,
        announce: message=>{
            said.push(message);
            reader?.adopt(message);
        },
        ...options,
    });
    reader = createReader({
        shared: keeper.shared, segments: keeper.segmentBuffers(),
        keeper: {
            reserve: (name, length, opts)=>keeper.reserve(name, length, opts),
            raise: name=>keeper.raise(name),
            raiseLater: name=>{
                keeper.raise(name);
            },
            drop: name=>{
                keeper.drop(name);
            },
        },
    });
    // The first pack opens behind a promise, as on OPFS.
    await new Promise(resolve=>setTimeout(resolve, 0));
    return {
        keeper, reader, said,
        /** @param {number} ms */
        step(ms){
            clock += ms;
            keeper.sweep();
        },
    };
}

/** @param {number} length @param {number} seed */
export const bodyOf = (length, seed)=>Uint8Array.from({ length }, (_, i)=>(i * 31 + seed) & 255);
