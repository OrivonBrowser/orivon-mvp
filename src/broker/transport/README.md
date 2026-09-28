# `src/broker/transport/`: how a page reaches the broker, and how bytes move

**What lives here.** The Electron IPC front door, its message validation, the per-origin rate
limiter, the credit-window byte pumps that relay a socket over a dedicated `MessagePortMain`, and
`orivon.fs.readFileSync`'s synchronous sibling to all of that (`sync-fs.ts`, `sync-fs-policy.ts`,
ADR-0016): a second, `ipcMain.on`/`event.returnValue` channel
(`SYNC_CONTROL_CHANNEL`) rather than a method on `CONTROL_CHANNEL`, because it never returns a
Promise the way every `ipcMain.handle` method here does.

**What it depends on.** `electron`, [`../index.ts`](../index.ts), [`../handles/`](../handles/),
[`../adapters/`](../adapters/), [`../grants/`](../grants/), [`../policy/origin.ts`](../policy/origin.ts)
and [`src/main/`](../../main/)'s channel and registry definitions.

**What it must never import.** [`src/shim/`](../../shim/), [`src/loader/`](../../loader/),
[`src/preload/`](../../preload/) or any renderer code. This directory is the trust boundary;
importing something on the far side of it inverts the trust direction.

**Owner stream.** `broker`, build step 2.

**[`dispatch/`](dispatch/) and [`relay/`](relay/) are this directory's own sub-folders, not a
sixth broker job.** `dispatch/` holds `dispatch()`'s per-capability switch cases (see Design
notes below); `relay/` holds the byte path -- the credit-window pumps, the sinks, the port
registry and the per-kind relays that wire a pump and a sink to a delivered port. Neither imports
the other; `relay/` in particular imports no `electron` value at all, so its tests run under
plain Node/vitest the same way [`../policy/`](../policy/) does.

## The two rules this directory exists to enforce

**Every call is attributed to the origin of the SENDING FRAME**, derived via
[`../policy/origin.ts`](../policy/origin.ts)'s `originFromSenderFrame`, never to anything the
renderer put in the payload (T3). A compromised renderer process can reach this channel
directly, so `method` and `payload` are validated here defensively rather than trusted because
the preload is well-behaved.

**Bytes never travel over request/response IPC.** `net.connect` returns a plain descriptor and
separately hands the frame a dedicated port; the read pump ([`port-pump.ts`](relay/port-pump.ts)) and
the write sink ([`port-sink.ts`](relay/port-sink.ts)) relay over that, each bounded by a credit window
so neither side can outrun the other. Per-message IPC is far too slow for torrent-rate data
([`contracts/ipc.ts`](../../contracts/ipc.ts)).

See [`../README.md`](../README.md)'s design notes for the socket-teardown rationale, which spans
this directory and [`../adapters/`](../adapters/).

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**Why `dispatch()`'s switch is split into [`transport/dispatch/app.ts`](dispatch/app.ts),
[`transport/dispatch/fs.ts`](dispatch/fs.ts), [`transport/dispatch/id.ts`](dispatch/id.ts) and
[`transport/dispatch/net.ts`](dispatch/net.ts) rather than staying inline in [`ipc.ts`](ipc.ts).**
Every new capability method adds dispatch cases, and with one inlined switch every one of them
lands in [`ipc.ts`](ipc.ts): the documented failure mode where two individually-compliant PRs
push a shared file over Rule 2's 500-line limit on merge, not on either branch. The cases group
by capability prefix (`app.*`, `fs.*`, `id.*`, `net.*`), so that grouping is the seam: each
capability's cases, and anything used by only that capability (`deliverTcpSocket`, needed only
by `net.connect`/`net.connectSecure`), live in their own file. `ipc.ts`'s own `dispatch()` is a
thin router that narrows `method` to each module's own slice of `ControlMethod`
(`Extract<ControlMethod, \`app.${string}\`>` and its three siblings) and calls straight through:
one switch, the same exhaustiveness, spread across four files. Growth lands in the one file that
needs it: a new `fs.*` method grows only `transport/dispatch/fs.ts`, a new `net.*` method only
`transport/dispatch/net.ts`.

**`ControlEvent` lives in [`port-transport.ts`](relay/port-transport.ts), alongside the `PortDeliveryFrame`
it is built from.** Both `ipc.ts` (the top-level router and `handleControlRequest`) and
`transport/dispatch/net.ts` (`deliverTcpSocket`, the `net.*` cases) need this type, and `transport/dispatch/net.ts`
must not import `ipc.ts`, because that would cycle back through `ipc.ts`'s own import of `dispatchNet`.
`port-transport.ts` holds the shape it is built from and imports nothing from either file,
so it is the one place both can reach without a cycle. `ipc.ts` re-exports it unchanged, so nothing
importing `ControlEvent` from `'../ipc.js'` (the test suite, chiefly) needed to change.

