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
 * The hot part is segments of shared memory, as many as the budget holds:
 * the account's (`account.js`), the program's one, where the segments are
 * one kind beside the memory others hold, and a take of theirs that does not
 * fit has the keeper let cold bodies go for it (`makeRoom`). A
 * segment of `segmentBytes` is shared by bodies, each placed in a block of a
 * power of two and taking its length rounded to a grain of it (`buddy.js`); a
 * body over a quarter of that (`large`) has a segment of its own instead, of
 * its length rounded to a page, made for it and let go of when it goes: a
 * block of half a segment or more is a half no other body can share, and a
 * body past a segment has no block at all. Held memory, which never leaves,
 * is placed apart from bodies, in shared segments of its own. A shared
 * segment costs the budget only as far as its blocks reach. A thread
 * learns of a segment by a message (`announce`), and a message reaches a
 * thread only between its turns, so the keeper keeps segments announced
 * before they are needed - two shared ones of each kind with nothing in it, own
 * ones with no bytes yet, each grown to the body it is given - and places a
 * writer's body only in a segment the writer says it has (`known`).
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

import { createAccountMemory, openAccount } from './account.js';
import { UNIT, blockOf, checkSegmentBytes, createBuddy, grainsOf } from './buddy.js';
import { BASE, DELTA, chunkWriter, readIndexFile } from './index-file.js';
import {
    COLD, F_DROP, F_FOR_ROOM, F_HELD, F_NO_DISK, F_ONLY_COPY, F_ON_DISK, F_THIS_RUN, GONE, HEADER_WORDS, HOT,
    CACHE_LAYOUT, H_COUNT, H_LAYOUT, H_LET_GO, H_NAMES, H_NAMES_EPOCH, H_TICK, MAX_RECORDS,
    MOVING, RECORD_WORDS, RETIRED, RETIRED_WRITING, R_FLAGS, R_HASH_A, R_HASH_B, R_LENGTH, R_NAME,
    R_NAME_LENGTH, R_OFFSET, R_PACK, R_PACK_OFFSET, R_SEGMENT, R_STATE, R_TICK, WRITING,
    P_ID, P_MARK, P_OFFSET, P_SEGMENT, checkFlags, checkName, growableShared, growTo, sharedBuffer,
    TABLE_LEFT, hashName, readersOf, stateOf, stateWord, tableBuffer, tableSlots, viewIndex,
} from './shared.js';

const MIB = 1024 * 1024;

/** Room the names reserve to grow into, as the records do: address space only, touched as used. */
const MAX_NAME_UNITS = 1 << 25;
/** The reservations' marks run from 1 to this, then round again (`WRITING`). */
const MAX_MARK = 0xffffff;
const FIRST_TABLE = 1024;
/**
 * Units of names no record names any more past which the keeper packs the
 * names together, where they are as many as the names held too: a pack
 * costs a copy of the names held, done once the dead ones are as many.
 */
const PACK_NAMES_UNITS = 1 << 16;
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

/** @typedef {import('./shared.js').DiskPolicy} DiskPolicy */

/**
 * A pack whose bodies fill less than this share of its file is compacted:
 * what is left of it is written anew, and the file goes. Moving a quarter to
 * free the rest writes at most a third of a byte for each byte given back.
 */
const COMPACT_LIVE = 1 / 4;
/**
 * Bytes a pass moves from one pack to another at most, past its first body:
 * the pass is the keeper's thread's, between its other work, and a pack of
 * 64 MiB a quarter live is 16 MiB moved. The rest moves at the next sweep.
 */
const COMPACT_PASS_BYTES = 1 << 20;
/**
 * The bytes of idle bodies a sweep cools past its first: a sweep is the
 * keeper's thread's, between the calls it answers, and cooling costs about 2
 * ms a MiB of small bodies (20000 bodies of 4 KiB held it 112 ms). The rest
 * cool at the sweeps after, each started and finished in its own sweep, so
 * none is left moving between them. Room wanted now (`room`, `makeRoom`)
 * cools what it needs, past this.
 */
const COOL_PASS_BYTES = 4 << 20;
/**
 * The address space the own segments announced ahead reserve in all: each
 * can grow to the budget, and a browser's V8 sandbox holds every buffer of a
 * page in one TiB (Chromium 158 made 502 growable buffers of 2 GiB and
 * refused the next), where the guest's memories must fit too.
 */
const SPARE_ADDRESS_BYTES = 16 * 2 ** 30;

/** What `append` answers where it wrote nothing: no pack open yet, or the disk refused. */
const NOT_YET = -1;
const REFUSED = -2;
/** What `append` answers where the pack it copied from held less than asked, or threw. */
const SOURCE_SHORT = -3;
const SOURCE_FAILED = -4;
/**
 * The most a disk read or write of memory that may grow takes at once: such
 * memory (an own segment's) goes through a fixed buffer of the keeper's in
 * pieces of this, as a host's disk refuses a view of it, and so does a body
 * moved from pack to pack - one bound, however large the body.
 */
const IO_PIECE = 1 << 20;

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
 * @property {() => Iterable<string> | Promise<Iterable<string>>} [names]  the files it holds:
 *     where given, a pack file no index names is let go of as the keeper opens
 */

