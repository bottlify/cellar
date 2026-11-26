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
 * that says the conversation is over (`closed`) ends every wait on it.
 *
 * A wait sleeps on the word it waits for, or on a bell word beside it
 * (`bell`) when the word it waits for means something and may not be moved
 * by anyone but its owner - a count of requests, say. Whoever moves the word
 * then moves the bell too, but only when a wait sleeps; and a close moves the
 * bell, which a close could not do to the word: a wait that looked at the
 * closed word just before the close and sleeps just after finds its bell
 * moved and returns, where a notify alone would have found nobody asleep yet. A wait
 * takes its terms as arguments, not an object: it is made once a call on the
 * hottest paths, and makes no garbage.
 */

/**
 * About how long a wait looks before it sleeps, in ms (`LOOKS_PER_MS`): the
 * other side often moves the word sooner.
 */
export const SPIN_MS = 0.05;

/** Looks between two checks of the closed word while a wait spins, less one (a mask). */
const SPIN_LOOKS = 255;

/**
 * Looks a millisecond of spin is taken to hold: a spin counts looks, not
 * time. Each reading of the clock is a number made on the heap, and a wait
 * that spins to its end on every call (a handler slower than the spin) would
 * make garbage on every call; a clock a browser coarsens could not time a
 * spin this short either. How long a look takes differs from one processor
 * to another: a spin of `spinMs` lasts about that, never more than its looks.
 */
const LOOKS_PER_MS = 100_000;

/** The longest spin a wait takes, in ms: its looks stay a count a loop reaches. */
const MAX_SPIN_MS = 1000;

/** @param {number} spinMs @returns {number} looks a spin of `spinMs` takes */
const looksFor = spinMs=>Math.max(SPIN_LOOKS + 1, Math.round(spinMs * LOOKS_PER_MS));

/**
 * A spin that learns from the waits it serves, for one waiting side: a side
 * whose word usually moves while it looks keeps looking as long as `most`; one
 * that went to sleep all the same looks an eighth less, down to a few hundred
 * (slowly: a side whose waits are mostly short loses little to a long one), so
 * a side that waits on long work does not burn a core for nothing -- on a
 * machine short of cores it is the other side's core. One wait in
 * `PROBE_EVERY` looks the whole way, and one that saw the word move at look
 * `k` keeps at least `2k`: a side whose waits grew short gets its spin back.
 * Counted in looks: no clock is read for it.
 *
 * @typedef {{ most: number, looks: number, waits: number }} Spin
 */

/** One wait in so many takes the whole spin, whatever was learnt. */
const PROBE_EVERY = 16;

/**
 * A spin of `spinMs` at most that learns (`Spin`).
 *
 * @param {number} [spinMs]
 * @returns {Spin}
 */
export function createSpin(spinMs = SPIN_MS){
    checkTimes(Infinity, spinMs);
    const most = spinMs > 0 ? looksFor(spinMs) : 0;
    return { most, looks: most, waits: 0 };
}

/**
 * How many looks the next wait of a spin takes: what it learnt, or the whole
 * spin when this wait is the one in `PROBE_EVERY` that looks again.
 *
 * @param {Spin} spin
 * @returns {number}
 */
export const nextLooks = spin=>(++spin.waits % PROBE_EVERY === 0 ? spin.most : spin.looks);

/**
 * What a spin learns from a wait that looked `looks` times: whether it then
 * slept. Its looks, an eighth less, or kept at least twice what this wait needed.
 *
 * @param {Spin} spin @param {number} looks @param {boolean} slept
 * @returns {number}
 */
export const learnt = (spin, looks, slept)=>slept
    ? Math.max(Math.min(spin.most, SPIN_LOOKS + 1), spin.looks - (spin.looks >> 3))
    : Math.min(spin.most, Math.max(spin.looks, looks * 2));

