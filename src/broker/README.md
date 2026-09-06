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

Rationale that explains why a file has the shape it has, moved out of source headers per
[`code-guidelines.md`](../../docs/development/code-guidelines.md)'s destination test -- kept here
rather than in the file so the 25-line comment budget measures a file's traps, not its history.

### The unlink hook -- why teardown does not wait for `closed`

`HandleTable.onUnlink` (`handles.ts`), the `unlink` field on a record
(`handle-store.ts`) and `socket.onUnlink(...)` (`socket-relay.ts`) are one
mechanism, added 2026-09-06 for `open-questions.md` A84. The rationale lives
here rather than in three source headers.

**The bug it closes.** `closeTree()` removes a handle from `handles` and
`byGrant` synchronously, then awaits `record.destroy(reason)`. For a clean
close that destroy is `socket.end(cb)` -- a HALF-close, whose callback fires
only once every queued byte has drained into the peer's receive window. A peer
that stops reading never lets that happen, so `destroy` never settled, the
handle's `closed` never settled, and everything gated on `closed` -- the pump,
the sink, the port, the `PortRegistry` slot -- stayed live. The record was
already out of both tables by then, so `revoke()` (which walks `byGrant`) and
`dropOrigin()` (which walks `handles`) could no longer find it either. There
was no remaining code path able to close that socket. Reproduced against Node
v24.11.1: ~3 MB queued, `writableLength` still over 1 MB three seconds later,
`end()`'s callback never fired.

**Why a hook rather than a shorter timeout.** `closeTree`'s own doc already
promised this ordering -- "the unlink pass and the promise rejections are
SYNCHRONOUS, before any destroy callback runs. That ordering is what makes
revocation immediate". The relay simply was not subscribed to it; it only had
`closed`. The hook finishes the design rather than adding a second one.

**Both halves, not one.** A84 named two fix shapes and the owner took both.
The hook makes teardown immediate; `destroySocket`'s `CLOSE_DRAIN_TIMEOUT_MS`
(`node-adapters.ts`) additionally guarantees the destroy itself always settles,
so `closed` and the handle count are released even in the pathological case.
Either alone leaves a real gap: without the deadline `closed` still never
settles, and without the hook the registry slot still waits on it.

**It also shuts A70's window.** `net.close`/`setNoDelay`/`setKeepAlive`
dispatch through `PortRegistry`, which has no concept of a grant, so they could
still reach a socket whose grant had just been revoked. The registry slot is
now released in the same synchronous pass that unlinks the handle, so the
lookup those three share simply stops answering. No extra check was needed.

**`code` is undefined for an app-initiated close.** Deliberate, and it matches
what `socket.closed` already did: it resolves for `'closed'` and rejects
otherwise, so the relay sent a bare `end` for a clean close and a coded one
for everything else. Passing the reason through the hook keeps the wire
identical -- only the timing changed, never the message.

### `port-pump.ts` -- the read-side byte pump

Relays bytes from an already-real WHATWG `ReadableStream` (`Duplex.toWeb`, [`ipc.ts`](ipc.ts)'s
`dialOne`) to the renderer over a socket's dedicated `MessagePortMain`. Deliberately pure and
Electron-free, the same reason `policy/` is, so it runs under plain Node/vitest with no
`MessagePortMain` at all -- `ipc.ts` (via `socket-relay.ts`) is where a real port's
`postMessage`/`on('message')` get wired to `send`/`handleCredit`. The write direction is
`port-sink.ts`, below -- this file is the read half only.

**Credit is bounded by the window, never trusted as reported.** `handleCredit` clamps the running
budget to `initialCredit` -- `contracts/ipc.ts` specifies "the broker sends at most
`LIMITS.readWindowBytes` ahead of what has been acknowledged", and credit is a remaining-budget
counter, so `sent - acknowledged <= window` is the same statement as `credit <= initialCredit`.
This file once trusted the renderer's reported figure outright, on the reasoning that an
over-reporting renderer only inflates its own queue in its own process -- wrong in one direction: a
`CreditMessage` carrying `Infinity` made `credit > 0` permanently true, so the pump never stopped
reading the OS socket, defeating the backpressure (and the TCP backpressure to the remote peer)
that is the whole point. Non-finite and negative figures are rejected rather than applied for the
same reason: `NaN` poisons the counter permanently, and a negative value drives it below zero with
no way back.

### `port-sink.ts` -- the write-side byte pump

Runs the credit-window relay backwards from `port-pump.ts`'s read side: the BROKER grants the
RENDERER a byte window to post outbound bytes into, because a `MessagePortMain` has no
`pause()`/drain of its own (`electron.d.ts`'s `MessagePortMain` has exactly `postMessage`,
`start`, `close`, `on('message')`, `on('close')`) -- so nothing at the transport layer stops a
hostile renderer posting faster than the OS socket drains (T11b).

**No sequence number, no pending-write queue.** A `WritableStreamDefaultWriter` serialises its
own sink calls -- `write()` is never re-entered before the previous call settles -- so tracking one
scalar `unacked` count and one scalar `pendingCount` is sufficient; there is nothing to reorder.
See `contracts/ipc.ts`'s own header for why write-end/write-abort travel on this port rather than
over `CONTROL_CHANNEL`.

**Acks are flushed either once `CREDIT_COALESCE_BYTES` has accepted, or once nothing else is
outstanding** (`pendingCount === 0`) -- so a lone slow write is never held hostage by coalescing,
and a burst of same-tick writes naturally merges into one ack, the same way a burst of same-tick
reads merges into one credit consumption on the read side.

**The heartbeat (`WRITE_HEARTBEAT_MS`) exists** because `contracts/ipc.ts`'s rule 2 -- every
reply-carrying message needs a timeout, because this transport fails by silence -- cannot be a
flat deadline here: a choked BitTorrent peer legitimately stalls a write for real, sometimes for
minutes. A zero-byte `WriteAckMessage` lets the renderer's own silence timer distinguish "the peer
is just slow" from "the transport died" without either side inventing a new message kind.

**`writer.close()` is never awaited** (the source keeps this as a trap next to the call itself,
not only here). Measured directly against `Duplex.toWeb` (Node 24.11.1): its `close()` promise
does not settle until the whole duplex is destroyed -- after the readable side also ends -- not
when the FIN this call sends is itself flushed. Awaiting it would deadlock any peer that
(correctly, per half-close) keeps reading after our FIN and waits for our reply before sending
its own.

### `socket-relay.ts` -- wiring one socket's pump and sink to its port

Split out of `ipc.ts`'s `net.connect` case so that file keeps only what is security-relevant: the
transport check, the origin re-derivation, and the port delivery. This file owns none of that; it
is handed an already-delivered `PortLike` and just wires it to a pump and a sink.

**Registration lives here too, not split back out to the caller**, because registering and
releasing a socket are one lifecycle, not two: whichever path ends the socket -- a clean close, a
revoke, a write-window violation the sink itself detects, the renderer's own port closing -- must
free the SAME registry slot, and keeping both ends in one file is what makes that easy to see.

### `port-messages.ts` -- validating messages on a socket's port

Split out of `ipc.ts`'s inline credit-message check once a second and third message kind joined
it -- one job (shape validation at this trust boundary), the same way `ipc-validation.ts` owns it
for `CONTROL_CHANNEL`.
