/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's index as the disk keeps it, for the next run: which body of
 * which name lies where in which pack. The keeper saves it every few seconds
 * while bodies come and go, so a save writes what changed, not the whole.
 *
 * A file is chunks one after another. The first is a base, the whole index
 * then; each after it a delta, the entries of the names whose place changed
 * since the chunk before (a name with no body any more is an entry of pack
 * -1). A chunk carries its generation, one more than the chunk before, and a
 * checksum of its bytes: a reader takes the chunks in order and stops at the
 * first that is not whole, so a save torn mid-write leaves the index of the
 * save before it. The keeper keeps two such files and writes a base into the
 * one it does not append to (`keeper.js`), so a torn base leaves the other.
 *
 * Names are written as their UTF-16 units straight from the shared names, one
 * byte a unit where every unit of the name fits one: a save makes no string.
 *
 * Chunk, little-endian:
 *   u32 MAGIC, u32 its bytes, u32 kind (BASE, DELTA), f64 generation,
 *   u32 next pack number, u32 packs on the disk, u32 each pack's number,
 *   u32 entries, each { i32 pack, u32 offset, u32 length, u8 flags,
 *   u32 name units (the top bit: a byte a unit), the units },
 *   u32 FNV-1a of every byte before it.
 *
 * An index saved by Cellar 0.9.0 and before (JSON, version 1) is read as a
 * base, so the bodies it names are not lost to the change of layout.
 */

const MAGIC = 0x32584943;
export const BASE = 1;
export const DELTA = 2;
/** A pack holds under 2 GiB (the keeper's `packBytes`): no body ends past it. */
const PACK_END = 2 ** 31;
/** Bytes of a chunk before its packs, and its checksum. */
const HEAD_BYTES = 28;
/** The top bit of an entry's unit count: its name is one byte a unit. */
const NARROW = 0x80000000;

/** @param {Uint8Array} bytes @param {number} from @param {number} to */
const checksum = (bytes, from, to)=>{
    let hash = 0x811c9dc5;
    for (let at = from; at < to; at++)
    {
        hash = Math.imul(hash ^ bytes[at], 0x01000193);
    }
    return hash >>> 0;
};

/**
 * Builds one chunk: its entries added one at a time, then the chunk made.
 */
export function chunkWriter(){
    let bytes = new Uint8Array(64 * 1024);
    let view = new DataView(bytes.buffer);
    let top = 0;
    let count = 0;
    /** @param {number} more */
    const room = more=>{
        if (top + more > bytes.length)
        {
            const larger = new Uint8Array(Math.max(top + more, bytes.length * 2));
            larger.set(bytes.subarray(0, top));
            bytes = larger;
            view = new DataView(bytes.buffer);
        }
    };
    return {
        /** Entries added. */
        count: ()=>count,
        /**
         * An entry: the body of the name `units[from, from + length)` lies at
         * `offset` of pack `pack`, `bodyLength` bytes; pack -1 for none.
         *
         * @param {number} pack @param {number} offset @param {number} bodyLength
         * @param {number} flags @param {ArrayLike<number>} units @param {number} from
         * @param {number} length
         */
        entry(pack, offset, bodyLength, flags, units, from, length){
            let narrow = true;
            for (let i = from; i < from + length; i++)
            {
                if (units[i] > 0xff)
                {
                    narrow = false;
                    break;
                }
            }
            room(17 + length * (narrow ? 1 : 2));
            view.setInt32(top, pack, true);
            view.setUint32(top + 4, offset, true);
            view.setUint32(top + 8, bodyLength, true);
            bytes[top + 12] = flags;
            view.setUint32(top + 13, narrow ? (length | NARROW) >>> 0 : length, true);
            top += 17;
            if (narrow)
            {
                for (let i = from; i < from + length; i++)
                {
                    bytes[top++] = units[i];
                }
            }
            else
            {
                for (let i = from; i < from + length; i++, top += 2)
                {
                    view.setUint16(top, units[i], true);
                }
            }
            count++;
        },
        /**
         * The chunk, its entries those added.
         *
         * @param {{ kind: number, generation: number, nextPack: number, packs: number[] }} head
         * @returns {Uint8Array}
         */
        finish({ kind, generation, nextPack, packs }){
            const length = HEAD_BYTES + packs.length * 4 + 4 + top + 4;
            const out = new Uint8Array(length);
            const words = new DataView(out.buffer);
            words.setUint32(0, MAGIC, true);
            words.setUint32(4, length, true);
            words.setUint32(8, kind, true);
            words.setFloat64(12, generation, true);
            words.setUint32(20, nextPack, true);
            words.setUint32(24, packs.length, true);
            let at = HEAD_BYTES;
            for (const pack of packs)
            {
                words.setUint32(at, pack, true);
                at += 4;
            }
            words.setUint32(at, count, true);
            out.set(bytes.subarray(0, top), at + 4);
            words.setUint32(length - 4, checksum(out, 0, length - 4), true);
            return out;
        },
    };
}