/**
 * How a wait ended: the word moved before it counted itself asleep (`moved`)
 * or after (`woke`: a mover may have seen the count and notified it, whether
 * or not the sleep itself began), the deadline passed (`timed-out`), or the
 * closed word was set first (`closed`). `woke` is what a mover's notifies are
 * held to, not a count of the times the thread slept: a wait that counted
 * itself asleep and found its word moved at its last look never slept.
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
export const deadlineOf = timeoutMs=>{
    if (timeoutMs === undefined || timeoutMs === Infinity)
    {
        return Infinity;
    }
    // NaN compares false to every time: a wait on it would never end, nor sleep.
    if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs))
    {
        throw new RangeError(`bell: a timeout of ${timeoutMs} ms`);
    }
    return clock.now() + timeoutMs;
};

/** @param {number} deadline @param {number} spinMs */
const checkTimes = (deadline, spinMs)=>{
    // A deadline may be Infinity (none); a spin is a time up to a second, or
    // none: past that a wait sleeps rather than spin.
    if (typeof deadline !== 'number' || Number.isNaN(deadline)
        || typeof spinMs !== 'number' || !(spinMs <= MAX_SPIN_MS) || Number.isNaN(spinMs))
    {
        throw new RangeError(`bell: a deadline of ${deadline}, a spin of ${spinMs} ms`);
    }
};

/**
 * Blocks until `words[index]` is no longer `seen`: for a thread that may
 * block (a worker, never a page's own thread).
 *
 * @param {Int32Array} words @param {number} index @param {number} seen
 * @param {number} sleeps  the word counting the waits asleep on `index`
 * @param {number} [deadline]  on the clock of `performance.now()`; Infinity by default
 * @param {number | Spin} [spinMs]  how long it looks before it sleeps (`SPIN_MS`), 0 sleeps at
 *     once; or a spin that learns (`createSpin`), its side's own
 * @param {number} [closed]  a word that, once not zero, ends the wait (none by default)
 * @param {number} [bell]  the word it sleeps on, `index` by default
 * @returns {WaitEnd}
 */
export function waitFor(words, index, seen, sleeps, deadline = Infinity, spinMs = SPIN_MS,
    closed = -1, bell = index){
    seen |= 0;
    const spin = typeof spinMs === 'object' ? spinMs : null;
    checkTimes(deadline, spin === null ? /** @type {number} */ (spinMs) : 0);
    let most = 0;
    if (spin === null)
    {
        most = /** @type {number} */ (spinMs) > 0 ? looksFor(/** @type {number} */ (spinMs)) : 0;
    }
    else
    {
        most = nextLooks(spin);
    }
    if (most <= 0)
    {
        return sleepFor(words, index, seen, sleeps, deadline, closed, bell);
    }
    // The clock is read only for a wait with a deadline, once in a few hundred
    // looks: each answer of it is a number made on the heap.
    const timed = deadline !== Infinity;
    let looks = 1;
    for (; Atomics.load(words, index) === seen; looks++)
    {
        if ((looks & SPIN_LOOKS) === 0)
        {
            if (closed >= 0 && Atomics.load(words, closed) !== 0)
            {
                return 'closed';
            }
            if (looks >= most || (timed && clock.now() >= deadline))
            {
                if (spin !== null && looks >= most)
                {
                    spin.looks = learnt(spin, looks, true);
                }
                return sleepFor(words, index, seen, sleeps, deadline, closed, bell);
            }
        }
    }
    if (spin !== null)
    {
        spin.looks = learnt(spin, looks, false);
    }
    return 'moved';
}

/**
 * The sleeping half of `waitFor`, with no look first.
 *
 * @param {Int32Array} words @param {number} index @param {number} seen @param {number} sleeps
 * @param {number} deadline @param {number} closed @param {number} bell
 * @returns {WaitEnd}
 */
