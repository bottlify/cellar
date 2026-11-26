/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache as one thread uses it: names looked up and hot bodies read in
 * place, with no word to the keeper; room to write asked of the keeper and
 * the body written straight into its segment, then made hot by the writer
 * itself.
 *
 * A body is read only inside `with`: the record counts the reader while the
 * callback runs, and the keeper takes no body a reader is in. A view kept past
 * the callback would see whatever the keeper put there next.
 *
 * A segment reaches this thread by a message (`adopt`); a body in a segment
 * not adopted yet reads as a miss, which a cache may answer.
 */

import {
    COLD, GONE, HOT, R_LENGTH, R_OFFSET, R_SEGMENT, R_STATE, WRITING, stateWord, viewIndex,
} from './shared.js';
import { bytesOf } from './bytes.js';

/**
 * What the reader asks the keeper: `reserve` and `raise` answer at once,
 * across a link by a blocking call; `raiseLater` and `drop` are not waited on.
 *
 * @typedef {Object} KeeperCalls
 * @property {(name: string, length: number, options: { onlyCopy: boolean,
 *     disk?: import('./keeper.js').DiskPolicy, known: number })
 *     => { id: number, segment: number, offset: number } | null} reserve
 * @property {(name: string, options: { known: number }) => boolean} raise
 *     `known`: the segments this reader has; a body placed past them could not be read here
 * @property {(name: string) => void} raiseLater
 * @property {(name: string) => void} drop
 */

/** What a read of a hot body came to. */
const DONE = 0;
/** The body is cold: on the disk, not in a segment. */
const NOT_HERE_COLD = 1;
/** The body is in no state to be read (written, moved, retired). */
const NOT_HOT = 2;
/** The body is in a segment this reader has not been told of yet. */
const UNSEEN = 3;

/** Names a reader remembers the records of, at most: past it it forgets them all. */
const KNOWN_MOST = 1 << 16;

/**
 * @param {Object} options
 * @param {import('./shared.js').SharedIndex} options.shared
 * @param {(SharedArrayBuffer | null)[]} [options.segments]  those known when the reader is made
 * @param {KeeperCalls} options.keeper
 */
