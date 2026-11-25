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
 * body going cold again writes nothing. What the disk holds survives the run:
 * the index of it is saved (`save`) and read back when the keeper opens.
 *
 * Bodies are of two kinds. One the cache can make again from its source (a
 * block of a bundle, a translation) goes cold when idle and away when idle
 * long, or at once where there is no disk. One that is the only copy of its
 * data (what a program wrote) goes to the disk, never away, and leaves memory
 * only once the disk holds it.
 */

import { blockOf, checkSegmentBytes, createBuddy } from './buddy.js';
import {
    COLD, F_DROP, F_ONLY_COPY, F_ON_DISK, GONE, HEADER_WORDS, HOT, H_COUNT, H_NAMES, H_TICK,
    MOVING, RECORD_WORDS, RETIRED, R_FLAGS, R_HASH_A, R_HASH_B, R_LENGTH, R_NAME, R_NAME_LENGTH,
    R_OFFSET, R_PACK, R_PACK_OFFSET, R_SEGMENT, R_STATE, R_TICK, WRITING, growableShared,
    growTo, sharedBuffer,
    hashName, readersOf, stateOf, stateWord, viewIndex,
} from './shared.js';

const MIB = 1024 * 1024;

/** Room the records and names reserve to grow into: address space only, touched as used. */
const MAX_RECORDS = 1 << 20;
const MAX_NAME_UNITS = 1 << 25;
const FIRST_TABLE = 1024;
/** Packs a run opens at most: 64 TiB of the default packs. */
const MAX_PACKS = 1 << 20;
/** The layout of the index saved on the disk: another is not read. */
const INDEX_VERSION = 1;

/**
 * A file on the disk as the keeper uses it: the shape of a
 * `FileSystemSyncAccessHandle`. Its methods are called on the keeper's thread
 * in the middle of its work and call none of the keeper's methods; one that
 * throws, or reads or writes less than asked, is a failure of the disk,
 * counted (`diskFailures`), and the body stays where it was.
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
 * @property {(message: { segment?: number, buffer?: SharedArrayBuffer | null,
 *     table?: SharedArrayBuffer }) => void} [announce]  sent to every thread reading:
 *     called on the keeper's thread in the middle of its work, it calls none of
 *     the keeper's methods; one that throws is counted (`announceFailures`)
 * @property {() => number} [now]
 */

/**
 * @param {KeeperOptions} options
 */
