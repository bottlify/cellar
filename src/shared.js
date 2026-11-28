/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's index as every thread sees it: three pieces of shared memory
 * the keeper writes and every thread reads without asking anyone.
 *
 * - `records`: one record a name, at a fixed place (its id), in a growable
 *   buffer. A record says where the name's body is -- a segment and an offset
 *   while hot, a pack and an offset on the disk -- and, in one word, its state
 *   and how many threads read the body now. One word so that a reader coming
 *   in and the keeper taking the body away are decided by one
 *   compare-and-swap: the keeper takes only a body no one reads, a reader
 *   enters only a body still hot.
 * - `names`: each name, in UTF-16 units, appended once and never moved or
 *   written over: where a name lies says which name it is.
 * - `table`: name -> record, open addressing over the record's ids. The keeper
 *   builds a larger one when this one fills and sends it out; a thread still
 *   on the old one finds every name the old one held and misses the newer
 *   ones, which a cache may.
 *
 * A record's fields other than the state word change only while its state
 * says no reader can be inside (writing, moving, cold, gone), and the state is
 * stored after them: whoever enters a hot record reads its place as the keeper
 * wrote it. A record no name leads to any more (retired, then left by its
 * readers) goes back to the keeper for another name; so an id a thread
 * remembers, or found a moment before, may be another name's by the time it
 * enters, and a thread checks where the record's name lies (`holds`) once
 * inside.
 */

/** Records a run holds at most: an id fits in 20 bits. */
export const MAX_RECORDS = 1 << 20;

/** The records' header, in 32-bit words. */
export const HEADER_WORDS = 16;
/** Records made, the ones gone back to the keeper for another name included. */
export const H_COUNT = 0;
/** The keeper's clock, in ms since the store opened: a reader's use is stamped with it. */
export const H_TICK = 1;
/** Units of `names` in use. */
export const H_NAMES = 2;
/** What the words mean (`CACHE_LAYOUT`), so that memory of another layout, or none, is refused. */
export const H_LAYOUT = 3;
/**
 * Reservations let go of without a body, counted by the reader that let go
 * (`abandon`): the keeper's next `reserve` gives their room back when the
 * count moved, so memory let go of is room again at once, not at a sweep.
 */
export const H_LET_GO = 4;
/**
 * Moved by the keeper around each time it packs the names together (odd
 * while it does): a name lies where it was written until then, and a place
 * a reader remembers from before may be another name's after.
 */
export const H_NAMES_EPOCH = 5;
/** The layout these words are in: changed with any word's meaning. */
export const CACHE_LAYOUT = 0x43430c03;

/** A slot of the table a name left: passed over by a lookup, taken by the next name put there. */
export const TABLE_LEFT = -1;


/** One record, in 32-bit words. */
export const RECORD_WORDS = 12;
export const R_HASH_A = 0;
export const R_HASH_B = 1;
/**
 * State in the top 8 bits; in the 24 below, the readers inside (`HOT`,
 * `RETIRED`) or the reservation's mark (`WRITING`, `RETIRED_WRITING`).
 */
export const R_STATE = 2;
export const R_SEGMENT = 3;
export const R_OFFSET = 4;
export const R_LENGTH = 5;
/** `H_TICK` at the last use. */
export const R_TICK = 6;
export const R_NAME = 7;
export const R_NAME_LENGTH = 8;
/** The pack holding the body on the disk, -1 for none. */
export const R_PACK = 9;
export const R_PACK_OFFSET = 10;
export const R_FLAGS = 11;

/** The body has no other source: it may go to the disk, never away. */
export const F_ONLY_COPY = 1;
/** The disk's copy is the body's: going cold writes nothing. */
export const F_ON_DISK = 2;
/** Asked away while read: the keeper takes it once the readers are out. */
export const F_DROP = 4;
/** On the disk only for this run: the saved index leaves it out (`disk: 'run'`). */
export const F_THIS_RUN = 8;
/** Never written to the disk (`disk: 'never'`). */
export const F_NO_DISK = 16;
/**
 * Idle, it stays hot: it leaves only when its room is wanted (`idle: 'stay'`),
 * for a body read again long after it was written. This run's alone: a saved
 * index keeps no more of a body's flags than `F_ONLY_COPY`.
 */
export const F_FOR_ROOM = 32;
/**
 * Memory held (`hold`): a reservation its holder writes and reads in place
 * for as long as it holds it, never taken back by `abandonAfterMs`. This
 * run's alone, as every reservation is.
 */
export const F_HELD = 64;

/**
 * What a reservation may ask for, as a word (`reserveFlags`): its record's own
 * flags, the keeper storing the word as it is asked. `F_HELD` is `hold`'s.
 */
