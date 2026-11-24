/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The requests of the channel's gate and the answer each must get: a request
 * says its own number and is of a length its number decides, the answer is
 * every byte of it plus its number, so an answer to another request, or to a
 * request read before its bytes were all there, never passes.
 */

/** Bytes a slot of the gate's channels holds. */
export const GATE_SLOT_BYTES = 256;

/** @param {number} seed @param {number} n */
export function requestOf(seed, n){
    let state = (seed ^ Math.imul(n + 1, 0x9e3779b9)) >>> 0 || 1;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const length = 4 + ((state >>> 0) % (GATE_SLOT_BYTES - 4));
    const request = new Uint8Array(length);
    new DataView(request.buffer).setUint32(0, n, true);
    for (let at = 4; at < length; at++)
    {
        request[at] = (n * 31 + at * 7 + seed) & 255;
    }
    return request;
}

/** @param {Uint8Array} request */
export function answerTo(request){
    const n = new DataView(request.buffer, request.byteOffset, 4).getUint32(0, true);
    const answer = new Uint8Array(request.length);
    for (let at = 0; at < request.length; at++)
    {
        answer[at] = (request[at] + n) & 255;
    }
    return answer;
}
