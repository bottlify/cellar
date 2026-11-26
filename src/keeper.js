/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's keeper: the one thread that places, moves and drops bodies.
 * Every thread reads the index and the hot bodies by itself (`shared.js`); it
 * comes here only for room to write a body into (`reserve`), for a cold body
 * to be brought back (`raise`) and to drop a name.
 *
 * The hot part is segments of shared memory, `segmentBytes` each, as many as
 * the budget holds; a segment's room is handed out in powers of two
 * (`buddy.js`). A thread learns of a segment by a message (`announce`), and a
 * message reaches a thread only between its turns, so the keeper keeps the
 * next segment announced before it is needed, and places a writer's body only
 * in a segment the writer says it has (`known`).
 *
 * The cold part is packs on the disk, `packBytes` each, bodies appended; a
 * body written once stays valid there until its name is written anew, so a
 * body going cold again writes nothing. A pack mostly dead is compacted, what
 * is left of it appended anew, and the file let go. What the disk holds
 * survives the run: the index of it is saved (`save`, `index-file.js`) and
 * read back when the keeper opens.
 *
 * Bodies are of two kinds. One the cache can make again from its source (a
 * block of a bundle, a translation) goes cold when idle and away when idle
 * long, or at once where there is no disk. One that is the only copy of its
 * data (what a program wrote) goes to the disk, never away, and leaves memory
 * only once the disk holds it.
 */

import { blockOf, checkSegmentBytes, createBuddy } from './buddy.js';
import { BASE, DELTA, chunkWriter, readIndexFile } from './index-file.js';
import {
    COLD, F_DROP, F_FOR_ROOM, F_NO_DISK, F_ONLY_COPY, F_ON_DISK, F_THIS_RUN, GONE, HEADER_WORDS, HOT,
    CACHE_LAYOUT, H_COUNT, H_LAYOUT, H_NAMES, H_TICK, MAX_RECORDS,
    MOVING, RECORD_WORDS, RETIRED, RETIRED_WRITING, R_FLAGS, R_HASH_A, R_HASH_B, R_LENGTH, R_NAME,
    R_NAME_LENGTH, R_OFFSET, R_PACK, R_PACK_OFFSET, R_SEGMENT, R_STATE, R_TICK, WRITING,
    checkName, growableShared, growTo, sharedBuffer,
    hashName, readersOf, stateOf, stateWord, viewIndex,
} from './shared.js';

const MIB = 1024 * 1024;

/** Room the names reserve to grow into, as the records do: address space only, touched as used. */
const MAX_NAME_UNITS = 1 << 25;
/** The reservations' marks run from 1 to this, then round again (`WRITING`). */
const MAX_MARK = 0xffffff;
const FIRST_TABLE = 1024;
/** Packs a run opens at most: 64 TiB of the default packs. */
const MAX_PACKS = 1 << 20;
/** The keeper's two index files: a save goes to the one not holding the last whole base. */
export const INDEX_FILES = /** @type {const} */ (['index-a', 'index-b']);

/** A pack's file on the disk. @param {number} number */
export const packFile = number=>`pack-${number}`;

/**
 * Which of the two index files is the index: the whole one of the later
 * generation, -1 for neither.
 *
 * @param {(import('./index-file.js').IndexFileState | null)[]} read
 */
const newerIndex = read=>(read[1] !== null && (read[0] === null
    || read[1].generation > read[0].generation) ? 1 : read[0] !== null ? 0 : -1);

/**
 * The bodies a keeper's disk holds as its last saved index says, read without
 * a keeper and without writing anything: a page asking how much of a cache is
 * there, or putting a whole file together from its bodies. Each body by name,
 * in pack `packFile(pack)` at `offset`, `length` bytes; `packs` every pack
 * whose file may be on the disk (one let go of is listed until its file is
 * gone); null where neither file is an index. A body past its pack's end is
 * the reader's to check: the index is true of the disk only as of its save.
 *
 * @param {(Uint8Array | null)[]} files  the bytes of `INDEX_FILES`, in order; null for one
 *     the disk does not have
 * @returns {{ packs: number[], bodies: Map<string, { pack: number, offset: number,
 *     length: number }> } | null}
 */
export function readSaved(files){
    const read = INDEX_FILES.map((_, at)=>{
        const bytes = files[at];
        return bytes ? readIndexFile(bytes, MAX_PACKS, F_ONLY_COPY) : null;
    });
    const chosen = newerIndex(read);
    const saved = chosen < 0 ? null : read[chosen];
    if (!saved)
    {
        return null;
    }
    return { packs: [...saved.packs], bodies: new Map([...saved.entries].map(([name, entry])=>
        [name, { pack: entry.pack, offset: entry.offset, length: entry.length }])) };
}

/**
 * Where a body may go on the disk: `kept` there and named in the saved index
 * for the next run (the default), there for this `run` only (a cold body that
 * means nothing to the next run: texels a GPU was given, say), or `never`
 * (one the disk must not hold, or not worth a write).
 *
 * @typedef {'kept' | 'run' | 'never'} DiskPolicy
 */
/** A map with no prototype: `toString` is no policy. @type {Record<string, number>} */
const POLICY_FLAGS = Object.assign(Object.create(null),
    { kept: 0, run: F_THIS_RUN, never: F_NO_DISK });

/**
 * A pack whose bodies fill less than this share of its file is compacted:
 * what is left of it is written anew, and the file goes. Moving a quarter to
 * free the rest writes at most a third of a byte for each byte given back.
 */
const COMPACT_LIVE = 1 / 4;

/** What `append` answers where it wrote nothing: no pack open yet, or the disk refused. */
const NOT_YET = -1;
const REFUSED = -2;

/**
 * A file on the disk as the keeper uses it: the shape of a
 * `FileSystemSyncAccessHandle`. Its methods are called on the keeper's thread
 * in the middle of its work and call none of the keeper's methods; one that
 * throws, or writes less than asked, is a failure of the disk, counted
 * (`diskFailures`), and the body stays where it was. A body read back short
 * says its pack holds less than the index: one that can be made again is
 * gone (`lostOnDisk`); an only copy stays cold, the read counted a failure,
 * for the keeper never lets an only copy go on its own judgement, and a run
 * reading its pack afresh skips it there if the pack is short (counted).
 *
 * @typedef {Object} DiskFile
 * @property {(view: Uint8Array, options: { at: number }) => number} read
 * @property {(view: Uint8Array, options: { at: number }) => number} write
 * @property {() => void} flush
 * @property {() => number} getSize
 * @property {(size: number) => void} truncate
 * @property {() => void} close
 */

/**
 * @typedef {Object} Disk
 * @property {(name: string) => DiskFile | Promise<DiskFile>} open  made where missing
 * @property {(name: string) => void | Promise<void>} [remove]
 */

/**
 * @typedef {Object} KeeperOptions
 * @property {number} budget  bytes of segments at most
 * @property {number} [segmentBytes]
 * @property {Disk | null} [disk]
 * @property {number} [packBytes]
 * @property {number} [coldAfterMs]  idle so long, a hot body goes to the disk
 * @property {number} [goneAfterMs]  idle so long, a cold body that can be made again goes
 * @property {number} [releaseAfterMs]  empty so long, a segment is let go
 * @property {number} [abandonAfterMs]  reserved so long and not committed, a reservation is
 *     taken back: its writer is taken for gone, its room given back, and its commit fails
 * @property {(message: { segment?: number, buffer?: SharedArrayBuffer | null,
 *     table?: SharedArrayBuffer }) => unknown} [announce]  sent to every thread reading:
 *     called on the keeper's thread in the middle of its work, it calls none of
 *     the keeper's methods; one that throws, or answers a promise that rejects,
 *     is counted (`announceFailures`)
 * @property {() => number} [now]
 */

/**
 * @param {KeeperOptions} options
 */
