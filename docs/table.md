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
- **One kind of cell: a signed 64-bit integer.** Cells are a `BigInt64Array` stored, added to and read through `Atomics`, so a reader sees each cell whole because the ECMAScript memory model says so. A value set or added is rounded to the nearest integer, and one that is not finite throws. A figure with a fraction goes in an integer unit its column's name says - a time in nanoseconds (`gpuNs`), a share in parts per million (`hitPpm`) - and the reader converts it. Values are read as numbers, exact up to 2^53.
- **The price of `Atomics`.** An `add` costs about 15 ns where a plain float64 `+=` cost 3 ns (Node 22.23, a 4-core Xeon VM at 2.1 GHz under load, 20 M adds of one cell, 7 runs an arm alternated twice, medians 14.4-15.4 against 2.7-3.0 ns); reading a 512 x 10 table with `all()` took about 150 µs against 95-115 µs. A counter is added to where it changes, not in an inner loop.
- **A row is not read whole.** A reader that looks while the writer fills a row may take some cells new and some old. `advance()` counts its row before the writer fills it, so a reader may see a newly taken ring row still holding the values of the lap before.
- **Published counts.** `use` and `advance` store their counts atomically. Rows the writer filled before it published a count are seen filled by a reader that read that count (a store-release and load-acquire on ARM64, ordered on x86).

[`src/table.test.js`](../src/table.test.js) holds these with readers on other threads: two readers watch one cell stored two million times with values whose both halves change, and a reader checks every row it was told about by `use`.