/**
 * @typedef {{ pack: number, offset: number, length: number, flags: number }} Entry
 *     where a name's body lies; pack -1 for a name with none
 */

/**
 * @typedef {Object} Chunk
 * @property {number} kind @property {number} generation @property {number} nextPack
 * @property {number[]} packs  the numbers of the packs on the disk when it was written
 * @property {[string, Entry][]} entries
 * @property {number} end  where it ends in its file
 */

/**
 * The chunk at `at`, or null where it is not whole: cut short, its checksum
 * wrong, a field past what a run counts to.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} maxPacks
 * @returns {Chunk | null}
 */
export function readChunk(bytes, at, maxPacks){
    if (at + HEAD_BYTES + 8 > bytes.length)
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const length = view.getUint32(at + 4, true);
    const end = at + length;
    if (view.getUint32(at, true) !== MAGIC || length < HEAD_BYTES + 8 || end > bytes.length
        || view.getUint32(end - 4, true) !== checksum(bytes, at, end - 4))
    {
        return null;
    }
    const kind = view.getUint32(at + 8, true);
    const generation = view.getFloat64(at + 12, true);
    const nextPack = view.getUint32(at + 20, true);
    const packCount = view.getUint32(at + 24, true);
    // A generation the next save can count on from; packs a run opens.
    if ((kind !== BASE && kind !== DELTA) || !Number.isSafeInteger(generation) || generation < 0
        || generation >= Number.MAX_SAFE_INTEGER || nextPack > maxPacks
        || HEAD_BYTES + packCount * 4 + 8 > length)
    {
        return null;
    }
    let top = at + HEAD_BYTES;
    /** @type {number[]} */
    const packs = [];
    const seen = new Set();
    for (let i = 0; i < packCount; i++, top += 4)
    {
        const pack = view.getUint32(top, true);
        // A pack listed twice would be opened twice: no keeper writes it.
        if (pack >= nextPack || seen.has(pack))
        {
            return null;
        }
        seen.add(pack);
        packs.push(pack);
    }
    const count = view.getUint32(top, true);
    top += 4;
    /** @type {[string, Entry][]} */
    const entries = [];
    for (let i = 0; i < count; i++)
    {
        if (top + 17 > end - 4)
        {
            return null;
        }
        const pack = view.getInt32(top, true);
        const offset = view.getUint32(top + 4, true);
        const bodyLength = view.getUint32(top + 8, true);
        const flags = bytes[top + 12];
        const word = view.getUint32(top + 13, true);
        const narrow = (word & NARROW) !== 0;
        const units = (word & ~NARROW) >>> 0;
        top += 17;
        const span = units * (narrow ? 1 : 2);
        if (top + span > end - 4)
        {
            return null;
        }
        let name = '';
        // In pieces: a name passed whole as arguments can be longer than a
        // call may take.
        for (let from = 0; from < units; from += 8192)
        {
            const piece = Math.min(8192, units - from);
            const codes = new Array(piece);
            for (let i2 = 0; i2 < piece; i2++)
            {
                codes[i2] = narrow ? bytes[top + from + i2] : view.getUint16(top + (from + i2) * 2, true);
            }
            name += String.fromCharCode(...codes);
        }
        top += span;
        entries.push([name, { pack, offset, length: bodyLength, flags }]);
    }
    return top === end - 4 ? { kind, generation, nextPack, packs, entries, end } : null;
}

