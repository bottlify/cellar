# Channel - calls between threads

[Home](../README.md) · [Bell](bell.md) · [Benchmarks](benchmarks.md)

Requests and responses occupy separate shared-memory slots. One client and one server own their respective sides for the life of the channel. Answers arrive in request order; a full channel waits for one slot to become available.

See the [page and worker quick start](../README.md#quick-start) for complete setup.

```js
// A worker that may block
const value = client.ask(request, { read: answer=>answer[0] });
// A thread with an event loop to keep
const valueLater = await client.call(request, { read: answer=>answer[0] });
```

| API | Behaviour |
| --- | --- |
| `createChannel({ slots, slotBytes })` | Creates memory; slots must be a power of two. |
| `openClient(memory)` | Opens the asking side. |
| `openServer(memory)` | Opens the serving side. |
| `ask(request, options)` | Blocking request; optional timeout and in-place read callback. |
| `call(request, options)` | Asynchronous request; waits for room when full. |
| `serve(handler, options)` | Answers pending requests; blocks for work if needed. |
| `serveAsync(handler, options)` | Asynchronous serving. |
| `close()` | Ends the channel on both sides. |

The request and answer are read where they lie, valid only inside their synchronous callbacks. The default answer reader returns a copy; use a read callback and reusable input buffers for allocation-sensitive blocking calls. Large payloads can remain in shared memory while the request identifies their location.

Inputs are byte views or arrays of integers 0-255; invalid inputs are refused. Invalid memory layouts are refused on open.

## Closing and errors

A handler that throws or returns too many bytes fails its request with `ChannelFailed`; subsequent requests can still be served. Asking from inside an answer reader and serving from inside a handler are prohibited.

An `ask` from a thread that cannot block throws if it would have to sleep. If a request was already sent and the caller stops waiting, its answer is discarded. A timeout does not cancel work already sent.

Closing rejects subsequent calls and ends waits with `ChannelClosed`. Requests sent before close are still served and answers written before close remain available. Create a new channel when replacing a worker; do not reuse an old link as if the old endpoints were still alive.

Blocking waits use [adaptive spin](bell.md#adaptive-spin) unless an explicit spin is supplied.
