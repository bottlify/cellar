# Cache - Keeper and Reader

[Home](../README.md) · [Remote keeper](remote.md) · [Channel](channel.md) · [Benchmarks](benchmarks.md)

One Keeper places named byte bodies in shared segments, manages their memory budget, and optionally keeps cold bodies on disk. Each thread has a Reader. Hot reads need no call to the Keeper; reservation and promotion from disk do.

A body of up to a quarter of `segmentBytes` (a page at least) takes a block of a shared segment, rounded up to a power of two. A larger one, held memory included, takes a segment of its own of its length rounded to a page: counted in the budget at that size, and let go of the moment the body goes (evicted, cooled, dropped, released or abandoned), not after `releaseAfterMs` as an empty shared segment is. The Keeper keeps own segments announced ahead with no bytes (address space only), as many as large bodies the budget holds at once, and grows one to the body it is given, so a Reader writing it has heard of it; one that writes more than that before it hears of the next is refused (`refusedUnseen`). Placing a large body over the budget lets go of empty shared segments but the spare, then makes room from the least recently used bodies as any reserve does. The spare stays for small bodies, so a budget of one segment holds no large body.

## Page and worker

Here the Keeper runs on the page without a disk. For OPFS synchronous handles, run the Keeper in a worker. A Reader on another thread reaches the Keeper through the [remote keeper](remote.md).

```js
// page.js
import { answerKeeper, createChannel, openKeeper, serveKeeperChannel } from '@bottlify/cellar';

let worker;
const keeper = await openKeeper({
    budget: 256 << 20,
    disk: null,
    announce: message=>worker?.postMessage(message),
});
setInterval(()=>keeper.sweep(), 1000);

const channel = createChannel();
serveKeeperChannel(channel, answerKeeper({ keeper }));

worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ shared: keeper.shared, segments: keeper.segmentBuffers(), channel });
```

```js
// worker.js
import { createReader, openClient, openKeeperClient } from '@bottlify/cellar';

let cache = null;
self.onmessage = ({ data })=>{
    if (data.shared === undefined)
    {
        cache.adopt(data);
        return;
    }
    const { keeper } = openKeeperClient(openClient(data.channel));
    cache = createReader({ shared: data.shared, segments: data.segments, keeper });

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
- `with(name, read)` hands `read` a view of the body where it lies, valid only inside `read`. A hot body read again is read through the same view while it stays where it is, so a read makes no object of its own and a body read item by item (a glyph, a table entry) makes no garbage per read.
- `hold(name, length)` returns memory the reader writes and reads in place for as long as it holds it: a reservation the Keeper never takes back (`abandonAfterMs` does not apply), never cools, moves or writes to disk, and no one reads through `with`. It counts under its name (`under`) and against the budget like a body. `abandon(name)` lets it go; its room returns at the Keeper's next `reserve` of any name, or at its next sweep, whichever comes first. Use it for working memory with an owner, such as a ring a realtime thread reads, not for values.
- A moving body is reported as cold by `look`; a normal `with` misses and asks for it back. With `wait: true`, a blocking promotion is attempted and the body is read once the move is over, if available.
- A terminated thread inside `with` leaves its reader count held for the run. The count is not associated with a thread; time-based reclamation would also reclaim bodies from merely slow readers.
- A new Reader receives `keeper.shared` and `keeper.segmentBuffers()` at the time it joins, then adopts announcements. Invalid cache layouts are refused.

## Writing and ownership

`reserve(name, length, options)` gives a writable view, or null; `commit(name)` publishes it. `put` combines reserve, copy and commit. `abandon(name)` returns an uncommitted reservation.

A refused Keeper reservation leaves the previous body as it was. A granted one replaces it; abandoning the replacement leaves no body. Room is made only where a block can be formed: an impossible request does not evict unrelated bodies for no result. When no body can leave (all reserved, read or only copies with nowhere to go), the walk that found that is not repeated within the same millisecond of the Keeper's clock: reservations refused meanwhile cost one look each, and a body that becomes free to leave is found from the next millisecond. A walk made while a reservation held its own name's body (which it never displaces for itself) is remembered only for that request: for another name's, that body may leave. Where bodies could leave but formed no block for a request, only the same request (block size, segments known, the name's own record) is refused that way within the millisecond; a smaller block is looked for afresh.

A reservation expires after `abandonAfterMs` (five minutes by default) and the next sweep reclaims it. A late `commit` or `put` returns false; a stale placement handed back to a Reader is refused. **A writer must stop using its view before expiry**: continued writing can corrupt another body's reused space. Raise the timeout for work that legitimately takes longer.

An idle hot body goes by the Keeper's `coldAfterMs`: to the disk, or away when it has nowhere to go. `idle: 'stay'` on `reserve` or `put` keeps such a body hot however long it is idle; it leaves only when its room is wanted, as the least recently used. That suits a body read again long after it was written (a translator's function, at a relink). The policy is the run's: a body read back from an earlier run's disk goes by the idle rule.

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
- `keeper.release(prefix)` drops those bodies together, including only copies, and reports what was there and what is still held by readers or writers. Deferred drops complete when the relevant use ends. Memory held under the prefix (`reader.hold`) is taken back at once: the owner going is its holder going, and the sweep never takes held memory itself.

Prefixes are literal string prefixes, not path or glob expressions. `figures()` includes release counters. Its `segments` and `segmentBytes` are the segments holding memory now, `peakSegmentBytes` the most they held at once; `segmentsMade` and `segmentsLetGo` count every segment announced, the own ones made ahead with no bytes included.

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
| Body length | Positive integer, within the budget and below 2 GiB (`refusedLarge`). A body larger than `packBytes` takes a pack of its own on the disk. |
| Idle and reservation spans | Below half the 32-bit millisecond clock range (about 24.8 days). |
| Names | Strings only; 2^20 names and 2^25 UTF-16 units per run. |

Names are not reused during a run. Retired records can be reused after their readers leave. The budget refers to hot body segments, not total process RSS or index storage.
