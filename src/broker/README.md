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
[`code-guidelines.md`](../../docs/development/code-guidelines.md)'s destination test — kept here
rather than in the file so the 25-line comment budget measures a file's traps, not its history.

### `port-sink.ts` — the write-side byte pump

Runs the credit-window relay backwards from `port-pump.ts`'s read side: the BROKER grants the
RENDERER a byte window to post outbound bytes into, because a `MessagePortMain` has no
`pause()`/drain of its own (`electron.d.ts`'s `MessagePortMain` has exactly `postMessage`,
`start`, `close`, `on('message')`, `on('close')`) — so nothing at the transport layer stops a
hostile renderer posting faster than the OS socket drains (T11b).

**No sequence number, no pending-write queue.** A `WritableStreamDefaultWriter` serialises its
own sink calls — `write()` is never re-entered before the previous call settles — so tracking one
scalar `unacked` count and one scalar `pendingCount` is sufficient; there is nothing to reorder.
See `contracts/ipc.ts`'s own header for why write-end/write-abort travel on this port rather than
over `CONTROL_CHANNEL`.

**Acks are flushed either once `CREDIT_COALESCE_BYTES` has accepted, or once nothing else is
outstanding** (`pendingCount === 0`) — so a lone slow write is never held hostage by coalescing,
and a burst of same-tick writes naturally merges into one ack, the same way a burst of same-tick
reads merges into one credit consumption on the read side.

**The heartbeat (`WRITE_HEARTBEAT_MS`) exists** because `contracts/ipc.ts`'s rule 2 — every
reply-carrying message needs a timeout, because this transport fails by silence — cannot be a
flat deadline here: a choked BitTorrent peer legitimately stalls a write for real, sometimes for
minutes. A zero-byte `WriteAckMessage` lets the renderer's own silence timer distinguish "the peer
is just slow" from "the transport died" without either side inventing a new message kind.

**`writer.close()` is never awaited** (the source keeps this as a trap next to the call itself,
not only here). Measured directly against `Duplex.toWeb` (Node 24.11.1): its `close()` promise
does not settle until the whole duplex is destroyed — after the readable side also ends — not
when the FIN this call sends is itself flushed. Awaiting it would deadlock any peer that
(correctly, per half-close) keeps reading after our FIN and waits for our reply before sending
its own.

### `socket-relay.ts` — wiring one socket's pump and sink to its port

Split out of `ipc.ts`'s `net.connect` case so that file keeps only what is security-relevant: the
transport check, the origin re-derivation, and the port delivery. This file owns none of that; it
is handed an already-delivered `PortLike` and just wires it to a pump and a sink.

**Registration lives here too, not split back out to the caller**, because registering and
releasing a socket are one lifecycle, not two: whichever path ends the socket — a clean close, a
revoke, a write-window violation the sink itself detects, the renderer's own port closing — must
free the SAME registry slot, and keeping both ends in one file is what makes that easy to see.

### `port-messages.ts` — validating messages on a socket's port

Split out of `ipc.ts`'s inline credit-message check once a second and third message kind joined
it — one job (shape validation at this trust boundary), the same way `ipc-validation.ts` owns it
for `CONTROL_CHANNEL`.
