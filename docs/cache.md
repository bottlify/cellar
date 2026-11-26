# Cache - Keeper and Reader

[Home](../README.md) · [Channel](channel.md) · [Benchmarks](benchmarks.md)

One Keeper places named byte bodies in shared segments, manages their memory budget, and optionally keeps cold bodies on disk. Each thread has a Reader. Hot reads need no call to the Keeper; reservation and promotion from disk do.

## Page and worker

Here the Keeper runs on the page without a disk. For OPFS synchronous handles, run the Keeper in a worker. The Channel is just one possible transport for KeeperCalls.

```js
// page.js
import { createChannel, openKeeper, openServer } from '@bottlify/cellar';

let worker;
const keeper = await openKeeper({
    budget: 256 << 20,
    disk: null,
    announce: message=>worker?.postMessage(message),
});
setInterval(()=>keeper.sweep(), 1000);

const channel = createChannel();
const server = openServer(channel);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
(async()=>{
    for (;;)
    {
        await server.serveAsync(request=>{
            const { op, name, length, options } = JSON.parse(decoder.decode(request.slice())); // a browser decodes no shared view
            const answer = op === 'reserve' ? keeper.reserve(name, length, options)
                : op === 'raise' ? keeper.raise(name, options) : keeper.drop(name);
            return encoder.encode(JSON.stringify(answer));
        });
    }
})();

worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ shared: keeper.shared, segments: keeper.segmentBuffers(), channel });
```

```js
// worker.js
import { createReader, openClient } from '@bottlify/cellar';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let cache = null;
self.onmessage = ({ data })=>{
    if (data.shared === undefined)
    {
        cache.adopt(data);
        return;
    }
    const client = openClient(data.channel);
    const send = call=>encoder.encode(JSON.stringify(call));
    const ask = call=>JSON.parse(decoder.decode(client.ask(send(call))));
    cache = createReader({ shared: data.shared, segments: data.segments, keeper: {
        reserve: (name, length, options)=>ask({ op: 'reserve', name, length, options }),
        raise: (name, options)=>ask({ op: 'raise', name, options }),
        raiseLater: name=>{ client.call(send({ op: 'raise', name })).catch(()=>{}); },
        drop: name=>{ client.call(send({ op: 'drop', name })).catch(()=>{}); },
    } });

    if (cache.put('blocks/42', Uint8Array.of(1, 2, 3)))
    {
        const sum = cache.with('blocks/42', body=>body.reduce((a, b)=>a + b, 0));
        console.log(sum); // 6
    }
};
```

The example omits application shutdown and error reporting. The Keeper must be available while a worker blocks for its answer.

## Reading

- `with(name, read, { wait })` calls `read` with an in-place view, or returns `undefined` on a miss. The body is pinned during the synchronous callback only. Do not keep the view or mutate it.
- A moving body is reported as cold by `look`; a normal `with` misses and asks for it back. With `wait: true`, a blocking promotion is attempted and the body is read once the move is over, if available.
- A terminated thread inside `with` leaves its reader count held for the run. The count is not associated with a thread; time-based reclamation would also reclaim bodies from merely slow readers.
- A new Reader receives `keeper.shared` and `keeper.segmentBuffers()` at the time it joins, then adopts announcements. Invalid cache layouts are refused.

## Writing and ownership

`reserve(name, length, options)` gives a writable view, or null; `commit(name)` publishes it. `put` combines reserve, copy and commit. `abandon(name)` returns an uncommitted reservation.

A refused Keeper reservation leaves the previous body as it was. A granted one replaces it; abandoning the replacement leaves no body. Room is made only where a block can be formed: an impossible request does not evict unrelated bodies for no result. When no body can leave (all reserved, read or only copies with nowhere to go), the walk that found that is not repeated within the same millisecond of the Keeper's clock: reservations refused meanwhile cost one look each, and a body that becomes free to leave is found from the next millisecond.

A reservation expires after `abandonAfterMs` (five minutes by default) and the next sweep reclaims it. A late `commit` or `put` returns false; a stale placement handed back to a Reader is refused. **A writer must stop using its view before expiry**: continued writing can corrupt another body's reused space. Raise the timeout for work that legitimately takes longer.

KeeperCalls must carry the whole placement `{ id, segment, offset, mark }`. The mark identifies the particular reservation. The `known` option limits placement and promotion to segments the Reader has heard of.