**Why [`ipc.ts`](ipc.ts)'s dispatch functions take structural types, not `electron`'s real
ones.** `handleControlRequest`, `dispatch` and `registerBrokerIpc` take a `Broker` and
structurally-typed `event`/`ipcMain`/`PortTransport`, so `ipc.test.ts` exercises the whole
control-channel logic under plain Node/vitest with no Electron process running, the same
pattern [`src/main/registry.ts`](../../main/registry.ts) uses. Only `brokerIpcSubsystem`, which
nothing in that test file calls, touches the real `ipcMain`/`MessageChannelMain` value imports;
importing `electron` at module scope is still safe outside a real Electron process (it resolves
to a harmless string, so destructuring a value from it yields `undefined`, which only breaks if
actually called).

**The per-origin call-rate limits ([`control-limiter.ts`](control-limiter.ts)) are provisional
(open-questions.md A38).** There are two budgets, and every control method draws on exactly one.

*The control bucket* (200 burst, 100 per second) covers every call that names a path, a host, a
grant or a new resource. Before it existed, HandleTable's in-flight cap did nothing to stop
`app.grants()`, which has no handle, grant, or I/O to scope, and 5,000 concurrent calls to it were
all answered in full. `registerSyncFsIpc` shares this same bucket, so `fs.readFileSync` cannot be
used to dodge it by moving traffic to a channel with no budget of its own. A fairness risk remains
open under A38: a burst of path-based calls can still starve an unrelated `app.grants()` poll.

*The handle-I/O budget* (4096 burst, 4096 per second) covers calls against a handle the origin
already holds: `fs.read`/`write`/`fstat`/`truncate`/`sync`/`close` and `net.close`/`setNoDelay`/
`setKeepAlive`. These used to share the control bucket, and a database that streams one
`fs.write` per record (nedb, as FreeTube uses it) spent all 200 tokens in one load, after which its
own writes and any `net.connect` answered `'limit'`. They cannot simply be exempt: the in-flight
cap bounds how many run at once, not how often, and a few hundred fast operations in flight can
still occupy the broker's UI thread continuously (T11b), while `close` and the `net.*` calls do not
run under the in-flight cap at all.

**The handle-I/O budget paces instead of refusing.** Past its burst, a call borrows its token and
waits until that token would have accrued (`token-bucket.ts`'s `createPacingLimiter`), so an app
writing faster than the budget is slowed to it rather than handed an error that fails its write
stream. The wait is bounded (one second), and so is the number of calls waiting, since the debt
is: past it the call is refused with `'limit'` exactly as the control bucket refuses. A waiting
call holds only its own payload and a timer; nothing runs on its behalf until it is admitted.

**`sync-fs.ts`/`sync-fs-policy.ts` reuse `../index.ts`'s own `Broker.fs.confineSync`**, ADR-0016's
synchronous grant-check/confinement entry point, built entirely from
`confineForOrigin`'s existing logic (`../index.ts`'s own doc), so a missing grant or a
traversal/symlink escape is refused by the SAME check `fs.readFile`/`writeFile` use, never a
second implementation of it (code-guidelines.md Rule 3). `sync-fs-policy.ts`'s
`createSyncFsPolicy` is a thin pass-through onto that method plus `node:fs`'s own `readFileSync`
for the raw disk I/O, which the async `BrokerFs.readFile` adapter has no synchronous counterpart
for. **Deliberately
outside the per-origin in-flight budget (`HandleTable.run`) `readFile`/`writeFile` run under** --
that budget is `async`-shaped by construction and a synchronous IPC reply cannot await a slot
becoming free, so this is a genuinely open design question, not merely a deferred one; see
`../index.ts`'s own doc on `confineSync` and `open-questions.md`.

**`sync-fs-policy.ts`'s `readFileSync` copies before returning, for the same reason
[`../adapters/node-fs-adapter.ts`](../adapters/node-fs-adapter.ts)'s `readFile` does**; see
`../adapters/README.md`'s Design notes for the structured-clone/pooled-buffer rationale. Being
synchronous does not exempt this path from it: `node:fs`'s `readFileSync` pools small allocations
exactly like its promise-based sibling, so a raw pass-through here would hand the page whatever
else shares the pool slab. No shared helper: the copy is `new Uint8Array(x)`, a single builtin
call, and the two sites live in different layers of the trust boundary (`transport/` depends on
`adapters/`, never the reverse): a named wrapper for one expression would be indirection without
reducing what either call site has to get right.

