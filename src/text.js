/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Text in bytes, for everything in Cellar that writes a string into memory
 * or reads one back: UTF-8 written where it goes and read where it lies,
 * shared memory included, and the UTF-16 units a name is kept in. Text of
 * ASCII, as names and most messages are, makes nothing on the heap to write
 * and only its string to read.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** Whether shared memory exists here: a browser's decoder refuses a view of it. */
const SHARED = typeof SharedArrayBuffer === 'function';

/** A surrogate with no partner: what UTF-8 cannot carry. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether `text` is whole UTF-16, every surrogate in its pair: what UTF-8
 * carries unchanged.
 *
 * @param {string} text
 */
export const wellFormed = text=>!LONE_SURROGATE.test(text);

/**
 * Writes `text` as UTF-8 into `bytes` from `at`, as much as fits before
 * `end` (whole characters): the bytes written. A view of shared memory is
 * written in place.
 *
 * @param {Uint8Array} bytes @param {number} at @param {string} text
 * @param {number} [end]
 */
export const writeText = (bytes, at, text, end = bytes.length)=>{
    const room = end - at;
    const ascii = Math.min(text.length, room);
    for (let n = 0; n < ascii; n++)
    {
        const code = text.charCodeAt(n);
        if (code >= 0x80)
        {
            return n + encoder.encodeInto(text.slice(n), bytes.subarray(at + n, end)).written;
        }
        bytes[at + n] = code;
    }
    return ascii;
};

/** The most a string is made from at once: a call takes no more arguments than that. */
const PIECE = 8192;

/**
 * The UTF-8 text of `length` bytes of `bytes` from `at`, wherever they lie:
 * anything but ASCII in shared memory is copied out first, since a browser
 * decodes no view of it.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} length
 */
export const readText = (bytes, at, length)=>{
    const end = at + length;
    for (let n = at; n < end; n++)
    {
        if (bytes[n] >= 0x80)
        {
            const part = bytes.subarray(at, end);
            return decoder.decode(SHARED && bytes.buffer instanceof SharedArrayBuffer ? part.slice() : part);
        }
    }
    return readUnits(bytes, at, length, false);
};

/**
 * UTF-8 bytes as text, wherever they lie.
 *
 * @param {Uint8Array} bytes
 */
export const textOf = bytes=>readText(bytes, 0, bytes.length);

/**
 * The text of `count` UTF-16 units of `bytes` from `at`: two bytes each,
 * little-endian (`wide`), or one each, every unit below 256.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} count @param {boolean} wide
 */
export const readUnits = (bytes, at, count, wide)=>{
    if (!wide && count <= PIECE)
    {
        return String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(at, at + count)));
    }
    let text = '';
    const codes = new Array(Math.min(count, PIECE));
    for (let from = 0; from < count; from += PIECE)
    {
        const piece = Math.min(PIECE, count - from);
        codes.length = piece;
        for (let n = 0; n < piece; n++)
        {
            const unit = at + (from + n) * (wide ? 2 : 1);
            codes[n] = wide ? bytes[unit] | bytes[unit + 1] << 8 : bytes[unit];
        }
        text += String.fromCharCode(...codes);
    }
    return text;
};
