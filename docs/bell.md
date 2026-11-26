# Bell and Doorbell - waiting on shared words

[Home](../README.md) · [Channel](channel.md) · [Ring](ring.md)

Bell is the synchronization primitive under Channel and Ring. A waiting thread looks at a shared word, registers its wait in a separate counter, looks again, and sleeps when needed. A publishing thread changes the word and only notifies when a wait is registered. The final check closes the window between looking and sleeping.

`waitFor`, `waitForAsync`, `wake`, `publish` and `ring` can also be used over an Int32Array for a custom protocol. A closed word ends a wait with `closed` unless the watched word has moved first. `deadlineOf(timeoutMs)` makes an absolute deadline on the clock used by the wait. Without `Atomics.waitAsync`, async waits poll at approximately one millisecond. A blocking wait must not run on the browser main thread.

A registered wait is not necessarily physically asleep. A worker terminated during a registered wait leaves its count behind; subsequent moves notify unnecessarily (the project measured about 50 ns per move on x86).

## Adaptive spin

Blocking waits can learn how many times to inspect the shared word before sleeping. A wait that still has to sleep decreases the next spin budget by one eighth down to a floor. A wait that sees a move keeps twice the work it needed; one in sixteen explores the full spin budget. This reduces wasted CPU when the other thread does long work, while preserving responsiveness for short handoffs.

`createSpin`, `doorbell.spin`, `ring.roomSpin` and a Channel end's `spin` expose this mechanism. An explicit `spinMs` selects a fixed budget instead. `SPIN_MS` is approximate: the budget is counted in looks, not elapsed time; an infinite blocking wait does not read the clock. A spin may not exceed one second. Invalid times are refused.

## Doorbell

Several rings may share one Doorbell, so a thread can wait for all of them at once.

```js
// reader loop; both rings already share this doorbell
for (;;)
{
    const seen = doorbell.seen();
    ringA.drain(takeA);
    ringB.drain(takeB);
    doorbell.wait(seen);
}
```

The loop above illustrates waiting order only; a real loop also handles close, bounded drains and shutdown. Read `seen()` before checking every source. If a writer publishes after that point, the generation changes and the wait cannot miss the new work. A bounded drain with work left must not wait for a fresh notification. A page uses `waitAsync` instead of `wait`.
