# Handle contracts — v0 specification

> **Status: DRAFT, needs owner review before any code is written.**
>
> This document defines the five handle types named but not specified in
> `capability-api.md` §v0 surface: `TcpSocket`, `TcpServer`, `UdpSocket`, `FileHandle`,
> `IdentityHandle`. It is a sibling of that document, not a section inside it — the same
> care level applies (ADR-0002: the Electron shell is disposable, this interface is not),
> kept separate so the policy content in `capability-api.md` stays readable at its current
> length.
>
> Direction decided by the owner, 2026-08-25 (`open-questions.md` A10, `ADR-0008`): **WHATWG
> streams are the durable interface. Node shapes are presented by `orivon-node-shim` on top,
> not by this layer.** `orivonApiVersion: 0` still applies — breaking changes are permitted
> here while it is 0.

## §Common shape

Every handle returned by `orivon.*` shares this base:

```ts
interface Handle {
  readonly id: string                // opaque; per-origin, not forgeable across origins (T11c)
  readonly closed: Promise<void>     // resolves on clean close, rejects with OrivonError otherwise
  close(): Promise<void>             // idempotent
}
```

- **Handles are never transferable** (`capability-api.md` design rule 3). `MessagePort` is
  transferable and carries no sender identity; a transferred handle would be a bearer
  capability the broker cannot see. This is already decided, restated here because every
  section below depends on it.
- **Every operation re-checks ownership** against the per-origin handle table before it runs
  (T11c). A handle ID from one origin is meaningless presented by another.
- **Every handle records the grant ID that authorised it**, captured at acquisition. This is
  what §Revocation walks.

## §Errors — a closed enum

```ts
class OrivonError extends Error {
  readonly code: OrivonErrorCode   // closed enum below
  readonly platformCode?: string   // e.g. 'ECONNREFUSED' -- advisory, unversioned
  readonly handleId?: string
}
```

| code | meaning |
|---|---|
| `denied` | outside what was granted — pattern mismatch, undeclared capability, privileged port, blocked address range |
| `revoked` | the grant authorising this handle was withdrawn |
| `unreachable` | the peer could not be reached (refused, no route, DNS failure) |
| `timeout` | the operation exceeded its deadline |
| `reset` | the peer terminated an established connection abruptly |
| `closed` | operation attempted on a handle that is already closed |
| `limit` | a resource limit was hit (quota, socket count, in-flight cap) |
| `invalid` | malformed argument — bad path, bad address, bad option |
| `notFound` | the named file or directory does not exist |
| `exists` | the named file or directory already exists |
| `internal` | a broker fault; should never be observed by an app, always logged |

**Rules:**

- **Closed.** An app may switch on `code` exhaustively and treat an unrecognised value as a
  bug, not a case to silently ignore. Adding a code is a breaking change once
  `orivonApiVersion` reaches 1 — see §Versioning.
- `platformCode` carries the underlying engine's own detail — a Node errno today
  (`ECONNREFUSED`, `ENOENT`, ...), whatever WASI or Mojo expose later. **Advisory and
  unversioned.** An app that branches on `platformCode` is coding against the engine
  underneath, not against Orivon, and that code may need adjustment across the Node →
  Wasmtime → Chromium/Mojo transitions design rule 7 anticipates. It exists so
  `orivon-node-shim` can reconstruct a faithful Node `Error` (`err.code === 'ECONNREFUSED'`
  is a real Node idiom and must keep working through the shim).
- **`denied` never carries a `platformCode`, and is uniform across every reason for denial.**
  This is deliberate, not an oversight — see the owner decision below.
- Every other code, for an address or resource the app was **permitted** to attempt, carries
  the real `platformCode`. See the owner decision immediately below for why.

### Owner decision, 2026-08-26 — how much failure detail an app receives

**Decided by the owner:** apps get the true, specific reason for a failure — refused,
timed out, no route, name doesn't resolve — whenever the attempt was one the app was
permitted to make. Detail is not withheld across the board to frustrate network scanning.

**Reasoning recorded, not re-litigated:** withholding detail everywhere breaks the large
body of existing Node code that branches on specific error codes (`ECONNREFUSED` vs.
`ETIMEDOUT` vs. `EHOSTUNREACH` drive real retry and fallback logic), which directly costs
`orivon-node-shim`'s mechanical-port goal (design rule 1) and `app-compatibility.md`'s
tier-2 porting cost. Address policy (T12) already denies private ranges unless the manifest
explicitly declares them and the user grants it, so the addresses an app can legally probe
are addresses any ordinary web page can already probe via `fetch` timing side channels —
detailed TCP errors add little that is not already leakable. Where a user *has* explicitly
granted a private-range pattern, detailed errors inside that range are what consenting to
the grant means.

