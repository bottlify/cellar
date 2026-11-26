/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The threads of the ordering gate (`ordering.itest.js`): a writer and a
 * reader of the journal itself, and a writer and a reader of the two
 * shapes beside it that say what the machine does - plain words with no
 * atomic at all, and a sequence check with no bracket.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { openJournal } from './journal.js';

const { role, memory, control } = workerData;
const stop = new Int32Array(control);
const stopped = ()=>Atomics.load(stop, 0) !== 0;

/** Words a record or block holds; each one says the write it is of. */
const WORDS = 16;
/** Where the shapes keep their sequence and their words: lines apart, 128 bytes an Apple core's. */
const SEQ = 0;
const DATA = 128;

/** @type {Record<string, () => Record<string, number>>} */
const roles = {
    journalWriter(){
        const journal = openJournal(memory);
        let written = 0;
        while (!stopped())
        {
            for (let k = 0; k < 4096; k++)
            {
                const sequence = journal.written();
                const view = journal.draft(WORDS * 4);
                for (let i = 0; i < WORDS; i++)
                {
                    view.setUint32(i * 4, sequence, true);
                }
                journal.commit();
                written++;
            }
        }
        return { written };
    },
    journalReader(){
        const journal = openJournal(memory);
        let read = 0;
        let torn = 0;
        let next = journal.oldest();
        const take = (/** @type {DataView} */ view, /** @type {number} */ length)=>{
            if (length !== WORDS * 4)
            {
                return false;
            }
            for (let i = 0; i < WORDS; i++)
            {
                if (view.getUint32(i * 4, true) !== next)
                {
                    return false;
                }
            }
            return true;
        };
        while (!stopped())
        {
            if (next === journal.written())
            {
                continue;
            }
            const oldest = journal.oldest();
            if (((oldest - next) | 0) > 0)
            {
                next = oldest;
            }
            const whole = journal.read(next, take);
            if (whole !== undefined)
            {
                read++;
                torn += whole ? 0 : 1;
            }
            next = (next + 1) >>> 0;
        }
        return { read, torn };
    },
    plainWriter(){
        const w = new Int32Array(memory);
        let k = 0;
        while (!stopped())
        {
            for (let round = 0; round < 4096; round++)
            {
                k++;
                for (let i = 0; i < WORDS; i++)
                {
                    w[DATA + i] = k;
                }
                w[SEQ] = k;
            }
        }
        return { written: k };
    },
    plainReader(){
        const w = new Int32Array(memory);
        let read = 0;
        let torn = 0;
        while (!stopped())
        {
            for (let round = 0; round < 4096; round++)
            {
                // Words written before the flag, read after it: a word older
                // than the flag is a load the processor or compiler moved.
                const flag = w[SEQ];
                let older = false;
                for (let i = 0; i < WORDS; i++)
                {
                    older ||= w[DATA + i] < flag;
                }
                read++;
                torn += older ? 1 : 0;
            }
        }
        return { read, torn };
    },
    bareWriter(){
        const w = new Int32Array(memory);
        let k = 0;
        while (!stopped())
        {
            for (let round = 0; round < 4096; round++)
            {
                k++;
                Atomics.store(w, SEQ, 2 * k - 1);
                for (let i = 0; i < WORDS; i++)
                {
                    w[DATA + i] = k;
                }
                Atomics.store(w, SEQ, 2 * k);
            }
        }
        return { written: k };
    },
    bareReader(){
        const w = new Int32Array(memory);
        const copy = new Int32Array(WORDS);
        let read = 0;
        let torn = 0;
        while (!stopped())
        {
            for (let round = 0; round < 4096; round++)
            {
                const before = Atomics.load(w, SEQ);
                if ((before & 1) !== 0)
                {
                    continue;
                }
                for (let i = 0; i < WORDS; i++)
                {
                    copy[i] = w[DATA + i];
                }
                if (Atomics.load(w, SEQ) !== before)
                {
                    continue;
                }
                read++;
                let mixed = false;
                for (let i = 0; i < WORDS; i++)
                {
                    mixed ||= copy[i] !== before / 2;
                }
                torn += mixed ? 1 : 0;
            }
        }
        return { read, torn };
    },
};

parentPort?.postMessage(roles[role]());
