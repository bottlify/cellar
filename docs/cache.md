# Cache - Keeper and Reader

[Home](../README.md) · [Remote keeper](remote.md) · [Channel](channel.md) · [Benchmarks](benchmarks.md)

One Keeper places named byte bodies in shared segments, manages their memory budget, and optionally keeps cold bodies on disk. Each thread has a Reader. Hot reads need no call to the Keeper; reservation and promotion from disk do.

A body of up to a quarter of `segmentBytes` (a page at least) is placed in a shared segment, in the smallest free block of a power of two that holds it, and takes its length rounded up to a grain of 512 bytes: the end of the block it leaves is free again for other bodies, so small bodies lie several to a page and a page is whole again once the last of them goes. A body's offset is a multiple of the grain; `grainsOf(length)` is the room a body of that length takes. A larger one, held memory included, takes a segment of its own of its length rounded to a page: counted in the budget at that size, and let go of the moment the body goes (evicted, cooled, dropped, released or abandoned), not after `releaseAfterMs` as an empty shared segment is. The Keeper keeps own segments announced ahead with no bytes (address space only), as many as large bodies the budget holds at once within 16 GiB of address space (two at least; each may grow to the budget, and a browser's V8 sandbox holds every buffer of a page in one TiB: `figures().spareAddressBytes`), and grows one to the body it is given, so a Reader writing it has heard of it; one that writes more than that before it hears of the next is refused (`refusedUnseen`). Placing a large body over the budget lets go of empty shared segments, then makes room from the least recently used bodies as any reserve does.

Room is made only where the bodies leaving make it. A body is refused before anything moves for it when it is larger than the budget could ever hold (a shared body's page, a large one's pages), when its own segment is one the Reader has not heard of yet (`refusedUnseen`), or when the budget would not hold it even with every body that can leave gone (held memory and bodies read or only copies stay, and a shared segment gives back budget only once every body in it goes). A shared body is placed in a block formed by every body in that block leaving, each able to, within the segment's reach or a growth the budget has room for; a body whose going forms no block, because the rest of its block is another body's, stays. `makeRoom` asks the same before it cools anything. A body written anew under its name goes, in this order, where there is room; over its old body's own block where no other body need go; where the least recently used bodies make room; over its old block with the bodies beside it gone, each able to: its old body is given back only once the new one is placed for sure, and a refusal leaves it as it was.

A shared segment is a fixed buffer of `segmentBytes` (an OPFS handle, and any host API declared without resizable buffers, refuses a view of a growable one), and a page of it is memory only once something is written there: the budget counts it to the page past the last block placed in it, and that count does not come back down while the segment is held. The Keeper keeps two shared segments that hold nothing yet announced ahead, which cost the budget nothing: a Reader told of every segment by its last turn has one to be placed in after the first takes memory; one emptied is let go after `releaseAfterMs`, or at once where a reserve or a take of the account (`makeRoom`) wants its room. Within the segments, room already counted is placed in first, so that none grows while another has room. An own segment is a growable buffer, and its body goes to and from the disk a piece at a time through a fixed buffer of the Keeper's, as does a body moved from one pack to another: at most 1 MiB (`figures().ioScratchBytes`), however large the body, and a body is in a pack only once all of it is written. Beside the segments' memory, their room lists take 9 bytes a grain of each shared segment, spares included (`figures().metadataBytes`; 288 KiB for one of 16 MiB): the Keeper's own memory, outside the budget, said rather than left unseen.

Held memory (`hold`) up to a quarter of a segment is placed apart from bodies, in shared segments of its own: it never leaves, so placed among bodies it would keep their whole segment from going when room is made. Apart, one 4 KiB scratch costs the budget 4 KiB, and every segment of bodies around it can go.

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

`reserve(name, length, flags)` gives a writable view, or null; `commit(name)` publishes it. `put(name, bytes, flags)` combines reserve, copy and commit. `abandon(name)` returns an uncommitted reservation. `flags` is one word made by `reserveFlags({ onlyCopy, disk, idle })` (0, the default, is none of them): a writer makes it once for a kind of body, not at each write, so a write makes no options object. A `put` makes no object of its own; a `reserve` makes its view, which a read of the body hands again while it lies where it was written.

