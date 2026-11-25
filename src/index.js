/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * @bottlify/cellar - shared-memory primitives for multithreaded JavaScript:
 * the bell two threads wait on each other by, byte rings, calls between two
 * threads (channels), and a cache of bodies in shared memory read in place by
 * name, under one budget, idle ones on the disk (OPFS).
 */

export { openKeeper } from './keeper.js';
export { createReader } from './reader.js';
export { ChannelClosed, ChannelFailed, createChannel, openClient, openServer } from './channel.js';
export { SPIN_MS, createDoorbell, deadlineOf, openDoorbell, publish, ring, wake, waitFor,
    waitForAsync } from './bell.js';
export { RingClosed, createRingMemory, openRing } from './ring.js';

/** @typedef {import('./keeper.js').Keeper} Keeper */
/** @typedef {import('./keeper.js').KeeperOptions} KeeperOptions */
/** @typedef {import('./keeper.js').Disk} Disk */
/** @typedef {import('./keeper.js').DiskFile} DiskFile */
/** @typedef {import('./reader.js').Reader} Reader */
/** @typedef {import('./reader.js').KeeperCalls} KeeperCalls */
/** @typedef {import('./shared.js').SharedIndex} SharedIndex */
/** @typedef {import('./channel.js').ChannelOptions} ChannelOptions */
/** @typedef {import('./channel.js').Handler} ChannelHandler */
/** @typedef {import('./bell.js').WaitEnd} WaitEnd */
/** @typedef {import('./bell.js').DoorbellMemory} DoorbellMemory */
/** @typedef {import('./bell.js').Doorbell} Doorbell */
/** @typedef {import('./ring.js').RingMemory} RingMemory */
/** @typedef {import('./ring.js').Ring} Ring */
