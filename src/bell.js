/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one way two threads wait on each other through shared memory: a word
 * one side moves and the other waits on, and beside it a count of the waits
 * asleep on that word.
 *
 * A wait looks at the word for a short while before it sleeps: the other
 * side mostly moves it within microseconds, and waking a sleeping thread
 * costs tens of them on a loaded machine. A side that moves the word
 * notifies only when the count says a wait sleeps: a notify takes a lock
 * every thread of the page shares, and the other side was mostly still
 * looking.
 *
 * No wake is lost between a wait's last look and its sleep. The wait adds
 * itself to the count before it looks a last time, and the side moving the
 * word stores it before it reads the count, both sequentially consistent: a
 * mover that finds no sleeper knows a wait yet to come sees what it stored,
 * and one that finds a sleeper notifies under the lock the wait takes.
 *
 * Words are indices into an `Int32Array` over a SharedArrayBuffer; a word
 * that says the conversation is over (`closed`) ends every wait on it. A wait
 * takes its terms as arguments, not an object: it is made once a call on the
 * hottest paths, and makes no garbage.
 */

/** How long a wait looks before it sleeps, in ms: the other side often moves the word sooner. */
export const SPIN_MS = 0.05;

/** Looks between two readings of the clock while a wait spins, less one (a mask). */
const SPIN_LOOKS = 255;

/**
 * How a wait ended: the word moved before it slept (`moved`) or after
 * (`woke`), the deadline passed (`timed-out`), or the closed word was set
 * first (`closed`).
 *
 * @typedef {'moved' | 'woke' | 'timed-out' | 'closed'} WaitEnd
 */


const clock = globalThis.performance ?? Date;

/** Whether this is node, whose threads end with nothing but a wait in their loop. */
const NODE = typeof (/** @type {any} */ (globalThis).process)?.versions?.node === 'string';

/**
 * The deadline of a wait of `timeoutMs`, on the clock waits read.
 *
 * @param {number | undefined} timeoutMs
 */
export const deadlineOf = timeoutMs=>(timeoutMs === undefined || timeoutMs === Infinity
    ? Infinity : clock.now() + timeoutMs);

/**
 * Blocks until `words[index]` is no longer `seen`: for a thread that may
 * block (a worker, never a page's own thread).
 *
 * @param {Int32Array} words @param {number} index @param {number} seen
 * @param {number} sleeps  the word counting the waits asleep on `index`
 * @param {number} [deadline]  on the clock of `performance.now()`; Infinity by default
 * @param {number} [spinMs]  how long it looks before it sleeps (`SPIN_MS`); 0 sleeps at once
 * @param {number} [closed]  a word that, once not zero, ends the wait (none by default)
 * @returns {WaitEnd}
 */
export function waitFor(words, index, seen, sleeps, deadline = Infinity, spinMs = SPIN_MS,
    closed = -1){
    seen |= 0;
    if (spinMs <= 0)
    {
        return sleepFor(words, index, seen, sleeps, deadline, closed);
    }
    // The clock is read once in a while, and not at all before the first few
    // hundred looks: each answer of it is a number made on the heap, and the
    // word often moves sooner.
    let spinUntil = -1;
    for (let looks = 1; Atomics.load(words, index) === seen; looks++)
    {
        if ((looks & SPIN_LOOKS) === 0)
        {
            if (closed >= 0 && Atomics.load(words, closed) !== 0)
            {
                return 'closed';
            }
            const now = clock.now();
            if (spinUntil < 0)
            {
                spinUntil = Math.min(deadline, now + spinMs);
            }
            else if (now >= spinUntil)
            {
                return sleepFor(words, index, seen, sleeps, deadline, closed);
            }
        }
    }
    return 'moved';
}

/**
 * The sleeping half of `waitFor`, with no look first.
 *
 * @param {Int32Array} words @param {number} index @param {number} seen @param {number} sleeps
 * @param {number} deadline @param {number} closed
 * @returns {WaitEnd}
 */
function sleepFor(words, index, seen, sleeps, deadline, closed){
    let slept = false;
    while (Atomics.load(words, index) === seen)
    {
        if (closed >= 0 && Atomics.load(words, closed) !== 0)
        {
            return 'closed';
        }
        const left = deadline - clock.now();
        if (left <= 0)
        {
            return 'timed-out';
        }
        Atomics.add(words, sleeps, 1);
        if (closed < 0 || Atomics.load(words, closed) === 0)
        {
            Atomics.wait(words, index, seen, left === Infinity ? undefined : left);
            slept = true;
        }
        Atomics.sub(words, sleeps, 1);
    }
    return slept ? 'woke' : 'moved';
}