function sleepFor(words, index, seen, sleeps, deadline, closed, bell){
    let slept = false;
    while (Atomics.load(words, index) === seen)
    {
        if (closed >= 0 && Atomics.load(words, closed) !== 0)
        {
            return 'closed';
        }
        const left = deadline === Infinity ? Infinity : deadline - clock.now();
        if (left <= 0)
        {
            return 'timed-out';
        }
        Atomics.add(words, sleeps, 1);
        slept = true;
        try
        {
            // The bell read after the count rose and before the last looks: a
            // move or a close after it moves the bell, and the sleep returns.
            const rung = bell === index ? seen : Atomics.load(words, bell);
            if (Atomics.load(words, index) === seen
                && (closed < 0 || Atomics.load(words, closed) === 0))
            {
                // Throws on a thread that may not block, a page's own.
                Atomics.wait(words, bell, rung, left === Infinity ? undefined : left);
            }
        }
        finally
        {
            Atomics.sub(words, sleeps, 1);
        }
    }
    return slept ? 'woke' : 'moved';
}

/**
 * `waitFor` without blocking the thread: what a thread with an event loop to
 * keep, a page's own above all, waits with. It does not look before it
 * sleeps: its thread has other work.
 *
 * @param {Int32Array} words @param {number} index @param {number} seen
 * @param {number} sleeps @param {number} [deadline] @param {number} [closed]
 * @param {number} [bell]  as `waitFor`'s
 * @returns {Promise<WaitEnd>}
 */
export async function waitForAsync(words, index, seen, sleeps, deadline = Infinity,
    closed = -1, bell = index){
    seen |= 0;
    checkTimes(deadline, 0);
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
        slept = true;
        try
        {
            const rung = bell === index ? seen : Atomics.load(words, bell);
            if (Atomics.load(words, index) === seen
                && (closed < 0 || Atomics.load(words, closed) === 0))
            {
                const waited = /** @type {any} */ (Atomics).waitAsync?.(words, bell, rung,
                    left === Infinity ? undefined : left);
                if (waited?.async)
                {
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
                    await new Promise(resolve=>setTimeout(resolve, 1));
                }
            }
        }
        finally
        {
            Atomics.sub(words, sleeps, 1);
        }
    }
    return slept ? 'woke' : 'moved';
}

/**
 * Wakes the waits asleep on `words[index]`, which the caller has just stored,
 * when the count `words[sleeps]` says one sleeps: through their bell, moved
 * first, where they sleep on one (`bell`).
 *
 * @param {Int32Array} words @param {number} index @param {number} sleeps
 * @param {number} [bell]  the word the waits sleep on, `index` by default
 * @returns {boolean} whether it notified
 */
export function wake(words, index, sleeps, bell = index){
    if (Atomics.load(words, sleeps) === 0)
    {
        return false;
    }
    if (bell !== index)
    {
        Atomics.add(words, bell, 1);
    }
    Atomics.notify(words, bell);
    return true;
}

/**
 * Stores `value` in `words[index]` and wakes what sleeps on it.
 *
 * @param {Int32Array} words @param {number} index @param {number} value @param {number} sleeps
 * @param {number} [bell]  as `wake`'s
 * @returns {boolean} whether it notified
 */
export function publish(words, index, value, sleeps, bell = index){
    Atomics.store(words, index, value | 0);
    return wake(words, index, sleeps, bell);
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
    /** The spin of this opening's waits: the thread that waits on it opens it. */
    const spin = createSpin();
    return {
        memory,
        /** What this opening's waits learnt of their spin, for diagnostics. */
        spin,
        /** The count now. */
        seen: ()=>Atomics.load(words, at),
        /**
         * Blocks until the count is no longer `seen`, looking first: for
         * `spinMs`, or by default as long as this opening's waits learnt to
         * (`createSpin`). For a thread that may block.
         *
         * @param {number} seen @param {number} [timeoutMs] @param {number} [spinMs]
         * @returns {WaitEnd}
         */
        wait: (seen, timeoutMs, spinMs)=>waitFor(words, at, seen, sleeps,
            deadlineOf(timeoutMs), spinMs ?? spin),
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