/**
 * @typedef {Object} KeeperOptions
 * @property {number} [budget]  bytes of segments at most, in an account of the
 *     keeper's own; with `account`, the account's bound on its kind
 * @property {import('./account.js').AccountMemory} [account]  the account the
 *     segments are taken from, as `kind`, beside what else it counts
 * @property {string} [kind]  the segments' kind in it: `cache` unless said
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
        segmentBytes = 16 * MIB, packBytes = 64 * MIB, kind = 'cache',
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
    const own = options.account === undefined;
    if (own && (typeof options.budget !== 'number' || !(options.budget >= 0)
        || !Number.isFinite(options.budget)))
    {
        throw new RangeError(`cache: a budget of ${options.budget} bytes`);
    }
    /** What the segments are taken from: the keeper takes no room of its own, it cools for it. */
    const account = openAccount(options.account
        ?? createAccountMemory({ limit: Infinity, kinds: { [kind]: /** @type {number} */ (options.budget) } }));
    /** The most the segments may hold: their kind's ceiling, or the account's limit. */
    const budget = account.bound(kind);
    if (!Number.isFinite(budget))
    {
        throw new RangeError(`cache: the account bounds ${kind} by nothing: a keeper needs a bound`);
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
        table: tableBuffer(FIRST_TABLE, 0),
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
     * A segment of one body (`own`) has no `buddy`; `length`, its body's.
     * `reach`: the bytes of it the budget counts (`grow`).
     *
     * @type {({ buffer: SharedArrayBuffer, bytes: Uint8Array, buddy: import('./buddy.js').Buddy | null,
     *     emptySince: number, length: number, reach: number } | null)[]}
     */
    const segments = [];
    /**
     * The numbers of the shared segments not let go, in order: what is placed
     * in. The budget counts each to the page past its last block (`grow`),
     * the last one holding none yet (`keepSpare`).
     *
     * @type {number[]}
     */
    const liveSegments = [];
    /**
     * The numbers of the shared segments of held memory, as `liveSegments`
     * are of bodies. Held memory is never taken back, cooled or moved:
     * placed among bodies that can leave, it would keep their whole segment
     * from going; placed apart, it costs the budget its own room alone.
     *
     * @type {number[]}
     */
    const heldSegments = [];
    /** Bytes of every segment holding memory, as the account holds them of `kind`. */
    let heldBytes = 0;
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
    /**
     * Record `id`'s entry is owed to the next save: noted only where there is
     * a disk to save to, so a keeper of memory alone, or one closed, keeps
     * nothing for a save that never comes.
     *
     * @param {number} id
     */
    const owe = id=>{
        if (disk !== null)
        {
            changed.add(id);
        }
    };
    /** The packs whose file may be on the disk are not the ones the last save listed. */
    let packsChanged = false;
    /** Closed: no file is opened any more. */
    let closed = false;

    const counts = {
        reserved: 0, refusedRoom: 0, refusedLarge: 0, refusedUnseen: 0,
        replaced: 0, raised: 0, raiseFailed: 0, cooled: 0, written: 0, writtenBytes: 0, gone: 0,
        loaded: 0, saved: 0, namesPacked: 0, segmentsMade: 0, segmentsLetGo: 0, letGoBytes: 0, deadDiskBytes: 0,
        diskFailures: 0, lostOnDisk: 0, abandoned: 0, skippedEntries: 0, announceFailures: 0,
        segmentFailures: 0, wholeSaves: 0, savedBytes: 0, compactedBytes: 0, packsRemoved: 0,
        reclaimedBytes: 0, evicted: 0, lostAtClose: 0, takenBack: 0, oldestListed: 0,
        released: 0, releasedBytes: 0, strayPacks: 0, peakSegmentBytes: 0, roomAsked: 0, roomMade: 0, roomRefused: 0,
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
    /** Slots of the table a name left (`TABLE_LEFT`): a lookup passes over them as over a name. */
    let left = 0;
    /** The table's generation: a reader takes a later one only. */
    let tableGeneration = 0;
    /** Units of the names in the table: the names a pack keeps, but for a record retired. */
    let namedUnits = 0;
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
        if (words[H_NAMES] + name.length > MAX_NAME_UNITS)
        {
            packNames();
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
        namedUnits += name.length;
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
        owe(id);
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
        giveName(id);
    };

    /**
     * Record `id`, gone, kept for another name: it names nothing, so a
     * reader that remembers it finds it is not its name's (`holds`), and a
     * pack of the names leaves its name out.
     *
     * @param {number} id
     */
    const giveName = id=>{
        set(id, R_NAME, -1);
        set(id, R_NAME_LENGTH, 0);
        free.push(id);
    };

    /**
     * The name of record `id`, gone with nothing of it left - no room, no
     * copy on the disk, nothing owed to a save - leads to no record any more:
     * its slot left (`TABLE_LEFT`), its record given back, its units dead
     * until the names are packed. A name put only once and dropped holds
     * nothing after, so the index is the size of the names held, not of
     * every name a run ever wrote.
     *
     * @param {number} id
     */
    const forgetName = id=>{
        const table = index.table();
        const mask = table.length - 1;
        for (let slot = get(id, R_HASH_A) & mask; ; slot = (slot + 1) & mask)
        {
            const entry = table[slot];
            if (entry === id + 1)
            {
                Atomics.store(table, slot, TABLE_LEFT);
                break;
            }
            if (entry === 0)
            {
                throw new Error(`cache: record ${id} is gone and named, and no name leads to it`);
            }
        }
        named--;
        left++;
        namedUnits -= get(id, R_NAME_LENGTH);
        giveName(id);
    };

    /**
     * The names records name, packed together from the first unit: the
     * units of names gone are room again. The epoch moves first, so a reader
     * that remembers a place from before finds it is not its name's
     * (`holds`), and one looking up meanwhile looks again (odd); stored and
     * loaded again before a unit is written over, which keeps those writes
     * after it (see the journal), and moved again once all is written.
     */
    const packNames = ()=>{
        /** @type {number[]} */
        const naming = [];
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            if (get(id, R_NAME) >= 0)
            {
                naming.push(id);
            }
        }
        // A record retired shares its name with the one its name leads to now.
        naming.sort((x, y)=>get(x, R_NAME) - get(y, R_NAME));
        Atomics.store(words, H_NAMES_EPOCH, Atomics.load(words, H_NAMES_EPOCH) + 1);
        Atomics.load(words, H_NAMES_EPOCH);
        let to = 0;
        let lastFrom = -1;
        let lastTo = 0;
        for (const id of naming)
        {
            const from = get(id, R_NAME);
            if (from !== lastFrom)
            {
                const length = get(id, R_NAME_LENGTH);
                names.copyWithin(to, from, from + length);
                lastFrom = from;
                lastTo = to;
                to += length;
            }
            set(id, R_NAME, lastTo);
        }
        words[H_NAMES] = to;
        Atomics.store(words, H_NAMES_EPOCH, Atomics.load(words, H_NAMES_EPOCH) + 1);
        counts.namesPacked++;
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
        if ((named + left + 1) * 2 > table.length)
        {
            // Made again of the same size where it is mostly slots names
            // left, so names put and dropped never grow it.
            const slots = (named + 1) * 4 > table.length ? table.length * 2 : table.length;
            const larger = tableBuffer(slots, ++tableGeneration);
            const into = tableSlots(larger);
            const mask = into.length - 1;
            // What the table leads to now, not every record: a retired one
            // is no name's any more, and put back it would lead its name to
            // a body written over since.
            for (const entry of table)
            {
                if (entry <= 0)
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
            left = 0;
            tell({ table: larger });
        }
        const mask = table.length - 1;
        // The first slot a name left on the way, else the empty one at its
        // end: a lookup of a name further on passes over either.
        let slot = first & mask;
        let at = -1;
        while (table[slot] !== 0)
        {
            if (at < 0 && table[slot] === TABLE_LEFT)
            {
                at = slot;
            }
            slot = (slot + 1) & mask;
        }
        if (at >= 0)
        {
            slot = at;
            left--;
        }
        Atomics.store(table, slot, id + 1);
        named++;
    };

    // --- segments -----------------------------------------------------------

    /**
     * A body over this many bytes has a segment of its own (`placeOwn`); one
     * of this many or fewer is placed in a block of a shared segment. A body
     * of half a segment or more needs a whole half free to be placed in, and
     * is let go of only when every body of that half can go; above a quarter,
     * a power-of-two body (a 1024 x 1024 texture) needs its whole block
     * either way. A page at least: a body of one takes one either way.
     */
    const large = Math.max(UNIT, segmentBytes / 4);
    /**
     * The largest own segment: the budget, within the 32-bit words a body's
     * length and place are kept in. A body past it is refused before
     * anything moves for it.
     */
    const ownMost = Math.min(Math.floor(budget / UNIT) * UNIT, 2 ** 31 - UNIT);
    /** @param {number} length */
    const pageOf = length=>Math.ceil(length / UNIT) * UNIT;
    /** The bytes a body of `length` takes in memory: its grains, or its own segment. @param {number} length */
    const placedOf = length=>(length > large ? pageOf(length) : grainsOf(length));
    /**
     * Whether a segment can hold a body of `length` within the budget: a
     * shared one the page its grains reach, an own one its pages.
     *
     * @param {number} length
     */
    const fits = length=>length > 0
        && (length <= large ? pageOf(grainsOf(length)) <= budget : pageOf(length) <= ownMost);

    /** @param {number} at */
    const segmentAt = at=>/** @type {NonNullable<typeof segments[0]>} */ (segments[at]);
    /** The room of shared segment `at`. @param {number} at */
    const buddyOf = at=>/** @type {import('./buddy.js').Buddy} */ (segmentAt(at).buddy);

    /**
     * A segment made over `buffer`, announced: its number.
     *
     * @param {SharedArrayBuffer} buffer @param {import('./buddy.js').Buddy | null} buddy
     */
    const addSegment = (buffer, buddy)=>{
        const at = segments.length;
        segments.push({ buffer, bytes: new Uint8Array(buffer, 0, buffer.byteLength), buddy,
            emptySince: tick(), length: 0, reach: 0 });
        counts.segmentsMade++;
        tell({ segment: at, buffer });
        return at;
    };

    /**
     * Memory of `bytes` more is held from now on, or none where the account
     * has no room or the engine will not give it: as a budget spent, room is
     * found by cooling, counted.
     *
     * @template T @param {() => T} make @param {number} bytes @returns {T | null}
     */
    const take = (make, bytes)=>{
        if (!account.take(bytes, kind))
        {
            return null;
        }
        let made;
        try
        {
            made = make();
        }
        catch {
            account.give(bytes, kind);
            counts.segmentFailures++;
            return null;
        }
        heldBytes += bytes;
        counts.peakSegmentBytes = Math.max(counts.peakSegmentBytes, heldBytes);
        return made;
    };

    /**
     * Segment `at` let go of: no body is in it, and it holds no memory any
     * more once every thread has heard so.
     *
     * @param {number} at
     */
    const letGoSegment = at=>{
        const bytes = segmentAt(at).reach;
        segments[at] = null;
        heldBytes -= bytes;
        account.give(bytes, kind);
        counts.segmentsLetGo++;
        counts.letGoBytes += bytes;
        tell({ segment: at, buffer: null });
    };

    /**
     * Whether a segment that could hold a body of `length` is made that a
     * thread knowing the first `known` does not have.
     *
     * @param {number} known @param {number} length @param {boolean} held
     */
    const beyond = (known, length, held)=>(length > large ? spares : held ? heldSegments : liveSegments)
        .some(at=>at >= known);

    /**
     * Two shared segments of `list` that hold nothing yet, announced ahead
     * of need: address space only, so a quiet run keeps no room of the
     * budget for a burst that may not come. Two, so that a thread told of
     * every segment by its last turn has one to be placed in after the
     * first takes memory, while it hears of the one made then.
     *
     * @param {number[]} list  `liveSegments` or `heldSegments`
     */
    const keepSpare = list=>{
        for (;;)
        {
            let spare = 0;
            for (let i = list.length - 1; i >= 0 && segmentAt(list[i]).reach === 0; i--)
            {
                spare++;
            }
            const buffer = spare >= 2 ? null : take(()=>sharedBuffer(segmentBytes), 0);
            if (buffer === null)
            {
                return;
            }
            list.push(addSegment(buffer, createBuddy(segmentBytes)));
        }
    };

    /**
     * The next own segments, announced ahead with no bytes, in order: each
     * grows to the large body it is given (a growable buffer, every thread's
     * view following it), so a thread writing that body has heard of it. As
     * many as large bodies the budget holds at once: a thread that heard of
     * them is placed without hearing again for as many as it could hold. A
     * spare is address space alone.
     *
     * @type {number[]}
     */
    const spares = [];
    /** The tick a large body last asked for spares the engine would not make: asked again at the next. */
    let sparesAskedAt = -1;
    /** Spares made again for a large body where none is left, once a tick at most. */
    const askSpareOwn = ()=>{
        const now = tick();
        if (spares.length === 0 && sparesAskedAt !== now)
        {
            sparesAskedAt = now;
            keepSpareOwn();
        }
    };
    /**
     * As many as large bodies the budget holds at once, within
     * `SPARE_ADDRESS_BYTES` of address space; two at least.
     */
    const sparesMost = Math.max(2, Math.min(Math.floor(ownMost / (large + UNIT)),
        Math.floor(SPARE_ADDRESS_BYTES / Math.max(ownMost, UNIT))));
    const keepSpareOwn = ()=>{
        while (spares.length < sparesMost)
        {
            // No memory yet, only room to grow into: nothing of the budget.
            const buffer = take(()=>growableShared(0, ownMost), 0);
            if (buffer === null)
            {
                return;
            }
            spares.push(addSegment(buffer, null));
        }
    };

    /**
     * Segment `at` holding `bytes` from now on, where the budget has room:
     * false where it has none. An own segment's buffer grows to them; a
     * shared one is address space of `segmentBytes` from the start, a fixed
     * buffer as a host's API takes (an OPFS handle, and any declared without
     * resizable buffers, refuses a view of a growable one), and a page of it
     * is memory only once written: the budget counts it to the page past
     * its last block, which never comes back down while it is held.
     *
     * @param {number} at @param {number} bytes
     */
    const grow = (at, bytes)=>{
        const one = segmentAt(at);
        const own = one.buddy === null;
        const buffer = /** @type {import('./shared.js').Growable} */ (one.buffer);
        if (take(()=>(own ? growTo(buffer, bytes) : undefined), bytes - one.reach) === null)
        {
            return false;
        }
        one.reach = bytes;
        if (own)
        {
            one.bytes = new Uint8Array(one.buffer, 0, bytes);
        }
        return true;
    };

    /**
     * Shared segments no body is in that hold memory let go of, those empty
     * `idleMs` at least: the sweep's after a while, kept meanwhile for the
     * bodies of a burst to come; one wanting the budget takes them at once.
     * True where one went.
     *
     * @param {number} idleMs
     */
    const letGoEmpty = idleMs=>{
        // Both kinds, with no array made for them, and the clock read only
        // for one that is empty: a reserve of a full cache comes here.
        const went = letGoEmptyOf(liveSegments, idleMs);
        return letGoEmptyOf(heldSegments, idleMs) || went;
    };
    /** @param {number[]} list @param {number} idleMs */
    const letGoEmptyOf = (list, idleMs)=>{
        let kept = 0;
        for (let i = 0; i < list.length; i++)
        {
            const s = list[i];
            const one = segmentAt(s);
            if (one.reach > 0 && buddyOf(s).empty()
                && (idleMs === 0 || age(tick(), one.emptySince) >= idleMs))
            {
                letGoSegment(s);
                continue;
            }
            list[kept++] = s;
        }
        const went = kept < list.length;
        list.length = kept;
        return went;
    };

    /*
     * Where a block lies, as one number: its segment and the byte it starts
     * at there (`segment * segmentBytes + offset`), exact in a double for
     * any segment number a run reaches. A reserve finds room on every call,
     * and a number is no object made for it.
     */
    /** @param {number} place */
    const segmentOf = place=>Math.floor(place / segmentBytes);
    /** @param {number} place */
    const offsetOf = place=>place % segmentBytes;

    /**
     * Room for `length` bytes in a segment of `list` below `limit`: where it
     * is (a place, `segmentOf`, `offsetOf`), or -1. Within the memory the
     * segments hold first, so that none grows while another has room; then
     * in one grown to the page past the block, where the budget has room.
     *
     * @param {number[]} list @param {number} length @param {number} limit
     */
    const placeIn = (list, length, limit)=>{
        for (let i = 0; i < list.length && list[i] < limit; i++)
        {
            const at = list[i];
            const offset = buddyOf(at).place(length, segmentAt(at).reach);
            if (offset >= 0)
            {
                return at * segmentBytes + offset;
            }
        }
        // A segment grows by a page at least: past the budget, none can.
        for (let i = 0; i < list.length && list[i] < limit && account.fits(UNIT, kind); i++)
        {
            const at = list[i];
            const offset = buddyOf(at).place(length);
            if (offset < 0)
            {
                continue;
            }
            if (!grow(at, Math.max(segmentAt(at).reach, pageOf(offset + grainsOf(length)))))
            {
                buddyOf(at).give(offset, length);
                continue;
            }
            keepSpare(list);
            return at * segmentBytes + offset;
        }
        return -1;
    };

    /**
     * The first spare own segment grown to `length` bytes rounded to a page,
     * where a thread knowing the first `limit` segments has it and the budget
     * has room, empty shared segments let go of for it: where it is (a
     * place), or -1. The next spare is announced at once.
     *
     * @param {number} length @param {number} limit
     */
    const placeOwn = (length, limit)=>{
        const bytes = pageOf(length);
        askSpareOwn();
        const at = spares.length > 0 && spares[0] < limit ? spares[0] : -1;
        if (at < 0)
        {
            return -1;
        }
        if (!account.fits(bytes, kind))
        {
            letGoEmpty(0);
        }
        if (!grow(at, bytes))
        {
            return -1;
        }
        segmentAt(at).length = length;
        spares.shift();
        keepSpareOwn();
        return at * segmentBytes;
    };

    /**
     * Room for `length` bytes below segment `limit` as it is now, empty
     * segments let go of where the budget has none for it: where it is (a
     * place), or -1.
     *
     * @param {number} length @param {number} limit @param {boolean} held  of held memory
     */
    const placeNow = (length, limit, held)=>{
        if (length > large)
        {
            return placeOwn(length, limit);
        }
        const list = held ? heldSegments : liveSegments;
        const found = placeIn(list, length, limit);
        if (found >= 0)
        {
            return found;
        }
        // A spare the engine would not make before is asked for again.
        keepSpare(list);
        return letGoEmpty(0) ? placeIn(list, length, limit) : -1;
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
     * spared can be placed by; a list made while a reserve held its own name's
     * body proves that only for its own request. `fruitless`: the requests of `fruitlessTick` a
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
     * Takes every body out of a block (`canLeave` said each may go), or none:
     * a block that cannot be made whole moves nothing. A reader may enter a
     * hot body between `canLeave` and here, and an only copy's write to the
     * disk may fail; so first every hot body is held (HOT to MOVING, which no
     * reader enters), then the copies the disk must have are written, and
     * only once all of that held does any body leave. On a failure each body
     * held is hot again as it was; a copy written meanwhile stays the
     * body's, on the disk, for the next time it goes cold. Gone and retired
     * bodies no one reads can change only here, and go last.
     *
     * @param {number[]} ids @param {number} count  the first `count` of them
     */
    const vacate = (ids, count)=>{
        // Kept between calls, as a full cache vacates at every reserve; a
        // vacate is never made inside another.
        const taken = vacating;
        let held = 0;
        for (let i = 0; i < count; i++)
        {
            const id = ids[i];
            if (stateOf(stateWordOf(id)) !== HOT)
            {
                continue;
            }
            if (Atomics.compareExchange(words, index.at(id) + R_STATE, stateWord(HOT),
                stateWord(MOVING)) !== stateWord(HOT))
            {
                return heldAgain(taken, held);
            }
            taken[held++] = id;
        }
        for (let i = 0; i < held; i++)
        {
            const flags = get(taken[i], R_FLAGS);
            if ((flags & F_DROP) === 0 && (flags & F_ON_DISK) === 0 && !writeOut(taken[i], false)
                && (flags & F_ONLY_COPY) !== 0)
            {
                return heldAgain(taken, held);
            }
        }
        // The packs the only copies lie in flushed, each once; one that fails
        // forgets the copies it may have lost.
        for (let i = 0; i < held; i++)
        {
            const flags = get(taken[i], R_FLAGS);
            if ((flags & (F_DROP | F_ONLY_COPY)) === F_ONLY_COPY
                && ((flags & F_ON_DISK) === 0 || !flushPack(get(taken[i], R_PACK))))
            {
                return heldAgain(taken, held);
            }
        }
        for (let i = 0; i < held; i++)
        {
            const id = taken[i];
            const flags = get(id, R_FLAGS);
            giveBack(id);
            if ((flags & F_DROP) !== 0)
            {
                forgetDisk(id);
                set(id, R_FLAGS, 0);
                store(id, GONE);
                counts.gone++;
            }
            else if ((flags & F_ON_DISK) !== 0)
            {
                store(id, COLD);
                counts.cooled++;
            }
            else
            {
                store(id, GONE);
                counts.gone++;
            }
        }
        for (let i = 0; i < count; i++)
        {
            const id = ids[i];
            const state = stateOf(stateWordOf(id));
            if (state === GONE && get(id, R_SEGMENT) >= 0)
            {
                giveBack(id);
            }
            else if (state === RETIRED)
            {
                takeRetired(id);
            }
        }
        return true;
    };

    /** The bodies `vacate` holds (MOVING) while it takes a block's out. @type {number[]} */
    const vacating = [];
    /**
     * Bodies a `vacate` held, hot again as they were: false, the vacate given up.
     *
     * @param {number[]} taken @param {number} held  the first `held` of them
     */
    const heldAgain = (taken, held)=>{
        for (let i = 0; i < held; i++)
        {
            store(taken[i], HOT);
        }
        return false;
    };

    /**
     * Whether every record of `ids` can leave for the record `spare`'s room
     * (`canLeave`): a loop, not a callback, so that `room` makes no context
     * of its own at each reserve for a closure it seldom runs.
     *
     * @param {number[]} ids @param {number} count  the first `count` of them @param {number} spare
     */
    const allCanLeave = (ids, count, spare)=>{
        for (let i = 0; i < count; i++)
        {
            if (!canLeave(ids[i], spare))
            {
                return false;
            }
        }
        return true;
    };


    /** What `room` knows of the budget the bodies that can leave give back. */
    const BUDGET_UNASKED = 0;
    const BUDGET_YES = 1;
    const BUDGET_NO = 2;
    /** The bodies of a block or a segment as `room`, `reuse` and `freeable` weigh them, kept between reserves. */
    /** @type {number[]} */
    const roomOwners = [];
    /** @type {number[]} */
    const freeableOwners = [];
    /**
     * Whether every record of `ids` but `own` can leave for `own`'s room.
     *
     * @param {number[]} ids @param {number} count  the first `count` of them @param {number} own
     */
    const othersCanLeave = (ids, count, own)=>{
        for (let i = 0; i < count; i++)
        {
            if (ids[i] !== own && !canLeave(ids[i], own))
            {
                return false;
            }
        }
        return true;
    };

    /**
     * The budget the bodies below segment `limit` that can leave would give
     * back by leaving (`canLeave`), `spare` kept: an own segment's whole,
     * and a shared segment's reach where every body in it can go (an empty
     * one's too). A body that leaves a shared segment others stay in gives
     * nothing back: the segment's reach does not come down while it is held.
     *
     * @param {number} limit @param {number} spare
     */
    const freeable = (limit, spare)=>{
        let bytes = 0;
        const owners = freeableOwners;
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            const segment = get(id, R_SEGMENT);
            if (segment >= 0 && segment < limit && segmentAt(segment).buddy === null
                && stateOf(stateWordOf(id)) !== GONE && canLeave(id, spare))
            {
                bytes += segmentAt(segment).reach;
            }
        }
        for (let i = 0; i < liveSegments.length && liveSegments[i] < limit; i++)
        {
            const at = liveSegments[i];
            if (segmentAt(at).reach > 0
                && allCanLeave(owners, buddyOf(at).ownersInto(0, segmentBytes, owners), spare))
            {
                bytes += segmentAt(at).reach;
            }
        }
        return bytes;
    };

    /**
     * Whether the budget would hold `need` bytes more with every body below
     * `limit` that can leave gone, `spare` kept.
     *
     * @param {number} need @param {number} limit @param {number} spare
     */
    const budgetMakes = (need, limit, spare)=>(account.fits(Math.max(0, need - freeable(limit, spare)), kind)
        ? BUDGET_YES : BUDGET_NO);

    /**
     * Room for `length` bytes, the least recently used bodies made cold to
     * find it, but only where their going makes it: a request is placed
     * either in a block of a shared segment, formed by every body in that
     * block leaving (all of them able to), within the segment's reach or a
     * growth the budget has room for; or by budget the bodies give back (an
     * own segment's body, a shared segment all of whose bodies go), which
     * an own segment and held memory are placed by, and a shared request
     * where no block forms. A request the bodies that can leave could not
     * make room for even all gone moves nothing: nor one whose own segment
     * the writer has not heard of. Where it is (a place, as `placeIn`'s),
     * or -1.
     *
     * @param {number} length @param {number} limit  segments a writer has
     * @param {number} [spare]  the record the room is for, never cooled for it
     * @param {boolean} [memory]  held memory (`F_HELD`)
     */
    const room = (length, limit, spare = -1, memory = false)=>{
        let found = placeNow(length, limit, memory);
        if (found >= 0)
        {
            return found;
        }
        // Held memory past a quarter of a segment is a segment of its own too.
        const own = length > large;
        // An own segment the writer has not heard of: no body's going makes it one.
        if (own && !(spares.length > 0 && spares[0] < limit))
        {
            return -1;
        }
        // The budget a body takes where it grows a segment: its pages, or a
        // fresh segment's page its grains reach.
        const need = own ? pageOf(length) : pageOf(grainsOf(length));
        // Whether what can leave gives back budget enough: asked once, where
        // it matters - a state of the call, not a closure that would make a
        // context at every reserve.
        let byBudget = BUDGET_UNASKED;
        if (own || memory)
        {
            byBudget = budgetMakes(need, limit, spare);
            if (byBudget === BUDGET_NO)
            {
                return -1;
            }
        }
        const block = own || memory ? segmentBytes : blockOf(length);
        /** Blocks found holding a body that cannot leave, or making no room, by segment and offset: each looked at once. */
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
                const asked = `${placedOf(length)}:${limit}:${spare}:${memory}`;
                if (listed)
                {
                    // A list made while the record spared was held for its
                    // own reserve says nothing of that body for any other.
                    if (oldestCount === 0 && (spare < 0 || stateOf(stateWordOf(spare)) !== MOVING))
                    {
                        fruitlessAt = now;
                    }
                    else
                    {
                        fruitless.add(asked);
                    }
                    return -1;
                }
                if (fruitlessAt === now || fruitless.has(asked))
                {
                    return -1;
                }
                listOldest();
                listed = true;
                continue;
            }
            const segment = get(id, R_SEGMENT);
            if (segmentAt(segment).buddy === null)
            {
                // A body in a segment of its own gives back budget, and nothing else.
                if (byBudget === BUDGET_UNASKED)
                {
                    byBudget = budgetMakes(need, limit, spare);
                }
                if (byBudget === BUDGET_NO || !cool(id))
                {
                    continue;
                }
            }
            else
            {
                const from = get(id, R_OFFSET) & -block;
                const key = segment * (segmentBytes / block) + from / block;
                if (held?.has(key))
                {
                    continue;
                }
                // The block formed holds the request where it lies within the
                // segment's reach, or the budget grows the segment to it; a
                // whole segment let go of gives budget back.
                const end = from + grainsOf(length);
                const reach = segmentAt(segment).reach;
                let makes = block !== segmentBytes && (end <= reach || account.fits(pageOf(end) - reach, kind));
                if (!makes)
                {
                    if (byBudget === BUDGET_UNASKED)
                    {
                        byBudget = budgetMakes(need, limit, spare);
                    }
                    makes = byBudget === BUDGET_YES;
                }
                const inside = makes ? buddyOf(segment).ownersInto(from, block, roomOwners) : 0;
                // A body alone in its block leaves as any body cools.
                const left = inside > 0 && (inside === 1 && roomOwners[0] === id ? cool(id)
                    : allCanLeave(roomOwners, inside, spare) && vacate(roomOwners, inside));
                if (!left)
                {
                    (held ??= new Set()).add(key);
                    continue;
                }
            }
            found = placeNow(length, limit, memory);
            if (found >= 0)
            {
                return found;
            }
        }
    };

    /**
     * Room for record `id`'s new body of `length` in the block its old body
     * lies at the start of, the old one held (MOVING) and given back only
     * where the new one is sure to be placed: every other body in that block
     * gone first (`evict`, where each can leave), none where it is false.
     * Within the segment's reach, a shared body for a shared body. A body
     * in a segment of its own is that segment's block for a new one of as
     * many pages or more, the budget growing it to them. Not for fewer: its
     * buffer grows and never shrinks, and a segment holds no page more than
     * its body - the old one's pages would stay charged and held unseen, and
     * a body anywhere takes the pages its length does. Where it is (a place),
     * or -1 with nothing moved.
     *
     * @param {number} id @param {number} length @param {number} limit @param {boolean} evict
     */
    const reuse = (id, length, limit, evict)=>{
        const segment = get(id, R_SEGMENT);
        if (segment < 0 || segment >= limit)
        {
            return -1;
        }
        const one = segmentAt(segment);
        if (one.buddy === null)
        {
            const bytes = pageOf(length);
            if (length <= large || bytes < one.reach || (bytes > one.reach && !grow(segment, bytes)))
            {
                return -1;
            }
            // The segment the new body's from now on: not let go of with the old one.
            set(id, R_SEGMENT, -1);
            one.length = length;
            return segment * segmentBytes;
        }
        if (length > large)
        {
            return -1;
        }
        const block = blockOf(length);
        const from = get(id, R_OFFSET) & -block;
        const reach = segmentAt(segment).reach;
        if (from + grainsOf(length) > reach)
        {
            return -1;
        }
        // The old body is in the block, held (MOVING): no other leaving
        // gives nothing to vacate, and vacate passes a body it holds by.
        const inside = buddyOf(segment).ownersInto(from, block, roomOwners);
        const alone = inside === 1 && roomOwners[0] === id;
        if (!alone && (!evict || !othersCanLeave(roomOwners, inside, id) || !vacate(roomOwners, inside)))
        {
            return -1;
        }
        giveBack(id);
        const offset = buddyOf(segment).place(length, reach);
        if (offset < 0)
        {
            throw new Error(`cache: the block at ${from} of segment ${segment} was free and placed nothing`);
        }
        return segment * segmentBytes + offset;
    };

    /**
     * Room in the account for `bytes` more of what it holds beside the
     * segments: empty segments let go, then the bodies no one reads, the least
     * recently read first, cooled with every other of their segment, so that
     * the segment goes (a body in a segment of its own goes with it); one
     * that cannot leave keeps its segment. True where the account has the
     * room now.
     *
     * @param {number} bytes
     */
    const makeRoom = bytes=>{
        if (account.fits(bytes))
        {
            return true;
        }
        counts.roomAsked++;
        letGoEmpty(0);
        // What the account could not hold were every body that can leave gone moves none.
        if (!account.fits(Math.max(0, bytes - freeable(Infinity, -1))))
        {
            counts.roomRefused++;
            return false;
        }
        /** Shared segments found holding a body that cannot leave. @type {Set<number>} */
        const held = new Set();
        listOldest();
        for (let id = nextOldest(Infinity, -1); !account.fits(bytes) && id >= 0; id = nextOldest(Infinity, -1))
        {
            const segment = get(id, R_SEGMENT);
            const buddy = segmentAt(segment).buddy;
            if (buddy === null)
            {
                cool(id);
                continue;
            }
            if (held.has(segment))
            {
                continue;
            }
            const inside = buddy.ownersInto(0, segmentBytes, roomOwners);
            if (!allCanLeave(roomOwners, inside, -1) || !vacate(roomOwners, inside))
            {
                held.add(segment);
                continue;
            }
            letGoEmpty(0);
        }
        const made = account.fits(bytes);
        counts[made ? 'roomMade' : 'roomRefused']++;
        return made;
    };

    /**
     * Record `id`'s body is at `segment` and `offset` from now on.
     *
     * @param {number} id @param {number} segment @param {number} offset
     */
    const placeBody = (id, segment, offset)=>{
        set(id, R_SEGMENT, segment);
        set(id, R_OFFSET, offset);
        segmentAt(segment).buddy?.own(offset, id);
    };

    /** @param {number} segment @param {number} offset @param {number} length */
    const giveRoom = (segment, offset, length)=>{
        const one = segments[segment];
        if (one === null)
        {
            return;
        }
        if (one.buddy === null)
        {
            // An own segment holds no body but this one: it goes with it, as
            // no other body could be placed in it.
            letGoSegment(segment);
            return;
        }
        one.buddy.give(offset, length);
        if (one.buddy.empty())
        {
            one.emptySince = tick();
        }
    };

    /** @param {number} id */
    const giveBack = id=>{
        giveRoom(get(id, R_SEGMENT), get(id, R_OFFSET), get(id, R_LENGTH));
        set(id, R_SEGMENT, -1);
    };

    /** The count of reservations let go of (`H_LET_GO`) as the keeper last gave their room back. */
    let letGoSeen = 0;

    /**
     * The room of every reservation let go of without a body, given back:
     * once the count of those moved since the last time, so a reserve after
     * an `abandon` finds the room it let go of, in a run that lets go of none
     * at the cost of one load.
     */
    const takeLetGo = ()=>{
        const count = Atomics.load(words, H_LET_GO);
        if (count === letGoSeen)
        {
            return;
        }
        letGoSeen = count;
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            if (stateOf(stateWordOf(id)) === GONE && get(id, R_SEGMENT) >= 0)
            {
                giveBack(id);
                counts.abandoned++;
            }
        }
    };

    /**
     * Takes reservation `id` back, its state `word` (writing, or retired
     * writing): its writer is taken for gone, what it would commit now fails,
     * the mark being no reservation's any more, and its room is given back.
     * False where the word moved meanwhile (the writer committed). The word
     * is the one its caller looked at: one loaded again here could be a body
     * committed and read since, which is no reservation to take back.
     *
     * @param {number} id @param {number} word
     */
    const takeBack = (id, word)=>{
        const writing = stateOf(word) === WRITING;
        if (!writing && stateOf(word) !== RETIRED_WRITING)
        {
            throw new Error(`cache: record ${id} taken back from state ${stateOf(word)}, not a writer's`);
        }
        if (Atomics.compareExchange(words, index.at(id) + R_STATE, word, stateWord(writing ? GONE : RETIRED))
            !== word)
        {
            return false;
        }
        if (writing)
        {
            giveBack(id);
            set(id, R_FLAGS, 0);
        }
        else
        {
            takeRetired(id);
        }
        return true;
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

    /**
     * Packs a copy could not be read from in this run (the read threw, or an
     * only copy came back short): not compacted any more, as the same read
     * would fail at every sweep and hold up the packs behind it. A raise
     * still tries its own body there.
     *
     * @type {Set<number>}
     */
    const setAside = new Set();

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
     * raise. A pack written nothing since its last flush is not flushed
     * again: a sweep or a save flushes what it changed, not every file.
     *
     * @param {number} number
     */
    const flushPack = number=>{
        if (durable.get(number) === filled.get(number))
        {
            return true;
        }
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
     * Fixed memory the disk reads and writes go through where theirs may
     * grow, at most `IO_PIECE`, made once it is first wanted.
     */
    let ioScratch = new Uint8Array(0);
    /** @param {number} length */
    const pieceOf = length=>{
        const bytes = Math.min(length, IO_PIECE);
        if (ioScratch.length < bytes)
        {
            ioScratch = new Uint8Array(Math.min(IO_PIECE, Math.max(bytes, ioScratch.length * 2)));
        }
        return ioScratch.subarray(0, bytes);
    };
    /** Whether a view's memory is of a fixed length, as a host's disk takes. @param {Uint8Array} view */
    const fixedMemory = view=>{
        const buffer = /** @type {any} */ (view.buffer);
        return buffer.growable !== true && buffer.resizable !== true;
    };
    /**
     * Writes `view` to `file` at `at`: at once where its memory is fixed, in
     * pieces through the keeper's own otherwise. Whether all of it was.
     *
     * @param {DiskFile} file @param {number} at @param {Uint8Array} view
     */
    const writeTo = (file, at, view)=>{
        if (fixedMemory(view))
        {
            return file.write(view, { at }) === view.length;
        }
        for (let done = 0; done < view.length;)
        {
            const piece = pieceOf(view.length - done);
            piece.set(view.subarray(done, done + piece.length));
            if (file.write(piece, { at: at + done }) !== piece.length)
            {
                return false;
            }
            done += piece.length;
        }
        return true;
    };
    /**
     * Reads into `view` from `file` at `at`, as `writeTo` writes: the bytes read.
     *
     * @param {DiskFile} file @param {number} at @param {Uint8Array} view
     */
    const readFrom = (file, at, view)=>{
        if (fixedMemory(view))
        {
            return file.read(view, { at });
        }
        let done = 0;
        while (done < view.length)
        {
            const piece = pieceOf(view.length - done);
            const read = file.read(piece, { at: at + done });
            view.set(piece.subarray(0, read), done);
            done += read;
            if (read < piece.length)
            {
                break;
            }
        }
        return done;
    };
    /**
     * Copies `length` bytes of pack `from` at `fromAt` to `file` at `at`, a
     * piece at a time: true where all of them were written, `SOURCE_SHORT`
     * or `SOURCE_FAILED` where the pack read held fewer or threw, false where
     * the write did not take them.
     *
     * @param {DiskFile} file @param {number} at @param {DiskFile} from
     * @param {number} fromAt @param {number} length
     */
    const copyTo = (file, at, from, fromAt, length)=>{
        for (let done = 0; done < length;)
        {
            const piece = pieceOf(length - done);
            let read = -1;
            try
            {
                read = from.read(piece, { at: fromAt + done });
            }
            catch
            {
                return SOURCE_FAILED;
            }
            if (read !== piece.length)
            {
                return SOURCE_SHORT;
            }
            if (file.write(piece, { at: at + done }) !== piece.length)
            {
                return false;
            }
            done += piece.length;
        }
        return true;
    };

    /**
     * Appends a body of `length` bytes to the pack bodies go to, flushed
     * where asked: from `view`, or from pack `from` at `fromAt`. Where it
     * wrote them (in `pack`), or `NOT_YET` where the next pack is not open
     * yet, `REFUSED` where the disk failed, counted, and `SOURCE_SHORT` or
     * `SOURCE_FAILED` where the pack copied from held less or threw. Where it
     * wrote them only once they are all written: a body cut short is no
     * body, and the next is written over it.
     *
     * @param {number} length @param {boolean} flush @param {Uint8Array | null} view
     * @param {DiskFile | null} [from] @param {number} [fromAt]
     */
    const append = (length, flush, view, from = null, fromAt = 0)=>{
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
            const written = view !== null ? writeTo(file, packTop, view)
                : copyTo(file, packTop, /** @type {DiskFile} */ (from), fromAt, length);
            if (written === SOURCE_SHORT || written === SOURCE_FAILED)
            {
                return written;
            }
            if (written !== true)
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
        const at = append(length, flush, one.bytes.subarray(offset, offset + length));
        if (at < 0)
        {
            return false;
        }
        set(id, R_PACK, pack);
        set(id, R_PACK_OFFSET, at);
        set(id, R_FLAGS, get(id, R_FLAGS) | F_ON_DISK);
        addLive(pack, length);
        owe(id);
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
                owe(id);
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
        /** What its file held as this run knew it: reclaimed once the file is gone. */
        const bytes = filled.get(number) ?? 0;
        packs.delete(number);
        live.delete(number);
        filled.delete(number);
        durable.delete(number);
        setAside.delete(number);
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
            counts.reclaimedBytes += bytes;
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
    const cool = id=>startCooling(id) && finishCooling(id);

    /**
     * The first half of `cool`, for many bodies before any finishes: the
     * body held (HOT to MOVING, which no reader enters) and its copy written
     * where the disk lacks one, not flushed; or, asked away, gone now. False
     * where it is read.
     *
     * @param {number} id
     */
    const startCooling = id=>{
        if (Atomics.compareExchange(words, index.at(id) + R_STATE, stateWord(HOT), stateWord(MOVING))
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
        if ((get(id, R_FLAGS) & F_ON_DISK) === 0)
        {
            writeOut(id, false);
        }
        return true;
    };

    /**
     * The second half: an only copy's pack flushed, once for every body a
     * cool wrote there (a pack flushed since is not flushed again), then the
     * body out of memory - cold, or gone where it can be made again; an only
     * copy the disk does not hold is hot again, and the answer false.
     *
     * @param {number} id
     */
    const finishCooling = id=>{
        if (stateOf(stateWordOf(id)) === GONE)
        {
            return true;
        }
        const onlyCopy = (get(id, R_FLAGS) & F_ONLY_COPY) !== 0;
        if (onlyCopy && (get(id, R_FLAGS) & F_ON_DISK) !== 0)
        {
            // A flush that fails forgets the copies it may have lost.
            flushPack(get(id, R_PACK));
        }
        const onDisk = (get(id, R_FLAGS) & F_ON_DISK) !== 0;
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
        // Saved by a run of a larger budget: no segment of this one holds it.
        if (!fits(length))
        {
            counts.raiseFailed++;
            return false;
        }
        store(id, MOVING);
        const found = room(length, known);
        const segment = segmentOf(found);
        const offset = offsetOf(found);
        if ((get(id, R_FLAGS) & F_ON_DISK) === 0)
        {
            // A flush failed while room was made, and its copy with it.
            if (found >= 0)
            {
                giveRoom(segment, offset, length);
            }
            set(id, R_FLAGS, 0);
            store(id, GONE);
            counts.lostOnDisk++;
            counts.raiseFailed++;
            return false;
        }
        if (found < 0)
        {
            store(id, COLD);
            counts[beyond(known, length, false) ? 'refusedUnseen' : 'raiseFailed']++;
            return false;
        }
        const one = segmentAt(segment);
        /** Bytes read, -1 where the disk threw. */
        let read = -1;
        try
        {
            read = readFrom(/** @type {DiskFile} */ (packs.get(get(id, R_PACK))), get(id, R_PACK_OFFSET),
                one.bytes.subarray(offset, offset + length));
        }
        catch
        {
            // A disk that threw: counted below.
        }
        if (read !== length)
        {
            giveRoom(segment, offset, length);
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
            setAside.add(get(id, R_PACK));
            store(id, COLD);
            return false;
        }
        placeBody(id, segment, offset);
        // Brought back now: not taken for idle since the last sweep.
        set(id, R_TICK, tick());
        store(id, HOT);
        counts.raised++;
        return true;
    };

    // --- room on the disk ---------------------------------------------------

    /**
     * Takes every body out of pack `number`, so the next save lets go of it:
     * each is written anew at the end of the pack bodies go to, its copy
     * there the disk's (a hot one from its segment, a cold one read from
     * here), or, where `evict` says so and it can be made again, a cold one
     * goes and a hot one forgets its copy (memory holds it). Stops where the
     * disk will not take a body now, or `COMPACT_PASS_BYTES` are moved: what
     * is left stays.
     *
     * @param {number} number @param {boolean} evict
     */
    const empty = (number, evict)=>{
        const from = /** @type {DiskFile} */ (packs.get(number));
        let moved = 0;
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
            if (moved > 0 && moved + length > COMPACT_PASS_BYTES)
            {
                return;
            }
            // A hot body is not written while it is hot: memory holds the
            // copy's bytes. A cold one goes from pack to pack a piece at a time.
            const one = state === HOT ? segments[get(id, R_SEGMENT)] : null;
            const at = one ? append(length, (flags & F_ONLY_COPY) !== 0,
                one.bytes.subarray(get(id, R_OFFSET), get(id, R_OFFSET) + length))
                : append(length, (flags & F_ONLY_COPY) !== 0, null, from, get(id, R_PACK_OFFSET));
            if (at === SOURCE_SHORT && (flags & F_ONLY_COPY) === 0)
            {
                // The pack holds less than the index says: the body is gone.
                forgetDisk(id);
                set(id, R_FLAGS, 0);
                store(id, GONE);
                counts.lostOnDisk++;
                continue;
            }
            if (at === SOURCE_SHORT || at === SOURCE_FAILED)
            {
                counts.diskFailures++;
                setAside.add(number);
                return;
            }
            if (at < 0)
            {
                return;
            }
            moved += length;
            addLive(number, -length);
            addLive(pack, length);
            set(id, R_PACK, pack);
            set(id, R_PACK_OFFSET, at);
            owe(id);
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
            if (number !== pack && !setAside.has(number) && bytes > 0 && share > 0 && share < COMPACT_LIVE
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
        /** The packs either file names. @type {Set<number>} */
        const named = new Set();
        read.forEach((state, at)=>{
            slots[at].onlyCopies = state?.onlyCopies ?? new Set();
            state?.packs.forEach(number=>named.add(number));
            state?.onlyCopies.forEach(number=>named.add(number));
            state?.entries.forEach(entry=>named.add(entry.pack));
        });
        // A pack file no index names: a run that ended before a save listed a
        // pack it opened left it, and what it holds is no one's.
        /** @type {number[]} */
        const strays = [];
        for (const name of await disk.names?.() ?? [])
        {
            const number = Number(name.slice(name.indexOf('-') + 1));
            if (packFile(number) === name && !named.has(number))
            {
                strays.push(number);
            }
        }
        // Numbers given from past the highest either file names or a file
        // holds, not from the count the run before reached: a pack let go of
        // gives its number back, so the numbers a run reads never run out.
        for (const number of [...named, ...strays])
        {
            nextPackNumber = Math.max(nextPackNumber, number + 1);
        }
        for (const number of strays)
        {
            if (disk.remove === undefined)
            {
                // Cut where it cannot be removed: opened for it.
                packs.set(number, await disk.open(packFile(number)));
            }
            removePack(number);
            counts.strayPacks++;
        }
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
        keepSpare(liveSegments);
        keepSpareOwn();
        keepSpare(heldSegments);
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

        /**
         * Room for `bytes` more in the account, beside the segments: what a
         * take of another kind that did not fit asks for (`openAccount`'s
         * `room`); true where the account has it now.
         *
         * @param {number} bytes
         */
        makeRoom,
        /** Segments by number, null for one let go, for a thread joining later. */
        segmentBuffers: ()=>segments.map(one=>(one === null ? null : one.buffer)),

        /**
         * Settles once no pack is opening: true where a body can go to the
         * disk now (a pack is open to append to, or opened ahead), false
         * where there is no disk, it is closed, or the pack failed to open
         * (`diskFailures`). The packs open behind a promise, as files do on
         * OPFS: what a run puts and saves before then stays in memory alone.
         *
         * @returns {Promise<boolean>}
         */
        ready: async()=>{
            await nextPack?.catch(()=>{});
            return disk !== null && (pack >= 0 || readyPack !== null);
        },

        /**
         * Room for `name`'s body of `length` bytes, in a segment below
         * `known`: true with the record, where to write and the reservation's
         * mark in `place` (`P_ID`...), or false with why counted. The writer
         * stores the record hot (`commit`) once it has written. `flags` is
         * the word `reserveFlags` makes; with `F_HELD`, memory the writer
         * keeps writing and reading in place, never committed and never taken
         * back by `abandonAfterMs` (`Reader.hold`).
         *
         * @param {string} name @param {number} length @param {number} flags
         * @param {number} known @param {Int32Array} place
         * @returns {boolean}
         */
        reserve(name, length, flags, known, place){
            checkName(name);
            checkFlags(flags);
            if (!Number.isInteger(length))
            {
                throw new RangeError(`cache: a body of ${length} bytes`);
            }
            // Refused before anything is moved for it.
            if (!fits(length))
            {
                counts.refusedLarge++;
                return false;
            }
            let id = recordOf(name);
            if (id < 0)
            {
                counts.refusedRoom++;
                return false;
            }
            const state = stateOf(stateWordOf(id));
            // Reservations let go of without a body keep their room until here.
            takeLetGo();
            if (state === GONE && get(id, R_SEGMENT) >= 0)
            {
                giveBack(id);
                counts.abandoned++;
            }
            // A hot body no one is in is held while room is found, so that a
            // reservation refused leaves the name's body as it was.
            const held = state === HOT && Atomics.compareExchange(words, index.at(id) + R_STATE,
                stateWord(HOT), stateWord(MOVING)) === stateWord(HOT);
            const memory = (flags & F_HELD) !== 0;
            // Room as it is; then the old body's own block, where no other
            // body need go; then the oldest bodies; then the old body's block
            // with those beside it gone. The name's own body is not cooled for
            // it, and given back only where the new one is placed for sure.
            const writtenOver = held && !memory;
            let found = -1;
            if (writtenOver)
            {
                found = placeNow(length, known, memory);
                if (found < 0)
                {
                    found = reuse(id, length, known, false);
                }
            }
            if (found < 0)
            {
                found = room(length, known, id, memory);
            }
            if (found < 0 && writtenOver)
            {
                found = reuse(id, length, known, true);
            }
            if (found < 0)
            {
                if (held)
                {
                    store(id, HOT);
                }
                counts[beyond(known, length, memory) ? 'refusedUnseen' : 'refusedRoom']++;
                return false;
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
                    giveRoom(segmentOf(found), offsetOf(found), length);
                    counts.refusedRoom++;
                    return false;
                }
                id = fresh;
            }
            forgetDisk(id);
            set(id, R_FLAGS, flags);
            store(id, MOVING);
            const segment = segmentOf(found);
            const offset = offsetOf(found);
            placeBody(id, segment, offset);
            set(id, R_LENGTH, length);
            // Now, not the last sweep's tick: a reservation's age, which
            // `abandonAfterMs` takes it back by, counts from when it was made.
            set(id, R_TICK, tick());
            const mark = nextMark;
            nextMark = nextMark === MAX_MARK ? 1 : nextMark + 1;
            Atomics.store(words, index.at(id) + R_STATE, stateWord(WRITING, mark));
            counts.reserved++;
            place[P_ID] = id;
            place[P_SEGMENT] = segment;
            place[P_OFFSET] = offset;
            place[P_MARK] = mark;
            return true;
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
                        placedBytes += placedOf(length);
                    }
                }
            }
            return { bodies, bytes, hotBytes, placedBytes };
        },

        /**
         * Lets go of every body under the names that begin with `prefix`, as
         * an owner that goes takes what it held with it: what was there, and
         * how many of those are still read (they go once no one reads them,
         * as a `drop` of each would leave them). What it reserved and never
         * committed, or holds, is taken back at once.
         *
         * @param {string} prefix
         * @returns {{ bodies: number, bytes: number, waiting: number }}
         */
        release(prefix){
            checkName(prefix);
            // Reservations let go of, this owner's among them: their room back now.
            takeLetGo();
            let bodies = 0;
            let bytes = 0;
            let waiting = 0;
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const word = stateWordOf(id);
                let state = stateOf(word);
                if (state === GONE || !namedUnder(id, prefix))
                {
                    continue;
                }
                bodies++;
                bytes += get(id, R_LENGTH);
                // A reservation the owner made and never committed, and memory
                // it held, are its alone and nobody reads them: the owner
                // going is their writer going, so their room comes back now,
                // as one held past abandonAfterMs does, and a late commit fails.
                if (state === WRITING || state === RETIRED_WRITING)
                {
                    if (takeBack(id, word))
                    {
                        continue;
                    }
                    // Committed since it was looked at, and maybe read: a body now.
                    state = stateOf(stateWordOf(id));
                    if (state === GONE)
                    {
                        continue;
                    }
                }
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
            // What was let go of is given back below, so a reserve after it scans for none.
            letGoSeen = Atomics.load(words, H_LET_GO);
            const at = tick();
            Atomics.store(words, H_TICK, at);
            /** Idle bodies held and written, to leave memory once their packs are flushed. @type {number[]} */
            const cooling = [];
            let coolingBytes = 0;
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
                    && (get(id, R_FLAGS) & F_HELD) === 0
                    && age(at, get(id, R_TICK)) >= abandonAfterMs)
                {
                    if (takeBack(id, word))
                    {
                        counts.takenBack++;
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
                if (state === GONE && get(id, R_NAME) >= 0 && (get(id, R_FLAGS) & F_ON_DISK) === 0
                    && !changed.has(id))
                {
                    forgetName(id);
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
                    && age(at, get(id, R_TICK)) >= coldAfterMs
                    && (cooling.length === 0 || coolingBytes + get(id, R_LENGTH) <= COOL_PASS_BYTES)
                    && startCooling(id))
                {
                    cooling.push(id);
                    coolingBytes += get(id, R_LENGTH);
                }
                else if (state === COLD && (get(id, R_FLAGS) & F_ONLY_COPY) === 0
                    && age(at, get(id, R_TICK)) >= goneAfterMs)
                {
                    drop(id);
                }
            }
            // Each pack the cooled only copies went to flushed once, not once a body.
            for (const id of cooling)
            {
                finishCooling(id);
            }
            const deadUnits = words[H_NAMES] - namedUnits;
            if (deadUnits >= PACK_NAMES_UNITS && deadUnits >= namedUnits)
            {
                packNames();
            }
            // An own segment went with its body.
            letGoEmpty(releaseAfterMs);
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
            durable.clear();
            setAside.clear();
            changed.clear();
            slots.length = 0;
            readyPack = null;
            // The disk's pieces: nothing is read or written any more.
            ioScratch = new Uint8Array(0);
            return whole;
        },

        /**
         * Hot bytes, segments, cold bytes and what was done, for the report:
         * `segments` and `segmentBytes` those holding memory (a spare holds
         * none), `segmentsMade` and `segmentsLetGo` every one
         * announced.
         */
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
            const sharedOnes = [...liveSegments, ...heldSegments];
            const shares = sharedOnes.map(buddyOf);
            // The own spares among them, of no bytes.
            const own = /** @type {NonNullable<typeof segments[0]>[]} */ (
                segments.filter(one=>one?.buddy === null));
            const ownBytes = own.reduce((sum, one)=>sum + one.bytes.length, 0);
            return {
                records: words[H_COUNT], names: named, freeRecords: free.length, hot, hotBytes, cold,
                coldBytes,
                // The spares among them, of no bytes, hold no memory.
                segments: sharedOnes.filter(at=>segmentAt(at).reach > 0).length
                    + own.filter(one=>one.length > 0).length,
                segmentBytes: heldBytes,
                placedBytes: shares.reduce((sum, one)=>sum + one.used(), ownBytes),
                roundingBytes: shares.reduce((sum, one)=>sum + one.wasted(),
                    own.reduce((sum, one)=>sum + one.bytes.length - one.length, 0)),
                indexBytes: shared.records.byteLength + shared.names.byteLength
                    + index.table().byteLength,
                // The fixed memory disk reads and writes of growable memory go through.
                ioScratchBytes: ioScratch.length,
                // The address space the own segments announced ahead may grow into.
                spareAddressBytes: spares.length * ownMost,
                // The shared segments' room lists, beside their memory: 9 bytes a grain.
                metadataBytes: shares.reduce((sum, one)=>sum + one.metadataBytes(), 0),
                packs: packs.size,
                // Let go of, the file not gone yet: removal pending, or failed and left to the next run.
                going: going.size,
                packsSetAside: setAside.size,
                diskBytes: [...filled.values()].reduce((sum, bytes)=>sum + bytes, 0),
                liveDiskBytes: [...live.values()].reduce((sum, bytes)=>sum + bytes, 0),
                ...counts,
                account: account.report(),
            };
        },
    };
    return keeper;
}

/** @typedef {Awaited<ReturnType<typeof openKeeper>>} Keeper */