**[`secure-connect-params.ts`](secure-connect-params.ts) validates `net.connectSecure`'s payload
apart from [`ipc-validation.ts`](ipc-validation.ts).** The TLS options are one job with rules of
their own. An unknown key is refused, not dropped, because an option an app believes it set must
never be silently ignored. Every PEM string, the CA bundle, the PKCS#12 bytes, the passphrase and
the ALPN list are bounded, because the broker loads them synchronously on the main thread when the
handshake starts. A refusal names the option and the rule it broke, never the value, so key
material cannot reach a log line or the page. The reply is the ordinary socket descriptor plus
`tls`, the handshake facts, picked field by field from the broker's socket rather than spread,
since that object also holds streams and functions that cannot clone.

### The unlink hook: why teardown does not wait for `closed`

`HandleTable.onUnlink` (`../handles/handles.ts`), the `unlink` field on a record
(`../handles/handle-store.ts`) and `socket.onUnlink(...)` (`relay/socket.ts`) are one
mechanism (A84). The rationale lives here rather than in three source headers.

**The failure it prevents.** `closeTree()` removes a handle from `handles` and
`byGrant` synchronously, then awaits `record.destroy(reason)`. For a clean
close that destroy is `socket.end(cb)`, a HALF-close whose callback fires
only once every queued byte has drained into the peer's receive window. A peer
that stops reading never lets that happen, so without the hook `destroy` never
settles, the handle's `closed` never settles, and everything gated on `closed`
(the pump, the sink, the port, the `PortRegistry` slot) stays live. The record
is already out of both tables by then, so neither `revoke()` (which walks
`byGrant`) nor `dropOrigin()` (which walks `handles`) can find it, and nothing
is left able to close that socket. Measured against Node v24.11.1: ~3 MB queued, `writableLength` still over 1 MB three seconds later,
`end()`'s callback never fired.

**Why a hook rather than a shorter timeout.** `closeTree`'s own doc already
promised this ordering: "the unlink pass and the promise rejections are
SYNCHRONOUS, before any destroy callback runs. That ordering is what makes
revocation immediate". The relay simply was not subscribed to it; it only had
`closed`. The hook finishes the design rather than adding a second one.

**Both halves, not one.** A84 named two fix shapes and the owner took both.
The hook makes teardown immediate; `destroySocket`'s `CLOSE_DRAIN_TIMEOUT_MS`
(`../adapters/node-adapters.ts`) additionally guarantees the destroy itself always settles,
so `closed` and the handle count are released even in the pathological case.
Either alone leaves a real gap: without the deadline `closed` still never
settles, and without the hook the registry slot still waits on it.

**The hook fires for every reason, but the relay acts on only some of them, and
this is not a detail.** Tearing down unconditionally loses data. `stop()` cancels the read stream, and cancelling the readable
half of a `Duplex.toWeb` DESTROYS the whole socket, dropping everything still
in its write queue. Measured against a real paused peer: 8 MiB queued, 8 MiB
lost, where a path with no teardown delivered all of it. So:

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
pinned by tests (`relay/tests/socket.test.ts`, and the real-socket truncation pair in
`../adapters/tests/socket-drain.test.ts`) so the branch cannot be simplified away silently.

**It also shuts A70's window.** `net.close`/`setNoDelay`/`setKeepAlive`
dispatch through `PortRegistry`, which has no concept of a grant, so they could
still reach a socket whose grant had just been revoked. The registry slot is
now released in the same synchronous pass that unlinks the handle, so the
lookup those three share simply stops answering. No extra check was needed.

**`code` is undefined for an app-initiated close.** Deliberate, and it matches
what `socket.closed` already did: it resolves for `'closed'` and rejects
otherwise, so the relay sent a bare `end` for a clean close and a coded one
for everything else. Passing the reason through the hook keeps the wire
identical; only the timing changed, never the message.

### `relay/datagram.ts`: why its unlink teardown is NOT conditional

`relay/socket.ts` branches on the close reason at unlink, and the section above explains at length
why that branch is load-bearing: `stop()` cancels the read stream, cancelling the readable half of
a `Duplex.toWeb` destroys the socket, and destroying it drops everything still in its write queue
(8 MiB queued, 8 MiB lost, measured). So a flushing reason must be left to settle through `closed`.

`relay/datagram.ts` tears down on **every** reason, and the asymmetry is deliberate rather than an
oversight in either file. A UDP socket has no write queue to lose: `send` hands a datagram to the
OS or refuses it, and nothing is ever buffered for later delivery. There is therefore nothing a
teardown here can truncate, and waiting would only hold the registry slot and the port open longer
than the grant that authorised them.

Anyone tempted to "fix" the inconsistency in either direction should read this paragraph and the
one above it as a pair. Both branches are pinned by tests (`relay/tests/datagram.test.ts` asserts
teardown for all five reasons; `relay/tests/socket.test.ts` and `../adapters/tests/socket-drain.test.ts`
assert the opposite for TCP), so neither can be simplified away silently.

### `relay/port-pump.ts`: the read-side byte pump

