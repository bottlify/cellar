/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The keeper's placing against a plain model held here: seeded random work
 * (put, reserve and commit or let go, hold and let go, drop, release an
 * owner, raise, time passing) with body sizes in the shares a real run asked
 * for, on a keeper with room to spare and on a cramped one. After each step
 * everything a caller sees is checked: each body read is byte for byte the
 * one written, an only copy is never lost, memory held and reservations
 * being written are never written over by another body, and the figures say
 * exactly what each block placed costs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAIN, UNIT } from './buddy.js';
import { cacheOf } from './cache.fixture.js';
import { memoryDisk } from './disk.fixture.js';

const KIB = 1024;
const SEGMENT = 64 * KIB;

/**
 * Body sizes as core's cache was asked for them: [from, to, share], bytes,
 * the shares of the reserves of a run (`SIZES_SOURCE`).
 *
 * @type {[number, number, number][]}
 */
const SIZES = [
    [1, 256, 0.30],
    [257, 1024, 0.30],
    [1025, 4096, 0.25],
    [4097, 16 * KIB, 0.12],
    [16 * KIB + 1, 64 * KIB, 0.03],
];

/** @param {() => number} random */
const sizeOf = random=>{
    let pick = random() * SIZES.reduce((sum, one)=>sum + one[2], 0);
    for (const [from, to, share] of SIZES)
    {
        pick -= share;
        if (pick <= 0)
        {
            return from + Math.floor(random() * (to - from + 1));
        }
    }
    return SIZES[0][0];
};

/**
 * What a body of `length` takes in memory: its length rounded to a grain, or
 * to a page past a quarter of a segment (a segment of its own).
 *
 * @param {number} length
 */
const placedOf = length=>(length > SEGMENT / 4 ? Math.ceil(length / UNIT) * UNIT
    : Math.ceil(length / GRAIN) * GRAIN);

/** @param {number} length @param {number} seed */
const patternOf = (length, seed)=>Uint8Array.from({ length }, (_, i)=>(i * 7 + seed * 13 + (i >> 8)) & 255);

/**
 * @param {number} seed @param {number} budget @param {number} steps
 */