A refused Keeper reservation leaves the previous body as it was. A granted one replaces it; abandoning the replacement leaves no body. Room is made only where a block can be formed: an impossible request does not evict unrelated bodies for no result. When no body can leave (all reserved, read or only copies with nowhere to go), the walk that found that is not repeated within the same millisecond of the Keeper's clock: reservations refused meanwhile cost one look each, and a body that becomes free to leave is found from the next millisecond. A walk made while a reservation held its own name's body (which it never displaces for itself) is remembered only for that request: for another name's, that body may leave. Where bodies could leave but formed no block for a request, only the same request (block size, segments known, the name's own record) is refused that way within the millisecond; a smaller block is looked for afresh.

A reservation expires after `abandonAfterMs` (five minutes by default) and the next sweep reclaims it. A late `commit` or `put` returns false; a stale placement handed back to a Reader is refused. **A writer must stop using its view before expiry**: continued writing can corrupt another body's reused space. Raise the timeout for work that legitimately takes longer.

An idle hot body goes by the Keeper's `coldAfterMs`: to the disk, or away when it has nowhere to go. A sweep cools 4 MiB of idle bodies past its first, the rest at the sweeps after, each body started and finished in one sweep: a sweep is the Keeper's thread's, between the calls it answers (20000 bodies of 4 KiB cooled at once held it 112 ms; a pass of the bound, 7 to 27 ms). Room a reserve or a take of the account wants now is made past that bound. `idle: 'stay'` on `reserve` or `put` keeps such a body hot however long it is idle; it leaves only when its room is wanted, as the least recently used. That suits a body read again long after it was written (a translator's function, at a relink). The policy is the run's: a body read back from an earlier run's disk goes by the idle rule.

`KeeperCalls.reserve(name, length, flags, known, place)` answers true with the whole placement written into the caller's `place`, an `Int32Array` of `PLACE_WORDS` words (`P_ID`, `P_SEGMENT`, `P_OFFSET`, `P_MARK`), or false where room was refused: a Reader hands the same `place` to every reserve, so a reservation makes no object on either side. The mark identifies the particular reservation. `known` limits placement and promotion to segments the Reader has heard of (`Infinity` for every one).

## Disk policies

A recreatable body may go away when there is no room. An `onlyCopy` body is not discarded merely for eviction. Explicit replacement, release and drop are different operations.

| `disk` | Behaviour |
| --- | --- |
| `kept` (default) | May go cold on disk and be named in the saved index for the next run. |
| `run` | May go cold on disk, but is not named in the persistent index. |
| `never` | Never written to disk; a recreatable idle body can be discarded, an only copy stays in memory. |

## Owners and prefixes

Choose a prefix with a delimiter for an owner's resources, for example `texels/root-42/`.

- `keeper.under(prefix)` reports bodies and bytes under the prefix, and of those in memory their bytes (`hotBytes`) and the room they take (`placedBytes`): the difference is what rounding to grains costs that owner. `figures()` gives the same for the whole cache (`placedBytes`, `roundingBytes`).
- `keeper.release(prefix)` drops those bodies together, including only copies, and reports what was there and what is still held by readers. Deferred drops complete when the reading ends. A reservation under the prefix never committed, and memory held there (`reader.hold`), are taken back at once, their room given back and a late `commit` failing: the owner going is their writer going, and the sweep never takes held memory itself.

Prefixes are literal string prefixes, not path or glob expressions. `figures()` includes release counters. Its `segments` and `segmentBytes` are the segments holding memory now, `peakSegmentBytes` the most they held at once; `segmentsMade` and `segmentsLetGo` count every segment announced, the own ones made ahead with no bytes included.

## Persistence and recovery

`save()` writes hot bodies lacking a disk copy, flushes the packs written since their last flush (as `sweep()` does) and saves the index of persistent bodies. False can mean some bodies remained in memory; a failure is not an all-or-nothing transaction over the entire live cache.

The index is a binary base followed by checksummed deltas. A save appends changed names, writes nothing when nothing changed, and periodically writes a base to the other index file. A torn index write leaves the last complete save readable. Legacy JSON indices (0.9.0 and earlier) are supported.

