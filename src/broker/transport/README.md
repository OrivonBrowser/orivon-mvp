# `src/broker/transport/`: how a page reaches the broker, and how bytes move

**What lives here.** The Electron IPC front door ([`ipc.ts`](ipc.ts)), its message validation,
the per-origin rate limiter, and `orivon.fs.readFileSync`'s synchronous channel
(`SYNC_CONTROL_CHANNEL`,
[`ADR-0016`](../../../docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)).
[`dispatch/`](dispatch/) holds `dispatch()`'s per-capability switch cases; [`relay/`](relay/)
holds the byte path: the credit-window pumps, the sinks, the port registry and the per-kind
relays that wire a pump and a sink to a delivered port.

**What it depends on.** `electron`, [`../index.ts`](../index.ts), [`../handles/`](../handles/),
[`../adapters/`](../adapters/), [`../grants/`](../grants/),
[`../policy/origin.ts`](../policy/origin.ts) and [`src/main/`](../../main/)'s channel and
registry definitions. `dispatch/` and `relay/` do not import each other, and `relay/` imports no
`electron` value, so its tests run under plain Node.

**What it must never import.** [`src/shim/`](../../shim/), [`src/loader/`](../../loader/),
[`src/preload/`](../../preload/) or any renderer code. This directory is the trust boundary;
importing something on the far side of it inverts the trust direction.

**Tied to Electron.** It is the IPC and `MessagePortMain` layer. `relay/` and the limiters are
Electron-free so they test under plain Node, not because they would outlive that transport.

**Owner stream.** `broker`, build step 2.

## The two rules this directory exists to enforce

**Every call is attributed to the origin of the sending frame** (`originFromSenderFrame`), never
to anything the renderer put in the payload (T3). A compromised renderer process can reach this
channel directly, so `method` and `payload` are validated here, not trusted because the preload
is well-behaved.

**Bytes never travel over request/response IPC.** `net.connect` returns a plain descriptor and
separately hands the frame a dedicated port; the read pump and the write sink relay over it, each
bounded by a credit window ([`contracts/ipc.ts`](../../contracts/ipc.ts),
[`handle-contracts.md`](../../../docs/architecture/handle-contracts.md) §Backpressure).

## Design notes

**`dispatch()` is split by capability prefix** (`dispatch/app.ts`, `fs.ts`, `id.ts`, `net.ts`,
...), so a new method grows only its own capability's file. One inline switch in `ipc.ts` is the
failure mode where two compliant PRs push a shared file past the 500-line limit on merge, not on
either branch. `ipc.ts`'s `dispatch()` stays a thin router that narrows `method` to each module's
slice (`Extract<ControlMethod, \`net.${string}\`>`).

**`ControlEvent` lives in [`relay/port-transport.ts`](relay/port-transport.ts).** `dispatch/net.ts`
needs it and must not import `ipc.ts`, which imports `dispatchNet`: that is a cycle. `ipc.ts`
re-exports it.

**`ipc.ts`'s dispatch functions take structural types, not `electron`'s**, so `ipc.test.ts` runs
the whole control channel under plain Node. Importing `electron` at module scope is still safe
there: outside a real Electron process it resolves to a string, so a destructured value is
`undefined` and breaks only if called, and only `brokerIpcSubsystem` calls one.

**Two call-rate budgets, both provisional (A38)** ([`control-limiter.ts`](control-limiter.ts)).
The control bucket covers every call that names a path, a host, a grant or a new resource, and
`fs.readFileSync` shares it. The handle-I/O budget covers calls on a handle the origin already
holds. It is separate because a database writing one `fs.write` per record (nedb, as FreeTube
uses it) spent the whole control bucket in one load, after which its own writes and any
`net.connect` answered `'limit'`. It is not an exemption: the in-flight cap bounds how many run
at once, not how often, and `close` and the `net.*` handle calls do not run under it at all
(T11b). It paces rather than refuses, because an error fails the app's write stream; the wait
and the debt are bounded. Still open under A38: a burst of path calls can starve an unrelated
`app.grants()` poll.

