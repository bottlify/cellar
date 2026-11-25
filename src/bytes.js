/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Throws where `record` is not bytes: a typed array of wider elements would
 * be cut to their low bytes, and a buffer or a view of no length written as
 * nothing.
 *
 * @param {ArrayLike<number>} record @param {string} what
 */
export const checkBytes = (record, what)=>{
    const length = record?.length;
    if (!Number.isInteger(length) || length < 0
        || (ArrayBuffer.isView(record) && /** @type {any} */ (record).BYTES_PER_ELEMENT !== 1))
    {
        throw new TypeError(`${what}: bytes are a Uint8Array or an array of numbers`);
    }
};
