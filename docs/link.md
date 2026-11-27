# Link - calls both ways between two threads

[Home](../README.md) · [Channel](channel.md) · [Ring](ring.md) · [Bell](bell.md)

A link joins two sides, each in its own thread or both in one. Each side calls the other by a target and a method with values, and answers the other's calls from its handlers. A side waiting for an answer still answers what it is asked meanwhile, at any depth: the other side often cannot answer without asking back. Underneath are two [rings](ring.md), one each way, and a [doorbell](bell.md#doorbell) per side that everything sent to that side rings.

```js
// thread A: a worker that may block
const memory = createLinkMemory();            // hand memory.b to thread B
const link = openLink(memory.a, { files: { size: name=>sizes.get(name) } });
const answer = link.ask('registry', 'get', ['HKCU\\Software']);

// thread B: one with an event loop to keep
const link = openLink(memory.b, { registry: { get: async key=>{
    // B asks A back before it answers; A answers while it waits.
    const size = await link.call('files', 'size', [key]);
    return { key, size };
} } });
await link.serve();                           // until either side closes the link
```

| API | Behaviour |
| --- | --- |
| `createLinkMemory({ capacity, words, slots, bellA, bellB })` | Two rings of `capacity` bytes (1 MiB), and `slots` calls in place a side (1, a power of two) of `words` words each way (4); a side's doorbell may be shared with whatever else its thread waits on. |
| `openLink(end, handlers, { words, spinMs, afterSend })` | Opens one side. `handlers[target][method]` answer the other side, a promise when it settles. |
| `ask(target, method, args, timeoutMs)` | Calls and blocks until answered, handling every call sent meanwhile. |
| `call(target, method, args)` | Calls and returns a promise, settled by `pump` or `serve`. |
| `askBytes(request, read, timeoutMs)`, `callBytes(request, read)` | A call in place: blocks for its answer, or returns a promise of it; `read` reads the answer where it lies. |
| `pump()` | Handles everything sent so far: calls, word calls, answers. |
| `serve()` | Pumps on the event loop until the link closes. |
| `bell` | This side's doorbell, for a thread that waits on the link with other work. |
| `close()`, `closed()` | Ends the link for both sides. |
| `diagnostics()` | What this side sent, woke and slept, and what it asked and how long it waited. |

## Values and failures

Arguments and answers are values of `codec.js`: undefined, null, booleans, numbers, strings, byte arrays, and arrays and plain objects of them. Anything else is refused when written. A record is decoded where it lies in the ring; byte arrays and strings decoded from it are copies of their own. A record longer than the ring's longest goes in parts, one after another, each carrying the whole's length, and is decoded once that many bytes are in. Large data is better not sent: name where it lies (a body in the [cache](cache.md), a range of a shared buffer) and send the name.

A handler that throws answers with its failure: the caller throws an `Error` with the same message and every own property that can cross (`code`, a list of what was missing). An answer that cannot cross is a failure too. A call to a target or method nobody answers fails with `link: nothing answers target.method`.

## Calls in place

Each side has `slots` calls in place: the request's bytes are written into the link's own shared memory, published by an atomic count, and answered the same way back, the answer read where it lies. No record or value is made, and a blocking one makes no promise either. This is the path for a protocol that takes turns millions of times, such as a slice asked for and each trap it raised answered, or a cache's keeper asked for room.

`askBytes(request, read)` copies the request into the next slot and blocks for the answer, handling everything the other side sends meanwhile; `callBytes(request, read)` hands back a promise that `pump` or `serve` settles. They go out in the order they were made and are answered in that order. A call made inside the wait for another takes the next slot; with every slot out and its answer a promise's, a thread that may block waits for one, and otherwise, or where a wait is to take it, the call is refused with an error that says so.

A word call is a call in place of the slot's whole size, its request and answer read as 32-bit words, one out at a time:

```js
link.request[0] = budget;
link.sendWords();                  // or: sendWords() then waitWords() to block
if (link.answered()) use(link.answer[0]);
```

The other side answers every call in place with a `words(request, answer, length)` handler run by `pump`, so also inside any wait: the slot's words, and the request's byte count; it returns the answer's byte count (the whole slot where it returns nothing). Or it takes the call itself with `takeWords()` (the request, or null) and answers it later with `reply` and `answerWords(failure, length)`. The two sides' calls nest: one side's call can be out while it answers the other's. A handler that throws, or `answerWords(failure)`, fails the call; the asker's `askBytes`, its promise, `answered` or `waitWords` throws the failure. Calls in place and value calls are each in order, not in order with each other.

`afterSend` runs after every send has rung the other side, for a side whose peer must also be told another way, such as a word its running loop polls.

## Waiting, threads and closing

Blocking waits look at the doorbell before they sleep: for `spinMs`, for what a function `spinMs` returns as each wait begins, or by default as long as the side's waits learnt to ([adaptive spin](bell.md#adaptive-spin)). A side that serves on its event loop looks briefly after it handled something, then waits asynchronously.

When both sides are in one thread, a blocking `ask` or `waitWords` serves the other side in place, since the thread it would wait for is the one it blocks; it is the same mechanism a [channel](channel.md)'s blocking `ask` serves a `serveAsync` of its thread with. An answer that would need the event loop (a handler returning a promise) cannot come then, and the call throws rather than wait for ever.

A thread that may block waits for room when the ring is full; one that may not keeps what it could not write for its next pump. `close()` closes both rings: calls waiting fail with `LinkClosed`, calls after fail at once, and a side waiting for room is let go. What the other side wrote before the close is still handled by `serve`.
