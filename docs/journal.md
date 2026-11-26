# Journal - one writer, many readers

[Home](../README.md) · [Ring](ring.md) · [Benchmarks](benchmarks.md)

A bounded journal for logs, traces and frame measurements. The writer does not wait for readers: old records are overwritten. Each reader follows its own sequence. Missing records are normal, unlike a Ring where unread records must be preserved.

## Example

```js
// engine.worker.js
import { createJournalMemory, openJournal } from '@bottlify/cellar';
const memory = createJournalMemory({ records: 4096, bytes: 1 << 20 });
postMessage({ journal: memory });
const journal = openJournal(memory);
function note(level, value){
    const record = journal.draft(16);
    record.setUint32(0, level, true);
    record.setFloat64(8, value, true);
    return journal.commit();
}
```

```js
// page.js - worker already created by the application
import { openJournal } from '@bottlify/cellar';
worker.onmessage = ({ data })=>{
    const journal = openJournal(data.journal);
    let next = journal.oldest();
    setInterval(()=>{
        for (const end = journal.written(); next !== end; next = (next + 1) >>> 0)
        {
            const value = journal.read(next, record=>record.getFloat64(8, true));
            if (value !== undefined) console.log(value);
        }
    }, 250);
};
```

## Record lifetime

`draft(length)` gives the writer a private DataView to fill; `commit()` copies the chosen bytes into the journal and returns the sequence. `read(sequence, take)` copies into a reader's private scratch memory, validates the copy and calls `take(view, length)` only with a complete record. It returns undefined if the record is absent, not yet committed or overwritten before the copy completes.

Do not retain the scratch view beyond the callback. The next read reuses it; a nested read gets a view of its own. A longer record can require a larger scratch allocation, invalidating an older view. Normal writes and reads reuse scratch storage.

`oldest()` and `written()` bound candidate sequences; bytes may be overwritten before a reader reaches them. Counts use unsigned 32-bit wrapping arithmetic, including after 2^32 records. The `first` memory option starts the sequence at a specified value. `shared: false` uses an ArrayBuffer for readers on the writer's own thread.

## Memory ordering

**Portability contract:** as of 0.12.2, shared Journal copies use plain memory operations bracketed by a sequentially consistent atomic store/load pair on each side. The writer publishes its byte head and loads it back before copying; the reader stores its own word after copying and loads the head to validate the copy.

The guarantee depends on the barriers emitted by JavaScript engines for these atomic pairs on x86 and ARM64. It is not a formal guarantee derived solely from the ECMAScript memory model for racing plain accesses. This limitation matters when targeting a new engine or architecture. Do not treat Journal as lossless storage or claim universal formal memory-model safety.

See the source comments in [`src/journal.js`](../src/journal.js) and the [benchmark notes](benchmarks.md#journal).
