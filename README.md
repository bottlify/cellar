# Cellar (`@bottlify/cellar`)

**Many threads. One memory.**

Cellar is a lightweight shared-memory library for multithreaded JavaScript. Threads share data, call each other, stream records and wait on each other without going through the event loop for every exchange.

Built for [Bottlify](https://github.com/bottlify/bottlify), and useful wherever JavaScript workers share data and do work together. Browser-first, with Node.js support. No runtime dependencies. MPL-2.0.

| Primitive | What it does |
| --- | --- |
| [Cache](docs/cache.md) | Shared bodies by name, read in place, one memory budget, optional disk storage. |
| [Channel](docs/channel.md) | Blocking or asynchronous RPC between two threads. |
| [Link](docs/link.md) | Calls both ways with values; a waiting side answers the other's calls meanwhile, and small word calls take turns in place. |
| [Ring](docs/ring.md) | A bounded one-writer, one-reader byte stream, with backpressure and in-place writing. |
| [Journal](docs/journal.md) | One writer, many readers; older records are overwritten, and the writer never waits for readers. |
| [Table](docs/table.md) | Named integer counters and rows one thread stores and any thread reads, with no request to the writer. |
| [Bell](docs/bell.md) | Wait on a shared word; notify only when a wait is registered. |
| [Doorbell](docs/bell.md#doorbell) | One wait for several sources of work. |

![Round trip between two threads: postMessage against Cellar](docs/latency.svg)

![Memory of a worker summing shared samples: postMessage against a channel](docs/memory.svg)

## Install

Not on npm yet. Each [release](https://github.com/bottlify/cellar/releases) contains `cellar.js`, `cellar.min.js`, TypeScript declarations (`types/`) and checksums. The examples use the future package name `@bottlify/cellar`; use your local module path or an import map with the release files today.

## Quick start

A function in a worker, called from the page. The shared memory is handed over once with `postMessage`; requests and answers then travel through the channel.

**page.js**

```js
import { createChannel, openClient } from '@bottlify/cellar';

const memory = createChannel({ slots: 16, slotBytes: 4096 });
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ memory });

const client = openClient(memory);
const sum = await client.call(Uint8Array.of(1, 2, 3), {
    read: answer=>answer[0],
});
console.log(sum); // 6
client.close();
```

**worker.js**

```js
import { ChannelClosed, openServer } from '@bottlify/cellar';

self.onmessage = ({ data })=>{
    const server = openServer(data.memory);
    try
    {
        for (;;) server.serve(request=>[request.reduce((a, b)=>a + b, 0)]);
    }
    catch (e)
    {
        if (!(e instanceof ChannelClosed)) throw e;
    }
};
```

A worker may also use `client.ask()` to block for an answer, or `server.serveAsync()` to keep its event loop available. See [Channel](docs/channel.md).

## Which primitive?

- **Cache:** resources used by many workers, under one budget; optionally cold on disk.
- **Channel:** ask another thread to do something and return an answer.
- **Link:** two threads that call each other, nested, with values or a few words at a time.
- **Ring:** deliver commands or batches without overwriting unread data; build directly in shared memory with `reserve()` and `commit()`.
- **Journal:** logs, traces and measurements; each reader follows its own sequence and can miss old records without stopping the writer.
- **Table:** counters and figures a reader samples whenever it likes, stored where they change.
- **Bell / Doorbell:** wait for a change or for work from several rings.

## Performance

Selected round-trip and memory measurements from Cellar 0.5.9 (Node.js 22, 4-core x86 VM, median of three runs):

| Work | postMessage | Cellar |
| --- | ---: | ---: |
| Small RPC | 38 µs | 2.2 µs |
| Idle event round trip | 38 µs | 1.5 µs |
| Sum 8 MiB of samples | 5.8 ms | 1.3 ms |
| Peak RSS, 8 MiB samples | 133 MiB | 77 MiB |

These measurements compare the example workloads, not every use of `postMessage`. The batch benchmarks also compare transferred buffers with copied and in-place ring writes. See [Benchmarks](docs/benchmarks.md) for the full numbers, methods and limitations.

## Requirements and important contracts

- Cross-origin isolation and `SharedArrayBuffer` for sharing memory between browser threads. Without shared memory, the cache can run within one thread.
- Growable buffers for the cache index and its segments of one body. `Atomics.waitAsync` is used where available; otherwise asynchronous waits poll. Node.js 22 or later.
- Never block the browser's main thread. Use the asynchronous APIs there. Views handed out for reading or writing have limited lifetimes; follow each primitive's contract.
- Journal copies records into private scratch memory. Its cross-thread integrity check relies on how current engines implement sequentially consistent Atomics, not solely on the ECMAScript memory model. See [Journal](docs/journal.md#memory-ordering).
- Optional disk storage uses a single Keeper per directory. OPFS synchronous handles belong in a worker.
- A cache write reservation has an expiry; a live writer must finish before it expires. See [Cache](docs/cache.md#writing-and-ownership).

For browser isolation, a common starting configuration is `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`; ensure the page and its resources meet the policy.

## Documentation and examples

[Cache](docs/cache.md) · [Channel](docs/channel.md) · [Link](docs/link.md) · [Ring](docs/ring.md) · [Journal](docs/journal.md) · [Table](docs/table.md) · [Bell and Doorbell](docs/bell.md) · [Benchmarks](docs/benchmarks.md)

[How Cellar works, drawn](examples/README.md) - diagrams and runnable examples.

## Develop

```sh
npm ci
npm run check
```

The check runs type checking, unit tests, integration gates and the build. `npm run build` writes the ES modules, declarations and checksums to `dist/`. GitHub CI runs the checks and publishes new versions as releases.

## License

[MPL-2.0](LICENSE).
