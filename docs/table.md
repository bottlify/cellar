# Table - numbers one thread stores, any thread reads; slots any thread claims

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

## Slots

`createTableMemory({ rows, columns, slots: true })` makes a table of slots: rows any thread claims and releases, such as a table of handles to objects shared across threads. Its columns are `type` and `owner`, then `columns`.

```js
const memory = createTableMemory({ rows: 4096, columns: ['object'], slots: true });
const handles = openTable(memory);                 // on any thread
const handle = handles.claim(EVENT, processId);    // -1 where every row is held
const row = handles.slot(handle);                  // -1 once released: a stale handle
handles.set(row, 2, objectId);
handles.release(handle);
handles.releaseOwner(processId);                   // a process's end: how many released
```

- `claim(type, owner)` takes a free row, writes its `type` and `owner` and zeros in the rest, and answers a handle; `slot(handle)` the row a handle holds, or -1; `release(handle)` true where it released it; `owned(owner)` the handles an owner holds; `releaseOwner(owner)` releases them. `used()` is the rows held, `written()` the claims ever made, `all()` the rows held. `use` and `advance` throw on a table of slots, `claim` and the rest on a table without.
- **A handle names a row and a generation**: `generation * rows + row`, never 0. Each row has a word of its own, its generation and its state (free, being claimed, held), changed only by `Atomics.compareExchange`: a claim moves a free row to being claimed under the next generation, writes its cells, then stores it held; a release moves it from held under the handle's generation back to free. A handle kept past its release is refused once the row is claimed again (ABA), until the row's generation comes round again after 2^29 - 1 claims. Rows are at most 2^24, so a handle is exact in a double.
- **No lock.** A claim starts looking at the row after the last claim's (`written()`), so a row freed is not the next one taken, and passes over rows another thread holds or is claiming. A table with no free row answers -1 after one look at each.
- **The holder writes its row.** While a thread holds a row it is the row's one writer, under the rules above for every cell. Another thread reads it as any reader does; a read made between two answers of `slot(handle)` that agree is of the row that handle held. `owned` reads a row's `owner` between two looks at the same held word, so it never names a row held by another owner's later claim; a row released between `owned` and `release` is not released twice.

[`src/table.itest.js`](../src/table.itest.js) has four threads claim and release rows of a table too small for all of them, each stamping and checking the rows it holds and checking that every handle it released stays refused, and then releases one owner's rows from the main thread.

## What a reader sees

- **One writer.** A table is written by one thread; `add` reads a cell before it stores it, so two writers lose counts.
- **One kind of cell: a 64-bit integer.** A cell is a `BigInt64Array` element, exact within 2^53 either way of zero. A value set or added is rounded to the nearest integer; one that is not finite, or that would pass 2^53 either way, throws and nothing is stored. A figure with a fraction goes in an integer unit its column's name says - a time in nanoseconds (`gpuNs`), a share in parts per million (`hitPpm`) - and the reader converts it.
- **Each cell whole, by the standard.** The writer stores and adds through `Atomics`, and a reader loads through `Atomics`: an atomic access of a `BigInt64Array` element is no-tear (ECMA-262, the memory model's `IsNoTearConfiguration`), where a plain one is not, so a reader sees the old value or the new. A cell kept as two 32-bit words and read high, low, high is not whole: a writer that stores twice between the reader's looks and leaves the high word as it was (-1, 5, -3; or 1, 2^32 + 2, 3) hands it a value no write made, and a version kept in a finite word only makes that rarer.
- **What it costs.** Node 22.23.5, 4 cores, load average about 8 (a test run beside it), 20 M operations, 7 runs an arm in each of two processes an arm, alternated, the median of each: an `add` 22.5 and 22.3 ns (the two-word cell it replaced 2.5 and 2.4); two adds to an 8-row table, as a writer that counts bytes and writes does, 53.3 and 54.4 ns (two-word 4.1 and 3.8); reading a 512 x 10 table with `all()` 140 and 140 µs (two-word 237 and 223). A table is written where something happens a few thousand times a second - a scheduler's quantum, a frame - not in a loop over guest instructions.
- **A row is not read whole.** A reader that looks while the writer fills a row may take some cells new and some old. `advance()` counts its row before the writer fills it, so a reader may see a newly taken ring row still holding the values of the lap before.
- **Published counts.** `use` and `advance` store their counts with `Atomics.store`, and a reader loads them with `Atomics.load`. The writer's plain stores before a count's store happen before a reader's reads after it loaded that count (ECMA-262, the memory model's happens-before through a synchronizes-with of the two `Atomics` accesses), so rows filled before a count was published are seen filled by a reader that read that count.

[`src/table.test.js`](../src/table.test.js) holds these with readers on other threads: two readers watch one cell stored two million times with values whose both words change, one watches a counter that carries every other add, a read made between a writer's two stores is one of them, and a reader checks every row it was told about by `use`.
