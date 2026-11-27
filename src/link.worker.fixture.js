/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A blocking side of the link's gate (`link.itest.js`): side A asks the
 * tree's root and posts the answer and what it answered; side B serves, its
 * waits on its doorbell, until the link closes, and posts what it answered.
 * Or (`role: 'words'`) the other side of a hand-over of word calls: it answers
 * `rounds` of them with the request plus one, and posts its counts.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { handlersOf, treeOf } from './link-gate.fixture.js';
import { openLink } from './link.js';

const { role, end, seed, wordsFromB, spinMs, rounds } = workerData;

if (role === 'words')
{
    const link = openLink(end, {}, { spinMs });
    // Its own waits, which the link does not make for it.
    let slept = 0;
    for (let round = 0; round < rounds; round++)
    {
        while (link.takeWords() === null)
        {
            const seen = link.bell.seen();
            if (link.takeWords() !== null)
            {
                break;
            }
            slept += link.bell.wait(seen, Infinity, spinMs) === 'woke' ? 1 : 0;
        }
        link.reply[0] = link.asked[0] + 1;
        link.answerWords();
    }
    parentPort?.postMessage({ ...link.counts, slept });
}
else
{
    const { nodes, root } = treeOf(seed, wordsFromB);
    /** @type {number[]} */
    const log = [];
    /** @type {any} */
    let link = null;
    const { handlers, words } = handlersOf(nodes, ()=>link, log, true);
    link = openLink(end, handlers, { words });
    if (role === 'a')
    {
        /** @type {any} */
        let answer;
        try
        {
            answer = { value: link.ask('t', 'node', [root.id]) };
        }
        catch (e){
            answer = { error: String(/** @type {any} */ (e)?.message) };
        }
        link.close();
        parentPort?.postMessage({ answer, log });
    }
    else
    {
        while (!link.closed())
        {
            const seen = link.bell.seen();
            link.pump();
            if (!link.closed())
            {
                link.bell.wait(seen);
            }
        }
        link.pump();
        parentPort?.postMessage({ log });
    }
}
