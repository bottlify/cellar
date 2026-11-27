/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How many bytes a wait or a call allocates, for a test that holds a hot path
 * to its garbage: V8's sampling heap profiler, the objects collected
 * meanwhile included, over many calls each awaited before the next, less what
 * the same loop makes around `empty`, the least of three samples. A sampled
 * estimate: a test bounds it with room for the sampler's noise, never asks it
 * for an exact zero. Node counts a promise dearer than a browser does (its
 * async hooks): a bound is for node.
 */

import { Session } from 'node:inspector/promises';

/** Bytes between two samples: small, so a few bytes a call still show. */
const INTERVAL = 64;

/** A promise settled once: what the empty body answers. */
const SETTLED = Promise.resolve();

/** @param {any} node @returns {number} the sampled bytes of a profile's tree */
const total = node=>node.selfSize
    + node.children.reduce((/** @type {number} */ sum, /** @type {any} */ child)=>sum + total(child), 0);

/**
 * @param {Session} session @param {() => unknown} body @param {number} calls
 * @returns {Promise<number>}
 */
async function sampled(session, body, calls){
    await session.post('HeapProfiler.startSampling', { samplingInterval: INTERVAL,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    for (let i = 0; i < calls; i++)
    {
        await body();
    }
    const { profile } = await session.post('HeapProfiler.stopSampling');
    return total(profile.head);
}

/**
 * The bytes `body` allocates a call, measured over `calls` calls after as
 * many to warm it.
 *
 * @param {() => unknown} body  awaited when it answers a promise
 * @param {{ calls?: number, empty?: () => unknown }} [options]  `empty`: the same
 *     loop without what is measured (an awaited settled promise by default)
 * @returns {Promise<number>}
 */
export async function bytesPerCall(body, { calls = 2000, empty = ()=>SETTLED } = {}){
    const session = new Session();
    session.connect();
    try
    {
        await session.post('HeapProfiler.enable');
        for (let i = 0; i < calls; i++)
        {
            await body();
            await empty();
        }
        let around = Infinity;
        let made = Infinity;
        for (let round = 0; round < 3; round++)
        {
            around = Math.min(around, await sampled(session, empty, calls));
            made = Math.min(made, await sampled(session, body, calls));
        }
        return Math.max(0, made - around) / calls;
    }
    finally
    {
        session.disconnect();
    }
}
