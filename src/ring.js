/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Records from one thread to another through shared memory, and a doorbell
 * the reader waits on until there is something to read.
 *
 * A thread that runs something long cannot stop to take a message: a message
 * is delivered only when the thread returns to its event loop. What it is
 * sent is written here instead and read between two steps of its work, and
 * when it has nothing to do it waits on the ring's doorbell rather than on the
 * event loop.
 *
 * One writer and one reader. Nothing written is lost: a record that does not
 * fit is refused, and the writer either tries again or waits for the reader
 * to make room. Records are bytes of any length up to `maxRecord`, each one
 * whole in the buffer -- one that would run past the end is put at the start,
 * behind a marker that says so -- so the reader is handed a view, not a copy.
 *
 * The indices are counts of bytes ever written and ever read, not positions:
 * the difference is what the ring holds, and an empty ring cannot be mistaken
 * for a full one. They wrap at 2^32, which the arithmetic here does too.
 *
 * The doorbell can be the ring's own or one shared with other rings
 * (`bell.js`), so a thread with several inbound rings waits once for all of
 * them. It is rung after the record is published, and wakes the reader only
 * when the reader sleeps on it.
 *
 * Either side may close the ring, when it goes or knows the other went: a
 * writer waiting for room and a write after it end with `RingClosed`, and the
 * reader is rung to find it closed, after it has read what was written before.
 */

import { createDoorbell, deadlineOf, openDoorbell, waitFor, waitForAsync, wake } from './bell.js';

/**
 * Words of the control block: bytes ever written and the writer's waits
 * asleep on `ROOM`; bytes ever read and a count the reader moves when it frees
 * room; not zero once either side closed the ring. On one cache line: the two
 * sides' words on lines of their own streamed 20 M records of 8 bytes no
 * faster (3.00 against 3.01 M a second, 8 runs each, x86).
 */
const WRITTEN = 0;
const ROOM_SLEEPS = 1;
const READ = 2;
const ROOM = 3;
const CLOSED = 4;
const CONTROL_WORDS = 5;

/** Why a write, or a wait for room, ended without writing. */
export class RingClosed extends Error {
    constructor(){
        super('ring: closed');
        this.name = 'RingClosed';
    }
}

/** A record's length word that means "the rest of the buffer is unused; go to the start". */
const WRAP = 0xffffffff;

/** Every record's length word and its bytes are kept aligned to this. */
const ALIGN = 4;

/** @param {number} n */
const aligned = n=>(n + ALIGN - 1) & ~(ALIGN - 1);

/**
 * @typedef {Object} RingMemory
 * @property {SharedArrayBuffer} control
 * @property {SharedArrayBuffer} data
 * @property {import('./bell.js').DoorbellMemory} bell  the doorbell it rings
 */

/**
 * The memory of a new ring, to be opened on both sides.
 *
 * @param {number} capacity  bytes, rounded up to a power of two of at least 64
 * @param {import('./bell.js').DoorbellMemory} [bell]  one shared with other rings; the
 *     ring's own by default
 * @returns {RingMemory}
 */
export function createRingMemory(capacity, bell = createDoorbell()){
    let size = 64;
    while (size < capacity)
    {
        size *= 2;
    }
    if (size > 1 << 30)
    {
        throw new RangeError('ring: a ring holds at most 1 GiB');
    }
    return { control: new SharedArrayBuffer(CONTROL_WORDS * 4), data: new SharedArrayBuffer(size),
        bell };
}

/**
 * One side of a ring. Either side may be opened from the same memory in any
 * thread; each method belongs to one of them, as its comment says.
 *
 * @param {RingMemory} memory
 */
