/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * @bottlify/cellar - shared-memory primitives for multithreaded JavaScript:
 * the bell two threads wait on each other by, byte rings, journals (one
 * writer, any readers, the oldest written over), calls between two threads
 * (channels) and both ways with values (links), tables of numbers one
 * thread stores and any reads, and a cache of bodies in shared memory read
 * in place by name, under one budget, idle ones on the disk (OPFS), its
 * keeper reached from any thread by one binary protocol (remote keeper).
 */

export { INDEX_FILES, openKeeper, packFile, readSaved } from './keeper.js';
export { createReader } from './reader.js';
export { ChannelClosed, ChannelFailed, createChannel, openClient, openServer } from './channel.js';
export { SPIN_MS, createDoorbell, createSpin, deadlineOf, mayWait, openDoorbell, publish, ring, wake,
    waitFor, waitForAsync } from './bell.js';
export { RingClosed, createRingMemory, openRing } from './ring.js';
export { LinkClosed, createLinkMemory, openLink } from './link.js';
export { answerKeeper, keeperWords, linkCarrier, openKeeperClient, serveKeeperChannel } from './remote.js';
export { decodeValue, encodeValue } from './codec.js';
export { textOf } from './text.js';
export { createJournalMemory, openJournal } from './journal.js';
export { createTableMemory, openTable } from './table.js';

/** @typedef {import('./keeper.js').Keeper} Keeper */
/** @typedef {import('./keeper.js').KeeperOptions} KeeperOptions */
/** @typedef {import('./keeper.js').Disk} Disk */
/** @typedef {import('./keeper.js').DiskFile} DiskFile */
/** @typedef {import('./reader.js').Reader} Reader */
/** @typedef {import('./reader.js').KeeperCalls} KeeperCalls */
/** @typedef {import('./reader.js').Place} Place */
/** @typedef {import('./shared.js').SharedIndex} SharedIndex */
/** @typedef {import('./channel.js').ChannelOptions} ChannelOptions */
/** @typedef {import('./channel.js').Handler} ChannelHandler */
/** @typedef {import('./bell.js').WaitEnd} WaitEnd */
/** @typedef {import('./bell.js').DoorbellMemory} DoorbellMemory */
/** @typedef {import('./bell.js').Doorbell} Doorbell */
/** @typedef {import('./ring.js').RingMemory} RingMemory */
/** @typedef {import('./ring.js').Ring} Ring */
/** @typedef {import('./journal.js').JournalMemory} JournalMemory */
/** @typedef {import('./journal.js').Journal} Journal */
/** @typedef {import('./link.js').LinkEnd} LinkEnd */
/** @typedef {import('./link.js').Link} Link */
/** @typedef {import('./link.js').Handlers} LinkHandlers */
/** @typedef {import('./link.js').WordsHandler} WordsHandler */
/** @typedef {import('./remote.js').KeeperServed} KeeperServed */
/** @typedef {import('./remote.js').Carrier} KeeperCarrier */
/** @typedef {import('./remote.js').KeeperClient} KeeperClient */
/** @typedef {import('./table.js').TableMemory} TableMemory */
/** @typedef {import('./table.js').Table} Table */
