# `src/main/storage/`: small files the shell keeps on disk

**What lives here.** `debounced-writer.ts`: the timing every small persisted file needs and none
should reimplement. `schedule()` says a change is waiting, a burst becomes one write, at most one
write runs at a time, and `flush()` resolves only once the file reflects every change made so far.
Each store supplies the write itself (what to serialise, where). `DebouncedWriter.flushAll()` is what
quitting waits on.

**What it depends on.** Nothing: no `electron`, no `node:` module. It is unit-tested under plain
vitest.

**What it must never import.** `electron`, or any store. The stores depend on it, never the reverse.

**Owner stream.** `shell`. Maintenance only.

## Design notes

**A change that arrives while a write runs is written after it, not beside it.** Two writes in
flight can land in either order, so the one that started from staler state could finish last and win.
The running write is left alone, `rerunRequested` is set, and its completion starts one more pass that
reads the state fresh. `flush()` therefore waits for that pass, and for a debounce timer still
running behind the write, before it resolves.

**A failed write rejects `flush()` and is otherwise the store's to report.** The writer swallows
nothing that a caller waiting on `flush()` needs to hear, and prints nothing itself. It does not give
the change up: it writes again after 1, 5 and 30 seconds (`RETRY_DELAYS_MS`), and a `flush()` that
finds the last write failed, the quit's included, makes one more attempt at once. A file held for a
moment by a virus scanner or a sync client is then written once it is let go.
