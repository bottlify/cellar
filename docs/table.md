# Table - numbers one thread stores, any thread reads

[Home](../README.md) · [Journal](journal.md) · [Ring](ring.md)

A table is rows of integer columns in shared memory. One thread stores numbers where they change - counters, a row per worker, a ring of the last frames - and any thread reads them whenever it likes, without asking the writer. Column names are fixed when the memory is made and travel with it. A string belongs elsewhere (a dictionary, a journal record); the table holds its id.

## Example

```js
// engine.worker.js
import { createTableMemory, openTable } from '@bottlify/cellar';
const memory = createTableMemory({ rows: 1, columns: ['frames', 'gpuNs'] });
postMessage({ counters: memory });
const counters = openTable(memory);
counters.use(1);
function frameShown(gpuMs){
    counters.add(0, 0, 1);
    counters.add(0, 1, gpuMs * 1e6);      // a time in an integer unit: nanoseconds
}
```

```js
// page.js - worker already created by the application
import { openTable } from '@bottlify/cellar';
worker.onmessage = ({ data })=>{
    const counters = openTable(data.counters);
    setInterval(()=>console.log(counters.row(0)), 1000); // { frames, gpuNs }
};
```

## API

`createTableMemory({ rows, columns })` makes the memory: `{ buffer, rows, columns }`, a `SharedArrayBuffer` and a copy of the names; post it as it is. `openTable(memory)` opens it on any thread.

- Writing: `set(row, column, value)` and `add(row, column, amount)`. `use(count)` publishes how many rows carry something. `advance()` takes the next row of a ring and returns its index; until the ring is full it also counts the row as in use.
- Reading: `get(row, column)`, `used()`, `written()` (rows ever taken by `advance`, an unsigned 32-bit count), `row(index)` as an object by column name, `all()` the rows in use, oldest first once a ring has lapped.

The table does not grow: its shape is fixed when it is made.

## What a reader sees

- **One writer.** A table is written by one thread; `add` reads a cell before it stores it, so two writers lose counts.
- **One kind of cell: an integer in two 32-bit words.** A cell is a low and a high `Uint32` word, two's complement, exact within 2^53 either way of zero. A value set or added is rounded to the nearest integer, and one that is not finite throws. A figure with a fraction goes in an integer unit its column's name says - a time in nanoseconds (`gpuNs`), a share in parts per million (`hitPpm`) - and the reader converts it.
- **Each cell whole, by the standard.** The writer stores with plain stores. An `add` that does not carry is one store of the low word, and a racing non-atomic read of an aligned `Uint32Array` element is no-tear (ECMA-262, the memory model's `IsNoTearConfiguration`), so a reader sees the old value or the new. A write that changes the high word marks it busy (a high word no value within 2^53 has), then stores the low word and the high one, each through `Atomics`. A reader loads high, low, high and reads again while the two highs differ or the high is busy; a cell whose words do not agree for a second is one its writer left half-written, and `get` throws rather than read it. A carry comes once in 2^32 of a count; a time in nanoseconds carries every 4.3 s of it.
- **What it costs.** Node 22.23 on a four-core Xeon VM at 2.1 GHz, load average about 2, 20 M operations, 7 runs an arm, arms alternated twice, the median of each pass: an `add` 2.0 and 2.1 ns (a float64 `+=` 2.6 and 2.6, `Atomics.add` on a `BigInt64Array` 14.7 and 12.3); two adds to an 8-row table, as a writer that counts bytes and writes does, 2.5 and 2.5 ns (float64 1.5 and 1.1, `BigInt64` 28.8 and 26.3); reading a 512 x 10 table with `all()` 209 and 188 µs (float64 92 and 84, `BigInt64` 147 and 136).
- **A row is not read whole.** A reader that looks while the writer fills a row may take some cells new and some old. `advance()` counts its row before the writer fills it, so a reader may see a newly taken ring row still holding the values of the lap before.
- **Published counts.** `use` and `advance` store their counts with `Atomics.store`, and a reader loads them with `Atomics.load`. The writer's plain stores before a count's store happen before a reader's reads after it loaded that count (ECMA-262, the memory model's happens-before through a synchronizes-with of the two `Atomics` accesses), so rows filled before a count was published are seen filled by a reader that read that count.

[`src/table.test.js`](../src/table.test.js) holds these with readers on other threads: two readers watch one cell stored two million times with values whose both words change, one watches a counter that carries every other add, a cell left between its words is said, and a reader checks every row it was told about by `use`.