**An unknown `net.connectSecure` option is refused, not dropped**
([`secure-connect-params.ts`](secure-connect-params.ts)): an option an app believes it set must
never be silently ignored.

### The unlink hook: why teardown does not wait for `closed`

`HandleTable.onUnlink` (`../handles/handles.ts`), a record's `unlink` field
(`../handles/handle-store.ts`) and `socket.onUnlink(...)` (`relay/socket.ts`) are one mechanism.
`closeTree()` unlinks a handle synchronously, then awaits `destroy`; for a clean close that is
`socket.end(cb)`, which never settles against a peer that stops reading. Everything gated on
`closed` (pump, sink, port, `PortRegistry` slot) then stays live, and nothing can find the record
to close it. The mechanism and the measurement are in `open-questions.md` A84.

**Both halves are needed.** The hook makes teardown immediate; `destroySocket`'s
`CLOSE_DRAIN_TIMEOUT_MS` (`../adapters/node-adapters.ts`) makes `destroy` always settle. Without
the deadline `closed` never settles; without the hook the registry slot still waits on it.

**The relay acts on only some reasons, and this is load-bearing.** `'closed'` and
`'sessionEnded'` flush, so the relay leaves them to settle through `closed`: tearing down at
unlink cancels the read stream, which destroys the whole socket (`socket-streams.ts`) and drops
its write queue (8 MiB queued, 8 MiB lost, measured). `'revoked'`, `'aborted'` and `'failed'` destroy
the socket anyway, so teardown is immediate. The listener receives the `CloseReason`, not the
code, because `'sessionEnded'` and `'revoked'` share code `'revoked'`. Pinned by
`relay/tests/socket.test.ts` and `../adapters/tests/socket-drain.test.ts`.

**The slot goes in the same pass.** `net.close`/`setNoDelay`/`setKeepAlive` look the socket up in
`PortRegistry`, which knows no grants; releasing the slot as the handle unlinks is what stops
them reaching a revoked socket (A70). `code` is undefined for an app-initiated close, so the wire
message is unchanged.

**[`relay/datagram.ts`](relay/datagram.ts) tears down on every reason, deliberately.** A UDP
socket has no write queue to lose: `send` hands a datagram to the OS or refuses it. Waiting would
only hold the slot and the port past the grant. Read this and the TCP branch as a pair before
"fixing" either; `relay/tests/datagram.test.ts` pins all five reasons.

### `relay/port-pump.ts`: the read-side byte pump

The read half of the credit window; `relay/socket.ts` wires a real port to it. Credit is clamped
to the window and a non-finite or negative figure is ignored, because the renderer's report is
not trusted: a `CreditMessage` of `Infinity` would keep the pump reading the OS socket forever,
defeating TCP backpressure to the peer, and `NaN` poisons the counter for good.

### `relay/port-sink.ts`: the write-side byte pump

The credit window run backwards: the broker grants the renderer a byte window to post into,
because a `MessagePortMain` has no `pause()` or drain (T11b). Why there is no sequence number and
why the heartbeat exists: `handle-contracts.md` §Backpressure: write direction. An ack flushes at
`CREDIT_COALESCE_BYTES` or when nothing else is outstanding, so a lone slow write is never held
back by coalescing. The `writer.close()` trap is at the call.

### `relay/socket.ts`: wiring one socket's pump and sink to its port

It is handed an already-delivered port, so `ipc.ts` keeps only the security-relevant part.
Registering and releasing the socket's registry slot live here together, because every path that
ends a socket (clean close, revoke, a window violation, the port closing, or both directions
ending cleanly) must free the same slot.

### `relay/port-messages.ts`: validating messages on a socket's port

Shape validation at this trust boundary, as `ipc-validation.ts` does for `CONTROL_CHANNEL`.
