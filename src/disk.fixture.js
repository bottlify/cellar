/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Disks for the cache's tests: in memory, in memory as a crash leaves it, and
 * over a directory of node's file system, all in the shape of OPFS's
 * synchronous handles. Opening answers a promise, as OPFS does.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{ remove?: boolean }} [options]  whether the disk can remove a file (yes)
 * @returns {import('./keeper.js').Disk & { files: Map<string, Uint8Array> }}
 */
export function memoryDisk({ remove = true } = {}){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    return {
        files,
        ...remove ? { remove: (/** @type {string} */ name)=>{
            files.delete(name);
        } } : {},
        async open(name){
            if (!files.has(name))
            {
                files.set(name, new Uint8Array(0));
            }
            // Room grows by doubling; the file's size is kept apart from it.
            let room = /** @type {Uint8Array} */ (files.get(name));
            let size = room.length;
            const keep = ()=>files.set(name, room.subarray(0, size));
            return {
                read(view, { at }){
                    const part = room.subarray(at, Math.min(size, at + view.length));
                    view.set(part);
                    return part.length;
                },
                write(view, { at }){
                    if (at + view.length > room.length)
                    {
                        const larger = new Uint8Array(Math.max(at + view.length, room.length * 2));
                        larger.set(room.subarray(0, size));
                        room = larger;
                    }
                    room.set(view, at);
                    size = Math.max(size, at + view.length);
                    keep();
                    return view.length;
                },
                flush(){},
                getSize: ()=>size,
                truncate(length){
                    size = Math.min(size, length);
                    keep();
                },
                close(){},
            };
        },
    };
}

/**
 * A change to a file since its last flush: bytes written at a place, or the
 * file cut to a size.
 *
 * @typedef {{ at: number, bytes: Uint8Array } | { cut: number }} Change
 */

/**
 * A disk that remembers what each file holds as flushed, for what a crash
 * leaves: `crash(keep)` answers every file as its last flush left it, with
 * each change since that `keep` says reached the disk anyway. A file removed
 * is gone at once. An operation fails while the file's name is in its set of
 * `failing` (a write as a full disk refuses it, by throwing).
 *
 * @param {Map<string, Uint8Array>} [start]  the files as a crash left them
 * @param {{ remove?: boolean }} [options]  whether the disk can remove a file (yes)
 */
export function crashDisk(start = new Map(), { remove = true } = {}){
    /** @type {Map<string, { bytes: Uint8Array, flushed: Uint8Array, since: Change[] }>} */
    const held = new Map([...start].map(([name, bytes])=>[name,
        { bytes: bytes.slice(), flushed: bytes.slice(), since: [] }]));
    const failing = { open: new Set(), read: new Set(), write: new Set(), flush: new Set(),
        remove: new Set() };
    /** Every flush asked, by file. @type {string[]} */
    const flushes = [];
    /** @param {Uint8Array} bytes @param {Change} change */
    const apply = (bytes, change)=>{
        if ('cut' in change)
        {
            return bytes.slice(0, Math.min(change.cut, bytes.length));
        }
        const out = new Uint8Array(Math.max(bytes.length, change.at + change.bytes.length));
        out.set(bytes);
        out.set(change.bytes, change.at);
        return out;
    };
    /** @type {import('./keeper.js').Disk} */
    const disk = {
        async open(name){
            if (failing.open.has(name))
            {
                throw new Error(`${name} does not open`);
            }
            if (!held.has(name))
            {
                held.set(name, { bytes: new Uint8Array(0), flushed: new Uint8Array(0), since: [] });
            }
            // A file removed and made again is another file: this handle keeps its own.
            const file = /** @type {{ bytes: Uint8Array, flushed: Uint8Array, since: Change[] }} */ (
                held.get(name));
            return {
                read(view, { at }){
                    if (failing.read.has(name))
                    {
                        throw new Error(`${name} does not read`);
                    }
                    const part = file.bytes.subarray(at, Math.min(file.bytes.length, at + view.length));
                    view.set(part);
                    return part.length;
                },
                write(view, { at }){
                    if (failing.write.has(name))
                    {
                        throw new Error('QuotaExceededError');
                    }
                    const change = { at, bytes: view.slice() };
                    file.bytes = apply(file.bytes, change);
                    file.since.push(change);
                    return view.length;
                },
                flush(){
                    flushes.push(name);
                    if (failing.flush.has(name))
                    {
                        throw new Error(`${name} does not flush`);
                    }
                    file.flushed = file.bytes.slice();
                    file.since = [];
                },
                getSize: ()=>file.bytes.length,
                truncate(size){
                    const change = { cut: size };
                    file.bytes = apply(file.bytes, change);
                    file.since.push(change);
                },
                close(){},
            };
        },
    };
    if (remove)
    {
        disk.remove = name=>{
            if (failing.remove.has(name))
            {
                throw new Error(`${name} is not removed`);
            }
            held.delete(name);
        };
    }
    return Object.assign(disk, {
        failing, flushes,
        /** The files as the run sees them now. */
        current: ()=>new Map([...held].map(([name, file])=>[name, file.bytes.slice()])),
        /**
         * The files as a crash now leaves them.
         *
         * @param {(change: Change, name: string) => boolean} [keep]  a change since a flush that
         *     reached the disk all the same
         */
        crash(keep = ()=>false){
            return new Map([...held].map(([name, file])=>[name, file.since
                .filter(change=>keep(change, name)).reduce(apply, file.flushed.slice())]));
        },
    });
}

/** @param {string} directory @returns {import('./keeper.js').Disk} */
export function directoryDisk(directory){
    fs.mkdirSync(directory, { recursive: true });
    return {
        async open(name){
            const file = path.join(directory, name);
            const fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+');
            return {
                read: (view, { at })=>fs.readSync(fd, view, 0, view.length, at),
                write: (view, { at })=>fs.writeSync(fd, view, 0, view.length, at),
                flush: ()=>fs.fsyncSync(fd),
                getSize: ()=>fs.fstatSync(fd).size,
                truncate: size=>fs.ftruncateSync(fd, size),
                close: ()=>fs.closeSync(fd),
            };
        },
        remove: name=>fs.rmSync(path.join(directory, name), { force: true }),
    };
}
