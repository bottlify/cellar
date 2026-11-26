/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** Why something is not bytes. @param {string} what @returns {never} */
const notBytes = what=>{
    throw new TypeError(`${what}: bytes are a Uint8Array or an array of integers from 0 to 255`);
};

/**
 * The bytes of `record` as they are now, to be copied: `record` itself, or,
 * for a view over shared memory that grows (another thread may grow it
 * between its length taken and the copy), a view of its own of the length it
 * has now. Bytes are a view of one-byte elements, or an array whose every
 * element is an integer from 0 to 255; anything else throws rather than be
 * written as something it is not: a typed array of wider elements would be
 * cut to their low bytes, a buffer, a view of no length, a string or an
 * object that only has a length written as zeros or nothing, a number past a
 * byte as its low byte. Makes nothing on the heap for any of them.
 *
 * @param {ArrayLike<number>} record @param {string} what
 * @returns {ArrayLike<number>}
 */
export const bytesOf = (record, what)=>{
    if (ArrayBuffer.isView(record))
    {
        if (/** @type {any} */ (record).BYTES_PER_ELEMENT !== 1)
        {
            notBytes(what);
        }
        return /** @type {any} */ (record.buffer).growable === true
            ? /** @type {Uint8Array} */ (record).subarray(0, /** @type {Uint8Array} */ (record).length)
            : record;
    }
    if (!Array.isArray(record))
    {
        notBytes(what);
    }
    for (let at = 0; at < record.length; at++)
    {
        const value = record[at];
        // An integer from 0 to 255, holes and NaN and strings refused: `& 255`
        // leaves only those unchanged.
        if ((value & 255) !== value)
        {
            notBytes(what);
        }
    }
    return record;
};