export function openRing(memory){
    const control = new Int32Array(memory.control);
    const bytes = new Uint8Array(memory.data);
    const words = new DataView(memory.data);
    const capacity = bytes.length;
    const mask = capacity - 1;
    const bell = openDoorbell(memory.bell);
    /** The longest record: one that fits however the ring is positioned. */
    const maxRecord = capacity / 2 - ALIGN;

    /** @param {number} index */
    const load = index=>Atomics.load(control, index) >>> 0;

    return {
        capacity,
        maxRecord,
        bell,

        /**
         * The writer's: puts one record in, and rings the doorbell. False,
         * and nothing written, when there is not room for it now; `RingClosed`
         * once the ring is closed.
         *
         * @param {ArrayLike<number>} record
         * @returns {boolean}
         */
        write(record){
            if (Atomics.load(control, CLOSED) !== 0)
            {
                throw new RingClosed();
            }
            const length = record.length;
            if (length > maxRecord)
            {
                throw new RangeError(`ring: a record of ${length} bytes is longer than ${maxRecord}`);
            }
            const written = load(WRITTEN);
            const free = capacity - ((written - load(READ)) >>> 0);
            const at = written & mask;
            const need = ALIGN + aligned(length);
            // What runs past the end is put at the start, and the tail it
            // skips is spent: a record is always whole, so it is read in place.
            const tail = capacity - at;
            const skip = tail < need ? tail : 0;
            if (skip + need > free)
            {
                return false;
            }
            if (skip > 0)
            {
                words.setUint32(at, WRAP, true);
            }
            const start = (at + skip) & mask;
            words.setUint32(start, length, true);
            bytes.set(record, start + ALIGN);
            // The record is published by the index, and the index by the store
            // being atomic: a reader that sees the new count sees the bytes.
            Atomics.store(control, WRITTEN, (written + skip + need) | 0);
            bell.ring();
            return true;
        },

        /**
         * The writer's, where it may block: puts one record in, waiting up to
         * `timeoutMs` in all for the reader to make room.
         *
         * @param {ArrayLike<number>} record
         * @param {number} [timeoutMs]
         * @returns {boolean} whether it was written
         */
        writeWaiting(record, timeoutMs){
            const deadline = deadlineOf(timeoutMs);
            for (;;)
            {
                const room = Atomics.load(control, ROOM);
                if (this.write(record))
                {
                    return true;
                }
                const end = waitFor(control, ROOM, room, ROOM_SLEEPS, deadline, undefined, CLOSED);
                if (end === 'closed')
                {
                    throw new RingClosed();
                }
                if (end === 'timed-out')
                {
                    return false;
                }
            }
        },

        /**
         * `writeWaiting` without blocking the thread: for a writer with an
         * event loop to keep, a page's own above all.
         *
         * @param {ArrayLike<number>} record
         * @param {number} [timeoutMs]
         * @returns {Promise<boolean>} whether it was written
         */
        async writeWaitingAsync(record, timeoutMs){
            const deadline = deadlineOf(timeoutMs);
            for (;;)
            {
                const room = Atomics.load(control, ROOM);
                if (this.write(record))
                {
                    return true;
                }
                const end = await waitForAsync(control, ROOM, room, ROOM_SLEEPS, deadline, CLOSED);
                if (end === 'closed')
                {
                    throw new RingClosed();
                }
                if (end === 'timed-out')
                {
                    return false;
                }
            }
        },

        /**
         * The reader's: the next record, as a view into the ring that stays
         * valid until `release` -- or null when there is none.
         *
         * @returns {Uint8Array | null}
         */
        peek(){
            let read = load(READ);
            const written = load(WRITTEN);
            if (read === written)
            {
                return null;
            }
            let at = read & mask;
            let length = words.getUint32(at, true);
            if (length === WRAP)
            {
                read = (read + (capacity - at)) >>> 0;
                Atomics.store(control, READ, read | 0);
                at = 0;
                length = words.getUint32(0, true);
            }
            return bytes.subarray(at + ALIGN, at + ALIGN + length);
        },

        /**
         * The reader's: gives the record `peek` returned back to the writer.
         */
        release(){
            const read = load(READ);
            const at = read & mask;
            const length = words.getUint32(at, true);
            Atomics.store(control, READ, (read + ALIGN + aligned(length)) | 0);
            Atomics.add(control, ROOM, 1);
            wake(control, ROOM, ROOM_SLEEPS);
        },

        /**
         * The reader's: the records there are, each handed to `take` before
         * the next is read, `most` at the most: a ring written without a pause
         * does not keep its reader from the others it reads. Returns how many.
         *
         * @param {(record: Uint8Array) => void} take
         * @param {number} [most]
         */
        drain(take, most = Infinity){
            let count = 0;
            for (let record = count < most ? this.peek() : null; record !== null;
                record = count < most ? this.peek() : null)
            {
                take(record);
                this.release();
                count++;
            }
            return count;
        },

        /**
         * Ends the ring for both sides: a writer waiting for room, and every
         * write after, end with `RingClosed`; the reader is rung, reads what
         * was written before, and finds `closed()` true.
         */
        close(){
            Atomics.store(control, CLOSED, 1);
            Atomics.notify(control, ROOM);
            bell.ring();
        },
        /** Whether either side closed the ring. */
        closed: ()=>Atomics.load(control, CLOSED) !== 0,

        /** Bytes held, records and their framing: for diagnostics. */
        held: ()=>(load(WRITTEN) - load(READ)) >>> 0,
    };
}

/** @typedef {ReturnType<typeof openRing>} Ring */