Relays bytes from an already-real WHATWG `ReadableStream` (`Duplex.toWeb`, [`ipc.ts`](ipc.ts)'s
`dialOne`) to the renderer over a socket's dedicated `MessagePortMain`. Deliberately pure and
Electron-free, the same reason `../policy/` is, so it runs under plain Node/vitest with no
`MessagePortMain` at all; `ipc.ts` (via `relay/socket.ts`) is where a real port's
`postMessage`/`on('message')` get wired to `send`/`handleCredit`. The write direction is
`port-sink.ts`, below; this file is the read half only.

**Credit is bounded by the window, never trusted as reported.** `handleCredit` clamps the running
budget to `initialCredit`: `../../contracts/ipc.ts` specifies "the broker sends at most
`LIMITS.readWindowBytes` ahead of what has been acknowledged", and credit is a remaining-budget
counter, so `sent - acknowledged <= window` is the same statement as `credit <= initialCredit`.
This file once trusted the renderer's reported figure outright, on the reasoning that an
over-reporting renderer only inflates its own queue in its own process, which is wrong in one direction: a
`CreditMessage` carrying `Infinity` made `credit > 0` permanently true, so the pump never stopped
reading the OS socket, defeating the backpressure (and the TCP backpressure to the remote peer)
that is the whole point. Non-finite and negative figures are rejected rather than applied for the
same reason: `NaN` poisons the counter permanently, and a negative value drives it below zero with
no way back.

### `relay/port-sink.ts`: the write-side byte pump

Runs the credit-window relay backwards from `port-pump.ts`'s read side: the BROKER grants the
RENDERER a byte window to post outbound bytes into, because a `MessagePortMain` has no
`pause()`/drain of its own (`electron.d.ts`'s `MessagePortMain` has exactly `postMessage`,
`start`, `close`, `on('message')`, `on('close')`), so nothing at the transport layer stops a
hostile renderer posting faster than the OS socket drains (T11b).

**No sequence number, no pending-write queue.** A `WritableStreamDefaultWriter` serialises its
own sink calls, and `write()` is never re-entered before the previous call settles, so tracking one
scalar `unacked` count and one scalar `pendingCount` is sufficient; there is nothing to reorder.
See `../../contracts/ipc.ts`'s own header for why write-end/write-abort travel on this port rather than
over `CONTROL_CHANNEL`.

**Acks are flushed either once `CREDIT_COALESCE_BYTES` has accepted, or once nothing else is
outstanding** (`pendingCount === 0`), so a lone slow write is never held hostage by coalescing,
and a burst of same-tick writes naturally merges into one ack, the same way a burst of same-tick
reads merges into one credit consumption on the read side.

**The heartbeat (`WRITE_HEARTBEAT_MS`) exists** because `../../contracts/ipc.ts`'s rule 2, that every
reply-carrying message needs a timeout because this transport fails by silence, cannot be a
flat deadline here: a choked BitTorrent peer legitimately stalls a write for real, sometimes for
minutes. A zero-byte `WriteAckMessage` lets the renderer's own silence timer distinguish "the peer
is just slow" from "the transport died" without either side inventing a new message kind.

**`writer.close()` is never awaited** (the source keeps this as a trap next to the call itself,
not only here). Measured directly against `Duplex.toWeb` (Node 24.11.1): its `close()` promise
does not settle until the whole duplex is destroyed, after the readable side also ends, not
when the FIN this call sends is itself flushed. Awaiting it would deadlock any peer that
(correctly, per half-close) keeps reading after our FIN and waits for our reply before sending
its own.

### `relay/socket.ts`: wiring one socket's pump and sink to its port

Split out of `ipc.ts`'s `net.connect` case so that file keeps only what is security-relevant: the
transport check, the origin re-derivation, and the port delivery. This file owns none of that; it
is handed an already-delivered `PortLike` and just wires it to a pump and a sink.

**Registration lives here too, not split back out to the caller**, because registering and
releasing a socket are one lifecycle, not two: whichever path ends the socket (a clean close, a
revoke, a write-window violation the sink itself detects, the renderer's own port closing) must
free the SAME registry slot, and keeping both ends in one file is what makes that easy to see.

**A clean end in both directions is one of those paths.** Once the app's own write-end has been
issued (the sink's `onEnded`) and the peer's FIN has ended the readable (the pump's
`onStreamEnded`), the relay calls `socket.close()`, which releases the handle and its socket slot
the same way a failure does. Either half alone is a half-close and stays open: a peer that has
stopped sending may still be reading. Without this, a connection both sides had finished stayed
counted against the origin's socket allowance until the app remembered to call `close()`.

### `relay/port-messages.ts`: validating messages on a socket's port

Split out of `ipc.ts`'s inline credit-message check once a second and third message kind joined
it: one job, shape validation at this trust boundary, the same way `ipc-validation.ts` owns it
for `CONTROL_CHANNEL`.
