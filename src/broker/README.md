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

## The layout

Five directories, one per job. The name of the directory is the question it answers.

| Directory | Job | Holds state? | Touches I/O? |
|---|---|---|---|
| [`policy/`](policy/) | **Decide** — may this origin do this? | no, pure functions | **never** |
| [`grants/`](grants/) | **Remember** — what did the user approve? | yes, per origin | disk, for persistence |
| [`handles/`](handles/) | **Hold** — what is this origin holding, and can I take it back? | yes, per origin | **never**, `destroy` is injected |
| [`adapters/`](adapters/) | **Do** — dial the address, open the file | no | **this is the only place** |
| [`transport/`](transport/) | **Speak** — reach the page, move the bytes | connection registry | Electron IPC and ports |

Three files stay at the top level because they belong to no single directory:

- [`index.ts`](index.ts) — `createBroker` and the capability entry points that consult all five
- [`broker-contracts.ts`](broker-contracts.ts) — the `Broker` interface and its fixed dependency shape
- [`errors.ts`](errors.ts) — `OrivonError` construction, used by every directory above
- [`io-errors.ts`](io-errors.ts) — the other half of that: translating a raw errno from an
  injected dependency into the closed enum. Split out of `index.ts` on 2026-09-07 when
  `udpBind` pushed it past 500 lines. A fourth top-level file where
  [`ADR-0015`](../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md) records three —
  same test as the other three: it belongs to no single directory. Kept apart from `errors.ts`
  because that file *constructs* and this one *translates*, and because merging them would
  quietly settle [`A39`](../../docs/open-questions.md), which is a behavioural question nobody
  has answered yet
- [`net-capability.ts`](net-capability.ts) — `orivon.net`'s three entry points (`connect`,
  `udpBind`, `listen`), lifted out of `index.ts` on 2026-09-09 when `net.listen` pushed it past
  500 lines — this file's own design note below says why it stayed at the top level rather than
  moving into a directory of its own
- [`id-capability.ts`](id-capability.ts) — `orivon.id`'s two entry points (`publicKey`, `sign` —
  the APP KEYS half of "two kinds of identity"; `requestIdentity`, the NAMED IDENTITIES half,
  has no `Broker` entry point yet, see the file's own header), built alongside
  `net-capability.ts` from the start rather than inlined into `index.ts` first, same reason:
  `index.ts` was already 264 lines before `id`
- [`fs-capability.ts`](fs-capability.ts) — `orivon.fs`'s eight entry points (`readFile`,
  `writeFile`, `confineSync` plus queue item 2.1's `mkdir`/`readdir`/`stat`/`rm`/`rename`),
  lifted out of `index.ts` on 2026-09-10 under the same Rule 2 seam `net-capability.ts` and
  `id-capability.ts` already established — every method routes through this file's own
  `confineForOrigin`, the one call into `policy/paths.ts`'s `confinePath`. `orivon.fs.open`
  (`FileHandle`) is deliberately not here — parked, see that lane's own PR body

The decomposition and the import boundaries are recorded in
[`ADR-0015`](../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md), including the two
alternatives that lost and the one file that makes the "I/O lives in `adapters/`" row need a
footnote. **Those boundaries are prose, enforced by nothing** — that gap is
[`A85`](../../docs/open-questions.md), deliberately left open rather than closed with a guard
written the same hour as the rule.

**Tests live in a `tests/` folder inside the directory they cover**, so what you scroll past when
reading a directory is that directory's code.

**Reading order, cold:** [`src/contracts/`](../contracts/) first (it is the product, and it is
types only), then [`policy/connect.ts`](policy/connect.ts)'s header for how security is reasoned
about here, then [`index.ts`](index.ts)'s `connect()` for one call end to end.


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

**The hook fires for every reason, but the relay acts on only some of them, and
this is not a detail.** The first version of this fix tore down unconditionally,
and it lost data. `stop()` cancels the read stream, and cancelling the readable
half of a `Duplex.toWeb` DESTROYS the whole socket -- dropping everything still
in its write queue. Measured against a real paused peer: 8 MiB queued, 8 MiB
lost, where the unmodified path delivered all of it. So:

- `'closed'` and `'sessionEnded'` FLUSH (`destroySocket` calls `socket.end()`).
  The relay must not touch the socket at unlink; these settle through `closed`,
  which the drain deadline now guarantees always happens. Later than unlink, but
  the app's final bytes actually arrive.
- `'revoked'`, `'aborted'` and `'failed'` DESTROY the socket regardless
  (`resetAndDestroy()`/`destroy()`). Nothing to preserve, so immediate teardown
  is correct and is the entire point of the fix.

The listener therefore receives the `CloseReason`, not only the error code --
because the code cannot tell these apart: `'sessionEnded'` and `'revoked'` both
carry code `'revoked'` and sit on opposite sides of the branch. Both cases are
pinned by tests (`socket-relay.test.ts`, and the real-socket truncation pair in
`socket-drain.test.ts`) so the branch cannot be simplified away silently.

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
### `transport/datagram-relay.ts` -- why its unlink teardown is NOT conditional

`socket-relay.ts` branches on the close reason at unlink, and the section above explains at length
why that branch is load-bearing: `stop()` cancels the read stream, cancelling the readable half of
a `Duplex.toWeb` destroys the socket, and destroying it drops everything still in its write queue
(8 MiB queued, 8 MiB lost, measured). So a flushing reason must be left to settle through `closed`.

`datagram-relay.ts` tears down on **every** reason, and the asymmetry is deliberate rather than an
oversight in either file. A UDP socket has no write queue to lose: `send` hands a datagram to the
OS or refuses it, and nothing is ever buffered for later delivery. There is therefore nothing a
teardown here can truncate, and waiting would only hold the registry slot and the port open longer
than the grant that authorised them.

Anyone tempted to "fix" the inconsistency in either direction should read this paragraph and the
one above it as a pair. Both branches are pinned by tests (`datagram-relay.test.ts` asserts
teardown for all five reasons; `socket-relay.test.ts` and `adapters/tests/socket-drain.test.ts`
assert the opposite for TCP), so neither can be simplified away silently.

### `policy/reserved-ports.ts` -- what a blanket grant does not reach

Owner decision, 2026-09-06 (`open-questions.md` A82). A grant of `*:*` is
legitimate -- the flagship declares one, because DHT and peer exchange reach
arbitrary hosts -- but it made every granted origin a general outbound traffic
generator from the user's own IP address, on any port. The ports with a real
abuse history and no legitimate use from a page's network grant are excluded
from any BLANKET grant, and reachable only when a pattern names the exact port.

**A range is not a naming.** `20-30` covers port 25 without anyone having read
the number, so it is treated as the blanket `*` is. Requiring `lo === hi ===
port` means a reserved port is reachable only when an app author typed it and a
person approved that exact line -- which is the property that makes it worth
showing in a prompt at all.

**The host half is deliberately not consulted.** `namesPortExactly` answers
"did anyone name this port", nothing more; `hostMatches` still runs unchanged
afterwards. Folding the two together would let a pattern naming `:25` for one
host quietly open `:25` everywhere.

**Checked after parsing, before resolving.** Before, so a reserved port never
becomes a name-existence oracle -- the same discipline `couldAnyPatternMatch`
already follows. After, because the answer depends on what the patterns say.

**Not a substitute for the address rules, and narrower than it looks.**
`policy/address.ts` already denies every private, loopback, link-local and
metadata address outright, so the remote-access ports in the set only matter
against a PUBLIC host. The owner chose the wider set knowing that.

**Scope: `tcp.connect` only.** `udp.send` shares the pattern grammar and would
want the same rule, but it has no implementation yet -- wiring it is part of
whoever builds `udp.send`, not of this.
### The socket allowance -- a declared number, not a hidden one

Owner decision, 2026-09-06 (`open-questions.md` A80). An origin's simultaneous-
socket budget used to be `LIMITS.concurrentSockets` (512) for everyone, declared
by nobody and shown to nobody -- while being the largest resource commitment in
the system, because every open socket pins a read and a write credit window
(~640 MiB at the ceiling).

