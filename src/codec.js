/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Values as bytes, for what crosses a ring between threads (`link.js`).
 *
 * What one thread asks another is values - numbers, strings, the bytes of
 * something read - and a ring carries bytes. JSON would do for the first two
 * and not for the third, and structured clone is not something a ring can
 * call, so this is the encoding a call across a ring uses: undefined, null,
 * booleans, numbers, strings, byte arrays, and arrays and plain objects of
 * those. Anything else is refused when written rather than arriving as
 * something it was not.
 *
 * Integers that fit 32 bits take five bytes and every other number nine;
 * a string is its UTF-8 bytes after their count - or, holding a surrogate
 * with no partner, which UTF-8 cannot say, its UTF-16 units.
 */

import { readText, readUnits, wellFormed, writeText } from './text.js';

const UNDEFINED = 0;
const NULL = 1;
const FALSE = 2;
const TRUE = 3;
const INT = 4;
const FLOAT = 5;
const STRING = 6;
const BYTES = 7;
const ARRAY = 8;
const OBJECT = 9;
const UNITS = 10;

/**
 * A growing buffer the encoder writes into.
 */
function createWriter(){
    let bytes = new Uint8Array(256);
    let view = new DataView(bytes.buffer);
    let length = 0;
    /** @param {number} more */
    const room = more=>{
        if (length + more <= bytes.length)
        {
            return;
        }
        let size = bytes.length * 2;
        while (size < length + more)
        {
            size *= 2;
        }
        const grown = new Uint8Array(size);
        grown.set(bytes.subarray(0, length));
        bytes = grown;
        view = new DataView(bytes.buffer);
    };
    return {
        /** @param {number} value */
        u8(value){
            room(1);
            bytes[length++] = value;
        },
        /** @param {number} value */
        u32(value){
            room(4);
            view.setUint32(length, value >>> 0, true);
            length += 4;
        },
        /** @param {number} value */
        i32(value){
            room(4);
            view.setInt32(length, value, true);
            length += 4;
        },
        /** @param {number} value */
        f64(value){
            room(8);
            view.setFloat64(length, value, true);
            length += 8;
        },
        /** Its UTF-8 bytes after their count. @param {string} value */
        text(value){
            room(4 + value.length * 3);
            const written = writeText(bytes, length + 4, value);
            view.setUint32(length, written, true);
            length += 4 + written;
        },
        /** @param {Uint8Array} value */
        raw(value){
            room(value.length);
            bytes.set(value, length);
            length += value.length;
        },
        done: ()=>bytes.slice(0, length),
    };
}

/**
 * @param {ReturnType<typeof createWriter>} out
 * @param {unknown} value
 * @param {number} depth
 */
function put(out, value, depth){
    if (depth > 64)
    {
        throw new Error('codec: a value nested deeper than 64');
    }
    if (value === undefined)
    {
        out.u8(UNDEFINED);
    }
    else if (value === null)
    {
        out.u8(NULL);
    }
    else if (value === false || value === true)
    {
        out.u8(value ? TRUE : FALSE);
    }
    else if (typeof value === 'number')
    {
        // -0 is a float: as an integer it would come back as 0.
        if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff
            && !Object.is(value, -0))
        {
            out.u8(INT);
            out.i32(value);
        }
        else
        {
            out.u8(FLOAT);
            out.f64(value);
        }
    }
    else if (typeof value === 'string')
    {
        if (wellFormed(value))
        {
            out.u8(STRING);
            out.text(value);
        }
        else
        {
            out.u8(UNITS);
            out.u32(value.length);
            for (let i = 0; i < value.length; i++)
            {
                out.u8(value.charCodeAt(i) & 0xff);
                out.u8(value.charCodeAt(i) >>> 8);
            }
        }
    }
    else if (value instanceof Uint8Array)
    {
        out.u8(BYTES);
        out.u32(value.length);
        out.raw(value);
    }
    else if (Array.isArray(value))
    {
        out.u8(ARRAY);
        out.u32(value.length);
        for (const each of value)
        {
            put(out, each, depth + 1);
        }
    }
    else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    {
        const entries = Object.entries(/** @type {Record<string, unknown>} */ (value));
        out.u8(OBJECT);
        out.u32(entries.length);
        for (const [key, each] of entries)
        {
            put(out, key, depth + 1);
            put(out, each, depth + 1);
        }
    }
    else
    {
        throw new Error(`codec: a ${Object.prototype.toString.call(value)} cannot cross`);
    }
}

/**
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function encodeValue(value){
    const out = createWriter();
    put(out, value, 0);
    return out.done();
}

/**
 * The value `encodeValue` made these bytes from. What it holds is its own:
 * byte arrays are copies, not views of `bytes`.
 *
 * @param {Uint8Array} bytes
 * @returns {any}
 */
export function decodeValue(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    const u32 = ()=>{
        const value = view.getUint32(at, true);
        at += 4;
        return value;
    };
    /** @returns {any} */
    const take = ()=>{
        const tag = bytes[at++];
        switch (tag)
        {
            case UNDEFINED: return undefined;
            case NULL: return null;
            case FALSE: return false;
            case TRUE: return true;
            case INT: {
                const value = view.getInt32(at, true);
                at += 4;
                return value;
            }
            case FLOAT: {
                const value = view.getFloat64(at, true);
                at += 8;
                return value;
            }
            case STRING: {
                const length = u32();
                const text = readText(bytes, at, length);
                at += length;
                return text;
            }
            case UNITS: {
                const length = u32();
                const text = readUnits(bytes, at, length, true);
                at += length * 2;
                return text;
            }
            case BYTES: {
                const length = u32();
                const copy = bytes.slice(at, at + length);
                at += length;
                return copy;
            }
            case ARRAY: {
                const length = u32();
                const list = new Array(length);
                for (let i = 0; i < length; i++)
                {
                    list[i] = take();
                }
                return list;
            }
            case OBJECT: {
                const length = u32();
                /** @type {Record<string, unknown>} */
                const object = {};
                for (let i = 0; i < length; i++)
                {
                    const key = take();
                    object[key] = take();
                }
                return object;
            }
            default:
                throw new Error(`codec: no value is tagged ${tag}`);
        }
    };
    const value = take();
    if (at !== bytes.length)
    {
        throw new Error(`codec: ${bytes.length - at} bytes after the value`);
    }
    return value;
}
