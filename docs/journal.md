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

Measured on ARM64, 2026-11-26: Apple M4 Pro (8 performance and 4 efficiency cores), macOS 27.2.1, on AC power, with Node 24.10.0 (V8 13.6) and Chrome 158.0.8127.38. The test was a seqlock litmus of the bracket alone: one writer and two readers over a block of 16 words, 8 s an arm. A copy counts as torn when the reader kept it after reading the same even sequence on both sides, yet the copy mixes two writes. There were two Chrome runs. The second ran with Chrome's background throttling off; its page was never hidden and no timer ran more than 2 ms late.

| Arm | Node torn / kept | Chrome, run 1 | Chrome, run 2 |
| --- | --- | --- | --- |
| No atomics at all (control) | 69,678,850 / 352,641,024 | 132,765,770 / 478,683,136 | 127,367,301 / 485,617,664 |
| Atomic sequence, no bracket | 227 / 895,560 | 4 / 1,027,622 | 26,144 / 34,520,854 |
| Bracket on the writer only | 0 / 725,107 | 0 / 4,924,137 | 5,283 / 491,118 |
| Bracket on the reader only | 0 / 167,675 | 0 / 3,557,425 | 0 / 5,483,084 |
| Bracket on both sides (the contract) | 0 / 131,673 | 0 / 1,041,778 | 0 / 100,993 |
| Every word atomic | 0 / 14,026 | 0 / 132,190 | 0 / 10,977 |

Without the bracket, plain copies tear on this processor. With it on both sides, none did. The bracket on the writer alone does not hold. The torn copies hold words newer than the sequence the reader checked: the reader's plain loads were satisfied after its second load of the sequence. The reader's side is what closes that, and it gave 0 in 5,483,084 copies, where the unbracketed rate predicts about 4,150. The writer's side guards the store order the reader relies on. It is kept although these runs did not need it. On x86 every arm gave 0, so x86 cannot tell the arms apart.

The journal itself, under the gate below, on CI's runners with Node 22, 2026-11-26 (one run each, 3 s a mutant, one writer and two readers):

| Journal | macOS ARM64 (`macos-latest`) torn / read | Linux ARM64 (`ubuntu-24.04-arm`) torn / read |
| --- | --- | --- |
| as it is | 0 | 0 |
| no bracket | 3,303 / 17,378,006 | 184,957 / 1,723,701 |
| no reader's side | 0 / 16,653,583 | 0 / 8,084,708 |
| no writer's side | 0 / 12,753,600 | 233 / 114,205 |

The journal tears without its bracket on both machines. Which side alone a machine needs differs: the Linux runner needed the writer's, the Chrome copy on the M4 Pro the reader's. So the contract is both sides.

The contract is held by a gate, not by these tables. [`src/ordering.itest.js`](../src/ordering.itest.js) races the journal's writer against two readers, and fails on any torn record it is handed. It then runs a control with no atomics and a copy with no bracket. A machine that tears neither cannot show that the bracket is what holds the journal, and there the second test says "not measured". [`scripts/ordering-mutants.mjs`](../scripts/ordering-mutants.mjs) (`npm run test:ordering`) takes the bracket out of the journal: both sides, and each side alone. It requires the first test to fail without the bracket and reports each side alone, which machines answer differently. CI runs both on ARM64 (Linux and macOS) with `CELLAR_EXPECT_REORDERING=1`, where "not measured" fails the job.

See the source comments in [`src/journal.js`](../src/journal.js) and the [benchmark notes](benchmarks.md#journal).
