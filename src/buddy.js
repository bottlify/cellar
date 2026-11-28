/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Room in one segment of the cache's hot part, in blocks of a power of two
 * from `GRAIN` to the segment's size: a body is placed in the smallest free
 * block that holds it, split from a larger one where none is free, and the
 * end of the block it leaves is free again at once, as the blocks of a power
 * of two that make it up: a body takes its length rounded to a grain, and
 * small bodies lie several to a page. A block given back joins its twin when
 * the twin is free too, so a segment whose bodies all went is one free block
 * again and can be let go whole. `wasted` counts what the rounding to a grain
 * costs.
 *
 * Only the keeper places and frees; nothing here is shared between threads.
 * Each body placed says whose it is, so the keeper can tell what would have
 * to leave for a larger block to form (`ownersWithin`).
 */

/** A page: a segment's size is whole pages. */
export const UNIT = 4096;
/**
 * The smallest block, where a body's length is rounded to. The lists cost 9
 * bytes a grain of every segment (`createBuddy`): a smaller grain saves less
 * rounding than its lists take on the sizes a run asks for.
 */
export const GRAIN = 512;

/** @param {number} n */
const log2 = n=>31 - Math.clz32(n);
/** By the grain a block starts at (`orders`): a free block, its order below this bit. */
const FREE = 0x40;
/** By the grain a body starts at (`orders`). */
const BODY = 0x20;

/** @param {number} grains */
const orderOf = grains=>(grains <= 1 ? 0 : log2(grains - 1) + 1);

/**
 * The bytes of the free block a body of `length` bytes is placed in: what
 * must be free, or made free, for it.
 *
 * @param {number} length
 */
export const blockOf = length=>GRAIN << orderOf(Math.ceil(length / GRAIN));

