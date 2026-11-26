/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuddy, UNIT } from './buddy.js';

/**
 * The buddy allocator written plainly, free blocks as sets of offsets by
 * order: which block a body takes, from the smallest order with one free,
 * the one freed longest ago, the upper halves of a split left free. The
 * allocator's lists must place exactly as this does.
 *
 * @param {number} bytes
 */
function plainBuddy(bytes){
    const top = Math.log2(bytes / UNIT);
    /** @type {Set<number>[]} */
    const free = Array.from({ length: top + 1 }, ()=>new Set());
    free[top].add(0);
    /** @type {Map<number, { order: number, length: number, owner: number }>} */
    const given = new Map();
    /** @param {number} length */
    const orderOf = length=>Math.max(0, Math.ceil(Math.log2(Math.ceil(length / UNIT))));
    return {
        /** @param {number} length */
        place(length){
            if (!(length > 0) || length > bytes)
            {
                return -1;
            }
            const order = orderOf(length);
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
                free[at].add(offset + (UNIT << at));
            }
            given.set(offset, { order, length, owner: -1 });
            return offset;
        },
        /** @param {number} offset */
        give(offset){
            let { order } = /** @type {{ order: number }} */ (given.get(offset));
            given.delete(offset);
            let at = offset;
            while (order < top && free[order].delete(at ^ (UNIT << order)))
            {
                at = Math.min(at, at ^ (UNIT << order));
                order++;
            }
            free[order].add(at);
        },
        /** @param {number} offset @param {number} owner */
        own(offset, owner){
            /** @type {{ owner: number }} */ (given.get(offset)).owner = owner;
        },
        /** @param {number} from @param {number} span */
        ownersWithin: (from, span)=>[...given].filter(([offset])=>offset >= from && offset < from + span)
            .sort((a, b)=>a[0] - b[0]).map(([, one])=>one.owner),
        used: ()=>[...given.values()].reduce((sum, one)=>sum + (UNIT << one.order), 0),
        wasted: ()=>[...given.values()].reduce((sum, one)=>sum + (UNIT << one.order) - one.length, 0),
        empty: ()=>given.size === 0,
        largest(){
            for (let order = top; order >= 0; order--)
            {
                if (free[order].size > 0)
                {
                    return UNIT << order;
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
                    const span = Math.max(UNIT << Math.floor(random() * 4), 1 << Math.ceil(Math.log2(one.length)));
                    const from = one.offset & -Math.min(span, bytes);
                    assert.deepEqual(buddy.ownersWithin(from, Math.min(span, bytes)),
                        plain.ownersWithin(from, Math.min(span, bytes)));
                }
            }
        }
    }
});
