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
 * - a link's calls in place (`keeperWords`, `linkCarrier`): a call the
 *   keeper's thread answers inside any wait of its own on that link, and one
 *   the asking side answers the keeper's calls while it waits for. For a
 *   thread the keeper's thread calls and waits on: over a channel the two
 *   waits would hold each other for good.
 *
 * A request: five little-endian words, then the name's bytes (UTF-8), as many
 * as its fifth word says, and nothing after; it and its answer lie on a
 * four-byte boundary, as both carriers' slots do.
 *
 *     op | a | b | c | name bytes | name...
 *
 *     RESERVE  a: length, b: known (-1: every segment), c: flags (`reserveFlags`, the
 *              record's own; `F_HELD` for `hold`)
 *     RAISE    a: known (-1: every segment; the raise not waited on)
 *     DROP
 *     OWN      name: the kind of names an owner is given
 *     RELEASE  name: the owner's prefix, a: the bodies it says it held
 *     ROOM     a: the units of 4 KiB the account wants room for (`makeRoom`), no name
 *
 * An answer: five words, the first its status, or a failure.
 *
 *     OK    RESERVE: id, segment, offset, mark; RAISE: -; DROP: -
 *           OWN: the prefix's byte count, then its bytes
 *           RELEASE: bodies, bytes (low, high words), waiting; ROOM: -
 *     NONE  RESERVE refused, RAISE false, OWN or RELEASE nothing to give,
 *           ROOM none made
 *     UNKNOWN, MALFORMED, FAILED  the request refused, or the keeper threw:
 *           the second word the byte count of what is said of it, then its bytes
 *
 * An unknown op or a request that is not of this layout is refused with its
 * failure, never taken for another call.
 */

import { ACCOUNT_UNIT } from './account.js';
import { SPIN_MS, mayWait } from './bell.js';
import { ChannelClosed, openServer } from './channel.js';
import { LinkClosed } from './link.js';
import { PLACE_WORDS, P_ID, P_MARK, P_OFFSET, P_SEGMENT, checkFlags, isFlags } from './shared.js';
import { readText, writeText } from './text.js';

/** The ops. */
export const RESERVE = 1;
export const RAISE = 2;
export const DROP = 3;
export const OWN = 4;
export const RELEASE = 5;
export const ROOM = 6;

/** The answers' statuses. */
const OK = 0;
const NONE = 1;
const UNKNOWN = -1;
const MALFORMED = -2;
const FAILED = -3;

/** The words before a request's name, and of an answer before its text. */
const HEAD_WORDS = 5;
const HEAD = HEAD_WORDS * 4;

/** @typedef {{ words: Int32Array, bytes: Uint8Array }} Lying */

/**
 * A view's memory as words and as bytes, from where it begins: made once a
 * view, as a carrier hands the same view of a slot every time it holds as
 * much. Null where it does not begin on a word.
 *
 * @type {WeakMap<ArrayBufferView, Lying | null>}
 */
const lyings = new WeakMap();
/** @param {Uint8Array | Int32Array} view @returns {Lying | null} */
const lyingOf = view=>{
    let lying = lyings.get(view);
    if (lying === undefined)
    {
        lying = view.byteOffset % 4 !== 0 ? null : {
            words: new Int32Array(view.buffer, view.byteOffset, view.byteLength >> 2),
            bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength) };
        lyings.set(view, lying);
    }
    return lying;
};

/**
 * What the keeper's thread answers a remote keeper's requests with: the
 * keeper's calls, and the owners of names, where this thread gives them out
 * (none: an owner's request is a failure).
 *
 * @typedef {Object} KeeperServed
 * @property {Pick<import('./keeper.js').Keeper, 'reserve' | 'raise' | 'drop' | 'makeRoom'>} keeper
 * @property {{ own: (kind: string) => string | null,
 *     release: (prefix: string, held: number) => { bodies: number, bytes: number, waiting: number } | null }}
 *     [owners]
 */