/** The bytes a body of `length` takes once placed. @param {number} length */
export const grainsOf = length=>Math.ceil(length / GRAIN) * GRAIN;

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
    const top = log2(bytes / GRAIN);
    const grains = bytes / GRAIN;
    /*
     * Free blocks by order (block = GRAIN << order), each order a list linked
     * through the grain its blocks start at, taken from the front and added at
     * the back: a block is taken, joined to its twin or added with no object
     * made, where a set of offsets made garbage on most of those changes.
     */
    /** By order: the grain the first free block starts at, -1 where none is free. */
    const heads = new Int32Array(top + 1).fill(-1);
    /** By order: the grain the last free block starts at. */
    const tails = new Int32Array(top + 1).fill(-1);
    /**
     * By the grain a free block starts at: the next and previous free block
     * of its order, -1 for none. By the grain a body starts at, as it is on
     * no list: whose it is (`own`) and its length in grains.
     */
    const next = new Int32Array(grains);
    const owners = next;
    const previous = new Int32Array(grains);
    const lengths = previous;
    /** By the grain a block starts at: `FREE` and its order, `BODY`, or -1 where none starts. */
    const orders = new Int8Array(grains).fill(-1);
    let given = 0;
    let used = 0;
    let asked = 0;

    /** @param {number} order @param {number} start  a block not free, added free */
    const addFree = (order, start)=>{
        orders[start] = FREE | order;
        next[start] = -1;
        previous[start] = tails[order];
        if (tails[order] >= 0)
        {
            next[tails[order]] = start;
        }
        else
        {
            heads[order] = start;
        }
        tails[order] = start;
    };

    /** @param {number} start  a free block, taken off its list */
    const takeFree = start=>{
        const order = orders[start] & ~FREE;
        orders[start] = -1;
        if (previous[start] >= 0)
        {
            next[previous[start]] = next[start];
        }
        else
        {
            heads[order] = next[start];
        }
        if (next[start] >= 0)
        {
            previous[next[start]] = previous[start];
        }
        else
        {
            tails[order] = previous[start];
        }
    };

    /** The block of `order` at `start` free, joined with its twins as far as they are. @param {number} order @param {number} start */
    const join = (order, start)=>{
        while (order < top)
        {
            const twin = start ^ (1 << order);
            if (orders[twin] !== (FREE | order))
            {
                break;
            }
            takeFree(twin);
            start = Math.min(start, twin);
            order++;
        }
        addFree(order, start);
    };

    addFree(top, 0);

    const self = {
        bytes,
        /**
         * Room for `length` bytes ending at `below` at most: its offset, or
         * -1 where no block holds it. A segment that holds memory only up to
         * `below` is placed in within that.
         *
         * @param {number} length @param {number} [below]
         */
        place(length, below = bytes){
            if (!(length > 0) || length > bytes)
            {
                return -1;
            }
            const count = Math.ceil(length / GRAIN);
            const order = orderOf(count);
            /** The last grain a body may start at. */
            const last = Math.floor(below / GRAIN) - count;
            let start = -1;
            let at = order;
            for (; at <= top; at++)
            {
                // The body lies at its block's start: a block running past
                // `below` holds it where that start is low enough. Below the
                // whole segment, the first block of a list is.
                for (let block = heads[at]; block >= 0 && start < 0; block = next[block])
                {
                    start = block <= last ? block : -1;
                }
                if (start >= 0)
                {
                    break;
                }
            }
            if (start < 0)
            {
                return -1;
            }
            takeFree(start);
            // Split down to the order asked, the upper halves left free.
            while (at > order)
            {
                at--;
                addFree(at, start + (1 << at));
            }
            // The end the body leaves, free as the blocks that make it up,
            // largest first: no twin of them is free, the body lying in each.
            for (let end = 1 << order, piece = order - 1; piece >= 0; piece--)
            {
                if (end - (1 << piece) >= count)
                {
                    end -= 1 << piece;
                    addFree(piece, start + end);
                }
            }
            orders[start] = BODY;
            owners[start] = -1;
            lengths[start] = count;
            given++;
            used += count * GRAIN;
            asked += length;
            return start * GRAIN;
        },
        /**
         * Gives back the body at `offset`, which held `length` bytes.
         *
         * @param {number} offset @param {number} length
         */
        give(offset, length){
            let at = offset / GRAIN;
            if (orders[at] !== BODY)
            {
                throw new Error(`cache: no body at ${offset} to give back`);
            }
            const count = lengths[at];
            orders[at] = -1;
            given--;
            used -= count * GRAIN;
            asked -= length;
            // Its grains as the blocks that make them up, the block it was
            // placed in starting with it: largest first.
            for (let piece = orderOf(count); piece >= 0; piece--)
            {
                if (at + (1 << piece) <= offset / GRAIN + count)
                {
                    join(piece, at);
                    at += 1 << piece;
                }
            }
        },
        /**
         * Says whose the body at `offset` is, for `ownersWithin`.
         *
         * @param {number} offset @param {number} owner
         */
        own(offset, owner){
            owners[offset / GRAIN] = owner;
        },
        /**
         * The owners of the bodies within `span` bytes from `from`, a span of
         * a block's size and place that holds a body, in order: every body
         * that starts in it lies in the block it was placed in, and so inside
         * it, but for one placed in a larger block before it, which may run
         * into it.
         *
         * @param {number} from @param {number} span @returns {number[]}
         */
        ownersWithin(from, span){
            /** @type {number[]} */
            const found = [];
            found.length = self.ownersInto(from, span, found);
            return found;
        },
        /**
         * `ownersWithin` written into the front of `found`, what lies past
         * them left as it was: how many. A caller that asks at every reserve
         * keeps one array, and an array cut short lets go of its room.
         *
         * @param {number} from @param {number} span @param {number[]} found
         * @returns {number}
         */
        ownersInto(from, span, found){
            let count = 0;
            let at = from / GRAIN;
            // Only where a body or a free block starts is a mark: the first
            // mark at the starts of ever larger blocks around the span is
            // the one that may run into it.
            for (let order = log2(span / GRAIN) + 1; order <= top; order++)
            {
                const start = at & -(1 << order);
                if (orders[start] !== -1)
                {
                    if (orders[start] === BODY && start + lengths[start] > at)
                    {
                        found[count++] = owners[start];
                        at = start + lengths[start];
                    }
                    break;
                }
            }
            while (at < (from + span) / GRAIN)
            {
                // A body or a free block starts here.
                if (orders[at] === BODY)
                {
                    found[count++] = owners[at];
                    at += lengths[at];
                }
                else
                {
                    at += 1 << (orders[at] & ~FREE);
                }
            }
            return count;
        },
        /** The bytes its lists take beside the segment: heads, tails, links and marks. */
        metadataBytes: ()=>heads.byteLength + tails.byteLength + next.byteLength + previous.byteLength
            + orders.byteLength,
        /** No body placed: the segment can be let go whole. */
        empty: ()=>given === 0,
        /** Bytes the bodies placed take. */
        used: ()=>used,
        /** Bytes of those the bodies do not fill. */
        wasted: ()=>used - asked,
        /** The largest block free now. */
        largest(){
            for (let order = top; order >= 0; order--)
            {
                if (heads[order] >= 0)
                {
                    return GRAIN << order;
                }
            }
            return 0;
        },
    };
    return self;
}

/** @typedef {ReturnType<typeof createBuddy>} Buddy */