const ASKED = F_ONLY_COPY | F_THIS_RUN | F_NO_DISK | F_FOR_ROOM | F_HELD;

/**
 * Whether `flags` is a reservation's word: no bit a reservation does not ask
 * for, and no body both on the disk for this run only and never on it.
 *
 * @param {number} flags
 */
export const isFlags = flags=>flags === (flags | 0) && (flags & ~ASKED) === 0
    && (flags & (F_THIS_RUN | F_NO_DISK)) !== (F_THIS_RUN | F_NO_DISK);

/** Throws where `flags` is no reservation's word (`isFlags`). @param {number} flags */
export const checkFlags = flags=>{
    if (!isFlags(flags))
    {
        throw new RangeError(`cache: reservation flags ${String(flags)}`);
    }
};

/**
 * Where a body may go on the disk: `kept` there and named in the saved index
 * for the next run (the default), there for this `run` only (a cold body that
 * means nothing to the next run: texels a GPU was given, say), or `never`
 * (one the disk must not hold, or not worth a write).
 *
 * @typedef {'kept' | 'run' | 'never'} DiskPolicy
 */

/**
 * The word a `reserve` or a `put` asks with, made once by whoever writes a
 * kind of body, not at each write: `onlyCopy`, bodies that cannot be made
 * again, which go to the disk and never away; `disk`, where a body may go on
 * the disk (`DiskPolicy`); `idle`, whether an idle body goes by the keeper's
 * idle rule (`'go'`) or stays until its room is wanted (`'stay'`). No options
 * are 0.
 *
 * @param {{ onlyCopy?: boolean, disk?: DiskPolicy, idle?: 'go' | 'stay' }} [options]
 */
export function reserveFlags({ onlyCopy = false, disk = 'kept', idle = 'go' } = {}){
    if (disk !== 'kept' && disk !== 'run' && disk !== 'never')
    {
        throw new RangeError(`cache: a disk policy of ${String(disk)}`);
    }
    if (idle !== 'go' && idle !== 'stay')
    {
        throw new RangeError(`cache: an idle policy of ${String(idle)}`);
    }
    return (onlyCopy ? F_ONLY_COPY : 0) | (disk === 'run' ? F_THIS_RUN : disk === 'never' ? F_NO_DISK : 0)
        | (idle === 'stay' ? F_FOR_ROOM : 0);
}

/**
 * Room the keeper granted, as the words of a record its asker owns and hands
 * to every reserve (`KeeperCalls.reserve`), so that a reserve makes no object:
 * the body's record, the segment and offset to write it at, and the
 * reservation's mark, which `commit` names.
 */
export const P_ID = 0;
export const P_SEGMENT = 1;
export const P_OFFSET = 2;
export const P_MARK = 3;
export const PLACE_WORDS = 4;

/** No body: never had one, or dropped; or a record no name leads to any more. */
export const GONE = 0;
/**
 * Being written by the thread that reserved it. No one reads a body being
 * written, so the word's low bits are not readers but the reservation's mark,
 * which the writer's `commit` names: a reservation the keeper took back (its
 * writer gone, `abandonAfterMs`) is no writer's to commit any more.
 */
export const WRITING = 1;
/** In a segment. */
export const HOT = 2;
/** On the disk only. */
export const COLD = 3;
/**
 * The keeper is moving the body: out of its segment (to the disk or away),
 * back from the disk, or held while room for the name's next body is found.
 * The keeper's thread does nothing else meanwhile, so a call to it is answered
 * once the move is over.
 */
export const MOVING = 4;
/**
 * A body whose name was written anew while it was read: the name leads to a
 * new record now, the readers inside this one finish, no one enters, and its
 * room goes once they are out, the record with it.
 */
export const RETIRED = 5;
/**
 * A reservation whose name was written anew before it was committed: the
 * name leads to a new record, the mark is kept, and the room goes once the
 * writer commits or abandons, or the keeper takes it back.
 */
export const RETIRED_WRITING = 6;

const READERS = 0xffffff;

/** @param {number} word */
export const stateOf = word=>word >>> 24;
/** @param {number} word */
export const readersOf = word=>word & READERS;
/** @param {number} state @param {number} [readers] */
export const stateWord = (state, readers = 0)=>((state << 24) | readers) | 0;

/**
 * Two 32-bit lanes of FNV-1a over the name's UTF-16 units, each from its own
 * basis, into `lanes`: the table probes by the first, a record is matched by
 * both and then by its name. Written into an array the caller keeps, so a
 * lookup makes nothing on the heap; always an `Int32Array`, so the stores
 * here meet one kind of array (fed two, a miss ran a third slower, V8).
 *
 * @param {string} name @param {Int32Array} lanes
 */
