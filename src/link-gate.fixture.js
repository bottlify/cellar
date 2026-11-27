/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The link's gate (`link.itest.js`): a tree of calls made from a seed, each
 * node answered by the side its depth gives, its children asked of the other
 * side while it is answered, and what each answer must be, worked out here in
 * one thread. Both sides make the same tree from the seed; each logs the nodes
 * it answers, in order.
 */

/** @param {number} seed */
export const random = seed=>()=>{
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * A node: a value with children asked meanwhile, a failure, a word call (only
 * a blocking side asks one), or a long value that crosses in parts.
 *
 * @typedef {{ id: number, kind: 'value' | 'fail' | 'words' | 'long', children: Node[] }} Node
 */

/**
 * The tree of a seed, its nodes by id.
 *
 * @param {number} seed @param {boolean} wordsFromB  whether side B may ask word calls
 */
export function treeOf(seed, wordsFromB){
    const next = random(seed);
    /** @type {Node[]} */
    const nodes = [];
    /** @param {number} depth @returns {Node} */
    const make = depth=>{
        const asker = depth % 2 === 0 ? 'a' : 'b';
        const pick = next();
        /** @type {Node['kind']} */
        const kind = depth === 0 || pick < 0.55 ? 'value' : pick < 0.7 ? 'fail'
            : pick < 0.9 && (asker === 'a' || wordsFromB) ? 'words' : 'long';
        const node = { id: nodes.length, kind, children: /** @type {Node[]} */ ([]) };
        nodes.push(node);
        if (kind === 'value' && depth < 9)
        {
            const count = (depth < 3 ? 1 : 0) + Math.floor(next() * 3);
            for (let i = 0; i < count; i++)
            {
                node.children.push(make(depth + 1));
            }
        }
        return node;
    };
    return { root: make(0), nodes };
}

/** The bytes of a long node. @param {number} id */
export const longOf = id=>Uint8Array.from({ length: 70_000 + id * 13 }, (_, at)=>(at * 7 + id) & 0xff);
/** What a word call's handler answers its request with. @param {number} id @param {number} x */
export const wordsOf = (id, x)=>(Math.imul(id, 31) + x) | 0;

/**
 * What a child's answer folds into its parent's, as both the sides and the
 * reference fold it.
 *
 * @param {Node} child @param {any} got  the answer, or the failure thrown
 */
export const folded = (child, got)=>{
    if (child.kind === 'fail')
    {
        return `F${got.code}:${got.message}`;
    }
    if (child.kind === 'long')
    {
        return `L${got.length}:${got.reduce((/** @type {number} */ sum, /** @type {number} */ byte)=>(sum * 31 + byte) >>> 0, 0)}`;
    }
    return got;
};

/**
 * A value node's answer from what its children answered.
 *
 * @param {Node} node @param {any[]} children
 */
export const valueOf = (node, children)=>({ id: node.id, children });

/** The failure a fail node throws. @param {Node} node */
export const failureOf = node=>Object.assign(new Error(`node ${node.id}`), { code: node.id });

/**
 * The tree answered in one thread: the root's answer, and the nodes each side
 * answers in the order it answers them.
 *
 * @param {Node} root
 */
export function reference(root){
    /** @type {{ a: number[], b: number[] }} */
    const log = { a: [], b: [] };
    /** @param {Node} node @param {number} depth @returns {any} */
    const answer = (node, depth)=>{
        log[depth % 2 === 0 ? 'b' : 'a'].push(node.id);
        if (node.kind === 'fail')
        {
            throw failureOf(node);
        }
        if (node.kind === 'long')
        {
            return longOf(node.id);
        }
        if (node.kind === 'words')
        {
            return wordsOf(node.id, node.id * 3);
        }
        return valueOf(node, node.children.map(child=>{
            try
            {
                return folded(child, answer(child, depth + 1));
            }
            catch (e){
                return folded(child, e);
            }
        }));
    };
    return { answer: answer(root, 0), log };
}

/**
 * The handlers of side `name`, which logs what it answers into `log`: a
 * blocking side asks its children with `ask`, one with an event loop to keep
 * with `call`.
 *
 * @param {Node[]} nodes @param {() => any} link @param {number[]} log @param {boolean} blocking
 */
export function handlersOf(nodes, link, log, blocking){
    /** @param {Node} child */
    const askBlocking = child=>{
        if (child.kind === 'words')
        {
            link().request[0] = child.id;
            link().request[1] = child.id * 3;
            link().sendWords();
            link().waitWords();
            return link().answer[0];
        }
        return link().ask('t', 'node', [child.id]);
    };
    /** @param {Node} node */
    const leaf = node=>{
        log.push(node.id);
        if (node.kind === 'fail')
        {
            throw failureOf(node);
        }
        return node.kind === 'long' ? longOf(node.id) : null;
    };
    return {
        handlers: { t: { node: blocking
            ? (/** @type {number} */ id)=>{
                const node = nodes[id];
                const got = leaf(node);
                if (node.kind !== 'value')
                {
                    return got;
                }
                return valueOf(node, node.children.map(child=>{
                    try
                    {
                        return folded(child, askBlocking(child));
                    }
                    catch (e){
                        return folded(child, e);
                    }
                }));
            }
            : async(/** @type {number} */ id)=>{
                const node = nodes[id];
                const got = leaf(node);
                if (node.kind !== 'value')
                {
                    return got;
                }
                const children = [];
                for (const child of node.children)
                {
                    try
                    {
                        children.push(folded(child, await link().call('t', 'node', [child.id])));
                    }
                    catch (e){
                        children.push(folded(child, e));
                    }
                }
                return valueOf(node, children);
            } } },
        /** @param {Int32Array} request @param {Int32Array} answer */
        words: (request, answer)=>{
            log.push(request[0]);
            answer[0] = wordsOf(request[0], request[1]);
        },
    };
}
