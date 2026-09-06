# `src/broker/` — the capability broker

**What lives here.** Manifest parsing, the grant model, per-origin enforcement, grant prompts,
per-app `session` partitions, and the handle tables. **This is the product** — everything else
in the repository exists so that this can be reached from a web page
([`ADR-0002`](../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**What it depends on.** [`src/contracts/`](../contracts/) and `electron`.

**What it must never import.** [`src/shim/`](../shim/), [`src/loader/`](../loader/), or any
renderer code. The broker is the authority; importing one of its consumers inverts the trust
direction and makes the boundary meaningless.

**Owner stream.** `broker` — build step 2, and the critical path.

**Settle the origin definition here.** It keys storage, session partitions, grants and derived
identity keys. Changing it after the first grant is persisted orphans every app's data
([`ADR-0003`](../../docs/decisions/ADR-0003-local-first-storage.md)).

**The three threats most likely to be got wrong** ([`security-model.md`](../../docs/architecture/security-model.md)):
T1/T10 path traversal, T3 origin spoofing via `senderFrame`, and **T12 DNS rebinding** — the
subtlest, because a correct glob matcher fed a *hostname* is still completely defeated by it.
Patterns are checked against **resolved addresses**, always.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**[`port-pump.ts`](port-pump.ts) is the read half only.** It relays bytes from an already-real
WHATWG `ReadableStream` (`Duplex.toWeb`, [`ipc.ts`](ipc.ts)'s `dialOne`) to the renderer over a
socket's dedicated `MessagePortMain`, and is deliberately pure and Electron-free — the same reason
`policy/` is — so it runs under plain Node/vitest with no `MessagePortMain` at all; `ipc.ts` is
where a real port's `postMessage`/`on('message')` get wired to `send`/`handleCredit`.

*The write half (an app writing bytes out) is deliberately not here.* There is no wire message for
it anywhere in `contracts/ipc.ts` — `handle-contracts.md`'s Backpressure section only specifies the
read side in detail, and `capability-api.md`'s Throughput section and ADR-0008 both stop at the
same point. Inventing one here would be a contracts decision made from inside a broker-owned PR;
it is filed as an open question instead of decided silently.

*Credit is bounded by the window, never trusted as reported.* `handleCredit` clamps the running
budget to `initialCredit` — `contracts/ipc.ts` specifies "the broker sends at most
`LIMITS.readWindowBytes` ahead of what has been acknowledged", and credit is a remaining-budget
counter, so `sent - acknowledged <= window` is the same statement as `credit <= initialCredit`.
This file once trusted the renderer's reported figure outright, on the reasoning that an
over-reporting renderer only inflates its own queue in its own process — wrong in one direction: a
`CreditMessage` carrying `Infinity` made `credit > 0` permanently true, so the pump never stopped
reading the OS socket, defeating the backpressure (and the TCP backpressure to the remote peer)
that is the whole point. Non-finite and negative figures are rejected rather than applied for the
same reason: `NaN` poisons the counter permanently, and a negative value drives it below zero with
no way back.
