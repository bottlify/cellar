/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The keeper reached from a thread that is not its own: what a reader there
 * asks it (`KeeperCalls`) and what an owner of names asks (`own`, `release`),
 * each a request of fixed words and the name's bytes, each answer fixed words
 * read where they lie.
 *
 * The keeper's thread answers with `answerKeeper`. Two things carry the bytes
 * between the threads, and the format is the same over both:
 *
 * - a channel (`serveKeeperChannel`, `openClient` as the carrier): requests
 *   out at once up to its slots, served on the keeper's event loop. For a
 *   thread the keeper's thread never waits on.
 * - a link (`keeperHandlers`, `linkCarrier`): a call the keeper's thread
 *   answers inside any wait of its own on that link, and one the asking side
 *   answers the keeper's calls while it waits for. For a thread the keeper's
 *   thread calls and waits on: over a channel the two waits would hold each
 *   other for good.
 *
 * A request: five little-endian words, then the name's bytes (UTF-8), as many
 * as its fifth word says, and nothing after.
 *
 *     op | a | b | c | name bytes | name...
 *
 *     RESERVE  a: length, b: known (-1: every segment), c: flags
 *     RAISE    a: known (-1: every segment; the raise not waited on)
 *     DROP
 *     OWN      name: the kind of names an owner is given
 *     RELEASE  name: the owner's prefix, a: the bodies it says it held
 *
 * An answer: five words, the first its status, or a failure.
 *
 *     OK    RESERVE: id, segment, offset, mark; RAISE: -; DROP: -
 *           OWN: the prefix's byte count, then its bytes
 *           RELEASE: bodies, bytes (low, high words), waiting
 *     NONE  RESERVE refused, RAISE false, OWN or RELEASE nothing to give
 *     UNKNOWN, MALFORMED, FAILED  the request refused, or the keeper threw:
 *           the second word the byte count of what is said of it, then its bytes
 *
 * An unknown op or a request that is not of this layout is refused with its
 * failure, never taken for another call.
 */

import { SPIN_MS, mayWait } from './bell.js';
import { ChannelClosed, openServer } from './channel.js';
import { LinkClosed } from './link.js';

/** The ops. */
export const RESERVE = 1;
export const RAISE = 2;
export const DROP = 3;
export const OWN = 4;
export const RELEASE = 5;

/** The answers' statuses. */
const OK = 0;
const NONE = 1;
const UNKNOWN = -1;
const MALFORMED = -2;
const FAILED = -3;

/** The bytes of a request's words, and of an answer's. */
const HEAD = 20;
const ANSWER = 20;

/** A reservation's flags. */
const ONLY_COPY = 1;
const HOLD = 2;
const STAY = 4;
const DISK_SHIFT = 3;
/** @type {readonly import('./keeper.js').DiskPolicy[]} */
const DISKS = ['kept', 'run', 'never'];

/** @param {Uint8Array} bytes @param {number} at */
const wordAt = (bytes, at)=>bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24;

/** @param {Uint8Array} bytes @param {number} at @param {number} value */
const setWord = (bytes, at, value)=>{
    bytes[at] = value;
    bytes[at + 1] = value >>> 8;
    bytes[at + 2] = value >>> 16;
    bytes[at + 3] = value >>> 24;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Writes `text` at `at` of `bytes`, which has room for it as UTF-8: its byte
 * count. A name of ASCII, as names are, makes nothing on the heap.
 *
 * @param {Uint8Array} bytes @param {number} at @param {string} text
 */
const writeText = (bytes, at, text)=>{
    for (let n = 0; n < text.length; n++)
    {
        const code = text.charCodeAt(n);
        if (code >= 0x80)
        {
            return encoder.encodeInto(text, bytes.subarray(at)).written;
        }
        bytes[at + n] = code;
    }
    return text.length;
};

/**
 * The text of `length` bytes at `at` of `bytes`, which may be shared: a
 * decoder reads no shared memory, so anything but ASCII is copied first.
 *
 * @param {Uint8Array} bytes @param {number} at @param {number} length
 */
const readText = (bytes, at, length)=>{
    const end = at + length;
    for (let n = at; n < end; n++)
    {
        if (bytes[n] >= 0x80)
        {
            return decoder.decode(bytes.slice(at, end));
        }
    }
    return length <= 4096 ? String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(at, end)))
        : decoder.decode(bytes.slice(at, end));
};