export function hashInto(name, lanes){
    let a = 0x811c9dc5;
    let b = 0x050c5d1f;
    for (let i = 0; i < name.length; i++)
    {
        const unit = name.charCodeAt(i);
        a = Math.imul(a ^ unit, 0x01000193);
        b = Math.imul(b ^ (unit + i), 0x01000193);
    }
    lanes[0] = a | 0;
    lanes[1] = b | 0;
}

/**
 * The two lanes of `hashInto`, in an array of their own.
 *
 * @param {string} name
 * @returns {[number, number]}
 */
export function hashName(name){
    const lanes = new Int32Array(2);
    hashInto(name, lanes);
    return [lanes[0], lanes[1]];
}

/**
 * Throws where `name` is not a string: anything else has no units to hash and
 * no length to keep, and would be written into the names as nothing.
 *
 * @param {unknown} name
 */
export const checkName = name=>{
    if (typeof name !== 'string')
    {
        throw new TypeError(`cache: a name is a string, not ${name === null ? 'null' : typeof name}`);
    }
};

/**
 * A shared buffer that grows in place, every thread's views following it
 * (ES2024; the project's type library is older).
 *
 * @typedef {SharedArrayBuffer & { grow: (bytes: number) => void, maxByteLength: number }} Growable
 */

/**
 * Whether this page can share memory between threads. Without it (a page not
 * cross-origin isolated) every buffer is an ArrayBuffer of this thread's own,
 * and the cache is one thread's: the keeper's and its readers', all of them
 * here. Asked when a buffer is made, not when this module is loaded.
 */
export const canShare = ()=>typeof SharedArrayBuffer === 'function';

/**
 * A buffer every reader of the cache reads: shared where memory can be.
 *
 * @param {number} bytes @returns {SharedArrayBuffer}
 */
export const sharedBuffer = bytes=>/** @type {SharedArrayBuffer} */ (canShare()
    ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));

/**
 * A table of `slots` slots (a power of two), its generation in a word after
 * them: a reader takes a table of a later generation than its own, whatever
 * order the keeper's messages reach it in.
 *
 * @param {number} slots @param {number} generation
 */
export const tableBuffer = (slots, generation)=>{
    const buffer = sharedBuffer((slots + 1) * 4);
    new Int32Array(buffer)[slots] = generation;
    return buffer;
};
/** @param {SharedArrayBuffer} buffer */
export const tableSlots = buffer=>new Int32Array(buffer, 0, buffer.byteLength / 4 - 1);
/** @param {SharedArrayBuffer} buffer */
const generationOf = buffer=>new Int32Array(buffer)[buffer.byteLength / 4 - 1];

/**
 * @param {number} bytes @param {number} most
 * @returns {Growable}
 */
export const growableShared = (bytes, most)=>{
    const Buffer = canShare() ? SharedArrayBuffer : ArrayBuffer;
    // An engine of shared memory but not of growable buffers takes the
    // maximum and makes a buffer that never grows: the index would stop at
    // its first size.
    if (!('maxByteLength' in Buffer.prototype))
    {
        throw new Error(`cache: this engine's ${Buffer.name} cannot grow, which the index needs`);
    }
    return /** @type {Growable} */ (new /** @type {any} */ (Buffer)(bytes, { maxByteLength: most }));
};

/**
 * Grows a buffer of `growableShared` in place: a shared one grows, a thread's
 * own resizes.
 *
 * @param {Growable} buffer @param {number} bytes
 */
export const growTo = (buffer, bytes)=>{
    if (typeof buffer.grow === 'function')
    {
        buffer.grow(bytes);
    }
    else
    {
        /** @type {any} */ (buffer).resize(bytes);
    }
};

/**
 * @typedef {Object} SharedIndex
 * @property {Growable} records
 * @property {Growable} names
 * @property {SharedArrayBuffer} table
 */

/**
 * A thread's views over the index.
 *
 * @param {SharedIndex} shared
 */
