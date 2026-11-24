# Cellar (`@bottlify/cellar`)

One cache for every thread of a page. Bodies live in shared memory and are read in place by name,
from any worker, without a message. One keeper thread places them under one budget, moves idle
bodies to the disk (the Origin Private File System) and brings them back when asked. Made for
[Bottlify](https://github.com/bottlify/bottlify), whose processes share one cache across their
workers; nothing in it is Bottlify's.

Status: the cache and its concurrency gate, the channel and its gate; not yet on npm. Every version is built into a
[release](https://github.com/bottlify/cellar/releases): `cellar.js`, `cellar.min.js`, the
declarations and their checksums.

## Install

```sh
npm install @bottlify/cellar
```

## Use

The keeper runs in one thread. It hands out the index and the segments every thread reads:

```js
import { openKeeper } from '@bottlify/cellar';

const keeper = await openKeeper({
    budget: 256 << 20,           // bytes of shared memory for hot bodies, at most
    disk,                        // OPFS sync handles, or null for memory only
    announce: message=>workers.forEach(worker=>worker.postMessage(message)),
});
// Each worker gets keeper.shared and keeper.segmentBuffers(); the keeper sweeps idle bodies.
setInterval(()=>keeper.sweep(), 1000);
```

Each thread reads through a reader. It reaches the keeper only for room to write and for a body
to be brought back from the disk, through whatever blocking call its threads already have:

```js
import { createReader } from '@bottlify/cellar';

const cache = createReader({ shared, segments, keeper: calls });
self.onmessage = event=>cache.adopt(event.data);   // segments made and let go

const sum = cache.with('blocks/42', body=>checksum(body));   // undefined on a miss
const into = cache.reserve('blocks/43', length);              // write in place
into?.set(bytes);
cache.commit('blocks/43');
```

A body is read only inside `with`: the keeper never takes a body a reader is in. A body that can
be made again goes away when there is no room and no disk; one marked `onlyCopy` never does.

## Channel

Calls between two threads without a message: a request is written where the other thread reads it,
the answer where the asking thread reads it, each side sleeping on a shared word until rung. A
message clones what it carries and waits for the other thread's event loop; a channel copies a
request once and need not wait for anything but the answer. What is large is not sent at all: the
request names where it lies (a body in the cache, a range of a shared buffer).

```js
import { createChannel, openClient, openServer } from '@bottlify/cellar';

const channel = createChannel({ slots: 16, slotBytes: 4096 });   // hand it to both threads

// In the worker: answer each request, read in place.
const server = openServer(channel);
for (;;) server.serve(request=>answerTo(request));   // blocks; serveAsync keeps the event loop

// In the asking thread: blocking (a worker) or not (any thread, a page's own too).
const client = openClient(channel);
const answer = client.ask(request);                  // a copy, or { read } reads it in place
const later = await client.call(request);
```

One asking side and one serving side; answers come back in order, as many requests out at once as
there are slots. A blocking ask makes no garbage: the request and answer are read where they lie.

`examples/memory.mjs` calls a function in a worker by postMessage and by the channel, each arm in a
process of its own (node 22, a 4-core x86 VM, 3 runs an arm, medians):

| | postMessage | channel |
| --- | --- | --- |
| a small call (100 000): time | 40 us | 2.1 us |
| collections, asking thread / worker | 80 / 34 | 8 / 0 (the 8: the process's start) |
| peak resident memory | 99 MiB | 79 MiB |
| 8 MiB of samples summed (200): time | 5.6 ms | 1.3 ms |
| collections in the worker | 52 | 0 |
| the worker's buffers at most | 32 MiB (copies) | 0 |
| peak resident memory | 140 MiB | 77 MiB |

`examples/call-a-worker.mjs` shows the same calls as a page would write them.

## Requirements

`SharedArrayBuffer` (a cross-origin isolated page) and growable shared buffers for a cache every
thread reads; without them the cache is one thread's, on buffers of its own, and works the same
there. `Atomics.waitAsync` for a channel's asynchronous waits. The disk is optional.

## Develop

```sh
npm ci
npm run check     # types (JSDoc, tsc), unit tests, the concurrency gate, the build
```

`npm run build` writes `dist/`: one ES module (`cellar.js`, `cellar.min.js`), the declarations
(`types/`) and `checksums.json`. A push to `main` runs the same checks on GitHub and, for a
version in `package.json` no release carries yet, releases it with the built files.

## License

[MPL-2.0](LICENSE).