Packs open behind a promise, as files do on OPFS, and the Keeper opens the next one ahead: until one is open, a body that would go to the disk stays in memory. `await keeper.ready()` settles once no pack is opening and answers whether bodies can go to the disk now (false with no disk, after `close()`, or where the pack failed to open, counted in `diskFailures`): a run that puts and saves at once awaits it first.

`readSaved([indexA, indexB])` reads the saved index without opening a Keeper or writing. Use `INDEX_FILES` for the filenames and `packFile(n)` for pack names. It reports packs and a map of named `{ pack, offset, length }` bodies, or null if neither index is valid. Validate bodies against actual pack files when reading them; the index describes the last save, not current in-memory state. Invalid entries are excluded.

An only copy leaves memory only once its copy is flushed; a sweep or a reserve that cools several writes them all, flushes each pack they went to once, and then lets them go (all hot again where that flush fails). A short write counts as failure. After a failed pack flush, copies written since its last successful flush are not trusted: hot bodies can be written again and recreatable cold bodies can be lost (`lostOnDisk`). A short read of a cold recreatable body loses it; an only copy remains cold and the read is counted as a failure. On a subsequent open, entries outside the file are skipped (`skippedEntries`).

If reading an index file throws or returns short, opening the Keeper rejects and leaves the disk alone. The application may retry later or run with `disk: null` rather than overwrite a store it could not inspect.

## Pack reclamation

Packs with less than a quarter of their file occupied by live bodies are compacted: remaining bodies are appended to a current pack, including hot bodies with a persistent copy. A sweep moves at most 1 MiB past its first body; the rest moves at the next sweeps. A subsequent save releases packs with no remaining references, unless a recoverable index still names an only copy there.

Files are removed when the Disk provides `remove`, otherwise truncated. `figures()` counts a pack let go of in `packsRemoved` at once, its bytes in `reclaimedBytes` only once its file is gone, and the packs let go of whose file is not gone yet (a removal pending, or one the disk failed, left to the next run) in `going`. Indexes track packs still opening or pending removal so that failed removals and crashes can be cleaned up on a later run. Pack numbers are allocated beyond those named by either recoverable index. Opening a store also releases unreferenced packs, including bodies written for the previous run only. A Disk that provides `names()` (the files it holds) has every `pack-N` file no index names let go of as the Keeper opens, counted in `strayPacks`, and no number given that such a file had: a run that ended before a save listed a pack it opened leaves one. Without `names()`, such a file is cut when its number is reached again.

A pack a copy could not be read from (the read threw, or an only copy came back short) is set aside for the run (`packsSetAside`): compaction does not try it again at every sweep, and a raise of a body there still reads its own copy.

When disk writes are refused, the next sweep attempts to reclaim the least recently used pack that contains no only copy, discarding recreatable bodies to make room for newer ones.

## Closing and failure contracts

`close()` saves and releases the files. The Keeper can continue in memory-only mode. Hot bodies remain; cold persistent bodies belong to the next run. A cold only copy not named by a complete save is first raised to memory if possible, evicting recreatable data as needed; failures to fit are counted as `lostAtClose`.

Disk callbacks and `announce` run during Keeper operations; do not call Keeper methods recursively from them. Callback failures are counted (`diskFailures`, `announceFailures`); rejected announce promises count too. A Reader that misses an announcement is not placed in a segment it has not heard of.

Only one Keeper may manage a directory. OPFS sync handles lock files; custom Disk implementations without locks require the host to enforce this constraint.

## Limits

| Setting | Constraint |
| --- | --- |
| `budget` | Finite nonnegative byte budget for hot bodies, in an account of the Keeper's own; with `account` ([Account](account.md)), the segments are its kind (`kind`, `cache` by default), bounded by its ceiling or the account's limit, and `makeRoom` lets bodies go for the account's other kinds. |
| `segmentBytes` | Power of two, 4 KiB to 1 GiB. |
| `packBytes` | Positive, below 2 GiB. |
| Body length | Positive integer, within the budget and below 2 GiB (`refusedLarge`). A body larger than `packBytes` takes a pack of its own on the disk. |
| Idle and reservation spans | Below half the 32-bit millisecond clock range (about 24.8 days). |
| Names | Strings only; 2^20 names and 2^25 UTF-16 units per run. |

Names are not reused during a run. Retired records can be reused after their readers leave. The budget refers to hot body segments, not total process RSS or index storage.