## Disk policies

A recreatable body may go away when there is no room. An `onlyCopy` body is not discarded merely for eviction. Explicit replacement, release and drop are different operations.

| `disk` | Behaviour |
| --- | --- |
| `kept` (default) | May go cold on disk and be named in the saved index for the next run. |
| `run` | May go cold on disk, but is not named in the persistent index. |
| `never` | Never written to disk; a recreatable idle body can be discarded, an only copy stays in memory. |

## Owners and prefixes

Choose a prefix with a delimiter for an owner's resources, for example `texels/root-42/`.

- `keeper.under(prefix)` reports bodies and bytes under the prefix, and of those in memory their bytes (`hotBytes`) and the blocks they take (`placedBytes`): the difference is what rounding to blocks costs that owner.
- `keeper.release(prefix)` drops those bodies together, including only copies, and reports what was there and what is still held by readers or writers. Deferred drops complete when the relevant use ends.

Prefixes are literal string prefixes, not path or glob expressions. `figures()` includes release counters.

## Persistence and recovery

`save()` writes hot bodies lacking a disk copy, flushes packs and saves the index of persistent bodies. False can mean some bodies remained in memory; a failure is not an all-or-nothing transaction over the entire live cache.

The index is a binary base followed by checksummed deltas. A save appends changed names, writes nothing when nothing changed, and periodically writes a base to the other index file. A torn index write leaves the last complete save readable. Legacy JSON indices (0.9.0 and earlier) are supported.

`readSaved([indexA, indexB])` reads the saved index without opening a Keeper or writing. Use `INDEX_FILES` for the filenames and `packFile(n)` for pack names. It reports packs and a map of named `{ pack, offset, length }` bodies, or null if neither index is valid. Validate bodies against actual pack files when reading them; the index describes the last save, not current in-memory state. Invalid entries are excluded.

A short write counts as failure. After a failed pack flush, copies written since its last successful flush are not trusted: hot bodies can be written again and recreatable cold bodies can be lost (`lostOnDisk`). A short read of a cold recreatable body loses it; an only copy remains cold and the read is counted as a failure. On a subsequent open, entries outside the file are skipped (`skippedEntries`).

If reading an index file throws or returns short, opening the Keeper rejects and leaves the disk alone. The application may retry later or run with `disk: null` rather than overwrite a store it could not inspect.

## Pack reclamation

Packs with less than a quarter of their file occupied by live bodies are compacted: remaining bodies are appended to a current pack, including hot bodies with a persistent copy. A subsequent save releases packs with no remaining references, unless a recoverable index still names an only copy there.

Files are removed when the Disk provides `remove`, otherwise truncated. Indexes track packs still opening or pending removal so that failed removals and crashes can be cleaned up on a later run. Pack numbers are allocated beyond those named by either recoverable index. Opening a store also releases unreferenced packs, including bodies written for the previous run only.

When disk writes are refused, the next sweep attempts to reclaim the least recently used pack that contains no only copy, discarding recreatable bodies to make room for newer ones.

## Closing and failure contracts

`close()` saves and releases the files. The Keeper can continue in memory-only mode. Hot bodies remain; cold persistent bodies belong to the next run. A cold only copy not named by a complete save is first raised to memory if possible, evicting recreatable data as needed; failures to fit are counted as `lostAtClose`.

Disk callbacks and `announce` run during Keeper operations; do not call Keeper methods recursively from them. Callback failures are counted (`diskFailures`, `announceFailures`); rejected announce promises count too. A Reader that misses an announcement is not placed in a segment it has not heard of.

Only one Keeper may manage a directory. OPFS sync handles lock files; custom Disk implementations without locks require the host to enforce this constraint.

## Limits

| Setting | Constraint |
| --- | --- |
| `budget` | Finite nonnegative byte budget for hot bodies. |
| `segmentBytes` | Power of two, 4 KiB to 1 GiB. |
| `packBytes` | Positive, below 2 GiB. |
| Body length | Positive integer, must fit a segment. |
| Idle and reservation spans | Below half the 32-bit millisecond clock range (about 24.8 days). |
| Names | Strings only; 2^20 names and 2^25 UTF-16 units per run. |

Names are not reused during a run. Retired records can be reused after their readers leave. The budget refers to hot body segments, not total process RSS or index storage.
