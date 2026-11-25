/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bytes of `record` as they are now, to be copied: `record` itself, or,
 * for a view over shared memory that grows (another thread may grow it
 * between its length taken and the copy), a view of its own of the length it
 * has now. Throws where `record` is not bytes: a typed array of wider
 * elements would be cut to their low bytes, a buffer or a view of no length
 * written as nothing. Makes nothing on the heap for any other.
 *
 * @param {ArrayLike<number>} record @param {string} what
 * @returns {ArrayLike<number>}
 */
export const bytesOf = (record, what)=>{
    if (ArrayBuffer.isView(record))
    {
        if (/** @type {any} */ (record).BYTES_PER_ELEMENT !== 1)
        {
            throw new TypeError(`${what}: bytes are a Uint8Array or an array of numbers`);
        }
        return /** @type {any} */ (record.buffer).growable === true
            ? /** @type {Uint8Array} */ (record).subarray(0, /** @type {Uint8Array} */ (record).length)
            : record;
    }
    const length = record?.length;
    if (!Number.isInteger(length) || length < 0)
    {
        throw new TypeError(`${what}: bytes are a Uint8Array or an array of numbers`);
    }
    return record;
};