/**
 * The keeper's thread's side: answers a request of `length` bytes lying in
 * `request` into `answer`, which has room for `room` bytes (`HEAD` at least):
 * the answer's bytes. A request refused, or a call that threw, is answered
 * with its failure, as much of what is said of it as there is room for.
 *
 * @param {KeeperServed} served
 * @returns {(request: Lying, length: number, answer: Lying, room: number) => number}
 */
export function answerKeeper({ keeper, owners }){
    /** @type {Lying} */
    let out;
    /** @param {number} status @param {number} [a] @param {number} [b] @param {number} [c] @param {number} [d] */
    const say = (status, a = 0, b = 0, c = 0, d = 0)=>{
        const words = out.words;
        words[0] = status;
        words[1] = a;
        words[2] = b;
        words[3] = c;
        words[4] = d;
        return HEAD;
    };
    let room = 0;
    /** The fixed words and `text` after them. @param {number} status @param {string} text */
    const sayText = (status, text)=>{
        const length = writeText(out.bytes, HEAD, text, room);
        say(status, length);
        return HEAD + length;
    };
    /** @param {number} known */
    const knownOf = known=>(known < 0 ? Infinity : known);
    /** Where the keeper answers a reserve. */
    const place = new Int32Array(PLACE_WORDS);
    return (request, length, answer, answerRoom)=>{
        out = answer;
        room = answerRoom;
        const words = request.words;
        if (length < HEAD || length > request.bytes.length || length !== HEAD + (words[4] >>> 0))
        {
            return sayText(MALFORMED, `remote keeper: a request of ${length} bytes is not of its layout`);
        }
        const op = words[0];
        const a = words[1];
        const b = words[2];
        const c = words[3];
        if (op < RESERVE || op > ROOM)
        {
            return sayText(UNKNOWN, `remote keeper: no op ${op}`);
        }
        if (op === RESERVE && !isFlags(c))
        {
            return sayText(MALFORMED, `remote keeper: reservation flags ${c}`);
        }
        try
        {
            const name = readText(request.bytes, HEAD, length - HEAD);
            if (op === RESERVE)
            {
                return keeper.reserve(name, a >>> 0, c, knownOf(b), place)
                    ? say(OK, place[P_ID], place[P_SEGMENT], place[P_OFFSET], place[P_MARK]) : say(NONE);
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
            if (op === ROOM)
            {
                return say(keeper.makeRoom((a >>> 0) * ACCOUNT_UNIT) ? OK : NONE);
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

/** @typedef {ReturnType<typeof answerKeeper>} KeeperAnswer */

/**
 * Serves a remote keeper's channel on this thread's event loop, one wait at a
 * time, until either side closes it: `ended` once it is, every request sent
 * before the close answered. Its answers are written in memory of its own,
 * which the channel copies into its slot.
 *
 * @param {SharedArrayBuffer} memory @param {KeeperAnswer} answer
 * @returns {{ close: () => void, ended: Promise<void> }}
 */
export function serveKeeperChannel(memory, answer){
    const server = openServer(memory);
    const canBlock = mayWait();
    const room = 4096;
    const out = /** @type {Lying} */ (lyingOf(new Uint8Array(room)));
    /** The answers' views, by length. @type {Uint8Array[]} */
    const answers = [];
    /** @param {Uint8Array} request */
    const handle = request=>{
        // A request off a word's boundary is refused like any other not of the layout.
        const lying = lyingOf(request) ?? /** @type {Lying} */ (lyingOf(request.slice()));
        const length = answer(lying, request.length, out, room);
        return answers[length] ??= out.bytes.subarray(0, length);
    };
    const ended = (async()=>{
        while (!server.closed())
        {
            try
            {
                // A reader that asked one thing asks the next straight after:
                // looked for briefly, as a link's serving does, where this
                // thread may block; then waited for on the event loop.
                if (await server.serveAsync(handle) > 0 && canBlock)
                {
                    while (server.serve(handle, { timeoutMs: SPIN_MS }) > 0)
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
            server.serve(handle);
        }
    })();
    return { close: server.close, ended };
}

/**
 * The handler of a link's calls in place (`openLink`'s `words`) that answers
 * a remote keeper: its answer written in the slot where the asking side reads it.
 *
 * @param {KeeperAnswer} answer @returns {import('./link.js').WordsHandler}
 */
export const keeperWords = answer=>(request, reply, length)=>{
    const lying = /** @type {Lying} */ (lyingOf(request));
    return answer(lying, length, /** @type {Lying} */ (lyingOf(reply)), reply.byteLength);
};

/**
 * A link's asking side as a remote keeper's carrier: its calls in place, a
 * call that blocks answering the keeper's side's calls meanwhile.
 *
 * @param {import('./link.js').Link} link @returns {Carrier}
 */
export const linkCarrier = link=>({
    ask: (request, { read })=>link.askBytes(request, read),
    call: (request, { read })=>link.callBytes(request, read),
});

/**
 * What carries a remote keeper's requests and answers: a channel's client
 * (`openClient`) or a link (`linkCarrier`). `ask` blocks for the answer;
 * `call` does not. Both are done with the request before they return, and
 * keep the calls in the order they were made.
 *
 * @typedef {{ ask: <T>(request: Uint8Array, options: { read: (answer: Uint8Array) => T }) => T,
 *     call: <T>(request: Uint8Array, options: { read: (answer: Uint8Array) => T }) => Promise<T> }} Carrier
 */

/**
 * The words of an answer, its failure thrown; null where it holds less than its words.
 *
 * @param {Uint8Array} answer
 */
const answered = answer=>{
    const lying = answer.length < HEAD ? null : lyingOf(answer);
    if (lying === null)
    {
        throw new Error(`remote keeper: an answer of ${answer.length} bytes`);
    }
    const words = lying.words;
    if (words[0] < 0)
    {
        throw new Error(readText(answer, HEAD, words[1]));
    }
    return words;
};

/**
 * A reserve's answer into `place`: false where it was refused.
 *
 * @param {Uint8Array} answer @param {Int32Array} place
 */
const placeInto = (answer, place)=>{
    const words = answered(answer);
    if (words[0] === NONE)
    {
        return false;
    }
    place[P_ID] = words[1];
    place[P_SEGMENT] = words[2];
    place[P_OFFSET] = words[3];
    place[P_MARK] = words[4];
    return true;
};
/** @param {Uint8Array} answer */
const placeLater = answer=>{
    const place = new Int32Array(PLACE_WORDS);
    return placeInto(answer, place) ? place : null;
};
/** @param {Uint8Array} answer */
const readYes = answer=>answered(answer)[0] === OK;
/** @param {Uint8Array} answer */
const readPrefix = answer=>{
    const words = answered(answer);
    return words[0] === NONE ? null : readText(answer, HEAD, words[1]);
};
/** @param {Uint8Array} answer */
const readLeft = answer=>{
    const words = answered(answer);
    return words[0] === NONE ? null : { bodies: words[1] >>> 0,
        bytes: (words[2] >>> 0) + (words[3] >>> 0) * 0x1_0000_0000, waiting: words[4] >>> 0 };
};

/** Whether a failure is the carrier closed: the keeper's side gone, or this one. @param {unknown} e */
const closedBy = e=>e instanceof ChannelClosed || e instanceof LinkClosed;

/**
 * The asking side of a remote keeper: the calls a reader on this thread makes
 * of the keeper (`keeper`, for `createReader`), and those an owner of names
 * makes. A call not waited on (`raiseLater`) that fails other than by
 * the carrier closing is handed to `onFailure`, by default thrown where
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
    let room = 256;
    let request = /** @type {Lying} */ (lyingOf(new Uint8Array(room)));
    /** The requests' views, by length. @type {Uint8Array[]} */
    let views = [];
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
        if (room < HEAD + name.length * 3)
        {
            room = HEAD + name.length * 3;
            request = /** @type {Lying} */ (lyingOf(new Uint8Array(room)));
            views = [];
        }
        const length = writeText(request.bytes, HEAD, name);
        const words = request.words;
        words[0] = op;
        words[1] = a;
        words[2] = b;
        words[3] = c;
        words[4] = length;
        return views[HEAD + length] ??= request.bytes.subarray(0, HEAD + length);
    };
    /** @param {number | undefined} known */
    const knownOf = known=>(known === undefined || known === Infinity ? -1 : known);
    /**
     * @param {string} name @param {number} length @param {number} flags
     * @param {number | undefined} known
     */
    const reserveOf = (name, length, flags, known)=>{
        checkFlags(flags);
        if (!Number.isInteger(length) || length < 0 || length > 0xffff_ffff)
        {
            throw new RangeError(`remote keeper: a body of ${length} bytes`);
        }
        return write(RESERVE, name, length, knownOf(known), flags);
    };
    /**
     * The place a blocking reserve's answer goes to: its asker's, set at each
     * and put back after, as a call a link serves while one waits may reserve
     * too.
     */
    let into = /** @type {Int32Array} */ (new Int32Array(PLACE_WORDS));
    const intoPlace = { read: (/** @type {Uint8Array} */ answer)=>placeInto(answer, into) };
    const later = { read: placeLater };
    /** Sent and not waited on. @param {Uint8Array} sent */
    const unwaited = sent=>carrier.call(sent, { read: answered }).catch(e=>{
        if (!closedBy(e))
        {
            onFailure(e);
        }
    });
    /**
     * The names a raise not waited on is out for: a reader that misses a cold
     * body again before it is brought back asks nothing more, where every miss
     * was a call queued behind the last.
     *
     * @type {Set<string>}
     */
    const raising = new Set();
    return {
        /** @type {import('./reader.js').KeeperCalls} */
        keeper: {
            reserve: (name, length, flags, known, place)=>{
                const request = reserveOf(name, length, flags, known);
                const waiting = into;
                into = place;
                try
                {
                    return carrier.ask(request, intoPlace);
                }
                finally
                {
                    into = waiting;
                }
            },
            raise: (name, { known })=>carrier.ask(write(RAISE, name, knownOf(known), 0, 0), { read: readYes }),
            raiseLater: name=>{
                if (raising.has(name))
                {
                    return;
                }
                raising.add(name);
                unwaited(write(RAISE, name, -1, 0, 0)).finally(()=>raising.delete(name));
            },
            // Waited on: whoever drops a name and asks for it next must find it
            // gone, as it would on the keeper's own thread.
            drop: name=>{
                carrier.ask(write(DROP, name, 0, 0, 0), { read: answered });
            },
        },

        /**
         * Room asked for without waiting: the place once granted (`P_ID`...),
         * a record of its own, null where the keeper had none.
         *
         * @param {string} name @param {number} length @param {number} flags
         * @param {number} [known]  the segments the asker has, every one by default
         * @returns {Promise<Int32Array | null>}
         */
        reserveLater: (name, length, flags, known)=>carrier.call(reserveOf(name, length, flags, known),
            later),

        /**
         * Room in the keeper's account for `bytes` more (`Keeper.makeRoom`):
         * true where it has it now. An account's `room` on this thread.
         *
         * @param {number} bytes @returns {boolean}
         */
        room: bytes=>carrier.ask(write(ROOM, '', Math.min(0xffff_ffff, Math.ceil(bytes / ACCOUNT_UNIT)),
            0, 0), { read: readYes }),

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
        releaseLater: (prefix, held)=>carrier.call(write(RELEASE, prefix, held, 0, 0),
            { read: readLeft }),
    };
}

/** @typedef {ReturnType<typeof openKeeperClient>} KeeperClient */