export async function openKeeper(options){
    const {
        budget, segmentBytes = 16 * MIB, packBytes = 64 * MIB,
        coldAfterMs = 30_000, goneAfterMs = 7 * 24 * 3600_000, releaseAfterMs = 10_000,
        announce = ()=>{}, now = ()=>performance.now(),
    } = options;
    /** The disk, null once closed: from then on the keeper is memory's only. */
    let disk = options.disk ?? null;
    // Ages are told on a 32-bit clock that wraps (`age`): a span past half of
    // it would read as a fresh one.
    for (const [name, ms] of Object.entries({ coldAfterMs, goneAfterMs, releaseAfterMs }))
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
    const index = viewIndex(shared);
    const { words } = index;
    const started = now();

    /** @type {({ buffer: SharedArrayBuffer, bytes: Uint8Array, buddy: import('./buddy.js').Buddy,
     *     emptySince: number } | null)[]} */
    const segments = [];
    /** @type {DiskFile[]} */
    const packs = [];
    /** The pack bodies are appended to, and where. */
    let pack = -1;
    let packTop = 0;
    /** The next pack, opened ahead: opening a file may not be synchronous. @type {Promise<DiskFile> | null} */
    let nextPack = null;
    /** @type {DiskFile | null} */
    let readyPack = null;
    /** Closed: no file is opened any more. */
    let closed = false;

    const counts = {
        reserved: 0, refusedBusy: 0, refusedRoom: 0, refusedLarge: 0, refusedUnseen: 0,
        replaced: 0, raised: 0, raiseFailed: 0, cooled: 0, written: 0, writtenBytes: 0, gone: 0,
        loaded: 0, saved: 0, segmentsMade: 0, segmentsLetGo: 0, letGoBytes: 0, deadDiskBytes: 0,
        diskFailures: 0, lostOnDisk: 0, abandoned: 0, skippedEntries: 0, announceFailures: 0,
        segmentFailures: 0,
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
            announce(message);
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
        }
    };

    /**
     * The record of `name`, made where there is none.
     *
     * @param {string} name
     */
    const recordOf = name=>{
        const hash = hashName(name);
        const known = index.find(name, hash);
        if (known >= 0)
        {
            return known;
        }
        const from = words[H_NAMES];
        // Room for its record first: a name written for none would be spent.
        if (words[H_COUNT] >= MAX_RECORDS || from + name.length > MAX_NAME_UNITS)
        {
            return -1;
        }
        growNames(from + name.length);
        for (let i = 0; i < name.length; i++)
        {
            index.names[from + i] = name.charCodeAt(i);
        }
        words[H_NAMES] = from + name.length;
        const id = newRecord(hash[0], hash[1], from, name.length);
        if (id >= 0)
        {
            insert(id, hash[0]);
        }
        return id;
    };

    /**
     * A record of no body yet, at the end of the records, not in the table:
     * its id, or -1 where the records are full.
     *
     * @param {number} a @param {number} b @param {number} nameAt @param {number} nameLength
     */
    const newRecord = (a, b, nameAt, nameLength)=>{
        const id = words[H_COUNT];
        if (id >= MAX_RECORDS)
        {
            return -1;
        }
        const bytesNeeded = (HEADER_WORDS + (id + 1) * RECORD_WORDS) * 4;
        if (bytesNeeded > shared.records.byteLength)
        {
            growTo(shared.records, Math.min(shared.records.maxByteLength,
                Math.max(bytesNeeded, shared.records.byteLength * 2)));
        }
        set(id, R_HASH_A, a);
        set(id, R_HASH_B, b);
        set(id, R_NAME, nameAt);
        set(id, R_NAME_LENGTH, nameLength);
        set(id, R_SEGMENT, -1);
        set(id, R_PACK, -1);
        set(id, R_FLAGS, 0);
        store(id, GONE);
        Atomics.store(words, H_COUNT, id + 1);
        return id;
    };

    /**
     * The name of record `old` led to a new record from now on, its name
     * shared; `old` retired, its readers left to finish. The new one's id, or
     * -1 where the records are full.
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
            const word = stateWordOf(old);
            const retired = stateWord(RETIRED, readersOf(word));
            if (Atomics.compareExchange(words, index.at(old) + R_STATE, word, retired) === word)
            {
                break;
            }
        }
        counts.replaced++;
        return id;
    };

    /** @param {number} id @param {number} first */
    const insert = (id, first)=>{
        let table = index.table();
        if ((words[H_COUNT] + 1) * 2 > table.length)
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
    };

    // --- segments -----------------------------------------------------------

    const madeBytes = ()=>segments.reduce((sum, one)=>sum + (one ? one.bytes.length : 0), 0);

    /** A new segment, announced, or -1 past the budget. */
    const makeSegment = ()=>{
        if (madeBytes() + segmentBytes > budget)
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
        // A number is never given to a second buffer: a thread that has not
        // heard a segment was let go still reads through its old view, and
        // under the same number it would read another body.
        const at = segments.length;
        segments.push(null);
        segments[at] = { buffer, bytes: new Uint8Array(buffer), buddy: createBuddy(segmentBytes),
            emptySince: tick() };
        counts.segmentsMade++;
        tell({ segment: at, buffer });
        return at;
    };

    /** One segment no body is in, announced ahead of need, where the budget has room. */
    const keepSpare = ()=>{
        if (!segments.some(one=>one !== null && one.buddy.empty()))
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
        for (let at = 0; at < Math.min(limit, segments.length); at++)
        {
            const one = segments[at];
            if (one === null)
            {
                continue;
            }
            const offset = one.buddy.place(length);
            if (offset >= 0)
            {
                return { segment: at, offset };
            }
        }
        return null;
    };

    /**
     * Room for `length` bytes, the least recently used bodies made cold to
     * find it.
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
        for (const id of oldestHot(limit))
        {
            if (id === spare)
            {
                continue;
            }
            cool(id);
            found = placeIn(length, limit);
            if (found !== null)
            {
                return found;
            }
        }
        return null;
    };

    /** @param {number} limit  @returns {number[]} hot ids no one reads, oldest first */
    const oldestHot = limit=>{
        const ids = [];
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            const word = stateWordOf(id);
            if (stateOf(word) === HOT && readersOf(word) === 0 && get(id, R_SEGMENT) < limit)
            {
                ids.push(id);
            }
        }
        const at = tick();
        return ids.sort((a, b)=>age(at, get(b, R_TICK)) - age(at, get(a, R_TICK)));
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
            && packs.length < MAX_PACKS)
        {
            const name = `pack-${packs.length}`;
            const opening = disk;
            // A disk that throws at once fails the same way as one whose
            // promise does: counted, and the body that wanted it stays.
            nextPack = Promise.resolve().then(()=>opening.open(name))
                .then(file=>{
                    nextPack = null;
                    // Opened after the keeper closed: let go of here, once.
                    if (closed)
                    {
                        closeFile(file);
                        return file;
                    }
                    readyPack = file;
                    return file;
                }, e=>{
                    counts.diskFailures++;
                    nextPack = null;
                    throw e;
                });
            nextPack.catch(()=>{});
        }
    };

    /**
     * Writes a hot body to the disk: true where the disk holds it now.
     *
     * @param {number} id
     */
    const writeOut = id=>{
        if (disk === null)
        {
            return false;
        }
        const length = get(id, R_LENGTH);
        if (pack < 0 || packTop + length > packBytes)
        {
            // Past the packs a run reads back, the disk is full: an index of
            // more would not be read.
            if (packs.length >= MAX_PACKS)
            {
                return false;
            }
            if (readyPack === null)
            {
                openNextPack();
                return false;
            }
            packs.push(readyPack);
            readyPack = null;
            pack = packs.length - 1;
            packTop = 0;
            openNextPack();
        }
        const one = /** @type {NonNullable<typeof segments[0]>} */ (segments[get(id, R_SEGMENT)]);
        const offset = get(id, R_OFFSET);
        try
        {
            // A disk that wrote less than asked holds no body: what it wrote is
            // written over by the next one.
            if (packs[pack].write(one.bytes.subarray(offset, offset + length), { at: packTop })
                !== length)
            {
                counts.diskFailures++;
                return false;
            }
            if (get(id, R_FLAGS) & F_ONLY_COPY)
            {
                packs[pack].flush();
            }
        }
        catch {
            counts.diskFailures++;
            return false;
        }
        set(id, R_PACK, pack);
        set(id, R_PACK_OFFSET, packTop);
        set(id, R_FLAGS, get(id, R_FLAGS) | F_ON_DISK);
        packTop += length;
        counts.written++;
        counts.writtenBytes += length;
        return true;
    };

    /** @param {number} id */
    const forgetDisk = id=>{
        if (get(id, R_FLAGS) & F_ON_DISK)
        {
            counts.deadDiskBytes += get(id, R_LENGTH);
        }
        set(id, R_FLAGS, get(id, R_FLAGS) & ~F_ON_DISK);
        set(id, R_PACK, -1);
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

    /** @param {number} id */
    const drop = id=>{
        const word = stateWordOf(id);
        const state = stateOf(word);
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

    // --- the index on the disk -----------------------------------------------

    /** The two files the index is saved to in turn, the newer whole one read. */
    const INDEX_FILES = ['index-a', 'index-b'];
    /** @type {DiskFile[]} */
    const indexFiles = [];
    let generation = 0;

    /** @param {DiskFile} file */
    const readIndex = file=>{
        try
        {
            // A file the disk fails to read is no index: the other one is.
            const bytes = new Uint8Array(file.getSize());
            if (file.read(bytes, { at: 0 }) !== bytes.length)
            {
                return null;
            }
            const saved = JSON.parse(new TextDecoder().decode(bytes));
            // A generation the next save can count on from, in a file of two.
            return saved?.version === INDEX_VERSION && Number.isSafeInteger(saved.generation)
                && saved.generation >= 0 && saved.generation < Number.MAX_SAFE_INTEGER
                && Number.isInteger(saved.packs) && saved.packs >= 0 && saved.packs <= MAX_PACKS
                && Array.isArray(saved.records) ? saved : null;
        }
        catch {
            // Torn mid-write, or not read: the other file is the index.
            return null;
        }
    };

    /** What the disk held when the keeper opened: packs, and a record cold for each body. */
    const load = async()=>{
        if (disk === null)
        {
            return;
        }
        for (const name of INDEX_FILES)
        {
            indexFiles.push(await disk.open(name));
        }
        const saved = indexFiles.map(readIndex).filter(one=>one !== null)
            .sort((a, b)=>b.generation - a.generation)[0];
        if (saved === undefined)
        {
            return;
        }
        generation = saved.generation;
        for (let at = 0; at < saved.packs; at++)
        {
            packs.push(await disk.open(`pack-${at}`));
        }
        if (packs.length > 0)
        {
            pack = packs.length - 1;
            packTop = packs[pack].getSize();
        }
        for (const entry of saved.records)
        {
            // An entry that does not say a body is skipped, not trusted: the
            // rest of the index is still the disk's.
            if (!Array.isArray(entry) || entry.length !== 5 || typeof entry[0] !== 'string'
                || !entry.slice(1).every(Number.isInteger))
            {
                counts.skippedEntries++;
                continue;
            }
            const [name, from, offset, length, flags] = entry;
            // Within a pack this run opened, and within that pack's file.
            if (from < 0 || from >= packs.length || offset < 0 || !(length > 0)
                || offset + length > packs[from].getSize())
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
            counts.loaded++;
        }
    };

    /**
     * @param {number} id
     */
    const nameOf = id=>{
        const from = get(id, R_NAME);
        const units = index.names.subarray(from, from + get(id, R_NAME_LENGTH));
        // In pieces: a name passed whole as arguments can be longer than a
        // call may take.
        let name = '';
        for (let at = 0; at < units.length; at += 8192)
        {
            name += String.fromCharCode(...units.subarray(at, at + 8192));
        }
        return name;
    };

    /** Flushes a file the keeper wrote: false where the disk failed, counted. @param {DiskFile} file */
    const flushed = file=>{
        try
        {
            file.flush();
            return true;
        }
        catch {
            counts.diskFailures++;
            return false;
        }
    };

    try
    {
        await load();
        keepSpare();
        openNextPack();
    }
    catch (e){
        // A file the disk would not open: the files opened are let go, and a
        // pack still opening is let go of where it opens, so the next try
        // finds none of them held.
        closed = true;
        for (const file of [...packs, ...indexFiles])
        {
            closeFile(file);
        }
        throw e;
    }

    const keeper = {
        shared,
        /** Segments by index, for a thread joining later. */
        segmentBuffers: ()=>segments.map(one=>(one === null ? null : one.buffer)),

        /**
         * Room for `name`'s body of `length` bytes, in a segment below
         * `known`: the record and where to write, or null with why counted.
         * The writer stores the record hot (`commit`) once it has written.
         *
         * @param {string} name @param {number} length
         * @param {{ onlyCopy?: boolean, known?: number }} [options]
         */
        reserve(name, length, { onlyCopy = false, known = Infinity } = {}){
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
                counts[segments.length > known ? 'refusedUnseen' : 'refusedRoom']++;
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
            set(id, R_FLAGS, onlyCopy ? F_ONLY_COPY : 0);
            store(id, MOVING);
            set(id, R_SEGMENT, found.segment);
            set(id, R_OFFSET, found.offset);
            set(id, R_LENGTH, length);
            set(id, R_TICK, Atomics.load(words, H_TICK));
            // The writer counts as one inside until it commits.
            Atomics.store(words, index.at(id) + R_STATE, stateWord(WRITING, 1));
            counts.reserved++;
            keepSpare();
            return { id, segment: found.segment, offset: found.offset };
        },

        /**
         * Brings `name`'s cold body back into a segment below `known` (the
         * segments the asker has): true where it is hot there now.
         *
         * @param {string} name @param {{ known?: number }} [options]
         */
        raise(name, { known = Infinity } = {}){
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
            const length = get(id, R_LENGTH);
            // Saved by a run of larger segments: no segment of this one holds it.
            if (length > segmentBytes)
            {
                counts.raiseFailed++;
                return false;
            }
            store(id, MOVING);
            const found = room(length, known);
            if (found === null)
            {
                store(id, COLD);
                counts[segments.length > known ? 'refusedUnseen' : 'raiseFailed']++;
                return false;
            }
            const one = /** @type {NonNullable<typeof segments[0]>} */ (segments[found.segment]);
            let read = 0;
            try
            {
                read = packs[get(id, R_PACK)].read(one.bytes.subarray(found.offset,
                    found.offset + length), { at: get(id, R_PACK_OFFSET) });
            }
            catch {
                giveRoom(found.segment, found.offset, length);
                counts.diskFailures++;
                store(id, COLD);
                counts.raiseFailed++;
                return false;
            }
            if (read !== length)
            {
                // The pack holds less than the index says (cut, or removed in
                // the origin): the body is not on the disk any more.
                giveRoom(found.segment, found.offset, length);
                forgetDisk(id);
                set(id, R_FLAGS, 0);
                store(id, GONE);
                counts.lostOnDisk++;
                counts.raiseFailed++;
                return false;
            }
            set(id, R_SEGMENT, found.segment);
            set(id, R_OFFSET, found.offset);
            set(id, R_TICK, Atomics.load(words, H_TICK));
            store(id, HOT);
            counts.raised++;
            keepSpare();
            return true;
        },

        /** @param {string} name */
        drop(name){
            const id = index.find(name);
            return id < 0 || drop(id);
        },

        /**
         * The clock moves; idle bodies go cold, long idle cold ones go, bodies
         * asked away go once no one reads them, segments empty long enough are
         * let go but one.
         */
        sweep(){
            const at = tick();
            Atomics.store(words, H_TICK, at);
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const word = stateWordOf(id);
                const state = stateOf(word);
                if (state === RETIRED && readersOf(word) === 0
                    && Atomics.compareExchange(words, index.at(id) + R_STATE, word,
                        stateWord(MOVING)) === word)
                {
                    if (get(id, R_SEGMENT) >= 0)
                    {
                        giveBack(id);
                    }
                    forgetDisk(id);
                    store(id, GONE);
                    continue;
                }
                if (state === GONE && get(id, R_SEGMENT) >= 0)
                {
                    // A reservation let go of without a body.
                    giveBack(id);
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
            for (let s = 0; s < segments.length; s++)
            {
                const one = segments[s];
                if (one === null || !one.buddy.empty())
                {
                    continue;
                }
                if (!spare)
                {
                    spare = true;
                    continue;
                }
                if (age(at, one.emptySince) >= releaseAfterMs)
                {
                    segments[s] = null;
                    counts.segmentsLetGo++;
                    counts.letGoBytes += segmentBytes;
                    tell({ segment: s, buffer: null });
                }
            }
            for (const file of packs)
            {
                flushed(file);
            }
        },

        /**
         * Writes the hot bodies the disk lacks and the index of all it holds,
         * for the next run to find: true where the disk holds them all now.
         */
        save(){
            if (disk === null || indexFiles.length === 0)
            {
                return false;
            }
            let whole = true;
            /** @type {[string, number, number, number, number][]} */
            const records = [];
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const state = stateOf(stateWordOf(id));
                if (state === HOT && (get(id, R_FLAGS) & F_ON_DISK) === 0)
                {
                    // Only no one may write it meanwhile: the keeper's thread
                    // is the one placing, and a reader does not write.
                    whole = writeOut(id) && whole;
                }
                if ((state === HOT || state === COLD) && (get(id, R_FLAGS) & F_ON_DISK) !== 0)
                {
                    records.push([nameOf(id), get(id, R_PACK), get(id, R_PACK_OFFSET),
                        get(id, R_LENGTH), get(id, R_FLAGS) & F_ONLY_COPY]);
                }
            }
            for (const file of packs)
            {
                // An index naming bodies the disk may not hold is not written.
                if (!flushed(file))
                {
                    return false;
                }
            }
            const next = generation + 1;
            const bytes = new TextEncoder().encode(JSON.stringify({
                version: INDEX_VERSION, generation: next, packs: packs.length, records,
            }));
            // The other file keeps the last index whole while this one is
            // written; a save that fails leaves the next one to this file
            // again, so the whole one is never the one written over.
            const file = indexFiles[next % indexFiles.length];
            try
            {
                file.truncate(0);
                if (file.write(bytes, { at: 0 }) !== bytes.length)
                {
                    counts.diskFailures++;
                    return false;
                }
                file.flush();
            }
            catch {
                counts.diskFailures++;
                return false;
            }
            generation = next;
            counts.saved++;
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
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const state = stateOf(stateWordOf(id));
                if (state === COLD)
                {
                    set(id, R_FLAGS, 0);
                    set(id, R_PACK, -1);
                    store(id, GONE);
                }
                else
                {
                    set(id, R_FLAGS, get(id, R_FLAGS) & ~F_ON_DISK);
                    set(id, R_PACK, -1);
                }
            }
            for (const file of [...packs, ...indexFiles, ...readyPack ? [readyPack] : []])
            {
                closeFile(file);
            }
            packs.length = 0;
            indexFiles.length = 0;
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
                if (state === HOT || state === WRITING || state === RETIRED)
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
            const live = segments.filter(one=>one !== null);
            return {
                records: words[H_COUNT], hot, hotBytes, cold, coldBytes,
                segments: live.length, segmentBytes: live.length * segmentBytes,
                placedBytes: live.reduce((sum, one)=>sum + one.buddy.used(), 0),
                roundingBytes: live.reduce((sum, one)=>sum + one.buddy.wasted(), 0),
                indexBytes: shared.records.byteLength + shared.names.byteLength
                    + index.table().byteLength,
                packs: packs.length, ...counts,
            };
        },
    };
    return keeper;
}

/** @typedef {Awaited<ReturnType<typeof openKeeper>>} Keeper */
