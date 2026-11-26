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
 * the callback would see whatever the keeper put there next. The count is one
 * word of the record, no thread's in particular: a thread terminated inside
 * `with` stays counted, and the body stays hot and its room held for the run.
 * Only the host knows a thread died, and a count taken back by time would
 * take a body from a reader that was only slow.
 *
 * A segment reaches this thread by a message (`adopt`); a body in a segment
 * not adopted yet reads as a miss, which a cache may answer.
 */

import {
    COLD, GONE, HOT, MOVING, RETIRED, RETIRED_WRITING, R_LENGTH, R_OFFSET, R_SEGMENT,
    R_STATE, WRITING, checkName, stateWord, viewIndex,
} from './shared.js';
import { bytesOf } from './bytes.js';

/**
 * Room the keeper granted: the record, where to write, and the reservation's
 * mark, which `commit` names.
 *
 * @typedef {{ id: number, segment: number, offset: number, mark: number }} Place
 */

/**
 * What the reader asks the keeper: `reserve` and `raise` answer at once,
 * across a link by a blocking call; `raiseLater` and `drop` are not waited on.
 *
 * @typedef {Object} KeeperCalls
 * @property {(name: string, length: number, options: { onlyCopy: boolean,
 *     disk?: import('./keeper.js').DiskPolicy, idle?: 'go' | 'stay', known: number })
 *     => Place | null} reserve
 * @property {(name: string, options: { known: number }) => boolean} raise
 *     `known`: the segments this reader has; a body placed past them could not be read here
 * @property {(name: string) => void} raiseLater
 * @property {(name: string) => void} drop
 */

/** What a read of a hot body came to. */
const DONE = 0;
/** The body is cold: on the disk, not in a segment. */
const NOT_HERE_COLD = 1;
/** The body is in no state to be read (written, retired, gone). */
const NOT_HOT = 2;
/** The body is in a segment this reader has not been told of yet. */
const UNSEEN = 3;
/** The keeper is moving the body: it is there, hot or cold once the move is over. */
const MOVED_NOW = 4;
/** The record is not the name's any more: it went back for another name. */
const STALE = 5;

/** Names a reader remembers the records of, at most: past it it forgets them all. */
const KNOWN_MOST = 1 << 16;

