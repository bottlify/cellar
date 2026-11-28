/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The account: one budget for every byte a program holds, its cache's
 * segments and the memory the cache does not place but must count (a
 * WebAssembly memory, compiled code, a decoder's heap), each declared to it
 * by kind and by holder, and every thread taking from it and giving back by
 * compare-and-swap on the same words, with no thread asked.
 *
 * A take that does not fit asks for room once (`room`, the keeper's
 * `makeRoom` on its own thread, a remote keeper's elsewhere): the keeper lets
 * cold bodies go until the sum fits. Only where that makes none is the take
 * refused, counted on the account and on its kind, and told (`onRefused`).
 * What its holder cannot do without (code the program runs) is taken past
 * the limit instead (`overdraw`): counted, the account over its limit for all
 * to see, and told (`onOverdrawn`) - never held uncounted.
 *
 * A kind may have a ceiling of its own inside the limit (the cache's
 * segments, say): its sum never passes it, whatever room the limit has.
 * A holder is one owner's part (a process): every kind it holds is counted on
 * it too, and given back at once when it goes (`release`).
 *
 * Counted in units of 4 KiB, the keeper's page: 32-bit words reach 8 TiB.
 */

import { sharedBuffer } from './shared.js';

/** The bytes of a unit. */
export const ACCOUNT_UNIT = 4096;

/** Kinds an account names at most, and the UTF-16 units of a kind's name. */
const MAX_KINDS = 16;
const NAME_UNITS = 24;
/** Holders an account numbers: the run's own (0) and 127 others. */
const HOLDERS = 128;
/** A limit or ceiling of this many units is none. */
const NONE = 0x7fffffff;

/** The header's words. */
const LIMIT = 0;
const USED = 1;
const PEAK = 2;
const REFUSED = 3;
const ROOM_ASKED = 4;
const ROOM_MADE = 5;
const KINDS = 6;
const OVERDRAWN = 7;
const HEADER = 8;
/** Each kind's words: what it holds, its ceiling, the most it held, takes refused. */
const K_HELD = 0;
const K_CEILING = 1;
const K_PEAK = 2;
const K_REFUSED = 3;
const KIND_WORDS = 4;
const KINDS_AT = HEADER;
const HOLDERS_AT = KINDS_AT + MAX_KINDS * KIND_WORDS;
/** A holder's words: whether it is out, then what it holds of each kind. */
const HOLDER_WORDS = 1 + MAX_KINDS;
const WORDS = HOLDERS_AT + HOLDERS * HOLDER_WORDS;

/** The holder of what no process holds: the run's own. */
export const RUN_HOLDER = 0;

/**
 * What a thread opening the account is handed: post it as it is.
 *
 * @typedef {{ buffer: SharedArrayBuffer | ArrayBuffer, kinds: string[] }} AccountMemory
 */

/** @param {number} bytes */
const unitsOf = bytes=>Math.ceil(Math.max(0, bytes) / ACCOUNT_UNIT);

/** @param {number | undefined} bytes @param {string} what */
const boundOf = (bytes, what)=>{
    if (bytes === undefined || bytes === Infinity)
    {
        return NONE;
    }
    if (!(bytes >= 0) || !Number.isFinite(bytes))
    {
        throw new RangeError(`account: ${what} of ${bytes} bytes`);
    }
    return Math.min(NONE - 1, Math.floor(bytes / ACCOUNT_UNIT));
};

/**
 * A fresh account of `limit` bytes (none: `Infinity`), rounded down to whole
 * units, its kinds named once with each one's ceiling (`Infinity`: the limit).
 *
 * Where memory cannot be shared, it is one thread's.
 *
 * @param {{ limit: number, kinds: Record<string, number> }} shape
 * @returns {AccountMemory}
 */
export function createAccountMemory({ limit, kinds }){
    const names = Object.keys(kinds);
    if (names.length === 0 || names.length > MAX_KINDS)
    {
        throw new RangeError(`account: ${names.length} kinds, 1 to ${MAX_KINDS}`);
    }
    for (const name of names)
    {
        if (name.length === 0 || name.length > NAME_UNITS)
        {
            throw new RangeError(`account: a kind named "${name}", 1 to ${NAME_UNITS} units`);
        }
    }
    const buffer = sharedBuffer(WORDS * 4);
    const words = new Int32Array(buffer);
    words[LIMIT] = boundOf(limit, 'a limit');
    words[KINDS] = names.length;
    names.forEach((name, at)=>{
        words[KINDS_AT + at * KIND_WORDS + K_CEILING] = boundOf(kinds[name], `the ${name} ceiling`);
    });
    // The run's holder is always out.
    words[HOLDERS_AT] = 1;
    return { buffer, kinds: names };
}

/**
 * @typedef {Object} AccountReport  In bytes; a limit or ceiling of none is null.
 * @property {number | null} limit
 * @property {number} used
 * @property {number} peak
 * @property {number} refused  takes refused
 * @property {number} roomAsked  takes that asked for room
 * @property {number} roomMade  of them, those room was made for
 * @property {number} overdrawn  takes made past the limit (`overdraw`)
 * @property {Record<string, { bytes: number, ceiling: number | null, peak: number,
 *     refused: number }>} kinds
 * @property {Record<string, Record<string, number>>} holders  each holder out but
 *     the run's, by its number: what it holds of each kind it holds any of
 */

/**
 * @typedef {Object} Account
 * @property {AccountMemory} memory
 * @property {number} holder  the holder this view takes for
 * @property {(bytes: number, kind: string) => boolean} take  room for `bytes`
 *     more of `kind`, room asked for where it does not fit; false and nothing
 *     taken where none was made
 * @property {(bytes: number, kind: string) => void} overdraw  `bytes` more of `kind`
 *     taken whatever the limit and the ceiling, counted and told
 * @property {(bytes: number, kind: string) => void} give  never more than the holder holds
 * @property {(bytes: number, kind: string, to: number) => void} move  what this
 *     holder holds handed to holder `to`, the sum unchanged
 * @property {() => number} claim  a holder no one holds (`RUN_HOLDER` where every one is)
 * @property {(holder: number) => number} release  every kind `holder` holds
 *     given back at once: the bytes
 * @property {(kind: string) => number} heldBy  what this view's holder holds of `kind`
 * @property {(bytes: number, kind?: string) => boolean} fits  whether `bytes`
 *     more would fit now (of `kind`, its ceiling as well)
 * @property {(kind: string) => number} bound  the most `kind` may hold: its
 *     ceiling, or the limit; Infinity for neither
 * @property {() => AccountReport} report
 */

/**
 * The account seen from one thread, taking for `holder`. `room(bytes)`: make
 * room for `bytes` more, true where it did (the keeper's `makeRoom`);
 * `onRefused`: a take refused once room was asked for; `onOverdrawn`: a take
 * made past the limit.
 *
 * @param {AccountMemory} memory
 * @param {{ holder?: number, room?: ((bytes: number) => boolean) | null,
 *     onRefused?: (refusal: { kind: string, bytes: number, used: number,
 *     limit: number | null }) => void,
 *     onOverdrawn?: (refusal: { kind: string, bytes: number, used: number,
 *     limit: number | null }) => void }} [options]
 * @returns {Account}
 */
export function openAccount(memory, { holder = RUN_HOLDER, room = null, onRefused = ()=>{},
    onOverdrawn = ()=>{} } = {}){
    const words = new Int32Array(memory.buffer, 0, WORDS);
    const count = words[KINDS];
    if (memory.kinds.length !== count)
    {
        throw new RangeError(`account: ${memory.kinds.length} kinds named, the memory holds ${count}`);
    }
    if (!(holder >= 0 && holder < HOLDERS))
    {
        throw new RangeError(`account: no holder ${holder}`);
    }
    /** @type {Map<string, number>} */
    const kindAt = new Map(memory.kinds.map((name, at)=>[name, at]));
    /** @param {string} kind */
    const indexOf = kind=>{
        const at = kindAt.get(kind);
        if (at === undefined)
        {
            throw new RangeError(`account: no kind ${kind} (${memory.kinds.join(', ')})`);
        }
        return at;
    };
    /** @param {number} at */
    const load = at=>Atomics.load(words, at);
    /** @param {number} at @param {number} by */
    const add = (at, by)=>{
        Atomics.add(words, at, by);
    };
    /** @param {number} who @param {number} kind */
    const holderWord = (who, kind)=>HOLDERS_AT + who * HOLDER_WORDS + 1 + kind;
    /** @param {number} at @param {number} value */
    const notePeak = (at, value)=>{
        for (;;)
        {
            const peak = load(at);
            if (value <= peak || Atomics.compareExchange(words, at, peak, value) === peak)
            {
                return;
            }
        }
    };
    /**
     * Adds `units` to word `at` where it stays within `bound`, by
     * compare-and-swap: two threads never both take the last of it.
     *
     * @param {number} at @param {number} units @param {number} bound
     */
    const within = (at, units, bound)=>{
        for (;;)
        {
            const held = load(at);
            if (held + units > bound)
            {
                return false;
            }
            if (Atomics.compareExchange(words, at, held, held + units) === held)
            {
                return true;
            }
        }
    };
    /** @param {number} kind @param {number} units */
    const tryTake = (kind, units)=>{
        const kindHeld = KINDS_AT + kind * KIND_WORDS;
        if (!within(kindHeld + K_HELD, units, load(kindHeld + K_CEILING)))
        {
            return false;
        }
        if (!within(USED, units, load(LIMIT)))
        {
            add(kindHeld + K_HELD, -units);
            return false;
        }
        add(holderWord(holder, kind), units);
        notePeak(PEAK, load(USED));
        notePeak(kindHeld + K_PEAK, load(kindHeld + K_HELD));
        return true;
    };
    /** @param {number} kind @param {number} units */
    const fitsUnits = (kind, units)=>{
        const at = KINDS_AT + kind * KIND_WORDS;
        return load(USED) + units <= load(LIMIT) && load(at + K_HELD) + units <= load(at + K_CEILING);
    };
    /** @param {number} units */
    const bytesOrNone = units=>(units === NONE ? null : units * ACCOUNT_UNIT);
    /**
     * Takes up to `units` from word `at`, never past what it holds: a give
     * that comes after its holder was released takes nothing from the others.
     *
     * @param {number} at @param {number} units
     */
    const takeFrom = (at, units)=>{
        for (;;)
        {
            const has = load(at);
            const taken = Math.min(units, has);
            if (taken <= 0)
            {
                return 0;
            }
            if (Atomics.compareExchange(words, at, has, has - taken) === has)
            {
                return taken;
            }
        }
    };
    /** @param {number} kind @param {number} units */
    const lessOf = (kind, units)=>{
        add(USED, -units);
        add(KINDS_AT + kind * KIND_WORDS + K_HELD, -units);
    };
    return {
        memory,
        holder,
        take(bytes, kind){
            const at = indexOf(kind);
            const units = unitsOf(bytes);
            if (units === 0 || tryTake(at, units))
            {
                return true;
            }
            // The kind at its own ceiling: no room the cache makes is its.
            const ceilingAt = KINDS_AT + at * KIND_WORDS;
            if (room !== null && load(ceilingAt + K_HELD) + units <= load(ceilingAt + K_CEILING))
            {
                add(ROOM_ASKED, 1);
                if (room(units * ACCOUNT_UNIT) && tryTake(at, units))
                {
                    add(ROOM_MADE, 1);
                    return true;
                }
            }
            add(REFUSED, 1);
            add(ceilingAt + K_REFUSED, 1);
            onRefused({ kind, bytes, used: load(USED) * ACCOUNT_UNIT, limit: bytesOrNone(load(LIMIT)) });
            return false;
        },
        overdraw(bytes, kind){
            const at = indexOf(kind);
            const units = unitsOf(bytes);
            add(KINDS_AT + at * KIND_WORDS + K_HELD, units);
            add(USED, units);
            add(holderWord(holder, at), units);
            add(OVERDRAWN, 1);
            notePeak(PEAK, load(USED));
            notePeak(KINDS_AT + at * KIND_WORDS + K_PEAK, load(KINDS_AT + at * KIND_WORDS + K_HELD));
            onOverdrawn({ kind, bytes, used: load(USED) * ACCOUNT_UNIT, limit: bytesOrNone(load(LIMIT)) });
        },
        give(bytes, kind){
            const at = indexOf(kind);
            const given = takeFrom(holderWord(holder, at), unitsOf(bytes));
            if (given > 0)
            {
                lessOf(at, given);
            }
        },
        move(bytes, kind, to){
            if (to === holder)
            {
                return;
            }
            const at = indexOf(kind);
            const moved = takeFrom(holderWord(holder, at), unitsOf(bytes));
            if (moved > 0)
            {
                add(holderWord(to, at), moved);
            }
        },
        claim(){
            for (let who = 1; who < HOLDERS; who++)
            {
                if (Atomics.compareExchange(words, HOLDERS_AT + who * HOLDER_WORDS, 0, 1) === 0)
                {
                    return who;
                }
            }
            return RUN_HOLDER;
        },
        release(who){
            if (who === RUN_HOLDER)
            {
                return 0;
            }
            let given = 0;
            for (let at = 0; at < count; at++)
            {
                const units = Atomics.exchange(words, holderWord(who, at), 0);
                if (units !== 0)
                {
                    lessOf(at, units);
                    given += units * ACCOUNT_UNIT;
                }
            }
            Atomics.store(words, HOLDERS_AT + who * HOLDER_WORDS, 0);
            return given;
        },
        heldBy: kind=>load(holderWord(holder, indexOf(kind))) * ACCOUNT_UNIT,
        fits: (bytes, kind)=>(kind === undefined ? load(USED) + unitsOf(bytes) <= load(LIMIT)
            : fitsUnits(indexOf(kind), unitsOf(bytes))),
        bound: kind=>{
            const units = Math.min(load(LIMIT), load(KINDS_AT + indexOf(kind) * KIND_WORDS + K_CEILING));
            return units === NONE ? Infinity : units * ACCOUNT_UNIT;
        },
        report(){
            /** @type {AccountReport['kinds']} */
            const kinds = {};
            memory.kinds.forEach((name, at)=>{
                const from = KINDS_AT + at * KIND_WORDS;
                kinds[name] = { bytes: load(from + K_HELD) * ACCOUNT_UNIT,
                    ceiling: bytesOrNone(load(from + K_CEILING)), peak: load(from + K_PEAK) * ACCOUNT_UNIT,
                    refused: load(from + K_REFUSED) };
            });
            /** @type {AccountReport['holders']} */
            const holders = {};
            for (let who = 1; who < HOLDERS; who++)
            {
                if (load(HOLDERS_AT + who * HOLDER_WORDS) === 0)
                {
                    continue;
                }
                /** @type {Record<string, number>} */
                const held = {};
                memory.kinds.forEach((name, at)=>{
                    const units = load(holderWord(who, at));
                    if (units > 0)
                    {
                        held[name] = units * ACCOUNT_UNIT;
                    }
                });
                holders[who] = held;
            }
            return { limit: bytesOrNone(load(LIMIT)), used: load(USED) * ACCOUNT_UNIT,
                peak: load(PEAK) * ACCOUNT_UNIT, refused: load(REFUSED), roomAsked: load(ROOM_ASKED),
                roomMade: load(ROOM_MADE), overdrawn: load(OVERDRAWN), kinds, holders };
        },
    };
}

/**
 * A holder's part of one kind taken in amounts of any size, a unit taken only
 * where its sum crosses one: a translator holding modules of a few kilobytes
 * each pays for the bytes it holds, not a unit a module. Each byte counts
 * `weight` times: what holding it costs past its own bytes (a module's
 * compiled code beside its wasm bytes).
 *
 * @param {Account} account @param {string} kind @param {number} [weight]
 * @returns {{ take(bytes: number): boolean, overdraw(bytes: number): void,
 *     give(bytes: number): void, held(): number }}
 */
export function openCharge(account, kind, weight = 1){
    let held = 0;
    /** @param {number} bytes */
    const unitsFor = bytes=>Math.ceil(bytes * weight / ACCOUNT_UNIT);
    return {
        take(bytes){
            const more = unitsFor(held + bytes) - unitsFor(held);
            if (more > 0 && !account.take(more * ACCOUNT_UNIT, kind))
            {
                return false;
            }
            held += bytes;
            return true;
        },
        overdraw(bytes){
            const more = unitsFor(held + bytes) - unitsFor(held);
            if (more > 0)
            {
                account.overdraw(more * ACCOUNT_UNIT, kind);
            }
            held += bytes;
        },
        give(bytes){
            const fewer = unitsFor(held) - unitsFor(Math.max(0, held - bytes));
            held = Math.max(0, held - bytes);
            if (fewer > 0)
            {
                account.give(fewer * ACCOUNT_UNIT, kind);
            }
        },
        held: ()=>held,
    };
}
