# Remote keeper - the cache from another thread

[Home](../README.md) · [Cache](cache.md) · [Channel](channel.md) · [Link](link.md)

A Reader on a thread that is not the Keeper's asks the Keeper for room and for cold bodies (`KeeperCalls`); an owner of names asks for names of its own and lets them go. The remote keeper is that conversation, once: a fixed binary request and answer, served on the Keeper's thread, carried by a channel or by a link.

```js
// the Keeper's thread
const answer = answerKeeper({ keeper, owners: { own: kind=>`${kind}/${++n}/`, release: (prefix, held)=>keeper.release(prefix) } });
serveKeeperChannel(channel, answer);                 // or: openLink(end, mine, { words: keeperWords(answer) })

// the Reader's thread
const client = openKeeperClient(openClient(channel)); // or: openKeeperClient(linkCarrier(link))
const reader = createReader({ shared, segments, keeper: client.keeper });
const place = await client.reserveLater('texels/1/a', 4096, reserveFlags({ onlyCopy: true, disk: 'run' }));
```

| API | Behaviour |
| --- | --- |
| `answerKeeper({ keeper, owners })` | The Keeper's side: answers a request where it lies into the memory it is handed. `owners` (`own`, `release`) is optional; without it an owner's request is a failure. |
| `serveKeeperChannel(memory, answer)` | Serves a channel on the event loop until either side closes it; `ended` once it is, every request sent before the close answered. Where the thread may block, it looks for the next request briefly before it waits on the event loop. |
| `keeperWords(answer)` | The handler of a link's calls in place (`openLink`'s `words`) on the Keeper's side. |
| `linkCarrier(link)` | A link's asking side as the client's carrier: its calls in place (`askBytes`, `callBytes`). |
| `openKeeperClient(carrier, { onFailure })` | `keeper` (`KeeperCalls` for `createReader`), `reserveLater`, `own`, `release`, `releaseLater`, `room` (the Keeper's `makeRoom`, an [account](account.md)'s `room` on this thread). |

## Which carrier

- **Channel** for a thread the Keeper's thread never waits on (a worker writing the cache on its own). Requests are out at once up to the channel's slots, more wait for room, and they are served on the Keeper's event loop.
- **Link** (its [calls in place](link.md#calls-in-place), sized for the longest name with `words`, and `slots` for the calls out at once) for a thread the Keeper's thread calls and waits on. A link's waiting side answers the other's calls inside its wait, so the Keeper's thread answers a reserve while it waits on that thread, and that thread answers the Keeper's calls while it waits for its reserve. Over a channel the two waits would hold each other for good.

Both carry the same bytes, and blocking and asynchronous calls use the same format.

## Format

Little-endian 32-bit words. A request is five words, then the name in UTF-8, exactly as many bytes as its fifth word says:

| Op | Code | a | b | c | name |
| --- | ---: | --- | --- | --- | --- |
| reserve | 1 | length | known, -1 for every segment | flags | the body's |
| raise | 2 | known, -1 for every segment (`raiseLater`) | | | the body's |
| drop | 3 | | | | the body's |
| own | 4 | | | | the kind of names |
| release | 5 | bodies held | | | the owner's prefix |
| room | 6 | units of 4 KiB wanted ([account](account.md)) | | | none |

Reservation flags: the word `reserveFlags` makes, the record's own flags as the Keeper stores them: 1 only copy, 8 on the disk for this run only (`disk: 'run'`), 16 never on the disk (`'never'`), 32 idle `stay`, 64 memory held (`hold`). Any other bit, or 8 and 16 together, is malformed.

An answer is five words, the first its status:

| Status | | Words after |
| ---: | --- | --- |
| 0 | ok | reserve: id, segment, offset, mark; own: the prefix's byte count, then its bytes; release: bodies, bytes (low, high), waiting |
| 1 | none | reserve refused, raise false, own or release with nothing to give, room none made |
| -1 | unknown op | the byte count of what is said, then its text |
| -2 | malformed | the same: a request shorter than its words, a name of another length than it says, flags or a disk policy it does not know |
| -3 | failed | the same: the Keeper threw, or an owner's request where no owners are served |

An unknown op or a malformed request is refused and nothing is done for it; the client throws the failure where it asked. A call not waited on (`raiseLater`, `drop`) that fails goes to `onFailure`, by default thrown where nothing catches it; one that fails because the carrier closed is not a failure, since nothing is left to answer.

A name of ASCII is written and read without an object of its own; a fixed answer is read where it lies. A blocking reserve writes its answer into the asker's `place` and makes no object; `reserveLater` answers a place of its own (`Int32Array` of `PLACE_WORDS`), as a promise does. A request and its answer lie on a four-byte boundary, as both carriers' slots do. Calls keep the order they were made in over both carriers: a channel full of requests copies a call and sends it when a slot frees, before anything asked after it. A name longer than the carrier holds (a channel's `slotBytes`, or a link's `words` times four, less the five words) is refused by the carrier when it is sent.

## Closing

Closing the channel ends `serveKeeperChannel` for both sides: calls out fail with `ChannelClosed`, and the Keeper's side answers what was asked before. A Keeper's side that gives names to an owner on the far side of a channel lets them go when `ended` settles, where the owner did not release them itself.