/**
 * What the keeper's thread answers a remote keeper's requests with: the
 * keeper's calls, and the owners of names, where this thread gives them out
 * (none: an owner's request is a failure).
 *
 * @typedef {Object} KeeperServed
 * @property {Pick<import('./keeper.js').Keeper, 'reserve' | 'raise' | 'drop'>} keeper
 * @property {{ own: (kind: string) => string | null,
 *     release: (prefix: string, held: number) => { bodies: number, bytes: number, waiting: number } | null }}
 *     [owners]
 */

/**
 * The keeper's thread's side: a request's answer, written into memory of its
 * own that the next request writes over; a carrier copies it out before then.
 * A request refused, or a call that threw, is answered with its failure.
 *
 * @param {KeeperServed} served
 * @returns {(request: Uint8Array) => Uint8Array}
 */
export function answerKeeper({ keeper, owners }){
    let out = new Uint8Array(256);
    /** The fixed answer, one view for every one. */
    let fixed = out.subarray(0, ANSWER);
    /** @param {number} status @param {number} [a] @param {number} [b] @param {number} [c] @param {number} [d] */
    const say = (status, a = 0, b = 0, c = 0, d = 0)=>{
        setWord(out, 0, status);
        setWord(out, 4, a);
        setWord(out, 8, b);
        setWord(out, 12, c);
        setWord(out, 16, d);
        return fixed;
    };
    /** An answer of the fixed words and `text` after them. @param {number} status @param {string} text */
    const sayText = (status, text)=>{
        const room = ANSWER + text.length * 3;
        if (out.length < room)
        {
            out = new Uint8Array(room);
            fixed = out.subarray(0, ANSWER);
        }
        const length = writeText(out, ANSWER, text);
        say(status, length);
        return out.subarray(0, ANSWER + length);
    };
    /** @param {number} known */
    const knownOf = known=>(known < 0 ? Infinity : known);
    return request=>{
        if (request.length < HEAD || request.length !== HEAD + (wordAt(request, 16) >>> 0))
        {
            return sayText(MALFORMED, `remote keeper: a request of ${request.length} bytes is not of`
                + ' its layout');
        }
        const op = wordAt(request, 0);
        const a = wordAt(request, 4);
        const b = wordAt(request, 8);
        const c = wordAt(request, 12);
        if (op < RESERVE || op > RELEASE)
        {
            return sayText(UNKNOWN, `remote keeper: no op ${op}`);
        }
        if (op === RESERVE && (c & ~(ONLY_COPY | HOLD | STAY | 3 << DISK_SHIFT)
            || (c >> DISK_SHIFT & 3) >= DISKS.length))
        {
            return sayText(MALFORMED, `remote keeper: reservation flags ${c}`);
        }
        try
        {
            const name = readText(request, HEAD, request.length - HEAD);
            if (op === RESERVE)
            {
                const place = keeper.reserve(name, a >>> 0, { onlyCopy: (c & ONLY_COPY) !== 0,
                    hold: (c & HOLD) !== 0, idle: (c & STAY) !== 0 ? 'stay' : 'go',
                    disk: DISKS[c >> DISK_SHIFT & 3], known: knownOf(b) });
                return place === null ? say(NONE)
                    : say(OK, place.id, place.segment, place.offset, place.mark);
            }
            if (op === RAISE)
            {
                return say(keeper.raise(name, { known: knownOf(a) }) ? OK : NONE);
            }
            if (op === DROP)
            {
                keeper.drop(name);
                return say(OK);
            }
            if (!owners)
            {
                return sayText(FAILED, 'remote keeper: no owners are given names here');
            }
            if (op === OWN)
            {
                const prefix = owners.own(name);
                return prefix === null ? say(NONE) : sayText(OK, prefix);
            }
            const left = owners.release(name, a >>> 0);
            return left === null ? say(NONE) : say(OK, left.bodies, left.bytes % 0x1_0000_0000,
                Math.floor(left.bytes / 0x1_0000_0000), left.waiting);
        }
        catch (e){
            return sayText(FAILED, String(/** @type {any} */ (e)?.message ?? e));
        }
    };
}

