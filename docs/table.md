# Table - numbers one thread stores, any thread reads

[Home](../README.md) · [Journal](journal.md) · [Ring](ring.md)

A table is rows of float64 columns in shared memory. One thread stores numbers where they change - counters, a row per worker, a ring of the last frames - and any thread reads them whenever it likes, without asking the writer. Column names are fixed when the memory is made and travel with it. A string belongs elsewhere (a dictionary, a journal record); the table holds its id.

## Example

```js
// engine.worker.js
import { createTableMemory, openTable } from '@bottlify/cellar';
const memory = createTableMemory({ rows: 1, columns: ['frames', 'draws'] });
postMessage({ counters: memory });
const counters = openTable(memory);
counters.use(1);
function frameShown(draws){
    counters.add(0, 0, 1);
    counters.set(0, 1, draws);
}
```

```js
// page.js - worker already created by the application
import { openTable } from '@bottlify/cellar';
worker.onmessage = ({ data })=>{
    const counters = openTable(data.counters);
    setInterval(()=>console.log(counters.row(0)), 1000); // { frames, draws }
};
```

## API

`createTableMemory({ rows, columns })` makes the memory: `{ buffer, rows, columns }`, a `SharedArrayBuffer` and a copy of the names; post it as it is. `openTable(memory)` opens it on any thread.

- Writing: `set(row, column, value)`, `add(row, column, amount)`, or the cells directly through `values` (a `Float64Array`, `rows * width`, row-major). `use(count)` publishes how many rows carry something. `advance()` takes the next row of a ring and returns its index; until the ring is full it also counts the row as in use.
- Reading: `used()`, `written()` (rows ever taken by `advance`, an unsigned 32-bit count), `row(index)` as an object by column name, `all()` the rows in use, oldest first once a ring has lapped.

The table does not grow: its shape is fixed when it is made.

## What a reader sees

- **One writer.** A table is written by one thread; `add` reads a cell before it stores it, so two writers lose counts.
- **Each cell whole.** A cell is a plain float64 store, as cheap as any typed-array store, and large counts stay exact up to 2^53. A reader sees a value the writer stored, never half of one: an aligned eight-byte access is a single instruction on x86-64 and ARM64, which is how engines compile it. The ECMAScript memory model promises tear-free racing accesses only for integer arrays, so this rests on the engines, as the [Journal's ordering](journal.md#memory-ordering) does.
- **A row is not read whole.** A reader that looks while the writer fills a row may take some cells new and some old. `advance()` counts its row before the writer fills it, so a reader may see a newly taken ring row still holding the values of the lap before.
- **Published counts.** `use` and `advance` store their counts atomically. Rows the writer filled before it published a count are seen filled by a reader that read that count (a store-release and load-acquire on ARM64, ordered on x86).

[`src/table.test.js`](../src/table.test.js) holds these with readers on other threads: two readers watch one cell stored two million times with values whose both halves change, and a reader checks every row it was told about by `use`.