/**
 * What a reader remembers of a name it found: its record, and where the name
 * lies, which a record is checked against once inside.
 *
 * @typedef {{ id: number, nameAt: number }} Found
 */

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
    /** Reserved and not committed yet, by name. @type {Map<string, Place>} */
    const writing = new Map();
    const counts = {
        hits: 0, misses: 0, cold: 0, moving: 0, unseen: 0, raisedWaiting: 0, reserved: 0,
        refused: 0, abandoned: 0, late: 0,
    };

    /**
     * Names this reader found (`Found`). Asked first, it spares a hit the
     * hash and the walk over the shared index. A record no name leads to goes
     * back to the keeper for another name, so what is remembered is checked
     * once inside (`holds`): a record that is not the name's, or one the name
     * left (neither hot, cold nor moving), sends the name to the index again.
     *
     * @type {Map<string, Found>}
     */
    const known = new Map();

    /**
     * `name` looked up in the index and remembered, or undefined.
     *
     * @param {string} name @returns {Found | undefined}
     */
    const lookUp = name=>{
        const id = index.find(name);
        if (id < 0)
        {
            return undefined;
        }
        if (known.size >= KNOWN_MOST)
        {
            known.clear();
        }
        const found = { id, nameAt: index.matched() };
        known.set(name, found);
        return found;
    };

    /** What the last `readHot` read, when it answered DONE. @type {any} */
    let readValue;

    /**
     * Reads the body of the name `found`, `length` units long, inside `read`,
     * where it is hot here: DONE with the value in `readValue`, or why not. A
     * hit makes no object of its own.
     *
     * @param {Found} found @param {number} length @param {(body: Uint8Array) => any} read
     * @returns {number} DONE, NOT_HERE_COLD, MOVED_NOW, NOT_HOT, UNSEEN or STALE
     */
    const readHot = (found, length, read)=>{
        const id = found.id;
        if (!index.enter(id))
        {
            // The state first, then whose it is: a record taken for another
            // name since had that name written before its state.
            const state = index.state(id);
            if (!index.holds(id, found.nameAt, length))
            {
                return STALE;
            }
            return state === COLD ? NOT_HERE_COLD : state === MOVING ? MOVED_NOW : NOT_HOT;
        }
        try
        {
            if (!index.holds(id, found.nameAt, length))
            {
                return STALE;
            }
            const words = index.words;
            const base = index.at(id);
            const view = views[words[base + R_SEGMENT]];
            if (view === undefined || view === null)
            {
                return UNSEEN;
            }
            const offset = words[base + R_OFFSET];
            readValue = read(view.subarray(offset, offset + words[base + R_LENGTH]));
            index.stamp(id);
            return DONE;
        }
        finally {
            index.leave(id);
        }
    };

    /**
     * Where the name `found`, `length` units long, is: hot, cold (a body the
     * keeper is moving counts as cold: there, but not read in place now), or
     * undefined where the record says nothing of it any more.
     *
     * @param {Found} found @param {number} length
     */
    const whereIs = (found, length)=>{
        const id = found.id;
        const state = index.state(id);
        if (!index.holds(id, found.nameAt, length))
        {
            return undefined;
        }
        return state === HOT ? 'hot' : state === COLD || state === MOVING ? 'cold' : undefined;
    };

    /**
     * Whether `place` is still a reservation its writer may write into: the
     * keeper takes back one held past `abandonAfterMs`, and its room may be
     * another body's by now (a place granted ahead and handed over late).
     *
     * @param {Place} place
     */
    const stillReserved = place=>{
        const word = Atomics.load(index.cover(place.id), index.at(place.id) + R_STATE);
        return word === stateWord(WRITING, place.mark) || word === stateWord(RETIRED_WRITING, place.mark);
    };

    /**
     * Ends the reservation `place` as `state` (HOT for a commit, GONE for an
     * abandon): false where the keeper took it back, its writer too late. A
     * reservation whose name was written anew meanwhile only lets its writer
     * out: the newer write is the name's.
     *
     * @param {Place} place @param {number} state
     */
    const finish = (place, state)=>{
        const words = index.cover(place.id);
        const at = index.at(place.id) + R_STATE;
        const mine = stateWord(WRITING, place.mark);
        if (Atomics.compareExchange(words, at, mine, stateWord(state)) === mine)
        {
            return true;
        }
        const retired = stateWord(RETIRED_WRITING, place.mark);
        if (Atomics.compareExchange(words, at, retired, stateWord(RETIRED)) === retired)
        {
            return true;
        }
        counts.late++;
        return false;
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
         * Where `name`'s body is, without reading it. A body the keeper is
         * moving is cold here: there, but not to be read in place now.
         *
         * @param {string} name @returns {'hot' | 'cold' | null}
         */
        look(name){
            checkName(name);
            const remembered = known.get(name);
            if (remembered !== undefined)
            {
                const where = whereIs(remembered, name.length);
                if (where !== undefined)
                {
                    return where;
                }
                known.delete(name);
            }
            const found = lookUp(name);
            return found === undefined ? null : whereIs(found, name.length) ?? null;
        },

        /**
         * Calls `read` with `name`'s body and answers what it returned; with
         * `wait`, a cold body, or one the keeper is moving, is brought back or
         * waited for first. A miss answers `undefined` and, for a cold or
         * moving body without `wait`, asks for it to be brought back for later.
         *
         * @template T
         * @param {string} name @param {(body: Uint8Array) => T} read
         * @param {{ wait?: boolean }} [options]
         * @returns {T | undefined}
         */
        with(name, read, options){
            checkName(name);
            let found = known.get(name);
            let got = NOT_HOT;
            if (found !== undefined)
            {
                got = readHot(found, name.length, read);
                if (got === NOT_HOT || got === STALE)
                {
                    // Not the name's record any more, or a record the name
                    // left: the index says which is its now.
                    known.delete(name);
                    found = undefined;
                }
            }
            if (found === undefined)
            {
                found = lookUp(name);
                if (found === undefined)
                {
                    counts.misses++;
                    return undefined;
                }
                got = readHot(found, name.length, read);
            }
            const wait = options !== undefined && options.wait;
            // The keeper answers once whatever it was doing is done: a body it
            // was moving is hot or cold by then, and a cold one brought back.
            if ((got === NOT_HERE_COLD || got === MOVED_NOW) && wait
                && keeper.raise(name, { known: heard }))
            {
                counts.raisedWaiting++;
                known.delete(name);
                found = lookUp(name);
                got = found === undefined ? NOT_HOT : readHot(found, name.length, read);
            }
            if (got === DONE)
            {
                counts.hits++;
                const value = readValue;
                readValue = undefined;
                return value;
            }
            counts.misses++;
            if (got === NOT_HERE_COLD || got === MOVED_NOW)
            {
                counts[got === NOT_HERE_COLD ? 'cold' : 'moving']++;
                if (!wait)
                {
                    keeper.raiseLater(name);
                }
            }
            else if (got === UNSEEN)
            {
                counts.unseen++;
            }
            else if (got === STALE)
            {
                known.delete(name);
            }
            return undefined;
        },

        /**
         * Room for `name`'s body: a view to write it into, or null where the
         * keeper has none. The body is not seen by anyone until `commit`.
         *
         * `disk` says where the body may go on the disk (`DiskPolicy`); `idle`
         * whether an idle body goes by the keeper's idle rule (`'go'`) or stays
         * until its room is wanted (`'stay'`).
         *
         * @param {string} name @param {number} length
         * @param {{ onlyCopy?: boolean, disk?: import('./keeper.js').DiskPolicy,
         *     idle?: 'go' | 'stay' }} [options]
         */
        reserve(name, length, { onlyCopy = false, disk = 'kept', idle = 'go' } = {}){
            checkName(name);
            // A second reserve of a name not committed yet replaces the first.
            self.abandon(name);
            const place = keeper.reserve(name, length, { onlyCopy, disk, idle, known: heard });
            const view = place === null ? null : views[place.segment];
            if (place !== null)
            {
                writing.set(name, place);
            }
            if (place === null || view === null || view === undefined)
            {
                // Placed where this reader cannot write: given back.
                self.abandon(name);
                counts.refused++;
                return null;
            }
            if (!stillReserved(place))
            {
                // Taken back before a byte was written: nothing to give back.
                writing.delete(name);
                counts.late++;
                return null;
            }
            counts.reserved++;
            return view.subarray(place.offset, place.offset + length);
        },

        /**
         * Makes the body written into `reserve`'s view readable: false where
         * it came too late, the keeper having taken the reservation back
         * (`abandonAfterMs`), and the body is not readable.
         *
         * @param {string} name @returns {boolean}
         */
        commit(name){
            const place = writing.get(name);
            if (place === undefined)
            {
                throw new Error(`cache: ${name} was not reserved here`);
            }
            writing.delete(name);
            index.stamp(place.id);
            return finish(place, HOT);
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
            const place = writing.get(name);
            if (place === undefined)
            {
                return;
            }
            writing.delete(name);
            counts.abandoned++;
            finish(place, GONE);
        },

        /**
         * `reserve`, a copy of `bytes`, `commit`: false where there was no
         * room, or the commit came too late.
         *
         * @param {string} name @param {Uint8Array} bytes
         * @param {{ onlyCopy?: boolean, disk?: import('./keeper.js').DiskPolicy,
         *     idle?: 'go' | 'stay' }} [options]
         */
        put(name, bytes, options){
            checkName(name);
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
            return self.commit(name);
        },

        /** @param {string} name */
        drop(name){
            checkName(name);
            keeper.drop(name);
        },

        figures: ()=>({ ...counts }),
    };
    return self;
}

/** @typedef {ReturnType<typeof createReader>} Reader */