export function createReader({ shared, segments = [], keeper }){
    const index = viewIndex(shared);
    /** By segment: a view, null for one let go, undefined for one not heard of. @type {(Uint8Array | null | undefined)[]} */
    const views = segments.map(buffer=>(buffer === null ? null : new Uint8Array(buffer)));
    /**
     * The segments this reader has heard of, each one below: what the keeper
     * may place a body in for it. A message missed (an announce that threw)
     * leaves a gap, and nothing past the gap is counted.
     */
    let heard = views.length;
    /** Reserved and not committed yet, by name. @type {Map<string, number>} */
    const writing = new Map();
    const counts = {
        hits: 0, misses: 0, cold: 0, unseen: 0, raisedWaiting: 0, reserved: 0, refused: 0,
        abandoned: 0,
    };

    /**
     * Names this reader found, by their record. A record is never used again
     * for another name: one still hot or cold is still its name's (a name
     * written anew gets a new record, and the old one is retired at its
     * commit), and any other state sends the name to the index again. Asked
     * first, it spares a hit the hash and the walk over the shared index.
     *
     * @type {Map<string, number>}
     */
    const known = new Map();

    /** @param {string} name @returns {number} its record, or -1 */
    const idOf = name=>{
        const id = known.get(name);
        if (id !== undefined)
        {
            const state = index.state(id);
            if (state === HOT || state === COLD)
            {
                return id;
            }
            known.delete(name);
        }
        const found = index.find(name);
        if (found >= 0)
        {
            if (known.size >= KNOWN_MOST)
            {
                known.clear();
            }
            known.set(name, found);
        }
        return found;
    };

    /** What the last `readHot` read, when it answered DONE. @type {any} */
    let readValue;

    /**
     * Reads `name`'s body inside `read`, where it is hot here: DONE with the
     * value in `readValue`, or why not. A hit makes no object of its own.
     *
     * @param {number} id @param {(body: Uint8Array) => any} read
     * @returns {number} DONE, NOT_HERE_COLD, NOT_HOT or UNSEEN
     */
    const readHot = (id, read)=>{
        if (!index.enter(id))
        {
            return index.state(id) === COLD ? NOT_HERE_COLD : NOT_HOT;
        }
        try
        {
            const base = index.at(id);
            const view = views[index.words[base + R_SEGMENT]];
            if (view === undefined || view === null)
            {
                return UNSEEN;
            }
            const offset = index.words[base + R_OFFSET];
            readValue = read(view.subarray(offset, offset + index.words[base + R_LENGTH]));
            index.stamp(id);
            return DONE;
        }
        finally {
            index.leave(id);
        }
    };

    const self = {
        /**
         * A message from the keeper: a segment made or let go, a larger table.
         *
         * @param {{ segment?: number, buffer?: SharedArrayBuffer | null,
         *     table?: SharedArrayBuffer }} message
         */
        adopt(message){
            if (message.table !== undefined)
            {
                index.adoptTable(message.table);
            }
            if (message.segment !== undefined)
            {
                // A segment not heard of stays undefined, one let go null.
                while (views.length <= message.segment)
                {
                    views.push(undefined);
                }
                views[message.segment] = message.buffer ? new Uint8Array(message.buffer) : null;
                while (heard < views.length && views[heard] !== undefined)
                {
                    heard++;
                }
            }
        },

        /**
         * Where `name`'s body is, without reading it.
         *
         * @param {string} name @returns {'hot' | 'cold' | null}
         */
        look(name){
            const id = idOf(name);
            if (id < 0)
            {
                return null;
            }
            const state = index.state(id);
            return state === HOT ? 'hot' : state === COLD ? 'cold' : null;
        },

        /**
         * Calls `read` with `name`'s body and answers what it returned; with
         * `wait`, a cold body is brought back first. A miss answers
         * `undefined` and, for a cold body without `wait`, asks for it to be
         * brought back for later.
         *
         * @template T
         * @param {string} name @param {(body: Uint8Array) => T} read
         * @param {{ wait?: boolean }} [options]
         * @returns {T | undefined}
         */
        with(name, read, { wait = false } = {}){
            const id = idOf(name);
            if (id < 0)
            {
                counts.misses++;
                return undefined;
            }
            let got = readHot(id, read);
            if (got === NOT_HERE_COLD && wait && keeper.raise(name, { known: heard }))
            {
                counts.raisedWaiting++;
                got = readHot(id, read);
            }
            if (got === DONE)
            {
                counts.hits++;
                const value = readValue;
                readValue = undefined;
                return value;
            }
            counts.misses++;
            if (got === NOT_HERE_COLD)
            {
                counts.cold++;
                if (!wait)
                {
                    keeper.raiseLater(name);
                }
            }
            else if (got === UNSEEN)
            {
                counts.unseen++;
            }
            return undefined;
        },

        /**
         * Room for `name`'s body: a view to write it into, or null where the
         * keeper has none. The body is not seen by anyone until `commit`.
         *
         * `disk` says where the body may go on the disk (`DiskPolicy`).
         *
         * @param {string} name @param {number} length
         * @param {{ onlyCopy?: boolean, disk?: import('./keeper.js').DiskPolicy }} [options]
         */
        reserve(name, length, { onlyCopy = false, disk = 'kept' } = {}){
            // A second reserve of a name not committed yet replaces the first.
            self.abandon(name);
            const place = keeper.reserve(name, length, { onlyCopy, disk, known: heard });
            const view = place === null ? null : views[place.segment];
            if (place !== null)
            {
                writing.set(name, place.id);
            }
            if (place === null || view === null || view === undefined)
            {
                // Placed where this reader cannot write: given back.
                self.abandon(name);
                counts.refused++;
                return null;
            }
            counts.reserved++;
            return view.subarray(place.offset, place.offset + length);
        },

        /**
         * Makes the body written into `reserve`'s view readable.
         *
         * @param {string} name
         */
        commit(name){
            const id = writing.get(name);
            if (id === undefined)
            {
                throw new Error(`cache: ${name} was not reserved here`);
            }
            writing.delete(name);
            index.stamp(id);
            // Hot, the writer out; or, where the name was written anew meanwhile,
            // only the writer out of a record retired under it.
            if (Atomics.compareExchange(index.words, index.at(id) + R_STATE,
                stateWord(WRITING, 1), stateWord(HOT)) !== stateWord(WRITING, 1))
            {
                index.leave(id);
            }
        },

        /**
         * Lets go of a reservation without a body (a writer that failed):
         * the name is left with none, as `reserve` took its body before away,
         * and the room goes back to the keeper at its next sweep. Nothing
         * where `name` is not reserved here.
         *
         * @param {string} name
         */
        abandon(name){
            const id = writing.get(name);
            if (id === undefined)
            {
                return;
            }
            writing.delete(name);
            counts.abandoned++;
            // No body, the writer out; or only the writer out of a record
            // retired under it.
            if (Atomics.compareExchange(index.words, index.at(id) + R_STATE,
                stateWord(WRITING, 1), stateWord(GONE)) !== stateWord(WRITING, 1))
            {
                index.leave(id);
            }
        },

        /**
         * `reserve`, a copy of `bytes`, `commit`: false where there was no room.
         *
         * @param {string} name @param {Uint8Array} bytes
         * @param {{ onlyCopy?: boolean, disk?: import('./keeper.js').DiskPolicy }} [options]
         */
        put(name, bytes, options){
            // The bytes as long as they are now, which is what is copied.
            const taken = bytesOf(bytes, 'cache');
            const into = self.reserve(name, taken.length, options);
            if (into === null)
            {
                return false;
            }
            try
            {
                into.set(taken);
            }
            catch (e){
                self.abandon(name);
                throw e;
            }
            self.commit(name);
            return true;
        },

        /** @param {string} name */
        drop(name){
            keeper.drop(name);
        },

        figures: ()=>({ ...counts }),
    };
    return self;
}

/** @typedef {ReturnType<typeof createReader>} Reader */
