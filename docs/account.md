# Account - one budget for every byte, the cache's and the rest

[Home](../README.md) · [Cache](cache.md) · [Remote keeper](remote.md)

An account is one memory budget in shared memory, counted by kind and by holder. The Cache's segments are one kind of it; the memory the Cache does not place but must count - a `WebAssembly.Memory`, compiled code, a decoder's heap - is declared to it by kind as well, grown and shrunk through it. Every thread takes and gives back by compare-and-swap on the same words, without asking another thread, so the sum is the program's, whichever thread changed it last.

```js
// the Keeper's thread
import { createAccountMemory, openAccount, openKeeper } from '@bottlify/cellar';
const account = createAccountMemory({ limit: 1536 << 20, kinds: { cache: 160 << 20, guest: Infinity } });
const keeper = await openKeeper({ account, segmentBytes: 16 << 20 });
worker.postMessage({ account });

// a worker, its remote keeper's client at hand (`openKeeperClient`)
const guest = openAccount(account, { room: client.room, onRefused: ({ bytes })=>console.error('no room', bytes) });
if (guest.take(64 << 20, 'guest'))
{
    memory.grow(1024);                  // the take came first; a grow that fails gives it back
}
```

## API

`createAccountMemory({ limit, kinds })` makes the memory: `{ buffer, kinds }`, a `SharedArrayBuffer` (an `ArrayBuffer` where memory cannot be shared) and the kinds' names. `limit` is in bytes, `Infinity` for none. `kinds` names up to 16 kinds, each with its ceiling inside the limit, `Infinity` for none. Post the memory as it is; `openAccount(memory, options)` opens it on any thread.

| Call | Behaviour |
| --- | --- |
| `take(bytes, kind)` | Room for `bytes` more of `kind`: true, or false and nothing taken. A take past the limit asks `room` once for room for its `bytes`, then tries again; one past its kind's ceiling asks nothing. |
| `overdraw(bytes, kind)` | What the holder cannot do without (the code a program runs) taken whatever the limit: counted (`overdrawn`), the account over its limit in its report, and told (`onOverdrawn`). Never held uncounted. |
| `give(bytes, kind)` | Gives back at most what this view's holder holds of `kind`: a give that comes after its holder was released takes nothing from the others. |
| `move(bytes, kind, to)` | What this holder holds handed to holder `to`, the sum unchanged. |
| `claim()` / `release(holder)` | A holder no one holds, `RUN_HOLDER` (0) where all 127 are; every kind a holder holds given back at once (the bytes). |
| `heldBy(kind)`, `fits(bytes, kind?)`, `bound(kind)` | What this holder holds; whether `bytes` more fit now (with `kind`, within its ceiling as well); the most a kind may hold, `Infinity` for no bound. |
| `report()` | `{ limit, used, peak, refused, roomAsked, roomMade, overdrawn, kinds, holders }` in bytes: each kind's `bytes`, `ceiling` (null for none), `peak` and takes `refused`; each holder out but the run's, by number, what it holds of each kind. A limit of none is null. |

Options of `openAccount`: `holder`, the holder this view takes for (`RUN_HOLDER` by default); `room(bytes)`, called where a take does not fit: true where it made room (the Keeper's `makeRoom` on its own thread, `client.room` of a [remote keeper](remote.md) elsewhere); `onRefused({ kind, bytes, used, limit })`, a take refused once room was asked for, and `onOverdrawn` (the same), a take made past the limit, for the caller to report.

`openCharge(account, kind, weight)` takes a holder's part in amounts of any size, a unit taken only where its sum crosses one, each byte counted `weight` times: `take(bytes)`, `overdraw(bytes)`, `give(bytes)`, `held()`.

## The Keeper on an account

`openKeeper({ account, kind })` takes its segments from the account as `kind` (`cache` unless said), bounded by that kind's ceiling or, without one, the limit; an account that bounds the kind by neither is refused. `openKeeper({ budget })` without an account makes one of its own, its kind's ceiling the budget. Either way `figures().account` is the account's report.

`keeper.makeRoom(bytes)` is what a take of another kind asks for: empty segments let go, the spare among them, then the bodies no one reads, least recently read first, each with every other body of its shared segment so that the segment goes (a body of its own segment goes with it), to the disk where it goes there and out where it can be made again. A segment holding a body being read, or an only copy the disk cannot take, stays. True where the account has the room now; `figures()` counts `roomAsked`, `roomMade` and `roomRefused`.

## Limits

| Setting | Constraint |
| --- | --- |
| Unit | 4 KiB (`ACCOUNT_UNIT`): a take is rounded up to whole units, a limit or ceiling down. |
| `limit`, ceilings | Nonnegative bytes below 8 TiB, or `Infinity`. |
| Kinds | 1 to 16, names of 1 to 24 UTF-16 units, fixed when the memory is made. |
| Holders | 128, the run's own included. |
