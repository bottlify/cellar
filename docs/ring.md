# Ring - one-way byte records

[Home](../README.md) · [Bell](bell.md) · [Journal](journal.md) · [Benchmarks](benchmarks.md)

A bounded SPSC ring with one writer and one reader. Each record is contiguous; a wrap marker lets a record start again at the beginning of the ring. Unread records are not overwritten.

## Page and worker

```js
// page.js
import { createDoorbell, createRingMemory, openRing } from '@bottlify/cellar';
const memory = createRingMemory(1 << 16, createDoorbell());
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ memory });
const ring = openRing(memory);
const record = new Uint8Array(8);
const fields = new DataView(record.buffer);
addEventListener('pointermove', event=>{
    fields.setInt32(0, event.clientX, true);
    fields.setInt32(4, event.clientY, true);
    ring.write(record); // false when full; this example drops that event
});
```

```js
// worker.js
import { openDoorbell, openRing } from '@bottlify/cellar';
self.onmessage = ({ data })=>{
    const ring = openRing(data.memory);
    const doorbell = openDoorbell(data.memory.bell);
    for (;;)
    {
        const seen = doorbell.seen();
        const closed = ring.closed();
        ring.drain(record=>{
            const fields = new DataView(record.buffer, record.byteOffset, record.length);
            console.log(fields.getInt32(0, true), fields.getInt32(4, true));
        });
        if (closed) break;
        doorbell.wait(seen);
    }
};
```

The example illustrates the protocol, not a logging benchmark. Close the ring when the application finishes.

## Write directly into shared memory

```js
// recorder.worker.js - ring and commands already supplied by the application
const words = new DataView(ring.bytes.buffer);
const at = ring.reserveWaiting(commands.length * 8);
let end = at;
for (const command of commands)
{
    words.setUint32(end, command.op, true);
    words.setUint32(end + 4, command.argument, true);
    end += 8;
}
ring.commit(end - at);
```

The batch must fit the ring's maximum record size. `reserve(length)` returns an offset or -1 if there is no room. `reserveWaiting` and `reserveWaitingAsync` wait for room; handle timeout before writing if a deadline is supplied. Only one reservation is active per writer. `commit(length)` may publish fewer bytes than reserved; `abandon()` cancels the reservation. Do not access reserved space after committing or abandoning it. `write()` performs the same operation with an intermediate copy.

## Reading and backpressure

- `write(record)` returns false when full. `writeWaiting` blocks; `writeWaitingAsync` is suitable for the page.
- `peek()` returns the next record's view, or null. `release()` returns that record's space. The view is valid only until release.
- `drain(take, most)` reads up to `most` records. Do not invoke `drain`, `peek` or `release` on this ring inside `take`. An illegal release can consume the current record and cause the outer drain to throw rather than free the next one.
- If a bounded drain leaves records (`held()` is nonzero), continue draining before waiting on the doorbell. A previously published record may not ring again.
- Inputs must be byte views or arrays of integers 0-255; invalid inputs and invalid ring memory layouts are refused.

## Close and wake protocol

Either side may close the ring. A writer waiting for space or writing after close receives `RingClosed`. The reader is rung so it can finish draining published records.

Read the doorbell generation **before** looking for work, and read the closed flag **before** draining. Exit after a drain that followed a close. Looking at the closed flag only after draining can miss a record published just before close. See [Bell](bell.md#doorbell).
