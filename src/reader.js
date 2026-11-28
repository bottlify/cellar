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
    COLD, F_HELD, F_NO_DISK, GONE, HOT, H_LET_GO, MOVING, PLACE_WORDS, P_ID, P_MARK, P_OFFSET, P_SEGMENT,
    RETIRED, RETIRED_WRITING, R_LENGTH, R_OFFSET, R_SEGMENT, R_STATE, WRITING, checkName, stateWord,
    viewIndex,
} from './shared.js';
import { bytesOf } from './bytes.js';

/**
 * What the reader asks the keeper: `reserve`, `raise` and `drop` answer at
 * once, across a link by a blocking call; `raiseLater` is not waited on.
 * A reserve asks with its flags (`reserveFlags`) and the segments this reader
 * has, and is answered in the words of the reader's own place (`P_ID`...):
 * true where room was granted.
 *
 * @typedef {Object} KeeperCalls
 * @property {(name: string, length: number, flags: number, known: number, place: Int32Array)
 *     => boolean} reserve
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

/** Entries of ended reservations a reader keeps by name, at most (`writing`). */
const ENDED_MOST = 1 << 12;

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
    /**
     * The places of reservations made here and not committed yet, `PLACE_WORDS`
     * a slot: a slot taken for each, its index by name (`writing`), and given
     * back to `freeSlots` when the reservation ends. The first slot is where
     * the keeper answers (`GRANTED`), copied into a slot of its own only for a
     * reservation that outlives the call (`reserve`, `hold`): a `put` holds
     * none.
     */
    let places = new Int32Array(PLACE_WORDS * 8);
    /** Slots given back, for the next reservation. @type {number[]} */
    const freeSlots = [];
    /** Slots ever used, the first included. */
    let slotsUsed = 1;
    /**
     * Reserved and not committed yet: each name's slot, -1 for a name whose
     * reservation ended. An entry is kept when its reservation ends, so that
     * the next reserve of the name changes it in place: a map that empties
     * makes its table again at each delete. Past `ENDED_MOST` ended entries
     * (its size less the slots in use) the map is made again of those still
     * reserved.
     *
     * @type {Map<string, number>}
     */
    let writing = new Map();
    const GRANTED = 0;
    /**
     * Where the keeper writes its answer: a record that never moves, copied
     * to `GRANTED` once the reserve is back. A reserve that waits on a link
     * may meet a call that reserves here too and outgrows `places`; an
     * answer written into the array it was asked with would land in the one
     * let go of.
     */
    const granted = new Int32Array(PLACE_WORDS);
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
     * The view of record `id`'s room, `length` bytes at `offset` of `view`:
     * the one made last for the record while it is over the same bytes.
     *
     * @param {number} id @param {Uint8Array} view @param {number} offset @param {number} length
     */
    const viewOf = (id, view, offset, length)=>{
        let body = bodyViews[id];
        if (body === undefined || body.buffer !== view.buffer
            || body.byteOffset !== view.byteOffset + offset || body.length !== length)
        {
            body = view.subarray(offset, offset + length);
            bodyViews[id] = body;
        }
        return body;
    };

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
            readValue = read(viewOf(id, view, words[base + R_OFFSET], words[base + R_LENGTH]));
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
     * Whether the place in `slot` is still a reservation its writer may write
     * into: the keeper takes back one held past `abandonAfterMs`, and its room
     * may be another body's by now (a place granted ahead and handed over late).
     *
     * @param {number} slot
     */
    const stillReserved = slot=>{
        const id = places[slot + P_ID];
        const mark = places[slot + P_MARK];
        const word = Atomics.load(index.cover(id), index.at(id) + R_STATE);
        return word === stateWord(WRITING, mark) || word === stateWord(RETIRED_WRITING, mark);
    };

    /**
     * Ends the reservation in `slot` with its state word `word` (a body
     * published, entered once; or gone, for an abandon): `ENDED`, or `LEFT`
     * where the name was written anew meanwhile and the newer write is the
     * name's, the record retired and only its writer let out of it; `LATE`
     * where the keeper took it back, its writer too late.
     *
     * @param {number} slot @param {number} word
     */
    const finish = (slot, word)=>{
        const id = places[slot + P_ID];
        const words = index.cover(id);
        const at = index.at(id) + R_STATE;
        const mine = stateWord(WRITING, places[slot + P_MARK]);
        if (Atomics.compareExchange(words, at, mine, word) === mine)
        {
            return ENDED;
        }
        const retired = stateWord(RETIRED_WRITING, places[slot + P_MARK]);
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
     * @param {number} slot
     */
    const letGo = slot=>{
        counts.abandoned++;
        if (finish(slot, stateWord(GONE)) === ENDED)
        {
            Atomics.add(index.words, H_LET_GO, 1);
        }
    };

    /**
     * The body written at the place in `slot` made readable: false where it
     * came too late, the reservation taken back. Published entered, as a reader
     * enters it, and stamped before it is left: a record no one is in can be
     * taken back and given to the next reservation, whose age a stamp landing
     * late would set to the last sweep's. A record retired meanwhile no name
     * leads to: nothing stamps it.
     *
     * @param {number} slot @returns {boolean}
     */
    const publish = slot=>{
        const ended = finish(slot, stateWord(HOT, 1));
        if (ended === ENDED)
        {
            index.stamp(places[slot + P_ID]);
            index.leave(places[slot + P_ID]);
        }
        return ended !== LATE;
    };

    /**
     * Room for `name`'s body from the keeper, an earlier reservation of the
     * name here let go of first: true with the place in `GRANTED`, in a
     * segment this reader can write, or false with why counted.
     *
     * @param {string} name @param {number} length @param {number} flags
     * @returns {boolean}
     */
    const reserveRoom = (name, length, flags)=>{
        // A second reserve of a name not committed yet replaces the first.
        self.abandon(name);
        if (!keeper.reserve(name, length, flags, heard, granted))
        {
            counts.refused++;
            return false;
        }
        places.set(granted, GRANTED);
        const view = views[places[GRANTED + P_SEGMENT]];
        if (view === null || view === undefined)
        {
            // Placed where this reader cannot write: given back.
            letGo(GRANTED);
            counts.refused++;
            return false;
        }
        if (!stillReserved(GRANTED))
        {
            // Taken back before a byte was written: nothing to give back.
            counts.late++;
            return false;
        }
        counts.reserved++;
        return true;
    };

    /**
     * The place just granted kept in a slot of its own under `name`, until
     * its reservation ends (`endOf`): a view of it to write into, made once
     * for its record's room and handed again to a read of it (`bodyViews`).
     *
     * @param {string} name @param {number} length @returns {Uint8Array}
     */
    const keep = (name, length)=>{
        let slot = freeSlots.pop();
        if (slot === undefined)
        {
            slot = slotsUsed++ * PLACE_WORDS;
            if (slot + PLACE_WORDS > places.length)
            {
                const more = new Int32Array(places.length * 2);
                more.set(places);
                places = more;
            }
        }
        places[slot + P_ID] = places[GRANTED + P_ID];
        places[slot + P_SEGMENT] = places[GRANTED + P_SEGMENT];
        places[slot + P_OFFSET] = places[GRANTED + P_OFFSET];
        places[slot + P_MARK] = places[GRANTED + P_MARK];
        writing.set(name, slot);
        return viewOf(places[slot + P_ID], /** @type {Uint8Array} */ (views[places[slot + P_SEGMENT]]),
            places[slot + P_OFFSET], length);
    };

    /**
     * The slot of `name`'s reservation, taken off it and free for the next:
     * -1 where `name` is not reserved here. Valid until the next reservation.
     *
     * @param {string} name
     */
    const endOf = name=>{
        const slot = writing.get(name);
        if (slot === undefined || slot < 0)
        {
            return -1;
        }
        writing.set(name, -1);
        freeSlots.push(slot);
        if (writing.size - (slotsUsed - 1 - freeSlots.length) > ENDED_MOST)
        {
            writing = new Map([...writing].filter(([, kept])=>kept >= 0));
        }
        return slot;
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
         * `flags`: what the body asks for (`reserveFlags`), none by default.
         *
         * @param {string} name @param {number} length @param {number} [flags]
         */
        reserve(name, length, flags = 0){
            checkName(name);
            if ((flags & F_HELD) !== 0)
            {
                throw new RangeError('cache: a body is reserved, memory held (`hold`)');
            }
            return reserveRoom(name, length, flags) ? keep(name, length) : null;
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
            return reserveRoom(name, length, F_NO_DISK | F_HELD) ? keep(name, length) : null;
        },

        /**
         * Makes the body written into `reserve`'s view readable: false where
         * it came too late, the keeper having taken the reservation back
         * (`abandonAfterMs`), and the body is not readable.
         *
         * @param {string} name @returns {boolean}
         */
        commit(name){
            const slot = endOf(name);
            if (slot < 0)
            {
                throw new Error(`cache: ${name} was not reserved here`);
            }
            return publish(slot);
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
            const slot = endOf(name);
            if (slot >= 0)
            {
                letGo(slot);
            }
        },

        /**
         * `reserve`, a copy of `bytes`, `commit`: false where there was no
         * room, or the commit came too late.
         *
         * @param {string} name @param {Uint8Array} bytes @param {number} [flags]  as `reserve`'s
         */
        put(name, bytes, flags = 0){
            checkName(name);
            if ((flags & F_HELD) !== 0)
            {
                throw new RangeError('cache: a body is put, memory held (`hold`)');
            }
            // The bytes as long as they are now, which is what is copied.
            const taken = bytesOf(bytes, 'cache');
            // `reserve` and `commit` without a slot or a view: a put holds
            // its reservation only for the copy.
            if (!reserveRoom(name, taken.length, flags))
            {
                return false;
            }
            try
            {
                /** @type {Uint8Array} */ (views[places[GRANTED + P_SEGMENT]]).set(taken,
                    places[GRANTED + P_OFFSET]);
            }
            catch (e){
                letGo(GRANTED);
                throw e;
            }
            return publish(GRANTED);
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