/**
 * Serves a remote keeper's channel on this thread's event loop, one wait at a
 * time, until either side closes it: `ended` once it is, every request sent
 * before the close answered.
 *
 * @param {SharedArrayBuffer} memory @param {(request: Uint8Array) => Uint8Array} answer
 * @returns {{ close: () => void, ended: Promise<void> }}
 */
export function serveKeeperChannel(memory, answer){
    const server = openServer(memory);
    const canBlock = mayWait();
    const ended = (async()=>{
        while (!server.closed())
        {
            try
            {
                // A reader that asked one thing asks the next straight after:
                // looked for briefly, as a link's serving does, where this
                // thread may block; then waited for on the event loop.
                if (await server.serveAsync(answer) > 0 && canBlock)
                {
                    while (server.serve(answer, { timeoutMs: SPIN_MS }) > 0)
                    {
                        // Answering.
                    }
                }
            }
            catch (e){
                if (!(e instanceof ChannelClosed))
                {
                    throw e;
                }
            }
        }
        // What was asked before the close is still answered.
        if (server.waiting() > 0)
        {
            server.serve(answer);
        }
    })();
    return { close: server.close, ended };
}

/** The link target a remote keeper's calls go to (`keeperHandlers`). */
const TARGET = 'cellar.keeper';

/**
 * The handlers the keeper's side of a link answers a remote keeper with,
 * among its own.
 *
 * @param {(request: Uint8Array) => Uint8Array} answer
 */
export const keeperHandlers = answer=>({ [TARGET]: { call: answer } });

/**
 * A link's asking side as a remote keeper's carrier: a call blocks in `ask`,
 * answering the keeper's side's calls meanwhile.
 *
 * @param {import('./link.js').Link} link @returns {Carrier}
 */
export const linkCarrier = link=>({
    ask: (request, { read })=>read(link.ask(TARGET, 'call', [request])),
    call: (request, { read })=>link.call(TARGET, 'call', [request]).then(read),
});

/**
 * What carries a remote keeper's requests and answers: a channel's client
 * (`openClient`) or a link (`linkCarrier`). `ask` blocks for the answer;
 * `call` does not. Both copy the request before they return.
 *
 * @typedef {{ ask: <T>(request: Uint8Array, options: { read: (answer: Uint8Array) => T }) => T,
 *     call: <T>(request: Uint8Array, options: { read: (answer: Uint8Array) => T }) => Promise<T> }} Carrier
 */

/**
 * The failure an answer says, thrown; or nothing where it is an answer.
 *
 * @param {Uint8Array} answer
 */
const failed = answer=>{
    if (answer.length < ANSWER)
    {
        throw new Error(`remote keeper: an answer of ${answer.length} bytes`);
    }
    const status = wordAt(answer, 0);
    if (status < 0)
    {
        throw new Error(readText(answer, ANSWER, wordAt(answer, 4)));
    }
    return status;
};

/** @param {Uint8Array} answer @returns {import('./reader.js').Place | null} */
const readPlace = answer=>(failed(answer) === NONE ? null : { id: wordAt(answer, 4),
    segment: wordAt(answer, 8), offset: wordAt(answer, 12) >>> 0, mark: wordAt(answer, 16) });
/** @param {Uint8Array} answer */
const readYes = answer=>failed(answer) === OK;
/** @param {Uint8Array} answer */
const readPrefix = answer=>(failed(answer) === NONE ? null : readText(answer, ANSWER, wordAt(answer, 4)));
/** @param {Uint8Array} answer */
const readLeft = answer=>(failed(answer) === NONE ? null : { bodies: wordAt(answer, 4) >>> 0,
    bytes: (wordAt(answer, 8) >>> 0) + (wordAt(answer, 12) >>> 0) * 0x1_0000_0000,
    waiting: wordAt(answer, 16) >>> 0 });

/** Whether a failure is the carrier closed: the keeper's side gone, or this one. @param {unknown} e */
const closedBy = e=>e instanceof ChannelClosed || e instanceof LinkClosed;

/**
 * The asking side of a remote keeper: the calls a reader on this thread makes
 * of the keeper (`keeper`, for `createReader`), and those an owner of names
 * makes. Calls not waited on (`raiseLater`, `drop`) that fail other than by
 * the carrier closing are handed to `onFailure`, by default thrown where
 * nothing catches them.
 *
 * @param {Carrier} carrier
 * @param {{ onFailure?: (error: unknown) => void }} [options]
 */