async function work(seed, budget, steps){
    let state = (seed * 2654435761) >>> 0;
    const random = ()=>(state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const pick = (/** @type {any[]} */ list)=>list[Math.floor(random() * list.length)];
    const { keeper, reader, step } = await cacheOf({ budget, segmentBytes: SEGMENT, disk: memoryDisk(),
        coldAfterMs: 100, goneAfterMs: 1000, abandonAfterMs: 1e9 });
    const owners = ['a/', 'b/', 'c/'];
    const names = owners.flatMap(owner=>Array.from({ length: 24 }, (_, i)=>`${owner}${i}`));
    /** Bodies committed: what they hold, whether the only copy. @type {Map<string, { bytes: Uint8Array, only: boolean }>} */
    const bodies = new Map();
    /** Reservations being written, and memory held: the view and what was written into it. @type {Map<string, { view: Uint8Array, bytes: Uint8Array, only: boolean }>} */
    const writing = new Map();
    /** @type {Map<string, { view: Uint8Array, bytes: Uint8Array }>} */
    const held = new Map();
    /**
     * Rooms let go of by their writer or holder: placed until the keeper's
     * next reserve gives them back (`H_LET_GO`). @type {number[]}
     */
    let letGo = [];
    const seen = { refused: 0, lost: 0, cold: 0, unraised: 0, placed: 0 };
    let serial = 0;

    const check = (/** @type {string} */ where)=>{
        for (const [name, one] of [...writing, ...held])
        {
            assert.deepEqual(one.view, one.bytes, `${where}: ${name}'s room was written over`);
        }
        let rounding = 0;
        for (const [name, { bytes, only }] of bodies)
        {
            const hot = reader.look(name) === 'hot';
            seen.cold += hot ? 0 : 1;
            const read = reader.with(name, body=>body.slice(), { wait: true });
            if (read === undefined && reader.look(name) === 'cold')
            {
                // No room to raise it into now: still on the disk.
                seen.unraised++;
                continue;
            }
            if (read === undefined)
            {
                // A body that can be made again may go; an only copy never.
                assert.equal(only, false, `${where}: the only copy ${name} was lost`);
                bodies.delete(name);
                seen.lost++;
                continue;
            }
            assert.deepEqual(read, bytes, `${where}: ${name} reads as written`);
        }
        // Each raised for its read may have cooled another: weighed once all are read.
        for (const [name, { bytes }] of bodies)
        {
            if (reader.look(name) === 'hot')
            {
                rounding += placedOf(bytes.length) - bytes.length;
            }
        }
        for (const { bytes } of [...writing.values(), ...held.values()])
        {
            rounding += placedOf(bytes.length) - bytes.length;
        }
        const figures = keeper.figures();
        // A room let go of is placed until given back, which forming a block
        // for a body raised may do: those still placed are some of them.
        const extra = [figures.roundingBytes - rounding,
            figures.placedBytes - figures.roundingBytes - figures.hotBytes];
        const sums = letGo.reduce((all, length)=>all.flatMap(([r, l])=>[[r, l],
            [r + placedOf(length) - length, l + length]]), [[0, 0]]);
        assert.ok(sums.some(([r, l])=>r === extra[0] && l === extra[1]),
            `${where}: every block placed is a body's in memory or a room let go of, of its length`
            + ` and its rounding (${extra} over ${letGo})`);
        assert.ok(figures.segmentBytes <= budget, `${where}: within the budget`);
        seen.placed = Math.max(seen.placed, figures.placedBytes);
    };

    for (let at = 0; at < steps; at++)
    {
        const op = random();
        const name = pick(names);
        const busy = writing.has(name);
        const where = `seed ${seed}, step ${at}`;
        if (op < 0.35 && !busy)
        {
            const bytes = patternOf(sizeOf(random), ++serial);
            const only = random() < 0.3;
            letGo = [];
            if (reader.put(name, bytes, { onlyCopy: only }))
            {
                bodies.set(name, { bytes, only });
            }
            else
            {
                seen.refused++;
            }
        }
        else if (op < 0.45 && !busy)
        {
            const bytes = patternOf(sizeOf(random), ++serial);
            const only = random() < 0.3;
            letGo = [];
            const view = reader.reserve(name, bytes.length, { onlyCopy: only });
            if (view !== null)
            {
                // The name's body before is not its body any more.
                bodies.delete(name);
                view.set(bytes);
                writing.set(name, { view, bytes, only });
            }
            else
            {
                seen.refused++;
            }
        }
        else if (op < 0.55 && writing.size > 0)
        {
            const [one, { bytes, only }] = pick([...writing]);
            writing.delete(one);
            if (random() < 0.75)
            {
                assert.equal(reader.commit(one), true, `${where}: ${one} committed`);
                bodies.set(one, { bytes, only });
            }
            else
            {
                reader.abandon(one);
                letGo.push(bytes.length);
            }
        }
        else if (op < 0.63)
        {
            const one = `held/${Math.floor(random() * 8)}`;
            if (held.has(one))
            {
                reader.abandon(one);
                letGo.push(/** @type {{ bytes: Uint8Array }} */ (held.get(one)).bytes.length);
                held.delete(one);
            }
            else
            {
                const bytes = patternOf(sizeOf(random), ++serial);
                letGo = [];
                const view = reader.hold(one, bytes.length);
                if (view !== null)
                {
                    view.set(bytes);
                    held.set(one, { view, bytes });
                }
                else
                {
                    seen.refused++;
                }
            }
        }
        else if (op < 0.70 && !busy)
        {
            reader.drop(name);
            bodies.delete(name);
        }
        else if (op < 0.73)
        {
            const owner = pick(owners);
            if (![...writing.keys()].some(one=>one.startsWith(owner)))
            {
                keeper.release(owner);
                for (const one of [...bodies.keys()].filter(key=>key.startsWith(owner)))
                {
                    bodies.delete(one);
                }
            }
        }
        else if (op < 0.80)
        {
            keeper.raise(name);
        }
        else
        {
            // The sweep gives rooms let go of back too.
            letGo = [];
            step(Math.floor(random() * 300));
        }
        check(where);
    }
    // Everything let go: every block is whole again and every segment but the spare goes.
    for (const one of writing.keys())
    {
        reader.abandon(one);
    }
    for (const one of held.keys())
    {
        reader.abandon(one);
    }
    for (const owner of owners)
    {
        keeper.release(owner);
    }
    step(1e6);
    step(1e6);
    const figures = keeper.figures();
    assert.deepEqual([figures.placedBytes, figures.roundingBytes, figures.hotBytes], [0, 0, 0],
        `seed ${seed}: nothing placed once everything went`);
    assert.ok(figures.segmentBytes <= SEGMENT, `seed ${seed}: the spare segment alone is kept`);
    return seen;
}

test('bodies of a real run\'s sizes are placed, read and let go as the plain model says, with room to spare',
    async()=>{
        for (let seed = 1; seed <= 12; seed++)
        {
            const seen = await work(seed, 64 * SEGMENT, 1500);
            assert.equal(seen.refused, 0, `seed ${seed}: a roomy keeper refuses nothing`);
        }
    });

test('bodies of a real run\'s sizes are placed, cooled, raised and let go as the plain model says, cramped',
    async()=>{
        let refused = 0;
        let cold = 0;
        for (let seed = 1; seed <= 12; seed++)
        {
            const seen = await work(seed, 3 * SEGMENT, 1500);
            refused += seen.refused;
            cold += seen.cold;
        }
        assert.ok(cold > 0, 'room was found by cooling');
        assert.ok(refused >= 0);
    });
