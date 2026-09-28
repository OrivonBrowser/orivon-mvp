# `src/telemetry/`: measurement and its disclosure

**What lives here.** Event collection, session accounting, sending, and the decidable part of the
two screens [`ADR-0004`](../../docs/decisions/ADR-0004-telemetry.md) makes non-optional: the
first-run disclosure and the "what has been sent" page. The screens themselves are not built yet
([`runner.ts`](runner.ts)). ADR-0004 holds the payload, the consent rule and why `activeSec` is
kept apart from `backgroundSec`; [`testing.md`](../../docs/development/testing.md) §6 says why the
accounting is a pure fold with its own tests.

**Mostly durable.** `accounting.ts`, `disclosure.ts`, `transport.ts` and `history.ts` are pure;
`runner.ts` wires them to Electron, and `store.ts` to disk.

**What it depends on.** [`src/contracts/`](../contracts/), and type-only
[`src/main/registry.ts`](../main/registry.ts) for the `Subsystem` that `runner.ts` exports.

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `telemetry`, build step 8.

## Design notes

**`accounting.ts`'s `applyEvent` runs one event at a time in [`runner.ts`](runner.ts)**, which
persists `AccountingState` periodically, so a crash loses minutes, not a session. The
`'checkpoint'` event gives it that moment during a silent stretch, such as hours of background
seeding with no focus change.

**[`store.ts`](store.ts) does not debounce, unlike `BookmarkStore`.** Accounting state changes
with time, not with clicks, so a debounce would mean a write after every event. Accounting and
history are written at `checkpoint()`; country and consent, discrete decisions a crash must not
lose, are written at once.

**[`transport.ts`](transport.ts) sends one aggregate payload per period, never one per event**:
`attemptSend` only ever sees a `TelemetryPayload`, never a `TelemetryEvent`. **`MAX_QUEUE_SIZE` is
1** because ADR-0004 forbids a backlog that reconstructs the timeline; the cost is that a device
offline across a month boundary loses the older period.
