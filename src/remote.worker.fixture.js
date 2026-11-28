/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread reading the cache through a remote keeper for `remote.itest.js`:
 * it joins over the index and the segments it is handed, hears of segments
 * made after (`adopt`), and on each `{ run }` runs that part of the gate,
 * posting what it saw.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { openAccount } from './account.js';
import { openClient } from './channel.js';
import { openLink } from './link.js';
import { createReader } from './reader.js';
import { linkCarrier, openKeeperClient } from './remote.js';
import { PLACE_WORDS, P_ID, P_MARK, P_OFFSET, P_SEGMENT, reserveFlags } from './shared.js';

const { carrier, memory, shared, segments, account } = workerData;
const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort);
/** @type {import('./link.js').Link | null} */
let link = null;
/** @type {import('./remote.js').KeeperClient} */
let client;
/** @type {Record<string, Record<string, (...args: any[]) => any>>} */
const handlers = {};
if (carrier === 'link')
{
    link = openLink(memory, handlers);
    client = openKeeperClient(linkCarrier(link));
    link.serve();
}
else
{
    client = openKeeperClient(openClient(memory));
}
const reader = createReader({ shared, segments, keeper: client.keeper });

/** @param {number} length @param {number} seed */
const bodyOf = (length, seed)=>{
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++)
    {
        bytes[i] = (i * 31 + seed + (i >>> 12)) & 255;
    }
    return bytes;
};
/** @param {Uint8Array} body */
const sumOf = body=>{
    let sum = 0;
    for (let i = 0; i < body.length; i += 4093)
    {
        sum = (sum + body[i] * (i + 1)) % 0x7fffffff;
    }
    return sum;
};

/** @type {Record<string, (message: any) => any>} */
const parts = {
    // Reserved, written and committed here, then read back here.
    put: ({ name, length, seed })=>({ put: reader.put(name, bodyOf(length, seed)),
        sum: reader.with(name, sumOf) ?? null, expected: sumOf(bodyOf(length, seed)) }),
    // Read with a wait: a cold body raised by the keeper for this thread.
    read: ({ name })=>({ look: reader.look(name), sum: reader.with(name, sumOf, { wait: true }) ?? null,
        figures: reader.figures() }),
    // An owner's names: given, filled, let go of.
    owner: ({ kind, count })=>{
        const prefix = /** @type {string} */ (client.own(kind));
        for (let n = 0; n < count; n++)
        {
            reader.put(`${prefix}${n}`, bodyOf(100, n), reserveFlags({ onlyCopy: true, disk: 'run' }));
        }
        reader.drop(`${prefix}0`);
        return { prefix, released: client.release(prefix, count - 1) };
    },
    // Room asked for, every request out at once, past the channel's slots.
    many: async({ count, length })=>{
        const asked = Array.from({ length: count }, (_, n)=>client.reserveLater(`many/${n}`, length, 0));
        port.postMessage({ sent: count });
        const settled = await Promise.allSettled(asked);
        return settled.map(one=>(one.status === 'fulfilled' ? { place: one.value && { id: one.value[P_ID],
            segment: one.value[P_SEGMENT], offset: one.value[P_OFFSET], mark: one.value[P_MARK] } }
            : { failed: String(one.reason?.name ?? one.reason) }));
    },
    // Memory of another kind taken from the keeper's account, room asked of the keeper.
    grow: ({ bytes })=>{
        const guest = openAccount(account, { room: client.room });
        return { taken: guest.take(bytes, 'guest'), report: guest.report() };
    },
    // A blocking call after the keeper's side went.
    after: ()=>{
        try
        {
            client.keeper.reserve('after', 10, 0, 1, new Int32Array(PLACE_WORDS));
            return { thrown: null };
        }
        catch (e){
            return { thrown: /** @type {any} */ (e).name };
        }
    },
};

// Asked by the keeper's thread while it waits: a keeper call of this thread's
// answered inside that wait.
handlers.worker = {
    reserveNow: (/** @type {string} */ name)=>{
        const place = new Int32Array(PLACE_WORDS);
        return client.keeper.reserve(name, 64, 0, 1, place)
            ? { segment: place[P_SEGMENT], offset: place[P_OFFSET] } : null;
    },
};

port.on('message', async message=>{
    if (message.adopt !== undefined)
    {
        reader.adopt(message.adopt);
        return;
    }
    try
    {
        port.postMessage({ said: await parts[message.run](message) });
    }
    catch (e){
        port.postMessage({ error: String(/** @type {any} */ (e)?.stack ?? e) });
    }
});
port.postMessage({ ready: true });