**Refinement, AI-applied, not re-asked:** the decision above is about attempts the app was
*allowed* to make. A `denied` result — the attempt itself was outside the grant — carries no
detail and is identical regardless of *why* it was denied (privileged port, pattern
mismatch, blocked private range, capability absent from the manifest). If `denied` varied by
reason, an app could iterate through denials and map exactly which pattern, port, or address
class is blocked, turning the permission boundary itself into a probe target. This costs
nothing against the owner's decision, because `denied` is precisely the boundary the owner's
own reasoning says should stay uninformative.

## §TcpSocket

```ts
interface TcpSocket extends Handle {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly remoteAddress: string   // the RESOLVED ip -- matches what the policy check ran against
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
  setNoDelay(on: boolean): Promise<void>
  setKeepAlive(on: boolean, initialDelayMs?: number): Promise<void>
}
```

- `orivon.net.connect()` resolves **after** the TCP handshake completes. There is no
  `connect` event and no observable "connecting" state on the returned object — the
  resolution of the promise *is* the connect event (design rule 2: everything is async).
- **General rule — and the fix for the gate-1b `address()` problem below:** anything Node
  exposes as a *synchronous* property is resolved by the broker before the acquisition
  promise settles, and handed to the app as a plain, already-populated value. It is never a
  cache that starts empty and fills in from a later event.
- `remoteAddress` is the address the connection actually reached — the **resolved** address,
  not the hostname the app asked for. This is required by T12: manifest patterns are checked
  against resolved addresses, and an app inspecting what it actually connected to must see
  the same address the policy check saw, or DNS-rebinding-style confusion becomes possible
  again one layer up.

### Close and half-close

| action | wire effect | `readable` | `writable` | `closed` |
|---|---|---|---|---|
| `writable.close()` | FIN sent | open | closed | pending |
| peer sends FIN | — | ends (EOF, no error) | open | pending |
| both of the above | — | closed | closed | resolves |
| `socket.close()` | FIN sent, then handle released | closed | closed | resolves |
| `writable.abort(e)` | RST sent | errored | errored | rejects `reset` |
| peer resets | RST received | errored | errored | rejects `reset` |
| grant revoked | RST sent | errored | errored | rejects `revoked` |

Closing the writable side does **not** close the readable side — that pairing is Node's
`socket.end()`, and half-close is load-bearing: a BitTorrent peer connection sends a
choke/interested handshake and keeps reading long after it has stopped writing new requests.
`closed` only settles once both directions have reached a terminal state.

### Backpressure — a credit window

This answers `capability-api.md` §Throughput's open note: *"`MessagePortMain` has no
documented backpressure, so the shim must implement its own flow control."*

- The broker sends at most `WINDOW` bytes (default **1 MiB**) ahead of what the renderer has
  acknowledged consuming.
- The renderer's `readable` is a `ReadableStream` backed by
  `ByteLengthQueuingStrategy({ highWaterMark: WINDOW })`. Its internal `pull()` only fires
  once the app has genuinely drained the queue below the high-water mark, and firing it sends
  a credit message back to the broker carrying the number of bytes consumed since the last
  credit update.
- When the outstanding-credit budget reaches zero, the broker **stops reading the underlying
  OS socket** — it does not keep reading and buffer in the main process. This propagates real
  TCP backpressure to the remote peer, which is the whole point: buffering in the broker just
  moves the memory-growth problem from the renderer to the main process instead of solving
  it.
- `writable`'s `write()` resolves only once the broker has accepted the bytes into the OS
  socket send buffer, so an app that `await`s each write receives genuine write-side
  backpressure too.