export function viewIndex(shared){
    // Shared memory or, where none can be shared, a buffer of one thread's.
    if (!(shared?.records?.byteLength >= HEADER_WORDS * 4)
        || new Int32Array(shared.records, 0, HEADER_WORDS)[H_LAYOUT] !== CACHE_LAYOUT)
    {
        throw new Error('cache: the memory is not a cache of this layout');
    }
    // Views of the length the buffers have now, made again when a record or a
    // name lies past them: a view that follows a growable buffer's length is
    // read several times slower (V8). The buffers only grow.
    let words = new Int32Array(shared.records, 0, shared.records.byteLength >> 2);
    let names = new Uint16Array(shared.names, 0, shared.names.byteLength >> 1);
    let table = tableSlots(shared.table);
    let generation = generationOf(shared.table);
    /** The lanes of the name being looked up. */
    const lanes = new Int32Array(2);
    /** Where the name `find` matched last lies in `names`. */
    let matched = -1;

    /** @param {number} id */
    const at = id=>HEADER_WORDS + id * RECORD_WORDS;
    /**
     * The words, as far as record `id` at least.
     *
     * @param {number} id
     */
    const cover = id=>{
        if (at(id) + RECORD_WORDS > words.length)
        {
            words = new Int32Array(shared.records, 0, shared.records.byteLength >> 2);
        }
        return words;
    };

    /**
     * The record holding `name`, or -1; where the name lies in `matched`.
     *
     * @param {string} name
     */
    const find = name=>{
        hashInto(name, lanes);
        const a = lanes[0];
        const b = lanes[1];
        const mask = table.length - 1;
        for (let slot = a & mask, probes = 0; probes <= mask;
            slot = (slot + 1) & mask, probes++)
        {
            const entry = Atomics.load(table, slot);
            if (entry === 0)
            {
                return -1;
            }
            if (entry === TABLE_LEFT)
            {
                continue;
            }
            const view = cover(entry - 1);
            const base = at(entry - 1);
            if (view[base + R_HASH_A] === a && view[base + R_HASH_B] === b
                && view[base + R_NAME_LENGTH] === name.length)
            {
                const from = view[base + R_NAME];
                if (sameName(from, name))
                {
                    matched = from;
                    return entry - 1;
                }
            }
        }
        return -1;
    };
    /** @param {number} from @param {string} name */
    const sameName = (from, name)=>{
        if (from + name.length > names.length)
        {
            names = new Uint16Array(shared.names, 0, shared.names.byteLength >> 1);
        }
        for (let i = 0; i < name.length; i++)
        {
            if (names[from + i] !== name.charCodeAt(i))
            {
                return false;
            }
        }
        return true;
    };

    return {
        /** The records' words as far as this thread has looked: `cover` reaches further. */
        get words(){
            return words;
        },
        /** The names as far as this thread has looked. */
        get names(){
            return names;
        },
        at,
        cover,
        find,
        /** Where the name the last `find` found lies in `names`. */
        matched: ()=>matched,
        /** @param {SharedArrayBuffer} buffer */
        adoptTable(buffer){
            if (generationOf(buffer) > generation)
            {
                generation = generationOf(buffer);
                table = tableSlots(buffer);
            }
        },
        table: ()=>table,
        /**
         * Enters a hot record to read its body: true where it is hot and now
         * counts this reader, false where it is not hot.
         *
         * @param {number} id
         */
        enter(id){
            const view = cover(id);
            const index = at(id) + R_STATE;
            for (;;)
            {
                const word = Atomics.load(view, index);
                if (stateOf(word) !== HOT || readersOf(word) === READERS)
                {
                    return false;
                }
                if (Atomics.compareExchange(view, index, word, word + 1) === word)
                {
                    return true;
                }
            }
        },
        /** @param {number} id */
        leave(id){
            Atomics.sub(cover(id), at(id) + R_STATE, 1);
        },
        /** @param {number} id */
        state: id=>stateOf(Atomics.load(cover(id), at(id) + R_STATE)),
        /** The names' epoch now (`H_NAMES_EPOCH`): odd while the keeper packs them. */
        epoch: ()=>Atomics.load(words, H_NAMES_EPOCH),
        /**
         * Whether record `id`, entered or its state read just before, is the
         * name that lies at `nameAt`, `length` units long, found at names'
         * epoch `epoch`: a name stays where it was written until the keeper
         * packs the names, which moves the epoch first, so within one where it
         * lies says which it is. Inside a record the answer holds until this
         * thread leaves; outside, for the state read before it. The epoch is
         * loaded last: the state the thread saw was stored after any packing
         * that gave the record to a name of another epoch, so the load sees it
         * moved; and the entering, a read-modify-write, keeps the lookup's
         * plain reads of the names before it.
         *
         * @param {number} id @param {number} nameAt @param {number} length @param {number} epoch
         */
        holds(id, nameAt, length, epoch){
            const base = at(id);
            return words[base + R_NAME] === nameAt && words[base + R_NAME_LENGTH] === length
                && Atomics.load(words, H_NAMES_EPOCH) === epoch;
        },
        /** @param {number} id */
        stamp(id){
            const view = cover(id);
            view[at(id) + R_TICK] = Atomics.load(view, H_TICK);
        },
    };
}

/** @typedef {ReturnType<typeof viewIndex>} IndexView */
