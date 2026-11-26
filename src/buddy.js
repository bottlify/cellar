/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Room in one segment of the cache's hot part, in blocks of a power of two
 * from `UNIT` to the segment's size: a block given back joins its twin when
 * the twin is free too, so a segment whose bodies all went is one free block
 * again and can be let go whole. The price is the rounding: a body takes the
 * block of the next power of two (`wasted` counts it).
 *
 * Only the keeper places and frees; nothing here is shared between threads.
 * Each block handed out says whose body it holds, so the keeper can tell what
 * would have to leave for a larger block to form (`ownersWithin`).
 */

/** The smallest block: one page. */
export const UNIT = 4096;

/** @param {number} n */
const log2 = n=>31 - Math.clz32(n);

/**
 * The bytes of the block a body of `length` bytes takes.
 *
 * @param {number} length
 */
export const blockOf = length=>{
    const units = Math.ceil(length / UNIT);
    return units <= 1 ? UNIT : UNIT << (log2(units - 1) + 1);
};

/**
 * Throws where `bytes` is no segment's size: a power of two from `UNIT` to
 * 1 GiB, so that a block's size and offset stay within the 32-bit words a
 * block is counted in.
 *
 * @param {number} bytes
 */
export const checkSegmentBytes = bytes=>{
    if (!Number.isInteger(bytes) || bytes < UNIT || bytes > 1 << 30 || (bytes & (bytes - 1)) !== 0)
    {
        throw new RangeError(
            `cache: a segment of ${bytes} bytes is not a power of two from ${UNIT} to 1 GiB`);
    }
};

/**
 * @param {number} bytes  the segment's size (`checkSegmentBytes`)
 */
export function createBuddy(bytes){
    checkSegmentBytes(bytes);
    const top = log2(bytes / UNIT);
    const units = bytes / UNIT;
    /*
     * Free blocks by order (block = UNIT << order), each order a list linked
     * through the unit its blocks start at, taken from the front and added at
     * the back: a block is taken, joined to its twin or added with no object
     * made, where a set of offsets made garbage on most of those changes.
     */
    /** By order: the unit the first free block starts at, -1 where none is free. */
    const heads = new Int32Array(top + 1).fill(-1);
    /** By order: the unit the last free block starts at. */
    const tails = new Int32Array(top + 1).fill(-1);
    /** By the unit a free block starts at: the next and previous free block of its order, -1 for none. */
    const next = new Int32Array(units);
    const previous = new Int32Array(units);
    /** By the unit a free block starts at: its order, -1 where none starts. */
    const freeOrders = new Int8Array(units).fill(-1);
    /** By the unit a block handed out starts at: its order, -1 where none starts. */
    const orders = new Int8Array(units).fill(-1);
    /** By the unit a block handed out starts at: whose it is (`own`). */
    const owners = new Int32Array(units);
    let given = 0;
    let used = 0;
    let asked = 0;

    /** @param {number} order @param {number} unit  a block not free, added free */
    const addFree = (order, unit)=>{
        freeOrders[unit] = order;
        next[unit] = -1;
        previous[unit] = tails[order];
        if (tails[order] >= 0)
        {
            next[tails[order]] = unit;
        }
        else
        {
            heads[order] = unit;
        }
        tails[order] = unit;
    };

    /** @param {number} unit  a free block, taken off its list */
    const takeFree = unit=>{
        const order = freeOrders[unit];
        freeOrders[unit] = -1;
        if (previous[unit] >= 0)
        {
            next[previous[unit]] = next[unit];
        }
        else
        {
            heads[order] = next[unit];
        }
        if (next[unit] >= 0)
        {
            previous[next[unit]] = previous[unit];
        }
        else
        {
            tails[order] = previous[unit];
        }
    };

    addFree(top, 0);

    /** @param {number} length */
    const orderOf = length=>{
        const units = Math.ceil(length / UNIT);
        return units <= 1 ? 0 : log2(units - 1) + 1;
    };

    return {
        bytes,
        /**
         * A block holding `length` bytes: its offset, or -1 where none is free.
         *
         * @param {number} length
         */
        place(length){
            if (!(length > 0) || length > bytes)
            {
                return -1;
            }
            const order = orderOf(length);
            let at = order;
            while (at <= top && heads[at] < 0)
            {
                at++;
            }
            if (at > top)
            {
                return -1;
            }
            const unit = heads[at];
            takeFree(unit);
            // Split down to the order asked, the upper halves left free.
            while (at > order)
            {
                at--;
                addFree(at, unit + (1 << at));
            }
            const offset = unit * UNIT;
            orders[offset / UNIT] = order;
            owners[offset / UNIT] = -1;
            given++;
            used += UNIT << order;
            asked += length;
            return offset;
        },
        /**
         * Gives back the block at `offset`, which held `length` bytes.
         *
         * @param {number} offset @param {number} length
         */
        give(offset, length){
            let order = orders[offset / UNIT];
            if (!(order >= 0))
            {
                throw new Error(`cache: no block at ${offset} to give back`);
            }
            orders[offset / UNIT] = -1;
            given--;
            used -= UNIT << order;
            asked -= length;
            let at = offset / UNIT;
            while (order < top)
            {
                const twin = at ^ (1 << order);
                if (freeOrders[twin] !== order)
                {
                    break;
                }
                takeFree(twin);
                at = Math.min(at, twin);
                order++;
            }
            addFree(order, at);
        },
        /**
         * Says whose body the block at `offset` holds, for `ownersWithin`.
         *
         * @param {number} offset @param {number} owner
         */
        own(offset, owner){
            owners[offset / UNIT] = owner;
        },
        /**
         * The owners of the blocks handed out within `span` bytes from
         * `from`, a span of a block's size and place that holds a block handed
         * out: so every block it meets lies inside it.
         *
         * @param {number} from @param {number} span @returns {number[]}
         */
        ownersWithin(from, span){
            /** @type {number[]} */
            const found = [];
            for (let at = from; at < from + span;)
            {
                const order = orders[at / UNIT];
                if (order >= 0)
                {
                    found.push(owners[at / UNIT]);
                    at += UNIT << order;
                    continue;
                }
                // A free block starts here, of the one order it is free at.
                at += UNIT << freeOrders[at / UNIT];
            }
            return found;
        },
        /** No block handed out: the segment can be let go whole. */
        empty: ()=>given === 0,
        /** Bytes in blocks handed out. */
        used: ()=>used,
        /** Bytes of those blocks the bodies do not fill. */
        wasted: ()=>used - asked,
        /** The largest block free now. */
        largest(){
            for (let order = top; order >= 0; order--)
            {
                if (heads[order] >= 0)
                {
                    return UNIT << order;
                }
            }
            return 0;
        },
    };
}

/** @typedef {ReturnType<typeof createBuddy>} Buddy */