- Credit updates are **coalesced**: at most one credit message per 64 KiB consumed, or once
  per animation frame, whichever comes first. A 52 MB/s stream (gate 4's measured throughput)
  must not emit a broker message per chunk of data — that reintroduces the per-message IPC
  cost `capability-api.md` §Throughput moved off the main channel in the first place.

## §TcpServer

```ts
interface TcpServer extends Handle {
  readonly connections: ReadableStream<TcpSocket>
  readonly localAddress: string
  readonly localPort: number
}
```

- Incoming connections arrive as a **stream, not an event.** This is the clearest practical
  payoff of the streams decision: if the app stops reading `connections`, the broker stops
  *accepting* new connections, and the OS listen backlog itself applies pressure back to
  whoever is trying to connect. An `EventEmitter`'s `'connection'` event has no way to say
  "not yet" — every accepted connection is delivered whether the app is ready or not, which
  is exactly the unbounded-growth failure mode design rule 3's "handles, not ambient
  authority" and the owner's streams decision both exist to avoid.
- `connections` is created with `highWaterMark: 0` — the broker never pre-accepts a
  connection the app has not asked for by reading. Each `read()` on the stream accepts
  exactly one pending connection.
- Sockets delivered through `connections` are **derived handles**: they inherit the server's
  grant (see §Revocation), and closing the server closes every socket it produced that is
  still open.
- The bound `localPort` is resolved before the acquisition promise for the server settles, so
  requesting `port: 0` (ask the OS to pick one) still yields a real, populated `localPort` —
  the same synchronous-property rule as `TcpSocket`.

## §UdpSocket

```ts
interface Datagram {
  data: Uint8Array
  address: string
  port: number
  family: 'IPv4' | 'IPv6'
}

interface UdpSocket extends Handle {
  readonly readable: ReadableStream<Datagram>
  readonly writable: WritableStream<Datagram>
  readonly localAddress: string
  readonly localPort: number
  readonly droppedInbound: number
}
```

- Message-oriented, not byte-oriented — this mirrors `WebTransport.datagrams` rather than a
  `Duplex`. One `Datagram` chunk is exactly one UDP packet, on both `readable` and `writable`;
  the broker never splits or coalesces a datagram.
- `localPort` is resolved and populated at acquisition. **This is what removes the
  synchronous-`address()` problem** that `spike/gate1b/shim/dgram.js` had to work around with
  a cache filled in by the `'listening'` event — under this contract there is no cache to
  fill, because the value is already there when the handle is returned.
- **Datagram loss is expected, and unsignalled as an error.** If the app is not reading fast
  enough and the `readable` internal queue is full, further inbound datagrams are dropped and
  `droppedInbound` increments — no error, no rejected promise, no dropped-datagram event.
  This is stated explicitly because it is the one place in this document where "backpressure"
  means *discard the data* rather than *slow the sender down*: UDP already has no delivery
  guarantee, and DHT/tracker traffic is designed to tolerate loss. Buffering to avoid losing a
  datagram would convert a protocol built to tolerate loss into an unbounded memory growth
  path — the exact failure this whole document exists to prevent.
- No multicast support in v0 (`addMembership`/`dropMembership` are not part of this
  contract), matching the recorded v0 limitation that local peer discovery is unavailable.

## §FileHandle

```ts
interface FileStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
}

interface FileHandle extends Handle {
  read(opts: { position: number; length: number }): Promise<Uint8Array>   // short read at EOF
  write(opts: { position: number; data: Uint8Array }): Promise<number>    // returns bytes written
  readable(opts?: { start?: number; end?: number }): ReadableStream<Uint8Array>
  writable(opts?: { start?: number }): WritableStream<Uint8Array>
  stat(): Promise<FileStat>
  truncate(length: number): Promise<void>
  sync(): Promise<void>
}
```

- Positional `read`/`write` mirror `fs.promises.FileHandle` and match what a torrent writer
  actually does — piece *N* is written at offset `N × pieceLength`, not appended sequentially.
  The stream factories (`readable`/`writable`) serve the bulk-transfer paths, such as feeding
  `<video>` from a downloaded region (`build-plan.md` §5, the range-capable custom-scheme
  media path).
- **`position` is explicit and required on every positional call — there is no implicit file
  cursor on this handle.** A cursor is mutable state shared across an async IPC boundary,
  which is a race the instant two writes to the same handle are in flight at once, and a
  torrent writer routinely has many pieces in flight concurrently. Node's familiar
  `position: null` "use the current cursor" form is presented by `orivon-node-shim`, which
  owns and advances a local cursor itself and always sends an explicit `position` underneath.
  **This is a deliberate, recorded deviation from design rule 1** ("mirror Node's shapes") —
  the shim absorbs the difference, so no app-facing code changes, but the durable interface
  underneath does not carry Node's shared-cursor hazard forward.
- Paths are resolved and confined to the app's files directory **in the broker, never trusted
  from the renderer.** `..` segments, absolute paths, and symlinks that would escape the
  confinement are rejected with `denied` (`security-model.md` T1/T10).
- Writes are checked against the running per-origin quota counter (`capability-api.md` A9 §3)
  before they land; exceeding it yields `limit`.
- **Exception to the revocation cascade:** a `FileHandle` obtained through
  `orivon.fs.userSelected` is authorised by the user's one-time OS picker choice, not by the
  standing `fs` grant. Revoking the `fs` capability does **not** close a handle obtained this
  way — but it also does not survive an app restart; it is a session-scoped exception, not a
  standing grant of its own. Stated explicitly here because §Revocation's cascade rule would
  otherwise silently and incorrectly include it.

## §IdentityHandle

```ts
interface IdentityHandle extends Handle {
  readonly kind: string                          // e.g. 'nostr'
  publicKey(): Promise<Uint8Array>                // the SAME key on every origin the user connected to
  signEvent(event: object): Promise<object>       // structured; broker serialises and screens `kind`
}
```

- No `readable`/`writable` — an `IdentityHandle` is not a byte channel. It is modelled as a
  handle because it is revocable and origin-scoped like every other capability, not because
  it streams anything.
- **No raw-bytes signing oracle.** Restated here as a binding contract rule, not just a note
  in `capability-api.md`, so it cannot be quietly reintroduced by a future implementation
  detail: `signEvent` takes and returns a structured event *object*, and the broker itself
  performs serialisation. An interface that accepted pre-serialised bytes to sign would let a
  compromised client sign literally anything under the user's identity.
- Event-kind screening is unchanged from `capability-api.md`: kinds 1/6/7 sign silently after
  the initial connect; kinds 0, 3, 5, 22242, and any delegation event prompt every time.
- `close()` releases *this app's* reference to the handle. It does **not** disconnect the
  named identity from the origin — disconnecting an identity is a user-initiated action in
  browser chrome, not something an app can trigger by closing its own handle. Without this
  rule, an app could force a fresh connect prompt on demand by closing and immediately
  re-requesting, which is exactly the prompt-fatigue outcome named identities exist to avoid.

## §Revocation — the cascade

- The broker maintains, per origin, a map from `grantId` to the set of live handle IDs it
  authorised.
- **Derived handles inherit the parent's grant.** A `TcpSocket` accepted from a `TcpServer`'s
  `connections` stream is registered as a child of both the server's grant *and* the server
  handle itself.
- On revocation of a grant, every handle in its set closes **immediately and abruptly**, not
  gracefully:
  - TCP: RST, not FIN. Any buffered unread or unsent data is discarded on both sides.
  - `closed` rejects with an `OrivonError` of code `revoked`.
  - Every promise the app is currently awaiting on that handle (a pending `read`, `write`,
    `connect`) rejects with `revoked`.
- **Immediate rather than graceful is an AI recommendation, not something the owner has
  separately ruled on — flagged as such.** The alternative, letting in-flight operations
  finish before tearing the handle down, has two costs: the revoke button in the UI would not
  mean what it visibly says ("this app can no longer do this," qualified by "...once it
  finishes what it's doing"), and completion time is entirely under the app's control, so a
  hostile or buggy app could keep a connection alive indefinitely simply by never finishing
  whatever it claims to be doing. The cost of immediate revocation is a discarded in-flight
  torrent piece, which is cheap to re-fetch from another peer.
- Revocation is **idempotent** and safe to call against an origin holding zero live handles.
- **Exception:** `fs.userSelected` handles are not in any grant's set — see §FileHandle.

## §Limits (T11, T11b)

Enforced per origin, with defaults chosen against gate 4's measured numbers (100 concurrent
sockets exercised cleanly) with headroom:

| limit | default |
|---|---|
| concurrent open sockets (`TcpSocket` + `UdpSocket` + accepted connections) | 512 |
| concurrent open `FileHandle`s | 64 |
| in-flight broker operations | 256 |
| per-socket read window (§TcpSocket backpressure `WINDOW`) | 1 MiB |

Exceeding any of these yields `limit`. **Calls beyond the in-flight cap reject immediately —
they do not queue.** An unbounded queue on the broker's UI thread is precisely how one
misbehaving origin freezes every tab (T11b); a rejection the app must retry keeps the broker
responsive to every other origin.

## §What the shim must do

The spike surfaced four failure modes that are easy to reintroduce if the lesson lives only
in `.claude/skills/orivon-electron/SKILL.md`. Promoted here to binding requirements on
`orivon-node-shim`:

1. **Shim completeness is measured against a dependency's actual call graph, never against
   this document's anticipated surface.** The worked example: `bittorrent-dht`'s RPC layer
   calls `net.isIP()` before every send. It is not a socket operation and is easy to omit
   from a design doc, but its absence made the DHT bind its listening socket successfully and
   then send nothing, ever — no error, no warning. **No shim module may be declared complete
   without checking it against the real source of every dependency it serves**, not just
   against the methods this specification happened to anticipate.
2. **Error visibility through a polyfill must be louder than Node's default, never quieter.**
   The spike's `globals.js` polyfilled `process.nextTick` with `queueMicrotask` for API-shape
   compatibility; Node's real `nextTick` surfaces an uncaught exception thrown inside its
   callback to the process, but `queueMicrotask` does not route into the same handlers, so
   the exception vanished silently. Any polyfilled Node timing primitive
   (`nextTick`, `setImmediate`, microtask ordering) must be audited for this class of
   behavioural change and must route uncaught exceptions to a broker-visible log — API-shape
   compatibility alone is not sufficient for anything touching error handling in
   security-relevant code.
3. **Every reply-carrying message sent over a `MessagePortMain` needs an explicit timeout.**
   Gate 0 confirmed this transport's failure mode is total silence, not an error — a dropped
   transferable never arrives, and never throws. A promise awaiting a reply with no timeout
   hangs forever on exactly this failure.
4. **No transferables on the renderer → main path, ever, as an optimisation or otherwise.**
   Gate 0 confirmed [electron#34905](https://github.com/electron/electron/issues/34905):
   passing an `ArrayBuffer` in a `postMessage` transfer list renderer→main silently drops the
   message. Structured clone is the only mechanism on this path, and it is fast enough on its
   own (313–1134 MB/s measured, against a 1–5 MB/s product need).
5. Every synchronous Node accessor this shim presents (`socket.address()`,
   `socket.remoteAddress`, and equivalents) is served from a value captured at handle
   acquisition, per §TcpSocket and §UdpSocket above — never from a cache an event fills in
   later.
6. **The raw `MessagePortMain` never crosses into the main world.** The preload holds it in
   the isolated world and exposes only `contextBridge` closures over it (T17). This is a
   security rule, not a throughput optimisation left for later.

## §Versioning

The versioned surface — subject to `orivonApiVersion` major-bump-plus-ADR rules once it
reaches 1 — is: the `OrivonErrorCode` enum, the five handle interfaces in this document, and
the close/half-close semantics table. `platformCode` string values are explicitly **not**
part of the versioned surface; they may change as the underlying engine changes (Node errno
today, WASI or Mojo equivalents later) without that counting as a breaking change to this
specification.

## §Conformance checklist

Testable assertions build steps 2 (broker) and 3 (shim) should drive as TDD targets
(`test-driven-development` per the tooling table), not an exhaustive test plan:

1. Closing `writable` on a `TcpSocket` leaves `readable` open until the peer also finishes.
2. A `TcpSocket` whose read credit window is exhausted stops the broker from reading its
   underlying OS socket (verifiable by stalled `recv` on the native side).
3. A `UdpSocket` with a full inbound queue increments `droppedInbound` rather than growing
   the queue or raising an error.
4. Revoking a grant rejects every pending operation promise on every handle in its cascade
   with `revoked`, and rejects `closed` the same way.
5. A `FileHandle` path containing `..` is rejected with `denied` before any filesystem access
   is attempted.
6. A `denied` error never carries a `platformCode`, regardless of which rule caused it.
7. A `TcpServer` whose `connections` stream is not being read stops accepting new incoming
   connections at the OS level.
8. A handle ID from one origin's table is rejected, not silently ignored, when presented by
   a different origin.
9. `orivon.fs.userSelected()` handles remain open across an `fs` grant revocation, and do not
   reopen after an app restart.

## Reference

- `docs/architecture/capability-api.md` — the parent specification; §v0 surface names these
  five handle types, §Throughput records the backpressure question this document answers.
- `docs/decisions/ADR-0008-handles-are-whatwg-streams.md` — why streams, not `EventEmitter`
  or raw `MessagePort`, and the alternatives rejected.
- `docs/architecture/security-model.md` — T1, T10 (path confinement), T11/T11b (resource
  exhaustion, broker freeze), T11c (cross-origin handle forgery), T12 (resolved-address
  policy), T17 (port isolation).
- `spike/gate1b/shim/net.js`, `spike/gate1b/shim/dgram.js` — the spike's working shims;
  verified against this document's shape (see the design session's verification notes) rather
  than copied from, since they predate the streams decision and target `EventEmitter`/
  `streamx` shapes that the *shim* still presents, one layer up from what this document
  defines.