/**
 * `waitFor` without blocking the thread: what a thread with an event loop to
 * keep, a page's own above all, waits with. It does not look before it
 * sleeps: its thread has other work.
 *
 * @param {Int32Array} words @param {number} index @param {number} seen
 * @param {number} sleeps @param {number} [deadline] @param {number} [closed]  as `waitFor`'s
 * @returns {Promise<WaitEnd>}
 */
export async function waitForAsync(words, index, seen, sleeps, deadline = Infinity,
    closed = -1){
    seen |= 0;
    let slept = false;
    while (Atomics.load(words, index) === seen)
    {
        if (closed >= 0 && Atomics.load(words, closed) !== 0)
        {
            return 'closed';
        }
        const left = deadline - clock.now();
        if (left <= 0)
        {
            return 'timed-out';
        }
        Atomics.add(words, sleeps, 1);
        if (closed < 0 || Atomics.load(words, closed) === 0)
        {
            const waited = /** @type {any} */ (Atomics).waitAsync?.(words, index, seen,
                left === Infinity ? undefined : left);
            if (waited?.async)
            {
                slept = true;
                // Node lets a thread whose loop has only this wait end:
                // something of the loop's own keeps it while it waits. A
                // browser keeps its threads, and the wait costs no timer there.
                const holding = NODE ? setInterval(()=>{}, 1 << 30) : null;
                try
                {
                    await waited.value;
                }
                finally
                {
                    if (holding !== null)
                    {
                        clearInterval(holding);
                    }
                }
            }
            else if (!waited)
            {
                // No waitAsync here: look again on a later turn of the loop.
                slept = true;
                await new Promise(resolve=>setTimeout(resolve, 1));
            }
        }
        Atomics.sub(words, sleeps, 1);
    }
    return slept ? 'woke' : 'moved';
}

/**
 * Wakes the waits asleep on `words[index]`, which the caller has just stored,
 * when the count `words[sleeps]` says one sleeps.
 *
 * @param {Int32Array} words @param {number} index @param {number} sleeps
 * @returns {boolean} whether it notified
 */
export function wake(words, index, sleeps){
    if (Atomics.load(words, sleeps) === 0)
    {
        return false;
    }
    Atomics.notify(words, index);
    return true;
}

/**
 * Stores `value` in `words[index]` and wakes what sleeps on it.
 *
 * @param {Int32Array} words @param {number} index @param {number} value @param {number} sleeps
 * @returns {boolean} whether it notified
 */
export function publish(words, index, value, sleeps){
    Atomics.store(words, index, value | 0);
    return wake(words, index, sleeps);
}

/**
 * Moves a doorbell on by one and wakes what sleeps on it: for a word several
 * writers ring, whose waits compare the count they read before they looked.
 *
 * @param {Int32Array} words @param {number} index @param {number} sleeps
 * @returns {boolean} whether it notified
 */
export function ring(words, index, sleeps){
    Atomics.add(words, index, 1);
    return wake(words, index, sleeps);
}

/**
 * Where a doorbell lies: the count it is rung by at `index` of the buffer's
 * words, and the count of the waits asleep on it in the word after.
 *
 * @typedef {{ buffer: SharedArrayBuffer, index: number }} DoorbellMemory
 */

/**
 * A doorbell of its own: two words.
 *
 * @returns {DoorbellMemory}
 */
export function createDoorbell(){
    return { buffer: new SharedArrayBuffer(8), index: 0 };
}

/**
 * A word several writers ring and one thread waits on: one wait for everything
 * that thread is sent, whatever it was sent through. The waiting side reads
 * the count (`seen`) before it looks at what it serves, and waits for the
 * count to move from that, so whatever is written after its look rings it.
 *
 * @param {DoorbellMemory} memory
 */
export function openDoorbell(memory){
    const words = new Int32Array(memory.buffer);
    const at = memory.index;
    const sleeps = at + 1;
    return {
        memory,
        /** The count now. */
        seen: ()=>Atomics.load(words, at),
        /**
         * Blocks until the count is no longer `seen`, looking for `spinMs`
         * first: for a thread that may block.
         *
         * @param {number} seen @param {number} [timeoutMs] @param {number} [spinMs]
         * @returns {WaitEnd}
         */
        wait: (seen, timeoutMs, spinMs = SPIN_MS)=>waitFor(words, at, seen, sleeps,
            deadlineOf(timeoutMs), spinMs),
        /**
         * The same on the event loop.
         *
         * @param {number} seen @param {number} [timeoutMs]
         * @returns {Promise<WaitEnd>}
         */
        waitAsync: (seen, timeoutMs)=>waitForAsync(words, at, seen, sleeps,
            deadlineOf(timeoutMs)),
        /** Moves the count on and wakes the waits asleep on it. */
        ring: ()=>ring(words, at, sleeps),
    };
}

/** @typedef {ReturnType<typeof openDoorbell>} Doorbell */