export async function openKeeper(options){
    const {
        budget, segmentBytes = 16 * MIB, packBytes = 64 * MIB,
        coldAfterMs = 30_000, goneAfterMs = 7 * 24 * 3600_000, releaseAfterMs = 10_000,
        abandonAfterMs = 300_000, announce = ()=>{}, now = ()=>performance.now(),
    } = options;
    /** The disk, null once closed: from then on the keeper is memory's only. */
    let disk = options.disk ?? null;
    // Ages are told on a 32-bit clock that wraps (`age`): a span past half of
    // it would read as a fresh one.
    for (const [name, ms] of Object.entries({ coldAfterMs, goneAfterMs, releaseAfterMs,
        abandonAfterMs }))
    {
        if (!(ms >= 0 && ms < 2 ** 31))
        {
            throw new RangeError(`cache: ${name} ${ms} is not a span of 0 to 24.8 days`);
        }
    }
    checkSegmentBytes(segmentBytes);
    // NaN compares false to every sum: no limit at all.
    if (typeof budget !== 'number' || !(budget >= 0) || !Number.isFinite(budget))
    {
        throw new RangeError(`cache: a budget of ${budget} bytes`);
    }
    // A body's place in a segment and in a pack is a 32-bit word of its record.
    if (!(packBytes > 0 && packBytes < 2 ** 31))
    {
        throw new RangeError(`cache: packs of ${packBytes} bytes: a pack holds under 2 GiB`);
    }
    const shared = {
        records: growableShared((HEADER_WORDS + 1024 * RECORD_WORDS) * 4,
            (HEADER_WORDS + MAX_RECORDS * RECORD_WORDS) * 4),
        names: growableShared(64 * 1024, MAX_NAME_UNITS * 2),
        table: sharedBuffer(FIRST_TABLE * 4),
    };
    new Int32Array(shared.records, 0, HEADER_WORDS)[H_LAYOUT] = CACHE_LAYOUT;
    const index = viewIndex(shared);
    /**
     * The keeper's own views of the records and the names, of the length the
     * buffers have now: a view that follows a growable buffer's length is
     * read several times slower (V8), and the keeper, the one thread that
     * grows them, makes these again when it does.
     */
    let words = new Int32Array(shared.records, 0, shared.records.byteLength / 4);
    let names = new Uint16Array(shared.names, 0, shared.names.byteLength / 2);
    const started = now();

    /**
     * The segments by number, null for one let go: a number is never given
     * twice, so a thread that has not heard a segment went still reads
     * through its old view and never sees another body under that number.
     *
     * @type {({ buffer: SharedArrayBuffer, bytes: Uint8Array, buddy: import('./buddy.js').Buddy,
     *     emptySince: number } | null)[]}
     */
    const segments = [];
    /** The numbers of the segments not let go, in order: what is placed in and counted. @type {number[]} */
    const liveSegments = [];
    /**
     * The packs on the disk by number, `pack-<number>`. A number is not given
     * twice in a run, nor one either index file names: a run after a torn
     * save may still read a pack let go of.
     *
     * @type {Map<number, DiskFile>}
     */
    const packs = new Map();
    /**
     * Packs let go of whose file may still be on the disk: removed behind a
     * promise not kept yet, or the disk failed to remove or cut it. Every
     * save lists them, so that a run reading the index lets go of what this
     * one could not, and no file is left that no index lists.
     *
     * @type {Set<number>}
     */
    const going = new Set();
    /** Bytes each pack's file holds as far as this run knows, and of them bodies a record leads to. */
    /** @type {Map<number, number>} */
    const filled = new Map();
    /** @type {Map<number, number>} */
    const live = new Map();
    /** The number the next pack opened takes. */
    let nextPackNumber = 0;
    /** The pack bodies are appended to, and where. */
    let pack = -1;
    let packTop = 0;
    /** The next pack, opened ahead: opening a file may not be synchronous. @type {Promise<DiskFile> | null} */
    let nextPack = null;
    /** Its number while it opens, -1 for none: listed, since its file may be made already. */
    let opening = -1;
    /** @type {{ number: number, file: DiskFile } | null} */
    let readyPack = null;
    /** The disk refused a write since the last sweep: room is made on it then. */
    let refused = false;
    /**
     * Records whose entry in the saved index may have changed since the last
     * save: each the record its name leads to (`replaceRecord` hands it on).
     *
     * @type {Set<number>}
     */
    const changed = new Set();
    /** The packs whose file may be on the disk are not the ones the last save listed. */
    let packsChanged = false;
    /** Closed: no file is opened any more. */
    let closed = false;

    const counts = {
        reserved: 0, refusedRoom: 0, refusedLarge: 0, refusedUnseen: 0,
        replaced: 0, raised: 0, raiseFailed: 0, cooled: 0, written: 0, writtenBytes: 0, gone: 0,
        loaded: 0, saved: 0, segmentsMade: 0, segmentsLetGo: 0, letGoBytes: 0, deadDiskBytes: 0,
        diskFailures: 0, lostOnDisk: 0, abandoned: 0, skippedEntries: 0, announceFailures: 0,
        segmentFailures: 0, wholeSaves: 0, savedBytes: 0, compactedBytes: 0, packsRemoved: 0,
        reclaimedBytes: 0, evicted: 0, lostAtClose: 0, takenBack: 0, oldestListed: 0,
        released: 0, releasedBytes: 0,
    };

    /**
     * Tells every thread reading of a segment or a table. One that throws is
     * counted, and the keeper goes on: a thread not told of a segment is
     * never placed in it (a reader's `known`), one not told of a larger table
     * finds the names the old one holds.
     *
     * @param {{ segment?: number, buffer?: SharedArrayBuffer | null, table?: SharedArrayBuffer }} message
     */
    const tell = message=>{
        try
        {
            const answer = /** @type {unknown} */ (announce(message));
            // One that answers a promise fails later: counted then, never an
            // unhandled rejection of the keeper's.
            if (typeof (/** @type {any} */ (answer)?.then) === 'function')
            {
                /** @type {PromiseLike<unknown>} */ (answer).then(undefined, ()=>{
                    counts.announceFailures++;
                });
            }
        }
        catch {
            counts.announceFailures++;
        }
    };

    /**
     * The clock in ms since the keeper opened, as a 32-bit word: it wraps
     * after 24.8 days, so times are compared by `age`, never by size.
     */
    const tick = ()=>Math.max(0, Math.floor(now() - started)) | 0;
    /**
     * How long since `since`, both of `tick`. A stamp is never after the
     * clock, so a difference past half the word is one that long ago or more.
     *
     * @param {number} at @param {number} since
     */
    const age = (at, since)=>{
        const ms = (at - since) | 0;
        return ms < 0 ? 2 ** 31 : ms;
    };

    // --- records ------------------------------------------------------------

    /** @param {number} id @param {number} field */
    const get = (id, field)=>words[index.at(id) + field];
    /** @param {number} id @param {number} field @param {number} value */
    const set = (id, field, value)=>{
        words[index.at(id) + field] = value;
    };
    /** @param {number} id */
    const stateWordOf = id=>Atomics.load(words, index.at(id) + R_STATE);
    /** @param {number} id @param {number} state */
    const store = (id, state)=>Atomics.store(words, index.at(id) + R_STATE, stateWord(state));

    /** @param {number} need  units */
    const growNames = need=>{
        const units = shared.names.byteLength / 2;
        if (need > units)
        {
            growTo(shared.names, Math.min(MAX_NAME_UNITS, Math.max(need, units * 2)) * 2);
            names = new Uint16Array(shared.names, 0, shared.names.byteLength / 2);
        }
    };

    /**
     * Records no name leads to any more (retired, then left by their
     * readers), kept for the next name or rewrite that needs one: a name
     * written anew while read takes a record, and gives one back once read.
     *
     * @type {number[]}
     */
    const free = [];
    /** Names in the table: what it is sized by (each name leads to one record). */
    let named = 0;
    /** The mark the next reservation takes (`WRITING`). */
    let nextMark = 1;

    /**
     * The record of `name`, made where there is none.
     *
     * @param {string} name
     */
    const recordOf = name=>{
        const known = index.find(name);
        if (known >= 0)
        {
            return known;
        }
        const from = words[H_NAMES];
        // Room for its record first: a name written for none would be spent.
        if ((free.length === 0 && words[H_COUNT] >= MAX_RECORDS) || from + name.length > MAX_NAME_UNITS)
        {
            return -1;
        }
        growNames(from + name.length);
        for (let i = 0; i < name.length; i++)
        {
            names[from + i] = name.charCodeAt(i);
        }
        words[H_NAMES] = from + name.length;
        const [a, b] = hashName(name);
        const id = newRecord(a, b, from, name.length);
        insert(id, a);
        return id;
    };

    /**
     * A record of no body yet, one given back or a new one at the end of the
     * records, not in the table: its id, or -1 where the records are full.
     *
     * @param {number} a @param {number} b @param {number} nameAt @param {number} nameLength
     */
    const newRecord = (a, b, nameAt, nameLength)=>{
        const count = words[H_COUNT];
        const id = free.length > 0 ? /** @type {number} */ (free.pop()) : count;
        if (id >= MAX_RECORDS)
        {
            return -1;
        }
        const bytesNeeded = (HEADER_WORDS + (id + 1) * RECORD_WORDS) * 4;
        if (bytesNeeded > shared.records.byteLength)
        {
            growTo(shared.records, Math.min(shared.records.maxByteLength,
                Math.max(bytesNeeded, shared.records.byteLength * 2)));
            words = new Int32Array(shared.records, 0, shared.records.byteLength / 4);
        }
        // A record given back is gone: no one enters it while its name is
        // written, and the state stored after says whose it is now.
        set(id, R_HASH_A, a);
        set(id, R_HASH_B, b);
        set(id, R_NAME, nameAt);
        set(id, R_NAME_LENGTH, nameLength);
        set(id, R_SEGMENT, -1);
        set(id, R_PACK, -1);
        set(id, R_FLAGS, 0);
        store(id, GONE);
        if (id === count)
        {
            Atomics.store(words, H_COUNT, id + 1);
        }
        return id;
    };

    /**
     * The name of record `old` led to a new record from now on, its name
     * shared; `old` retired, its readers or its writer left to finish. The new
     * one's id, or -1 where the records are full.
     *
     * @param {number} old
     */
    const replaceRecord = old=>{
        const id = newRecord(get(old, R_HASH_A), get(old, R_HASH_B), get(old, R_NAME),
            get(old, R_NAME_LENGTH));
        if (id < 0)
        {
            return -1;
        }
        const table = index.table();
        const mask = table.length - 1;
        for (let slot = get(old, R_HASH_A) & mask; ; slot = (slot + 1) & mask)
        {
            if (table[slot] === old + 1)
            {
                Atomics.store(table, slot, id + 1);
                break;
            }
        }
        for (;;)
        {
            // A reservation keeps its mark for its writer's commit; a body read
            // keeps its readers.
            const word = stateWordOf(old);
            const retired = stateOf(word) === WRITING ? stateWord(RETIRED_WRITING, readersOf(word))
                : stateWord(RETIRED, readersOf(word));
            if (Atomics.compareExchange(words, index.at(old) + R_STATE, word, retired) === word)
            {
                break;
            }
        }
        // The name leads to the new record: its entry is said by that one.
        changed.delete(old);
        changed.add(id);
        counts.replaced++;
        return id;
    };

    /**
     * Record `id`, retired and no one in it any more, now gone: its room
     * given back and the record kept for another name (`free`).
     *
     * @param {number} id
     */
    const letGo = id=>{
        if (get(id, R_SEGMENT) >= 0)
        {
            giveBack(id);
        }
        forgetDisk(id, false);
        set(id, R_FLAGS, 0);
        // No name leads to it: nothing of it is the saved index's.
        changed.delete(id);
        free.push(id);
    };

    /**
     * Takes record `id` back where it is retired and no one is in it: true
     * where it was, and is gone now (`letGo`).
     *
     * @param {number} id
     */
    const takeRetired = id=>{
        const empty = stateWord(RETIRED);
        if (Atomics.compareExchange(words, index.at(id) + R_STATE, empty, stateWord(GONE)) !== empty)
        {
            return false;
        }
        letGo(id);
        return true;
    };

    /** @param {number} id @param {number} first */
    const insert = (id, first)=>{
        let table = index.table();
        if ((named + 1) * 2 > table.length)
        {
            const larger = sharedBuffer(table.length * 2 * 4);
            const into = new Int32Array(larger);
            const mask = into.length - 1;
            // What the table leads to now, not every record: a retired one
            // is no name's any more, and put back it would lead its name to
            // a body written over since.
            for (const entry of table)
            {
                if (entry === 0)
                {
                    continue;
                }
                let slot = get(entry - 1, R_HASH_A) & mask;
                while (into[slot] !== 0)
                {
                    slot = (slot + 1) & mask;
                }
                into[slot] = entry;
            }
            index.adoptTable(larger);
            shared.table = larger;
            table = into;
            tell({ table: larger });
        }
        const mask = table.length - 1;
        let slot = first & mask;
        while (table[slot] !== 0)
        {
            slot = (slot + 1) & mask;
        }
        Atomics.store(table, slot, id + 1);
        named++;
    };

    // --- segments -----------------------------------------------------------

    /** A new segment, announced, or -1 past the budget. */
    const makeSegment = ()=>{
        if ((liveSegments.length + 1) * segmentBytes > budget)
        {
            return -1;
        }
        /** @type {SharedArrayBuffer} */
        let buffer;
        try
        {
            buffer = sharedBuffer(segmentBytes);
        }
        catch {
            // Memory the engine will not give now: as a budget spent, room is
            // found by cooling, counted.
            counts.segmentFailures++;
            return -1;
        }
        const at = segments.length;
        segments.push({ buffer, bytes: new Uint8Array(buffer), buddy: createBuddy(segmentBytes),
            emptySince: tick() });
        liveSegments.push(at);
        counts.segmentsMade++;
        tell({ segment: at, buffer });
        return at;
    };

    /** @param {number} at */
    const segmentAt = at=>/** @type {NonNullable<typeof segments[0]>} */ (segments[at]);

    /**
     * Whether a segment is made that a thread knowing the first `known` does
     * not have.
     *
     * @param {number} known
     */
    const beyond = known=>liveSegments.length > 0 && liveSegments[liveSegments.length - 1] >= known;

    /** One segment no body is in, announced ahead of need, where the budget has room. */
    const keepSpare = ()=>{
        if (!liveSegments.some(at=>segmentAt(at).buddy.empty()))
        {
            makeSegment();
        }
    };

    /**
     * Room for `length` bytes in a segment below `limit`: where it is, or null.
     *
     * @param {number} length @param {number} limit
     */
    const placeIn = (length, limit)=>{
        for (const at of liveSegments)
        {
            if (at >= limit)
            {
                break;
            }
            const offset = segmentAt(at).buddy.place(length);
            if (offset >= 0)
            {
                return { segment: at, offset };
            }
        }
        return null;
    };

    /**
     * The hot bodies no one read, oldest first, as they were when listed, by
     * key: the age's complement above, the id below (ids under 2^20, ages at
     * most 2^31: exact in a double, and sorted as numbers). Each body's stamp
     * then is beside it. Room is taken from the front, across reserves, and
     * the list is made again only once used up: a full cache pays one walk
     * over the records for many reserves, not one each. A body read since it
     * was listed (its stamp moved) is not old any more and is passed over; one
     * made hot since is newer than every one listed and waits for the next
     * list.
     */
    let oldestKeys = new Float64Array(0);
    let oldestTicks = new Int32Array(0);
    let oldestCount = 0;
    let oldestNext = 0;
    /**
     * What the lists of a tick showed gives no room, so that a reserve asking
     * the same in the same tick is refused for the price of one look, not a
     * walk over every record. A body may leave again without the keeper being
     * told (a reader commits it or lets go of it in the shared words), so
     * nothing is remembered past the tick it was learnt in.
     * `fruitlessAt`: the tick a fresh list held no candidate at all - no body
     * hot and unread - which no request of any size, segments known or record
     * spared can be placed by. `fruitless`: the requests of `fruitlessTick` a
     * list with candidates gave no room for, by block, segments known and
     * record spared: the refusal of a large block says nothing of a small one.
     */
    let fruitlessAt = -1;
    let fruitlessTick = -1;
    /** @type {Set<string>} */
    const fruitless = new Set();

    const listOldest = ()=>{
        const count = words[H_COUNT];
        if (oldestKeys.length < count)
        {
            oldestKeys = new Float64Array(count);
            oldestTicks = new Int32Array(count);
        }
        const at = tick();
        let listed = 0;
        for (let id = 0; id < count; id++)
        {
            const word = stateWordOf(id);
            if (stateOf(word) === HOT && readersOf(word) === 0)
            {
                oldestKeys[listed++] = (2 ** 31 - age(at, get(id, R_TICK))) * MAX_RECORDS + id;
            }
        }
        oldestKeys.subarray(0, listed).sort();
        for (let i = 0; i < listed; i++)
        {
            oldestTicks[i] = get(oldestKeys[i] % MAX_RECORDS, R_TICK);
        }
        oldestCount = listed;
        oldestNext = 0;
        counts.oldestListed++;
    };

    /**
     * The next listed body that may go for room below `limit`, -1 once the
     * list is used up.
     *
     * @param {number} limit @param {number} spare  never this record
     */
    const nextOldest = (limit, spare)=>{
        while (oldestNext < oldestCount)
        {
            const i = oldestNext++;
            const id = oldestKeys[i] % MAX_RECORDS;
            const word = stateWordOf(id);
            if (stateOf(word) === HOT && readersOf(word) === 0 && get(id, R_TICK) === oldestTicks[i]
                && id !== spare && get(id, R_SEGMENT) < limit)
            {
                return id;
            }
        }
        return -1;
    };

    /**
     * Whether the body in a block can leave it now: a reservation let go of,
     * a record retired that no one is in, or a hot body no one reads that can
     * go cold or away (an only copy only where it is on the disk, asked away,
     * or the disk can take it).
     *
     * @param {number} id @param {number} spare  never this record
     */
    const canLeave = (id, spare)=>{
        const word = stateWordOf(id);
        const state = stateOf(word);
        if (state === GONE || (state === RETIRED && readersOf(word) === 0))
        {
            return true;
        }
        if (state !== HOT || readersOf(word) !== 0 || id === spare)
        {
            return false;
        }
        const flags = get(id, R_FLAGS);
        return (flags & F_ONLY_COPY) === 0 || (flags & (F_ON_DISK | F_DROP)) !== 0
            || (disk !== null && (flags & F_NO_DISK) === 0);
    };

    /**
     * Takes the body in a block out of it (`canLeave`): false where it stays.
     *
     * @param {number} id
     */
    const leave = id=>{
        const state = stateOf(stateWordOf(id));
        if (state === GONE)
        {
            giveBack(id);
            return true;
        }
        return state === RETIRED ? takeRetired(id) : cool(id);
    };

    /**
     * Room for `length` bytes, the least recently used bodies made cold to
     * find it, but only where that forms a block for it: a body is taken out
     * only with every other in the block of the size asked it lies in, and
     * only where all of them can leave. A request no block can be formed for
     * moves nothing.
     *
     * @param {number} length @param {number} limit  segments a writer has
     * @param {number} [spare]  the record the room is for, never cooled for it
     */
    const room = (length, limit, spare = -1)=>{
        let found = placeIn(length, limit);
        if (found !== null)
        {
            return found;
        }
        const made = makeSegment();
        if (made >= 0 && made < limit)
        {
            found = placeIn(length, limit);
            if (found !== null)
            {
                return found;
            }
        }
        const block = blockOf(length);
        /** Blocks found holding a body that cannot leave, by segment and offset: each looked at once. */
        /** @type {Set<number> | null} */
        let held = null;
        for (let listed = false; ;)
        {
            const id = nextOldest(limit, spare);
            if (id < 0)
            {
                const now = tick();
                if (fruitlessTick !== now)
                {
                    fruitless.clear();
                    fruitlessTick = now;
                }
                const asked = `${block}:${limit}:${spare}`;
                if (listed)
                {
                    if (oldestCount === 0)
                    {
                        fruitlessAt = now;
                    }
                    else
                    {
                        fruitless.add(asked);
                    }
                    return null;
                }
                if (fruitlessAt === now || fruitless.has(asked))
                {
                    return null;
                }
                listOldest();
                listed = true;
                continue;
            }
            if (blockOf(get(id, R_LENGTH)) >= block)
            {
                // Its own block holds the body.
                if (!cool(id))
                {
                    continue;
                }
            }
            else
            {
                const segment = get(id, R_SEGMENT);
                const from = get(id, R_OFFSET) & -block;
                const key = segment * (segmentBytes / block) + from / block;
                if (held?.has(key))
                {
                    continue;
                }
                const inside = segmentAt(segment).buddy.ownersWithin(from, block);
                if (!inside.every(other=>canLeave(other, spare)))
                {
                    (held ??= new Set()).add(key);
                    continue;
                }
                if (!inside.every(leave))
                {
                    continue;
                }
            }
            found = placeIn(length, limit);
            if (found !== null)
            {
                return found;
            }
        }
    };

    /**
     * Record `id`'s body is at `found` from now on.
     *
     * @param {number} id @param {{ segment: number, offset: number }} found
     */
    const placeBody = (id, found)=>{
        set(id, R_SEGMENT, found.segment);
        set(id, R_OFFSET, found.offset);
        segmentAt(found.segment).buddy.own(found.offset, id);
    };

    /** @param {number} segment @param {number} offset @param {number} length */
    const giveRoom = (segment, offset, length)=>{
        const one = segments[segment];
        if (one !== null)
        {
            one.buddy.give(offset, length);
            if (one.buddy.empty())
            {
                one.emptySince = tick();
            }
        }
    };

    /** @param {number} id */
    const giveBack = id=>{
        giveRoom(get(id, R_SEGMENT), get(id, R_OFFSET), get(id, R_LENGTH));
        set(id, R_SEGMENT, -1);
    };

    // --- disk ---------------------------------------------------------------

    /** @param {DiskFile} file */
    const closeFile = file=>{
        try
        {
            file.close();
        }
        catch {
            counts.diskFailures++;
        }
    };

    const openNextPack = ()=>{
        if (disk !== null && !closed && nextPack === null && readyPack === null
            && nextPackNumber < MAX_PACKS)
        {
            const number = nextPackNumber++;
            const opener = disk;
            opening = number;
            packsChanged = true;
            // A disk that throws at once fails the same way as one whose
            // promise does: counted, and the body that wanted it stays.
            nextPack = Promise.resolve().then(()=>opener.open(packFile(number)))
                .then(file=>{
                    nextPack = null;
                    opening = -1;
                    // Opened after the keeper closed: let go of here, once, and
                    // removed where the disk can; the last index lists it, for
                    // the next run to let go of where this one did not.
                    if (closed)
                    {
                        closeFile(file);
                        Promise.resolve().then(()=>opener.remove?.(packFile(number)))
                            .catch(()=>{
                                counts.diskFailures++;
                            });
                        return file;
                    }
                    try
                    {
                        // A number no index names may still be a file a run
                        // left behind (a crash before it was listed): what it
                        // held is no one's.
                        file.truncate(0);
                    }
                    catch {
                        counts.diskFailures++;
                    }
                    readyPack = { number, file };
                    return file;
                }, e=>{
                    counts.diskFailures++;
                    nextPack = null;
                    opening = -1;
                    packsChanged = true;
                    throw e;
                });
            nextPack.catch(()=>{});
        }
    };

    /** @param {number} number @param {number} bytes */
    const addLive = (number, bytes)=>{
        live.set(number, (live.get(number) ?? 0) + bytes);
    };

    /**
     * Bytes at the start of each pack its last flush covered: what the disk
     * holds of it for certain.
     *
     * @type {Map<number, number>}
     */
    const durable = new Map();

    /**
     * Flushes pack `number`: false where the disk failed, counted. A flush
     * that failed may have lost what the pack took since the one before, so
     * no body written there since is trusted to the disk: one memory holds
     * forgets its copy (written again when it goes cold or is saved), a cold
     * one goes (it can be made again: a cold only copy was flushed before it
     * left memory, and lies below), and one being raised is let go by the
     * raise.
     *
     * @param {number} number
     */
    const flushPack = number=>{
        try
        {
            /** @type {DiskFile} */ (packs.get(number)).flush();
            durable.set(number, filled.get(number) ?? 0);
            return true;
        }
        catch {
            counts.diskFailures++;
        }
        const certain = durable.get(number) ?? 0;
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            const flags = get(id, R_FLAGS);
            if (get(id, R_PACK) !== number || (flags & F_ON_DISK) === 0
                || get(id, R_PACK_OFFSET) + get(id, R_LENGTH) <= certain)
            {
                continue;
            }
            const state = stateOf(stateWordOf(id));
            if (get(id, R_SEGMENT) >= 0 || (state !== COLD && (flags & F_ONLY_COPY) === 0))
            {
                forgetDisk(id, state !== RETIRED);
            }
            else if (state === COLD && (flags & F_ONLY_COPY) === 0)
            {
                drop(id);
                counts.lostOnDisk++;
            }
        }
        return false;
    };

    /**
     * Appends `bytes` to the pack bodies go to, flushed where asked: where it
     * wrote them (in `pack`), or `NOT_YET` where the next pack is not open
     * yet, or `REFUSED` where the disk failed, counted.
     *
     * @param {Uint8Array} bytes @param {boolean} flush
     */
    const append = (bytes, flush)=>{
        const length = bytes.length;
        if (pack < 0 || packTop + length > packBytes)
        {
            // Past the packs a run reads back, the disk is full: an index of
            // more would not be read (`openNextPack` opens none).
            if (readyPack === null)
            {
                openNextPack();
                return NOT_YET;
            }
            pack = readyPack.number;
            packs.set(pack, readyPack.file);
            filled.set(pack, 0);
            durable.set(pack, 0);
            live.set(pack, 0);
            packTop = 0;
            readyPack = null;
            openNextPack();
        }
        const file = /** @type {DiskFile} */ (packs.get(pack));
        try
        {
            // A disk that wrote less than asked holds no body: what it wrote is
            // written over by the next one.
            if (file.write(bytes, { at: packTop }) !== length)
            {
                counts.diskFailures++;
                refused = true;
                return REFUSED;
            }
        }
        catch {
            counts.diskFailures++;
            refused = true;
            return REFUSED;
        }
        const at = packTop;
        packTop += length;
        filled.set(pack, Math.max(packTop, filled.get(pack) ?? 0));
        if (flush && !flushPack(pack))
        {
            refused = true;
            return REFUSED;
        }
        return at;
    };

    /**
     * Writes a hot body to the disk: true where the disk holds it now. An
     * only copy is flushed, as it may leave memory next, unless the caller
     * flushes the pack itself before anything trusts the copy (`save`).
     *
     * @param {number} id @param {boolean} [flush]
     */
    const writeOut = (id, flush = (get(id, R_FLAGS) & F_ONLY_COPY) !== 0)=>{
        if (disk === null || (get(id, R_FLAGS) & F_NO_DISK) !== 0)
        {
            return false;
        }
        const length = get(id, R_LENGTH);
        const one = /** @type {NonNullable<typeof segments[0]>} */ (segments[get(id, R_SEGMENT)]);
        const offset = get(id, R_OFFSET);
        const at = append(one.bytes.subarray(offset, offset + length), flush);
        if (at < 0)
        {
            return false;
        }
        set(id, R_PACK, pack);
        set(id, R_PACK_OFFSET, at);
        set(id, R_FLAGS, get(id, R_FLAGS) | F_ON_DISK);
        addLive(pack, length);
        changed.add(id);
        counts.written++;
        counts.writtenBytes += length;
        return true;
    };

    /**
     * The disk's copy of a body is no longer its: dead bytes in its pack.
     *
     * @param {number} id
     * @param {boolean} [named]  whether its name leads to it: a record retired is no name's
     */
    const forgetDisk = (id, named = true)=>{
        if (get(id, R_FLAGS) & F_ON_DISK)
        {
            counts.deadDiskBytes += get(id, R_LENGTH);
            addLive(get(id, R_PACK), -get(id, R_LENGTH));
            if (named)
            {
                changed.add(id);
            }
        }
        set(id, R_FLAGS, get(id, R_FLAGS) & ~F_ON_DISK);
        set(id, R_PACK, -1);
    };

    /**
     * Lets go of pack `number`, which no record leads to and no index on the
     * disk names an only copy in: removed where the disk can (opened or not),
     * else cut to nothing and flushed. It stays `going`, listed, until that
     * is done; a disk that fails is counted, the file left to the next run.
     *
     * @param {number} number
     */
    const removePack = number=>{
        const file = packs.get(number);
        const remover = disk;
        packs.delete(number);
        live.delete(number);
        counts.reclaimedBytes += filled.get(number) ?? 0;
        filled.delete(number);
        durable.delete(number);
        if (number === pack)
        {
            pack = -1;
        }
        counts.packsRemoved++;
        going.add(number);
        /** The file is gone, or holds nothing: the next save need not list it. */
        const gone = ()=>{
            going.delete(number);
            packsChanged = true;
        };
        if (remover?.remove === undefined)
        {
            const cut = /** @type {DiskFile} */ (file);
            try
            {
                // Flushed: a cut a crash undid would leave the bytes in a file no index lists.
                cut.truncate(0);
                cut.flush();
                gone();
            }
            catch {
                counts.diskFailures++;
            }
            closeFile(cut);
            return;
        }
        // A handle open on a file keeps it on OPFS: closed first.
        if (file !== undefined)
        {
            closeFile(file);
        }
        Promise.resolve().then(()=>remover.remove?.(packFile(number))).then(gone, ()=>{
            counts.diskFailures++;
        });
    };

    // --- moves --------------------------------------------------------------

    /**
     * Takes a hot body no one reads out of its segment: to the disk where it
     * goes there, away where it can be made again. False where it is read,
     * or is the only copy and the disk cannot take it now.
     *
     * @param {number} id
     */
    const cool = id=>{
        const index_ = index.at(id) + R_STATE;
        if (Atomics.compareExchange(words, index_, stateWord(HOT), stateWord(MOVING))
            !== stateWord(HOT))
        {
            return false;
        }
        // Asked away while it was read: it goes now, not to the disk.
        if ((get(id, R_FLAGS) & F_DROP) !== 0)
        {
            giveBack(id);
            forgetDisk(id);
            set(id, R_FLAGS, 0);
            store(id, GONE);
            counts.gone++;
            return true;
        }
        const onlyCopy = (get(id, R_FLAGS) & F_ONLY_COPY) !== 0;
        const onDisk = (get(id, R_FLAGS) & F_ON_DISK) !== 0 || writeOut(id);
        if (!onDisk && onlyCopy)
        {
            store(id, HOT);
            return false;
        }
        giveBack(id);
        if (onDisk)
        {
            store(id, COLD);
            counts.cooled++;
        }
        else
        {
            store(id, GONE);
            counts.gone++;
        }
        return true;
    };

    /**
     * Whether record `id`'s name begins with `prefix`, compared where the
     * name lies.
     *
     * @param {number} id @param {string} prefix
     */
    const namedUnder = (id, prefix)=>{
        const at = get(id, R_NAME);
        if (get(id, R_NAME_LENGTH) < prefix.length)
        {
            return false;
        }
        for (let i = 0; i < prefix.length; i++)
        {
            if (names[at + i] !== prefix.charCodeAt(i))
            {
                return false;
            }
        }
        return true;
    };

    /**
     * Takes record `id`'s body away: false where it is read or written now,
     * and is marked to go once committed and no one reads it (`F_DROP`).
     *
     * @param {number} id
     */
    const drop = id=>{
        const word = stateWordOf(id);
        const state = stateOf(word);
        if (state === WRITING)
        {
            // The body being written was made from what the drop says is old.
            set(id, R_FLAGS, get(id, R_FLAGS) | F_DROP);
            return false;
        }
        if (state === HOT)
        {
            if (Atomics.compareExchange(words, index.at(id) + R_STATE, stateWord(HOT),
                stateWord(MOVING)) !== stateWord(HOT))
            {
                set(id, R_FLAGS, get(id, R_FLAGS) | F_DROP);
                return false;
            }
            giveBack(id);
        }
        else if (state !== COLD)
        {
            return state === GONE;
        }
        forgetDisk(id);
        set(id, R_FLAGS, 0);
        store(id, GONE);
        counts.gone++;
        return true;
    };

    /**
     * Brings cold record `id` back into a segment below `known`: true where
     * it is hot there now.
     *
     * @param {number} id @param {number} known
     */
    const raiseRecord = (id, known)=>{
        const length = get(id, R_LENGTH);
        // Saved by a run of larger segments: no segment of this one holds it.
        if (length > segmentBytes)
        {
            counts.raiseFailed++;
            return false;
        }
        store(id, MOVING);
        const found = room(length, known);
        if ((get(id, R_FLAGS) & F_ON_DISK) === 0)
        {
            // A flush failed while room was made, and its copy with it.
            if (found !== null)
            {
                giveRoom(found.segment, found.offset, length);
            }
            set(id, R_FLAGS, 0);
            store(id, GONE);
            counts.lostOnDisk++;
            counts.raiseFailed++;
            return false;
        }
        if (found === null)
        {
            store(id, COLD);
            counts[beyond(known) ? 'refusedUnseen' : 'raiseFailed']++;
            return false;
        }
        const one = segmentAt(found.segment);
        /** Bytes read, -1 where the disk threw. */
        let read = -1;
        try
        {
            read = /** @type {DiskFile} */ (packs.get(get(id, R_PACK))).read(one.bytes.subarray(found.offset,
                found.offset + length), { at: get(id, R_PACK_OFFSET) });
        }
        catch
        {
            // A disk that threw: counted below.
        }
        if (read !== length)
        {
            giveRoom(found.segment, found.offset, length);
            counts.raiseFailed++;
            if (read >= 0 && (get(id, R_FLAGS) & F_ONLY_COPY) === 0)
            {
                // The pack holds less than the index says (cut, or removed in
                // the origin): the body is not on the disk any more.
                forgetDisk(id);
                set(id, R_FLAGS, 0);
                store(id, GONE);
                counts.lostOnDisk++;
                return false;
            }
            counts.diskFailures++;
            store(id, COLD);
            return false;
        }
        placeBody(id, found);
        // Brought back now: not taken for idle since the last sweep.
        set(id, R_TICK, tick());
        store(id, HOT);
        counts.raised++;
        keepSpare();
        return true;
    };

    // --- room on the disk ---------------------------------------------------

    /** Bytes a body is read into on its way from one pack to another. */
    let carry = new Uint8Array(0);

    /**
     * Takes every body out of pack `number`, so the next save lets go of it:
     * each is written anew at the end of the pack bodies go to, its copy
     * there the disk's (a hot one from its segment, a cold one read from
     * here), or, where `evict` says so and it can be made again, a cold one
     * goes and a hot one forgets its copy (memory holds it). Stops where the
     * disk will not take a body now: what is left stays.
     *
     * @param {number} number @param {boolean} evict
     */
    const empty = (number, evict)=>{
        const from = /** @type {DiskFile} */ (packs.get(number));
        for (let id = 0; id < words[H_COUNT] && live.get(number) !== 0; id++)
        {
            if (get(id, R_PACK) !== number || (get(id, R_FLAGS) & F_ON_DISK) === 0)
            {
                continue;
            }
            const state = stateOf(stateWordOf(id));
            if (state !== COLD && state !== HOT)
            {
                // Retired and no name's: its copy here is no one's.
                forgetDisk(id, false);
                continue;
            }
            const flags = get(id, R_FLAGS);
            if (evict && (flags & F_ONLY_COPY) === 0)
            {
                if (state === COLD)
                {
                    drop(id);
                    counts.evicted++;
                }
                else
                {
                    forgetDisk(id);
                }
                continue;
            }
            const length = get(id, R_LENGTH);
            /** @type {Uint8Array} */
            let bytes;
            if (state === HOT)
            {
                // A hot body is not written while it is hot: memory holds the copy's bytes.
                const one = /** @type {NonNullable<typeof segments[0]>} */ (segments[get(id, R_SEGMENT)]);
                bytes = one.bytes.subarray(get(id, R_OFFSET), get(id, R_OFFSET) + length);
            }
            else
            {
                if (carry.length < length)
                {
                    carry = new Uint8Array(length);
                }
                bytes = carry.subarray(0, length);
                /** Bytes read, -1 where the disk threw. */
                let read = -1;
                try
                {
                    read = from.read(bytes, { at: get(id, R_PACK_OFFSET) });
                }
                catch
                {
                    // A disk that threw: counted below.
                }
                if (read >= 0 && read !== length && (flags & F_ONLY_COPY) === 0)
                {
                    // The pack holds less than the index says: the body is gone.
                    forgetDisk(id);
                    set(id, R_FLAGS, 0);
                    store(id, GONE);
                    counts.lostOnDisk++;
                    continue;
                }
                if (read !== length)
                {
                    counts.diskFailures++;
                    return;
                }
            }
            const at = append(bytes, (flags & F_ONLY_COPY) !== 0);
            if (at < 0)
            {
                return;
            }
            addLive(number, -length);
            addLive(pack, length);
            set(id, R_PACK, pack);
            set(id, R_PACK_OFFSET, at);
            changed.add(id);
            counts.compactedBytes += length;
            if (flags & F_ONLY_COPY)
            {
                // Both files written anew: neither names it in the old pack.
                basesOwed = 2;
            }
        }
    };

    /**
     * One pack bodies fill less than `COMPACT_LIVE` of, the emptiest, taken
     * out of (`empty`): its dead bytes are given back at the next save. A
     * pack with none left has nothing to move: it waits for a save to let it
     * go, or for the index files to stop naming an only copy there, and
     * taken it would be taken every time, the next emptiest never.
     */
    const compact = ()=>{
        let emptiest = -1;
        for (const [number, bytes] of filled)
        {
            const share = /** @type {number} */ (live.get(number)) / bytes;
            if (number !== pack && bytes > 0 && share > 0 && share < COMPACT_LIVE
                && (emptiest < 0 || share < /** @type {number} */ (live.get(emptiest))
                    / /** @type {number} */ (filled.get(emptiest))))
            {
                emptiest = number;
            }
        }
        if (emptiest >= 0)
        {
            empty(emptiest, false);
        }
    };

    /**
     * After the disk refused a write: the bodies used longest ago make room
     * for the newer ones, not the other way round. Of the packs that can be
     * emptied without a write, the one whose last used body is the oldest is
     * taken out of, what can be made again in it going (`empty`); a pack
     * holding an only copy is not one of them, since the copy cannot move
     * while the disk refuses, and what went for it would free nothing. The
     * pack bodies go to is closed to new ones first where no other can be
     * emptied, so that it can be.
     */
    const makeRoomOnDisk = ()=>{
        /** @type {Map<number, number>} */
        const lastUsed = new Map();
        /** @type {Set<number>} */
        const held = new Set();
        const at = tick();
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            const number = get(id, R_PACK);
            if (number >= 0 && (get(id, R_FLAGS) & F_ON_DISK) !== 0)
            {
                const idle = age(at, get(id, R_TICK));
                lastUsed.set(number, Math.min(lastUsed.get(number) ?? idle, idle));
                const state = stateOf(stateWordOf(id));
                if ((get(id, R_FLAGS) & F_ONLY_COPY) !== 0 && (state === HOT || state === COLD))
                {
                    held.add(number);
                }
            }
        }
        let oldest = -1;
        for (const [number, idle] of lastUsed)
        {
            if (number !== pack && !held.has(number)
                && (oldest < 0 || idle > /** @type {number} */ (lastUsed.get(oldest))))
            {
                oldest = number;
            }
        }
        if (oldest < 0)
        {
            // No other pack can be emptied: the next body opens another.
            pack = -1;
            return;
        }
        empty(oldest, true);
    };

    // --- the index on the disk -----------------------------------------------

    /**
     * The two files the index is saved to: a base is written into the one
     * the last save did not write, deltas appended to the one it did, so a
     * save torn mid-write leaves the index of the save before it whole.
     * Each with where its chain ends and the packs an only copy it names lies
     * in: such a pack stays while either file is the next run's to read.
     *
     * @type {{ file: DiskFile, end: number, onlyCopies: Set<number> }[]}
     */
    const slots = [];
    /** The file the last whole save wrote, its deltas after it; -1 for none. */
    let current = -1;
    let generation = 0;
    /**
     * Saves still to be bases: two as the keeper opens and after an only
     * copy moved, so each file is written anew and neither names a pack it
     * left; one after a delta failed, which may have left a torn tail.
     */
    let basesOwed = 2;
    /** Bytes of the current file's base and of the deltas after it: past the base, a base. */
    let baseBytes = 0;
    let deltaBytes = 0;

    /**
     * What an index file says, null where it is no whole index. A file the
     * disk fails to read, or reads less of than it holds, throws: it may be
     * the newer index, and a keeper that went on without it would not know
     * the packs it names an only copy in, the pack numbers it gives, nor the
     * generation to save past, so would let go of, write over or outdate
     * what the next run reads.
     *
     * @param {DiskFile} file @param {string} name
     */
    const readIndex = (file, name)=>{
        let bytes;
        try
        {
            bytes = new Uint8Array(file.getSize());
            if (file.read(bytes, { at: 0 }) !== bytes.length)
            {
                throw new Error('read short');
            }
        }
        catch (e){
            throw new Error(`cache: the disk failed to read ${name}`, { cause: e });
        }
        return readIndexFile(bytes, MAX_PACKS, F_ONLY_COPY);
    };

    /**
     * Whether record `id` is in the index: a body hot or cold whose copy on
     * the disk is the next run's.
     *
     * @param {number} id
     */
    const indexed = id=>{
        const state = stateOf(stateWordOf(id));
        return (state === HOT || state === COLD)
            && (get(id, R_FLAGS) & (F_ON_DISK | F_THIS_RUN | F_NO_DISK)) === F_ON_DISK;
    };

    /** What the disk held when the keeper opened: packs, and a record cold for each body. */
    const load = async()=>{
        if (disk === null)
        {
            return;
        }
        for (const name of INDEX_FILES)
        {
            slots.push({ file: await disk.open(name), end: 0, onlyCopies: new Set() });
        }
        const read = slots.map((slot, at)=>readIndex(slot.file, INDEX_FILES[at]));
        read.forEach((state, at)=>{
            slots[at].onlyCopies = state?.onlyCopies ?? new Set();
            // Numbers given from past the highest either file names, not from
            // the count the run before reached: a pack let go of gives its
            // number back, so the numbers a run reads never run out.
            /** @param {number} number */
            const named = number=>{
                nextPackNumber = Math.max(nextPackNumber, number + 1);
            };
            state?.packs.forEach(named);
            state?.onlyCopies.forEach(named);
            state?.entries.forEach(entry=>named(entry.pack));
        });
        const chosen = newerIndex(read);
        const saved = read[chosen];
        if (saved === null || saved === undefined)
        {
            return;
        }
        current = chosen;
        slots[chosen].end = saved.end;
        generation = saved.generation;
        counts.skippedEntries += saved.skipped;
        /** @param {number} number */
        const spokenFor = number=>slots.some(slot=>slot.onlyCopies.has(number));
        const withBodies = new Set([...saved.entries.values()].map(entry=>entry.pack));
        for (const number of saved.packs)
        {
            if (disk.remove !== undefined && !withBodies.has(number) && !spokenFor(number))
            {
                // A pack no entry names is let go of by its name, unopened:
                // opening would make again a file the run before removed.
                removePack(number);
                continue;
            }
            const file = await disk.open(packFile(number));
            packs.set(number, file);
            filled.set(number, file.getSize());
            durable.set(number, file.getSize());
            live.set(number, 0);
            if (number > pack)
            {
                pack = number;
            }
        }
        if (pack >= 0)
        {
            packTop = /** @type {number} */ (filled.get(pack));
        }
        for (const [name, { pack: from, offset, length, flags }] of saved.entries)
        {
            // Within its pack's file: the index file checked the rest.
            if (!(offset + length <= (filled.get(from) ?? 0)))
            {
                counts.skippedEntries++;
                continue;
            }
            const id = recordOf(name);
            if (id < 0)
            {
                continue;
            }
            set(id, R_PACK, from);
            set(id, R_PACK_OFFSET, offset);
            set(id, R_LENGTH, length);
            set(id, R_FLAGS, (flags & F_ONLY_COPY) | F_ON_DISK);
            set(id, R_TICK, 0);
            store(id, COLD);
            addLive(from, length);
            counts.loaded++;
        }
        // A pack no body of the index is in holds what the run before wrote
        // for itself (`disk: 'run'`) or let go of: it goes, unless the other
        // file, which a torn save leaves to the next run, names an only copy there.
        for (const number of [...packs.keys()])
        {
            if (live.get(number) === 0 && !spokenFor(number))
            {
                removePack(number);
            }
        }
    };

    try
    {
        await load();
        keepSpare();
        openNextPack();
    }
    catch (e){
        // A file the disk would not open or read: the files opened are let
        // go, nothing on the disk changed, and a pack still opening is let go
        // of where it opens, so the next try finds none of them held.
        closed = true;
        for (const file of [...packs.values(), ...slots.map(slot=>slot.file)])
        {
            closeFile(file);
        }
        throw e;
    }

    const keeper = {
        shared,
        /** Segments by number, null for one let go, for a thread joining later. */
        segmentBuffers: ()=>segments.map(one=>(one === null ? null : one.buffer)),

        /**
         * Room for `name`'s body of `length` bytes, in a segment below
         * `known`: the record, where to write and the reservation's mark, or
         * null with why counted. The writer stores the record hot (`commit`)
         * once it has written.
         *
         * @param {string} name @param {number} length
         * @param {{ onlyCopy?: boolean, disk?: DiskPolicy, idle?: 'go' | 'stay',
         *     known?: number }} [options]
         * @returns {import('./reader.js').Place | null}
         */
        reserve(name, length, { onlyCopy = false, disk: policy = 'kept', idle = 'go',
            known = Infinity } = {}){
            checkName(name);
            const policyFlags = POLICY_FLAGS[policy];
            if (policyFlags === undefined)
            {
                throw new RangeError(`cache: a disk policy of ${String(policy)}`);
            }
            if (idle !== 'go' && idle !== 'stay')
            {
                throw new RangeError(`cache: an idle policy of ${String(idle)}`);
            }
            if (!Number.isInteger(length))
            {
                throw new RangeError(`cache: a body of ${length} bytes`);
            }
            // No block holds an empty body or one past a segment: refused
            // before anything is moved for it.
            if (!(length > 0) || length > segmentBytes)
            {
                counts.refusedLarge++;
                return null;
            }
            let id = recordOf(name);
            if (id < 0)
            {
                counts.refusedRoom++;
                return null;
            }
            const state = stateOf(stateWordOf(id));
            // A reservation let go of without a body keeps its room until here.
            if (state === GONE && get(id, R_SEGMENT) >= 0)
            {
                giveBack(id);
                counts.abandoned++;
            }
            // A hot body no one is in is held while room is found, so that a
            // reservation refused leaves the name's body as it was.
            const held = state === HOT && Atomics.compareExchange(words, index.at(id) + R_STATE,
                stateWord(HOT), stateWord(MOVING)) === stateWord(HOT);
            // The name's own body is not cooled for it: a reader that leaves
            // it meanwhile does not make it a candidate.
            let found = room(length, known, id);
            if (found === null && held && get(id, R_SEGMENT) < known
                && blockOf(length) <= blockOf(get(id, R_LENGTH)))
            {
                // Its own block holds the new body: written over in place.
                giveBack(id);
                found = placeIn(length, known);
            }
            if (found === null)
            {
                if (held)
                {
                    store(id, HOT);
                }
                counts[beyond(known) ? 'refusedUnseen' : 'refusedRoom']++;
                return null;
            }
            if (held)
            {
                if (get(id, R_SEGMENT) >= 0)
                {
                    giveBack(id);
                }
            }
            else if (state === HOT || state === WRITING)
            {
                // A body being read or written is left to those inside, the
                // name led to a new record.
                const fresh = replaceRecord(id);
                if (fresh < 0)
                {
                    giveRoom(found.segment, found.offset, length);
                    counts.refusedRoom++;
                    return null;
                }
                id = fresh;
            }
            forgetDisk(id);
            set(id, R_FLAGS, (onlyCopy ? F_ONLY_COPY : 0) | policyFlags
                | (idle === 'stay' ? F_FOR_ROOM : 0));
            store(id, MOVING);
            placeBody(id, found);
            set(id, R_LENGTH, length);
            // Now, not the last sweep's tick: a reservation's age, which
            // `abandonAfterMs` takes it back by, counts from when it was made.
            set(id, R_TICK, tick());
            const mark = nextMark;
            nextMark = nextMark === MAX_MARK ? 1 : nextMark + 1;
            Atomics.store(words, index.at(id) + R_STATE, stateWord(WRITING, mark));
            counts.reserved++;
            keepSpare();
            return { id, segment: found.segment, offset: found.offset, mark };
        },

        /**
         * Brings `name`'s cold body back into a segment below `known` (the
         * segments the asker has): true where it is hot there now.
         *
         * @param {string} name @param {{ known?: number }} [options]
         */
        raise(name, { known = Infinity } = {}){
            checkName(name);
            const id = index.find(name);
            if (id < 0)
            {
                return false;
            }
            const state = stateOf(stateWordOf(id));
            if (state !== COLD)
            {
                return state === HOT && get(id, R_SEGMENT) < known;
            }
            return raiseRecord(id, known);
        },

        /**
         * Takes `name`'s body away: true where it is gone now, false where it
         * is read or written, and goes once committed and no one reads it.
         *
         * @param {string} name
         */
        drop(name){
            checkName(name);
            const id = index.find(name);
            return id < 0 || drop(id);
        },

        /**
         * What is held under the names that begin with `prefix` - an owner's,
         * when its names are its own (`texels/<root>/`): the bodies and their
         * bytes, every record of such a name that is not gone counted, one a
         * name was written anew over and is still read included. Of them, the
         * bytes of those in memory (`hotBytes`, as `figures` counts them) and
         * of the blocks they take there (`placedBytes`): what the owner's
         * bodies cost the segments, their rounding the difference.
         *
         * @param {string} prefix
         * @returns {{ bodies: number, bytes: number, hotBytes: number, placedBytes: number }}
         */
        under(prefix){
            checkName(prefix);
            let bodies = 0;
            let bytes = 0;
            let hotBytes = 0;
            let placedBytes = 0;
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const state = stateOf(stateWordOf(id));
                if (state !== GONE && namedUnder(id, prefix))
                {
                    const length = get(id, R_LENGTH);
                    bodies++;
                    bytes += length;
                    if (state === HOT || state === WRITING || state === RETIRED || state === RETIRED_WRITING)
                    {
                        hotBytes += length;
                        placedBytes += blockOf(length);
                    }
                }
            }
            return { bodies, bytes, hotBytes, placedBytes };
        },

        /**
         * Lets go of every body under the names that begin with `prefix`, as
         * an owner that goes takes what it held with it: what was there, and
         * how many of those are still read or written (they go once no one
         * reads them, as a `drop` of each would leave them).
         *
         * @param {string} prefix
         * @returns {{ bodies: number, bytes: number, waiting: number }}
         */
        release(prefix){
            checkName(prefix);
            let bodies = 0;
            let bytes = 0;
            let waiting = 0;
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const state = stateOf(stateWordOf(id));
                if (state === GONE || !namedUnder(id, prefix))
                {
                    continue;
                }
                bodies++;
                bytes += get(id, R_LENGTH);
                // A name written anew is another record's now: its old body
                // goes when its readers leave, by no drop.
                if (state === RETIRED || state === RETIRED_WRITING || !drop(id))
                {
                    waiting++;
                }
            }
            counts.released += bodies;
            counts.releasedBytes += bytes;
            return { bodies, bytes, waiting };
        },

        /**
         * The clock moves; idle bodies go cold, long idle cold ones go, bodies
         * asked away go once no one reads them, records retired and left go
         * back for other names, reservations held past `abandonAfterMs` are
         * taken back, segments empty long enough are let go but one.
         */
        sweep(){
            const at = tick();
            Atomics.store(words, H_TICK, at);
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const word = stateWordOf(id);
                const state = stateOf(word);
                if (state === RETIRED)
                {
                    takeRetired(id);
                    continue;
                }
                if ((state === WRITING || state === RETIRED_WRITING)
                    && age(at, get(id, R_TICK)) >= abandonAfterMs)
                {
                    // Its writer is taken for gone: what it would commit now
                    // fails, the mark being no reservation's any more.
                    const taken = stateWord(state === WRITING ? GONE : RETIRED);
                    if (Atomics.compareExchange(words, index.at(id) + R_STATE, word, taken) === word)
                    {
                        counts.takenBack++;
                        if (state === WRITING)
                        {
                            giveBack(id);
                            set(id, R_FLAGS, 0);
                        }
                        else
                        {
                            takeRetired(id);
                        }
                    }
                    continue;
                }
                if (state === GONE && get(id, R_SEGMENT) >= 0)
                {
                    // A reservation let go of without a body.
                    giveBack(id);
                    counts.abandoned++;
                    continue;
                }
                if (state !== HOT && state !== COLD)
                {
                    continue;
                }
                if (state === HOT && readersOf(word) === 0 && (get(id, R_FLAGS) & F_DROP) !== 0)
                {
                    drop(id);
                }
                else if (state === HOT && readersOf(word) === 0
                    && (get(id, R_FLAGS) & F_FOR_ROOM) === 0
                    && age(at, get(id, R_TICK)) >= coldAfterMs)
                {
                    cool(id);
                }
                else if (state === COLD && (get(id, R_FLAGS) & F_ONLY_COPY) === 0
                    && age(at, get(id, R_TICK)) >= goneAfterMs)
                {
                    drop(id);
                }
            }
            let spare = false;
            let kept = 0;
            for (const s of liveSegments)
            {
                const one = segmentAt(s);
                if (one.buddy.empty())
                {
                    if (!spare)
                    {
                        spare = true;
                    }
                    else if (age(at, one.emptySince) >= releaseAfterMs)
                    {
                        segments[s] = null;
                        counts.segmentsLetGo++;
                        counts.letGoBytes += segmentBytes;
                        tell({ segment: s, buffer: null });
                        continue;
                    }
                }
                liveSegments[kept++] = s;
            }
            liveSegments.length = kept;
            for (const number of [...packs.keys()])
            {
                flushPack(number);
            }
            if (refused)
            {
                refused = false;
                makeRoomOnDisk();
            }
            else
            {
                compact();
            }
        },

        /**
         * Writes the hot bodies the disk lacks and the index of all it holds,
         * for the next run to find: true where the disk holds them all now.
         */
        save(){
            if (disk === null || slots.length === 0)
            {
                return false;
            }
            let whole = true;
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                // A body for this run only, or never on the disk, is no next
                // run's: not written for it, and not named in its index.
                if (stateOf(stateWordOf(id)) === HOT
                    && (get(id, R_FLAGS) & (F_ON_DISK | F_THIS_RUN | F_NO_DISK)) === 0)
                {
                    // Only no one may write it meanwhile: the keeper's thread
                    // is the one placing, and a reader does not write. Each
                    // pack is flushed once below, not once a body.
                    whole = writeOut(id, false) && whole;
                }
            }
            // Every pack, past one that fails too: each failure distrusts the
            // bodies of its own pack, and only those.
            let flushedAll = true;
            for (const number of [...packs.keys()])
            {
                flushedAll = flushPack(number) && flushedAll;
            }
            if (!flushedAll)
            {
                // An index naming bodies the disk may not hold is not written.
                return false;
            }
            const asBase = basesOwed > 0 || current < 0 || deltaBytes > baseBytes;
            if (!asBase && changed.size === 0 && !packsChanged)
            {
                // The index on the disk says all there is.
                return whole;
            }
            const target = !asBase ? current : current < 0 ? (generation + 1) % 2 : 1 - current;
            const writer = chunkWriter();
            const onlyCopies = asBase ? new Set() : new Set(slots[current].onlyCopies);
            /** @param {number} id */
            const enter = id=>{
                const named = indexed(id);
                const from = get(id, R_PACK);
                const flags = named ? get(id, R_FLAGS) & F_ONLY_COPY : 0;
                writer.entry(named ? from : -1, named ? get(id, R_PACK_OFFSET) : 0,
                    named ? get(id, R_LENGTH) : 0, flags, names, get(id, R_NAME),
                    get(id, R_NAME_LENGTH));
                if (flags !== 0)
                {
                    onlyCopies.add(from);
                }
            };
            if (asBase)
            {
                for (let id = 0; id < words[H_COUNT]; id++)
                {
                    if (indexed(id))
                    {
                        enter(id);
                    }
                }
            }
            else
            {
                for (const id of changed)
                {
                    enter(id);
                }
            }
            // Packs no record leads to and neither file, once this one is
            // written, names an only copy in: let go of after it.
            const other = slots[1 - target].onlyCopies;
            const leaving = [...packs.keys()].filter(number=>number !== pack
                && live.get(number) === 0 && !onlyCopies.has(number) && !other.has(number));
            // Listed: every pack whose file may be on the disk, those let go
            // of until it is gone and the one still opening too; a file no
            // index lists would be no run's to let go of.
            const listed = [...packs.keys(), ...going];
            for (const number of [readyPack?.number ?? -1, opening])
            {
                if (number >= 0)
                {
                    listed.push(number);
                }
            }
            // Spent though the write fails: a chunk the disk took without a
            // flush may be read all the same, and a later one of the same
            // generation would tie with it, the next run taking either.
            generation++;
            const bytes = writer.finish({ kind: asBase ? BASE : DELTA, generation,
                nextPack: nextPackNumber, packs: listed });
            const slot = slots[target];
            try
            {
                if (asBase)
                {
                    slot.file.truncate(0);
                }
                if (slot.file.write(bytes, { at: asBase ? 0 : slot.end }) !== bytes.length)
                {
                    throw new Error('written short');
                }
                slot.file.flush();
            }
            catch {
                counts.diskFailures++;
                // A delta cut short may have left a torn tail: the next save
                // writes a base into the other file. A base that failed leaves
                // the next one to this file again, so the whole one is never
                // the one written over. The file may hold what it held or what
                // was written: the packs either names an only copy in stay.
                basesOwed = Math.max(basesOwed, 1);
                slot.onlyCopies = new Set([...slot.onlyCopies, ...onlyCopies]);
                return false;
            }
            counts.saved++;
            counts.savedBytes += bytes.length;
            slot.onlyCopies = onlyCopies;
            if (asBase)
            {
                current = target;
                slot.end = bytes.length;
                baseBytes = bytes.length;
                deltaBytes = 0;
                basesOwed = Math.max(0, basesOwed - 1);
                counts.wholeSaves++;
            }
            else
            {
                slot.end += bytes.length;
                deltaBytes += bytes.length;
            }
            changed.clear();
            // The packs as listed; one let go of at once is not listed any more.
            packsChanged = false;
            for (const number of leaving)
            {
                removePack(number);
            }
            return whole;
        },

        /**
         * Saves, then lets go of every file, the pack still opening too:
         * true where the save was whole.
         */
        close(){
            if (closed)
            {
                return false;
            }
            const whole = keeper.save();
            closed = true;
            disk = null;
            // Memory's only from here: a hot body the disk held stays until it
            // can be made again or is let go, an only copy for good; a cold one
            // is the next run's, on the disk, and no body of this run any more.
            // A cold only copy no whole save names where it lies (the save
            // failed, or it is this run's) would be no one's: it is brought
            // back first, room made from what can be made again.
            /** @type {number[]} */
            const unnamed = [];
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                if (stateOf(stateWordOf(id)) !== COLD)
                {
                    set(id, R_FLAGS, get(id, R_FLAGS) & ~F_ON_DISK);
                    set(id, R_PACK, -1);
                }
                else if ((get(id, R_FLAGS) & F_ONLY_COPY) !== 0 && (!indexed(id) || changed.has(id)))
                {
                    unnamed.push(id);
                }
            }
            for (const id of unnamed)
            {
                if (raiseRecord(id, Infinity))
                {
                    set(id, R_FLAGS, get(id, R_FLAGS) & ~F_ON_DISK);
                    set(id, R_PACK, -1);
                }
                else if (stateOf(stateWordOf(id)) === COLD)
                {
                    counts.lostAtClose++;
                }
            }
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                if (stateOf(stateWordOf(id)) === COLD)
                {
                    set(id, R_FLAGS, 0);
                    set(id, R_PACK, -1);
                    store(id, GONE);
                }
            }
            for (const file of [...packs.values(), ...slots.map(slot=>slot.file),
                ...readyPack ? [readyPack.file] : []])
            {
                closeFile(file);
            }
            packs.clear();
            live.clear();
            filled.clear();
            slots.length = 0;
            readyPack = null;
            return whole;
        },

        /** Hot bytes, segments, cold bytes and what was done, for the report. */
        figures(){
            let hotBytes = 0;
            let coldBytes = 0;
            let hot = 0;
            let cold = 0;
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const state = stateOf(stateWordOf(id));
                if (state === HOT || state === WRITING || state === RETIRED || state === RETIRED_WRITING)
                {
                    hot++;
                    hotBytes += get(id, R_LENGTH);
                }
                else if (state === COLD)
                {
                    cold++;
                    coldBytes += get(id, R_LENGTH);
                }
            }
            const made = liveSegments.map(segmentAt);
            return {
                records: words[H_COUNT], names: named, freeRecords: free.length, hot, hotBytes, cold,
                coldBytes,
                segments: made.length, segmentBytes: made.length * segmentBytes,
                placedBytes: made.reduce((sum, one)=>sum + one.buddy.used(), 0),
                roundingBytes: made.reduce((sum, one)=>sum + one.buddy.wasted(), 0),
                indexBytes: shared.records.byteLength + shared.names.byteLength
                    + index.table().byteLength,
                packs: packs.size,
                diskBytes: [...filled.values()].reduce((sum, bytes)=>sum + bytes, 0),
                liveDiskBytes: [...live.values()].reduce((sum, bytes)=>sum + bytes, 0),
                ...counts,
            };
        },
    };
    return keeper;
}

/** @typedef {Awaited<ReturnType<typeof openKeeper>>} Keeper */
