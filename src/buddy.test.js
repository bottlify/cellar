/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuddy, GRAIN, UNIT } from './buddy.js';

/**
 * The buddy allocator written plainly, free blocks as sets of offsets by
 * order: which block a body is placed in, from the smallest order with one
 * free, the one freed longest ago, the upper halves of a split left free;
 * then the end of the block the body leaves free, as the bits of what it
 * leaves laid from the block's end, largest first. A body given back is
 * the bits of its grains laid from its start, largest first, each joined
 * with its twins. The allocator's lists must place exactly as this does.
 *
 * @param {number} bytes
 */
function plainBuddy(bytes){
    const top = Math.log2(bytes / GRAIN);
    /** @type {Set<number>[]} */
    const free = Array.from({ length: top + 1 }, ()=>new Set());
    free[top].add(0);
    /** @type {Map<number, { grains: number, length: number, owner: number }>} */
    const given = new Map();
    /** The bits of `n`, largest first. @param {number} n */
    const bits = n=>Array.from({ length: 31 }, (_, i)=>2 ** (30 - i)).filter(bit=>(n & bit) !== 0);
    /** @param {number} order @param {number} offset */
    const join = (order, offset)=>{
        let at = offset;
        while (order < top && free[order].delete(at ^ (GRAIN << order)))
        {
            at = Math.min(at, at ^ (GRAIN << order));
            order++;
        }
        free[order].add(at);
    };
    return {
        /** @param {number} length */
        place(length){
            if (!(length > 0) || length > bytes)
            {
                return -1;
            }
            const grains = Math.ceil(length / GRAIN);
            const order = Math.ceil(Math.log2(grains));
            let at = order;
            while (at <= top && free[at].size === 0)
            {
                at++;
            }
            if (at > top)
            {
                return -1;
            }
            const offset = /** @type {number} */ (free[at].values().next().value);
            free[at].delete(offset);
            while (at > order)
            {
                at--;
                free[at].add(offset + (GRAIN << at));
            }
            let end = offset + (GRAIN << order);
            for (const bit of bits(2 ** order - grains))
            {
                end -= bit * GRAIN;
                free[Math.log2(bit)].add(end);
            }
            given.set(offset, { grains, length, owner: -1 });
            return offset;
        },
        /** @param {number} offset */
        give(offset){
            const { grains } = /** @type {{ grains: number }} */ (given.get(offset));
            given.delete(offset);
            let at = offset;
            for (const bit of bits(grains))
            {
                join(Math.log2(bit), at);
                at += bit * GRAIN;
            }
        },
        /** @param {number} offset @param {number} owner */
        own(offset, owner){
            /** @type {{ owner: number }} */ (given.get(offset)).owner = owner;
        },
        /** @param {number} from @param {number} span */
        ownersWithin: (from, span)=>[...given]
            .filter(([offset, one])=>offset < from + span && offset + one.grains * GRAIN > from)
            .sort((a, b)=>a[0] - b[0]).map(([, one])=>one.owner),
        used: ()=>[...given.values()].reduce((sum, one)=>sum + one.grains * GRAIN, 0),
        wasted: ()=>[...given.values()].reduce((sum, one)=>sum + one.grains * GRAIN - one.length, 0),
        empty: ()=>given.size === 0,
        largest(){
            for (let order = top; order >= 0; order--)
            {
                if (free[order].size > 0)
                {
                    return GRAIN << order;
                }
            }
            return 0;
        },
    };
}

test('the buddy places, joins and reports as the plain allocator does, over random work', ()=>{
    for (const bytes of [UNIT, 16 * UNIT, 256 * UNIT])
    {
        for (let seed = 1; seed <= 20; seed++)
        {
            let state = seed * 2654435761 >>> 0;
            const random = ()=>{
                state = (state * 1103515245 + 12345) >>> 0;
                return state / 2 ** 32;
            };
            const buddy = createBuddy(bytes);
            const plain = plainBuddy(bytes);
            /** @type {{ offset: number, length: number }[]} */
            const held = [];
            for (let step = 0; step < 2000; step++)
            {
                if (held.length > 0 && random() < 0.45)
                {
                    const [one] = held.splice(Math.floor(random() * held.length), 1);
                    buddy.give(one.offset, one.length);
                    plain.give(one.offset);
                }
                else
                {
                    // Mostly small bodies, now and then one past a unit or past the segment.
                    const length = 1 + Math.floor(random() ** 3 * bytes * 1.1);
                    const offset = buddy.place(length);
                    assert.equal(offset, plain.place(length), `${bytes}/${seed}/${step}: place ${length}`);
                    if (offset >= 0)
                    {
                        buddy.own(offset, step);
                        plain.own(offset, step);
                        held.push({ offset, length });
                    }
                }
                assert.equal(buddy.used(), plain.used());
                assert.equal(buddy.wasted(), plain.wasted());
                assert.equal(buddy.empty(), plain.empty());
                assert.equal(buddy.largest(), plain.largest());
                if (held.length > 0)
                {
                    // The block of a random size and place around a body held.
                    const one = held[Math.floor(random() * held.length)];
                    const span = Math.max(GRAIN << Math.floor(random() * 8), 1 << Math.ceil(Math.log2(one.length)));
                    const from = one.offset & -Math.min(span, bytes);
                    assert.deepEqual(buddy.ownersWithin(from, Math.min(span, bytes)),
                        plain.ownersWithin(from, Math.min(span, bytes)));
                }
            }
            for (const one of held)
            {
                buddy.give(one.offset, one.length);
            }
            assert.equal(buddy.empty(), true);
            assert.equal(buddy.largest(), bytes, `${bytes}/${seed}: one free block again once all went`);
        }
    }
});

test('small bodies lie several to a page, a body takes its length rounded to a grain, and the page is whole once they go',
    ()=>{
        const buddy = createBuddy(8 * UNIT);
        const offsets = Array.from({ length: UNIT / GRAIN }, ()=>buddy.place(100));
        assert.deepEqual(offsets, offsets.map((_, i)=>i * GRAIN), 'a page of grains, one after another');
        assert.equal(buddy.used(), UNIT);
        assert.equal(buddy.wasted(), UNIT - offsets.length * 100);
        const nine = buddy.place(9000);
        assert.equal(nine, 4 * UNIT, 'in the half of the segment left whole');
        assert.equal(buddy.used(), UNIT + Math.ceil(9000 / GRAIN) * GRAIN, 'its grains, not its power of two');
        assert.equal(buddy.place(UNIT - 1), UNIT, 'the next page');
        assert.equal(buddy.place(GRAIN), 4 * UNIT + Math.ceil(9000 / GRAIN) * GRAIN, 'right after it');
        assert.deepEqual(buddy.ownersWithin(0, 8 * UNIT).length, offsets.length + 3);
        for (const at of offsets)
        {
            buddy.give(at, 100);
        }
        assert.deepEqual(buddy.ownersWithin(0, UNIT), []);
        assert.deepEqual([buddy.place(UNIT), buddy.place(UNIT)].sort((a, b)=>a - b), [0, 7 * UNIT],
            'the page is whole again, beside the end the 9000 left');
    });
