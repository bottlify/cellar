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
    COLD, GONE, HOT, H_LET_GO, MOVING, RETIRED, RETIRED_WRITING, R_LENGTH, R_OFFSET, R_SEGMENT,
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
 *     disk?: import('./keeper.js').DiskPolicy, idle?: 'go' | 'stay', known: number, hold?: boolean })
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

/** How a reservation ended (`finish`). */
const LATE = 0;
const ENDED = 1;
const LEFT = 2;

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
     * The view each record's hot body was last read through, by record id:
     * handed again while the record's segment, offset and length are what
     * they were, so a read of a hot body makes no view of its own - a body
     * read item by item (a glyph, a table entry) makes no garbage a read.
     * Dropped with the segment it is over (`adopt`), so it keeps no segment
     * let go of alive.
     *
     * @type {(Uint8Array | undefined)[]}
     */
    const bodyViews = [];

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
            const bodyLength = words[base + R_LENGTH];
            let body = bodyViews[id];
            if (body === undefined || body.buffer !== view.buffer
                || body.byteOffset !== view.byteOffset + offset || body.length !== bodyLength)
            {
                body = view.subarray(offset, offset + bodyLength);
                bodyViews[id] = body;
            }
            readValue = read(body);
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
     * Ends the reservation `place` with its state word `word` (a body
     * published, entered once; or gone, for an abandon): `ENDED`, or `LEFT`
     * where the name was written anew meanwhile and the newer write is the
     * name's, the record retired and only its writer let out of it; `LATE`
     * where the keeper took it back, its writer too late.
     *
     * @param {Place} place @param {number} word
     */
    const finish = (place, word)=>{
        const words = index.cover(place.id);
        const at = index.at(place.id) + R_STATE;
        const mine = stateWord(WRITING, place.mark);
        if (Atomics.compareExchange(words, at, mine, word) === mine)
        {
            return ENDED;
        }
        const retired = stateWord(RETIRED_WRITING, place.mark);
        if (Atomics.compareExchange(words, at, retired, stateWord(RETIRED)) === retired)
        {
            return LEFT;
        }
        counts.late++;
        return LATE;
    };

    /**
     * A reservation given up without a body: its room the keeper's again at
     * its next reserve, told so by the count of those let go (`H_LET_GO`),
     * which moves after the record is gone, so a keeper that sees it moved
     * finds the record gone.
     *
     * @param {Place} place
     */
    const letGo = place=>{
        counts.abandoned++;
        if (finish(place, stateWord(GONE)) === ENDED)
        {
            Atomics.add(index.words, H_LET_GO, 1);
        }
    };

    /**
     * What `reserve` and `put` ask the keeper with: their options, the
     * defaults filled in, and the segments this reader has heard of. No
     * object is made for options not given.
     *
     * @param {{ onlyCopy?: boolean, disk?: import('./keeper.js').DiskPolicy,
     *     idle?: 'go' | 'stay', hold?: boolean } | undefined} options
     */
    const askOf = options=>{
        if (options === undefined)
        {
            return { onlyCopy: false, disk: /** @type {const} */ ('kept'), idle: /** @type {const} */ ('go'),
                known: heard };
        }
        const { onlyCopy = false, disk = 'kept', idle = 'go', hold = false } = options;
        return hold ? { onlyCopy, disk, idle, known: heard, hold }
            : { onlyCopy, disk, idle, known: heard };
    };

    /**
     * The body written at `place` made readable: false where it came too
     * late, the reservation taken back. Published entered, as a reader
     * enters it, and stamped before it is left: a record no one is in can be
     * taken back and given to the next reservation, whose age a stamp landing
     * late would set to the last sweep's. A record retired meanwhile no name
     * leads to: nothing stamps it.
     *
     * @param {Place} place @returns {boolean}
     */
    const publish = place=>{
        const ended = finish(place, stateWord(HOT, 1));
        if (ended === ENDED)
        {
            index.stamp(place.id);
            index.leave(place.id);
        }
        return ended !== LATE;
    };

    /**
     * Room for `name`'s body from the keeper, an earlier reservation of the
     * name here let go of first: the place, in a segment this reader can
     * write, or null with why counted.
     *
     * @param {string} name @param {number} length
     * @param {Parameters<typeof askOf>[0]} options
     * @returns {Place | null}
     */
    const reserveRoom = (name, length, options)=>{
        // A second reserve of a name not committed yet replaces the first.
        self.abandon(name);
        const place = keeper.reserve(name, length, askOf(options));
        if (place === null)
        {
            counts.refused++;
            return null;
        }
        const view = views[place.segment];
        if (view === null || view === undefined)
        {
            // Placed where this reader cannot write: given back.
            letGo(place);
            counts.refused++;
            return null;
        }
        if (!stillReserved(place))
        {
            // Taken back before a byte was written: nothing to give back.
            counts.late++;
            return null;
        }
        counts.reserved++;
        return place;
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
                const before = views[message.segment];
                views[message.segment] = message.buffer ? new Uint8Array(message.buffer) : null;
                if (before)
                {
                    for (let id = 0; id < bodyViews.length; id++)
                    {
                        if (bodyViews[id]?.buffer === before.buffer)
                        {
                            bodyViews[id] = undefined;
                        }
                    }
                }
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
        reserve(name, length, options){
            checkName(name);
            const place = reserveRoom(name, length, options);
            if (place === null)
            {
                return null;
            }
            writing.set(name, place);
            return /** @type {Uint8Array} */ (views[place.segment]).subarray(place.offset, place.offset + length);
        },

        /**
         * Memory of `length` bytes held under `name`: a view this reader
         * writes and reads in place for as long as it holds it, which the
         * keeper never takes back, cools or moves, and no one reads through
         * `with`: memory, not a body. Counted under its name and in the
         * keeper's budget like any body; never on the disk. Let go of with
         * `abandon`, its room the keeper's again at its next reserve. Null
         * where there is no room, or where the room is in a segment this
         * reader cannot write.
         *
         * @param {string} name @param {number} length
         * @returns {Uint8Array | null}
         */
        hold(name, length){
            checkName(name);
            const place = reserveRoom(name, length, { disk: 'never', hold: true });
            if (place === null)
            {
                return null;
            }
            writing.set(name, place);
            return /** @type {Uint8Array} */ (views[place.segment]).subarray(place.offset, place.offset + length);
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
            return publish(place);
        },

        /**
         * Lets go of a reservation without a body (a writer that failed):
         * the name is left with none, as `reserve` took its body before away,
         * and the room goes back to the keeper at its next reserve. Nothing
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
            letGo(place);
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
            // `reserve` and `commit` without their view or their entry in
            // `writing`: a put holds its reservation only for the copy.
            const place = reserveRoom(name, taken.length, options);
            if (place === null)
            {
                return false;
            }
            try
            {
                /** @type {Uint8Array} */ (views[place.segment]).set(taken, place.offset);
            }
            catch (e){
                letGo(place);
                throw e;
            }
            return publish(place);
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