export function openKeeperClient(carrier, { onFailure = e=>{
    queueMicrotask(()=>{
        throw e;
    });
} } = {}){
    let request = new Uint8Array(256);
    /**
     * The request for `op` written into this side's memory: a view of it, valid
     * until the next request is written.
     *
     * @param {number} op @param {string} name @param {number} a @param {number} b @param {number} c
     */
    const write = (op, name, a, b, c)=>{
        if (typeof name !== 'string')
        {
            throw new TypeError(`remote keeper: a name is a string, not ${name === null ? 'null' : typeof name}`);
        }
        if (request.length < HEAD + name.length * 3)
        {
            request = new Uint8Array(HEAD + name.length * 3);
        }
        const length = writeText(request, HEAD, name);
        setWord(request, 0, op);
        setWord(request, 4, a);
        setWord(request, 8, b);
        setWord(request, 12, c);
        setWord(request, 16, length);
        return request.subarray(0, HEAD + length);
    };
    /** @param {number | undefined} known */
    const knownOf = known=>(known === undefined || known === Infinity ? -1 : known);
    /**
     * @param {string} name @param {number} length
     * @param {{ onlyCopy?: boolean, disk?: import('./keeper.js').DiskPolicy, idle?: 'go' | 'stay',
     *     known?: number, hold?: boolean }} options
     */
    const reserveOf = (name, length, { onlyCopy = false, disk = 'kept', idle = 'go', known, hold = false })=>{
        const policy = DISKS.indexOf(disk);
        if (policy < 0 || (idle !== 'go' && idle !== 'stay'))
        {
            throw new RangeError(`remote keeper: a disk policy of ${String(disk)}, idle ${String(idle)}`);
        }
        if (!Number.isInteger(length) || length < 0 || length > 0xffff_ffff)
        {
            throw new RangeError(`remote keeper: a body of ${length} bytes`);
        }
        return write(RESERVE, name, length, knownOf(known), (onlyCopy ? ONLY_COPY : 0) | (hold ? HOLD : 0)
            | (idle === 'stay' ? STAY : 0) | policy << DISK_SHIFT);
    };
    /** Sent and not waited on. @param {Uint8Array} sent */
    const unwaited = sent=>{
        carrier.call(sent.slice(), { read: failed }).catch(e=>{
            if (!closedBy(e))
            {
                onFailure(e);
            }
        });
    };
    return {
        /** @type {import('./reader.js').KeeperCalls} */
        keeper: {
            reserve: (name, length, options)=>carrier.ask(reserveOf(name, length, options), { read: readPlace }),
            raise: (name, { known })=>carrier.ask(write(RAISE, name, knownOf(known), 0, 0), { read: readYes }),
            raiseLater: name=>unwaited(write(RAISE, name, -1, 0, 0)),
            drop: name=>unwaited(write(DROP, name, 0, 0, 0)),
        },

        /**
         * Room asked for without waiting: the place once granted, null where
         * the keeper had none.
         *
         * @param {string} name @param {number} length
         * @param {Parameters<typeof reserveOf>[2]} options
         * @returns {Promise<import('./reader.js').Place | null>}
         */
        reserveLater: (name, length, options)=>carrier.call(reserveOf(name, length, options).slice(),
            { read: readPlace }),

        /**
         * Names of the keeper's for one owner of `kind`: their prefix, or null
         * where it gives none.
         *
         * @param {string} kind @returns {string | null}
         */
        own: kind=>carrier.ask(write(OWN, kind, 0, 0, 0), { read: readPrefix }),

        /**
         * The owner of `prefix` goes, saying it held `held` bodies: what the
         * keeper's side found under it, or null where it was gone already.
         *
         * @param {string} prefix @param {number} held
         * @returns {{ bodies: number, bytes: number, waiting: number } | null}
         */
        release: (prefix, held)=>carrier.ask(write(RELEASE, prefix, held, 0, 0), { read: readLeft }),

        /**
         * `release` not waited on, after every call sent before it.
         *
         * @param {string} prefix @param {number} held
         * @returns {Promise<{ bodies: number, bytes: number, waiting: number } | null>}
         */
        releaseLater: (prefix, held)=>carrier.call(write(RELEASE, prefix, held, 0, 0).slice(),
            { read: readLeft }),
    };
}

/** @typedef {ReturnType<typeof openKeeperClient>} KeeperClient */