It is now the app's own `net.concurrentSockets`, clamped to the ceiling, with
`LIMITS.defaultConcurrentSockets` (64) for an app that declares nothing. The
point of the modest default is that it is the *forcing function*: an ordinary
app never reaches 64, so anything that genuinely needs the ceiling must declare
a number -- and that number is then one a person saw at grant time.

**It follows `fs.quotaBytes` exactly**, which already solved this for disk:
optional in the manifest, enforced in the broker, rendered in the prompt. Both
now share one validator (`readPositiveInteger`, `loader/manifest-capabilities.ts`)
because the reason is shared, not only the shape.

**Clamped, never rejected.** The manifest validator deliberately accepts a
number above the ceiling and `GrantLedger.socketAllowance` takes the minimum.
Rejecting at parse time would make any future change to
`LIMITS.concurrentSockets` a breaking change for every manifest that had
declared the old one.

**`AcquireRequest.socketLimit` is optional and falls back to the CEILING, not
the default.** Deliberate, and the direction matters: a caller that does not
know an origin's declaration must not be able to hand it a budget SMALLER than
it is entitled to. Only `index.ts`'s `connect` knows the ledger, and only it
passes the real number.

### `transport/port-pump.ts` -- the read-side byte pump

Relays bytes from an already-real WHATWG `ReadableStream` (`Duplex.toWeb`, [`ipc.ts`](transport/ipc.ts)'s
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

### `transport/port-sink.ts` -- the write-side byte pump

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

### `transport/socket-relay.ts` -- wiring one socket's pump and sink to its port

Split out of `ipc.ts`'s `net.connect` case so that file keeps only what is security-relevant: the
transport check, the origin re-derivation, and the port delivery. This file owns none of that; it
is handed an already-delivered `PortLike` and just wires it to a pump and a sink.

**Registration lives here too, not split back out to the caller**, because registering and
releasing a socket are one lifecycle, not two: whichever path ends the socket -- a clean close, a
revoke, a write-window violation the sink itself detects, the renderer's own port closing -- must
free the SAME registry slot, and keeping both ends in one file is what makes that easy to see.

### `transport/port-messages.ts` -- validating messages on a socket's port

Split out of `ipc.ts`'s inline credit-message check once a second and third message kind joined
it -- one job (shape validation at this trust boundary), the same way `ipc-validation.ts` owns it
for `CONTROL_CHANNEL`.

### `index.ts` -- three splits so far

Three pieces have moved out of this file, all at Rule 2's 500-line limit and all by concern:
`grants/grant-ledger.ts` (the per-origin state), `io-errors.ts` (translating an injected
dependency's raw error), and -- 2026-09-09, when `net.listen` landed -- `net-capability.ts`
(`connect`/`authorisedSend`/`udpBind`/`listen`, the whole of `orivon.net`). What stays is the
dependency shape `createBroker` fixes, the origin-normalising `canonical()` every capability
shares, and the `fs`/`app`/grant-ledger entry points that do not yet warrant a file of their own.

**`net-capability.ts` stayed at the top level rather than becoming a `net/` directory**, unlike
`grants/grant-ledger.ts`'s own move. The five directories are organised by JOB (`ADR-0015`:
decide / remember / hold / do / speak) -- `net-capability.ts` is not a sixth job, it is
`index.ts`'s own job (the capability entry points) split purely for line count, the same test
`io-errors.ts` and `broker-contracts.ts` already pass as top-level files. It takes `HandleTable`
and `GrantLedger` as constructed dependencies rather than building its own, so nothing about
`createBroker`'s fixed dependency shape or its stub-testability changed in the move -- a pure
extraction, not a redesign.

**There is headroom left for now.** `fs` is still missing everything below `readFile`/
`writeFile` and `id` has nothing at all; whoever builds either should check this file's line
count before adding inline rather than assuming there is room, the same way `net.listen`'s
author had to.

### `net-capability.ts` -- the accept-queue bound is not the specification's backpressure

`handle-contracts.md`'s conformance item 7 for `TcpServer` wants the OS listen backlog itself to
apply pressure once an app stops reading `connections` -- but vanilla Node `net` accepts a
connection and fires `'connection'` unconditionally the instant the OS hands one over; there is
no public API to defer the `accept()` syscall independent of app readiness (`pauseOnConnect`
pauses an accepted SOCKET's data flow, not the listener's accept loop). `../adapters/
node-adapters.ts`'s `listenTcp` is honest about this gap rather than claiming to have closed it:
`LISTEN_ACCEPT_QUEUE_LIMIT` bounds how many accepted-but-unclaimed connections one listener holds
before it starts resetting new ones outright, which keeps an unread `connections` stream from
pinning unbounded memory in the main process (T11b) without pretending to be OS-level
backpressure. AI recommendation, not an owner decision -- flagged for the same reason the write
heartbeat and dial timeout are (`transport/port-sink.ts`, `adapters/node-adapters.ts`'s own
`DIAL_TIMEOUT_MS`): nothing in `contracts/` or `handle-contracts.md` specifies this number.

### `policy/manifest-patterns.ts` -- moved here from `src/loader/`, and a gap it closed

`patternSetFromCapabilities` (Manifest.capabilities -> `update.ts`'s `PatternSet`) used to live
in `src/loader/update-patterns.ts`, the only place that needed it until `app.requestGrant`'s
policy (`policy/request-grant.ts`, queue item 4.1) needed the exact same conversion for its own
subset check. This file may never import `src/loader/` (this README's own "what it must never
import"), so the function moved here instead, with `src/loader/update-patterns.ts` reduced to a
re-export of it -- `src/loader/index.ts`'s import needed no change.

**The move surfaced a real gap, not a style issue: the function never mapped
`capabilities.net?.https?.connect` to `'https.connect'`.** Concretely, this meant a manifest
update that ADDED `https.connect` (ADR-0017) installed SILENTLY -- `decideUpdate`'s subset check
never saw the new key, so `widensAuthority` could not fire -- and a `requestGrant` call for a
declared `https.connect` would have been refused as "not declared". Fixed as part of the move,
with a regression test (`policy/tests/manifest-patterns.test.ts`) rather than left for a separate
change, because leaving it broken would have made `request-grant.ts`'s own "never exceeds the
manifest" guarantee false for exactly the one capability ADR-0017 added most recently.

### `policy/request-grant.ts` and `../main/request-grant.ts` -- what a persisted grant may trust

Queue item 4.1's own security shape asks: "if grants are read back from storage at startup, a
tampered store must not be able to mint authority the user never gave -- what is trusted on that
read path?" At the time this section was first written **there was no such read path to
secure**: `grants/grant-ledger.ts`'s `OriginRecord.grants` was never written to `LedgerStorage` at
all (only `versionFloor` and `rollbackAcknowledgedVersion` were) -- every grant was in-memory only
and did not survive a restart. That was a real, separate, filed gap (A23) against decision 9 ("a
grant lasts until revoked").

**A23 is now closed** (`grants/grant-persistence.ts`, `grants/grant-ledger.ts`). The read path this
paragraph worried about now exists, and the conclusion it drew is exactly what got built: hydration
never becomes a second place authority can be minted. `hydrateGrants` (`grant-persistence.ts`)
restores exactly the `(origin, capability, patterns)` tuple a real, accepted `requestGrant`/
install-time `broker.grant()` call already wrote, re-validates it against the origin's CURRENT
manifest via `decideGrantRequest` -- the same check a live request gets, reused rather than
reimplemented -- and mints a fresh `GrantId` rather than trusting one read off disk (there is not
one to trust: `PersistedGrant` carries no `id` field at all). A grant a live request could no
longer obtain is silently dropped, never restored. See `grants/README.md`'s own design note for
the full mechanism, including why hydration runs from `registerApp` rather than `versionFloor`'s
own earlier-touch hook (it needs a manifest to re-validate against), and the T13c exclusion for
loopback/plain-http origins.