/**
 * @typedef {Object} IndexFileState
 * @property {number} generation  the last whole chunk's
 * @property {number} nextPack @property {number[]} packs  as the last whole chunk says
 * @property {Map<string, Entry>} entries  every name with a body, the chain applied: each in a
 *     pack the file lists, of a length, within what a pack holds
 * @property {Set<number>} onlyCopies  packs an entry of only copy named at any point of the
 *     chain: what the file could lead a run to, so long as it is the index read
 * @property {number} end  where the last whole chunk ends
 * @property {number} skipped  entries that did not say a body
 */

/**
 * Takes out of `state` the entries that do not say a body: in a pack the
 * file does not list, of no bytes, or past what a pack holds. Counted, the
 * rest of the index still the disk's.
 *
 * @param {IndexFileState} state
 * @returns {IndexFileState}
 */
function bodiesOnly(state){
    const listed = new Set(state.packs);
    for (const [name, { pack, offset, length }] of state.entries)
    {
        if (!listed.has(pack) || !(offset >= 0) || !(length > 0) || !(offset + length <= PACK_END))
        {
            state.entries.delete(name);
            state.skipped++;
        }
    }
    return state;
}

/**
 * What one index file says: its base and every delta after it that is whole
 * and of the next generation, applied in order; null where its base is not
 * whole.
 *
 * @param {Uint8Array} bytes @param {number} maxPacks  packs a run opens at most
 * @param {number} onlyCopy  the flag of an only copy
 * @returns {IndexFileState | null}
 */
export function readIndexFile(bytes, maxPacks, onlyCopy){
    if (bytes.length > 0 && bytes[0] === 0x7b)
    {
        return readVersion1(bytes, maxPacks, onlyCopy);
    }
    const base = readChunk(bytes, 0, maxPacks);
    if (base === null || base.kind !== BASE)
    {
        return null;
    }
    /** @type {IndexFileState} */
    const state = { generation: base.generation, nextPack: base.nextPack, packs: base.packs,
        entries: new Map(), onlyCopies: new Set(), end: base.end, skipped: 0 };
    for (let chunk = /** @type {Chunk | null} */ (base); chunk !== null;
        chunk = readChunk(bytes, state.end, maxPacks))
    {
        if (chunk !== base && (chunk.kind !== DELTA || chunk.generation !== state.generation + 1))
        {
            break;
        }
        for (const [name, entry] of chunk.entries)
        {
            if (entry.pack < 0)
            {
                state.entries.delete(name);
                continue;
            }
            state.entries.set(name, entry);
            if (entry.flags & onlyCopy)
            {
                state.onlyCopies.add(entry.pack);
            }
        }
        state.generation = chunk.generation;
        state.nextPack = chunk.nextPack;
        state.packs = chunk.packs;
        state.end = chunk.end;
    }
    return bodiesOnly(state);
}

/**
 * An index of Cellar 0.9.0 and before: JSON, packs `pack-0` up to its count.
 *
 * @param {Uint8Array} bytes @param {number} maxPacks @param {number} onlyCopy
 * @returns {IndexFileState | null}
 */
function readVersion1(bytes, maxPacks, onlyCopy){
    let saved;
    try
    {
        saved = JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        // Torn mid-write: the other file is the index.
        return null;
    }
    if (saved?.version !== 1 || !Number.isSafeInteger(saved.generation) || saved.generation < 0
        || saved.generation >= Number.MAX_SAFE_INTEGER || !Number.isInteger(saved.packs)
        || saved.packs < 0 || saved.packs > maxPacks || !Array.isArray(saved.records))
    {
        return null;
    }
    /** @type {IndexFileState} */
    const state = { generation: saved.generation, nextPack: saved.packs,
        packs: Array.from({ length: saved.packs }, (_, at)=>at), entries: new Map(),
        onlyCopies: new Set(), end: bytes.length, skipped: 0 };
    for (const entry of saved.records)
    {
        // An entry that does not say a body is skipped, not trusted: the
        // rest of the index is still the disk's.
        if (!Array.isArray(entry) || entry.length !== 5 || typeof entry[0] !== 'string'
            || !entry.slice(1).every(Number.isInteger) || entry[1] < 0 || entry[1] >= saved.packs)
        {
            state.skipped++;
            continue;
        }
        const [name, pack, offset, length, flags] = entry;
        state.entries.set(name, { pack, offset, length, flags: flags & onlyCopy });
        if (flags & onlyCopy)
        {
            state.onlyCopies.add(pack);
        }
    }
    return bodiesOnly(state);
}
