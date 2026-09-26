# `src/broker/capabilities/`: the `orivon.*` entry points

**What lives here.** `net.ts` (`orivon.net`'s `connect`/`udpBind`/`listen`), `net-connect-secure.ts`
(`connectSecure`, split out of `net.ts` by the same Rule 2 seam), `fs.ts` (`orivon.fs`'s nine
entry points), `fs-handle-wrapper.ts` (the shared handle-scoped-sibling wrapper `fs.ts` and
`user-selected.ts` both use), `user-selected.ts` (`fs.userSelected`), `id.ts` (`orivon.id`'s
`publicKey`/`sign`), `secrets.ts` (`orivon.secrets`), `web.ts` (`orivon.web`) and `socket-room.ts`
(a cheap socket-count check `net.ts` uses before dialling).

Each was lifted out of [`../index.ts`](../index.ts) under the same Rule 2 seam, once adding a
capability's own entry points pushed that file past 500 lines; see `../index.ts`'s own Design
note for what stays there instead.

**What it depends on.** [`../broker-contracts.ts`](../broker-contracts.ts),
[`../errors.ts`](../errors.ts), [`../io-errors.ts`](../io-errors.ts), [`../grants/`](../grants/),
[`../handles/`](../handles/) and [`../policy/`](../policy/).

**What it must never import.** [`../../shim/`](../../shim/), [`../../loader/`](../../loader/), or
any renderer code -- see the parent README's "What it must never import".

**Owner stream.** `broker`, build step 2.

## Design notes

**This folder is not a sixth broker job.** The five directories at `../` are organised by JOB
(`ADR-0015`: decide / remember / hold / do / speak), and this folder is not a sixth: every file
here is `../index.ts`'s own job (the capability entry points) split purely for line count, the
same test `../io-errors.ts` and `../broker-contracts.ts` already pass as top-level files. Each
takes `HandleTable` and `GrantLedger` as constructed dependencies rather than building its own, so
nothing about `createBroker`'s fixed dependency shape or its stub-testability changes by a file
moving here: a pure extraction, not a redesign.

**There is headroom left for now.** `fs` is still missing everything below `readFile`/
`writeFile` and `id` has nothing at all; whoever builds either should check the target file's line
count before adding inline rather than assuming there is room, the same way `net.listen`'s
author had to.

### `net-connect-secure.ts`: an option that unbinds the name adds the address check

`connectSecure` matches the grant against the hostname the app named, never a resolved address
(`../policy/connect-secure.ts`), because default verification of a certificate for that name
against the runtime's built-in roots is what binds the name to whoever answered. Three of the
app's TLS options remove that binding: `rejectUnauthorized: false` (nothing is verified), its
own `ca` (a root the app chose can vouch for any name), and a `servername` other than the host
(the certificate answers for a different name). Each is honoured, as Node honours it, and each
sends the call through `checkConnect` as well: resolve once, require every answer to pass the
same `https.connect` grant under `net.ts`'s `connect()` rule, and dial only the checked literal,
with SNI and certificate verification still on the name (`../secure-dial-contracts.ts`'s
`SecureDialTarget.addresses`). Without it, `rejectUnauthorized: false` under a `*:443` grant
would turn a name the app controls, rebound to `127.0.0.1` or `192.168.1.1`, into a full
unauthenticated session with a loopback or LAN service, where default verification refuses the
handshake. Both checks apply, so an option only ever narrows what a grant reaches. The cost: a
LAN node with a self-signed certificate is reached through a grant naming its address (or
`localhost:<port>`), never through a hostname that resolves privately, exactly as for plain TCP.
A replacement grant re-checks such a socket by the address it reached
(`connectStillAuthorised`), as it does a plain one.

### `net.ts`: the accept-queue bound is not the specification's backpressure

`handle-contracts.md`'s conformance item 7 for `TcpServer` wants the OS listen backlog itself to
apply pressure once an app stops reading `connections`, but vanilla Node `net` accepts a
connection and fires `'connection'` unconditionally the instant the OS hands one over; there is
no public API to defer the `accept()` syscall independent of app readiness (`pauseOnConnect`
pauses an accepted SOCKET's data flow, not the listener's accept loop). `../adapters/
node-adapters.ts`'s `listenTcp` is honest about this gap rather than claiming to have closed it:
`LISTEN_ACCEPT_QUEUE_LIMIT` bounds how many accepted-but-unclaimed connections one listener holds
before it starts resetting new ones outright, which keeps an unread `connections` stream from
pinning unbounded memory in the main process (T11b) without pretending to be OS-level
backpressure. Provisional, flagged for the same reason the write
heartbeat and dial timeout are (`../transport/relay/port-sink.ts`, `../adapters/node-adapters.ts`'s
own `DIAL_TIMEOUT_MS`): nothing in `contracts/` or `handle-contracts.md` specifies this number.

### `fs.ts`'s `open`: confining once, no `abort`, and why a stream errors on quota (A184)

**Confinement runs exactly once, at open, never again for `read`/`write`/`stat`/`truncate`/
`sync`/`readable`/`writable`.** Every other `fs` method re-derives a fresh `confineForOrigin`
call per invocation because each one carries a fresh path; `open`'s own operations carry no path
at all past acquisition; they address the real OS file descriptor `deps.fs.open` already
returned. A symlink swapped in on disk after `open()` returns cannot retarget an already-open fd
the way it could a second path lookup, so there is nothing left for a second confinement check to
catch. This mirrors `net.connect` exactly: the policy check runs once, at acquisition, and every
operation after it re-checks only OWNERSHIP of the handle (T11c, via `runFileIo`'s
`{on:'handle'}` scope), never the grant a second time.

**`FailableFileHandle` has no `abort`, unlike `FailableTcpSocket`.** A `TcpSocket` is one fixed
duplex, so "abort the socket" is unambiguous: tear the whole handle down with an RST. A
`FileHandle`'s `readable()`/`writable()` are FACTORIES, so an app may hold several live streams
over one handle at once, at different offsets, exactly matching this handle's own no-implicit-
cursor rule, so "abort the file" has no single stream to mean. Aborting one `writable()`
stream discards that stream's own buffered bytes through the real underlying `WritableStream`'s
own `abort()`, entirely below this interface; it never reaches into the handle table the way a
TcpSocket's `abort()` does, and the other streams the app may be holding are untouched.

**`writable()`'s quota check ERRORS the stream on the chunk that exceeds it, and does not
silently drop the chunk the way `udp.send`'s A87 counted loss does.** The two failures are not
the same shape (code-guidelines.md Rule 3's counterweight: extract or diverge on the REASON, not
the shape): a DHT peer list routinely names addresses outside a grant, so treating the first
excluded peer as fatal would kill a working swarm, and UDP has no delivery guarantee to violate
by dropping one packet. A torrent write that silently dropped bytes past quota would instead
corrupt the file actually landing on disk, and there is no "the app expected some loss here" for a
positional byte stream the way there is for a P2P transport. Positional `write()` gets the same
treatment via `reserveFsBytes`/`releaseFsBytes`; both paths share the SAME running per-origin
counter, so an app cannot bypass its declared quota by switching from one call shape to the
other.

**`destroy()`'s teardown (`../adapters/node-fs-adapter.ts`) is conditional on the close reason,
mirroring `destroySocket`'s A84 fix (`../transport/README.md`'s Design notes), but deliberately
does NOT reuse its `CLOSE_DRAIN_TIMEOUT_MS`.**
'closed'/'sessionEnded' let a still-queued `writable()` stream finish before the fd is released;
'revoked'/'aborted'/'failed' discard it outright: same two-way split, same reason (a flushing
reason must not truncate the app's own final bytes; an abrupt one has nothing worth preserving).
The socket version needs a deadline because `socket.end()`'s callback can wait forever on a REMOTE
PEER that has simply stopped reading. A local `fs.WriteStream` has no such adversary: it drains to
the OS's own `write()` syscall, bounded by real disk I/O, never by another party's willingness to
read anything. Proven directly, not assumed: `node-fs-adapter-open.test.ts`'s teardown tests fire a
write without awaiting it and call `destroy()` a line later, deterministic because JS is single-
threaded and a real fs write cannot complete before the test's own next synchronous statement runs,
the same trick that makes the test immune to disk speed.

**That same abrupt-teardown path has a SECOND escape past the file's own `nodeStream.on('error',
() => {})` guard, found while restoring a fix a usage-limit interruption had left reverted --
`Writable.toWeb` also settles `writer.closed`, `writer.ready`, and each individual
`writer.write(chunk)` call's own promise when it detects the premature close, none of which that
raw-stream 'error' listener ever sees. `writable()`'s `getWriter()` is wrapped (not called
eagerly, since acquiring and holding a writer before the caller does would lock the stream out from
under them) so that whichever writer the caller ends up creating gets a silent `.catch(() => {})`
attached to all three, alongside whatever handler the caller attaches itself, the instant it is
acquired. A `writer.abort()` at the WHATWG layer is not a substitute: it avoids the escape too,
but waits for an in-flight write to finish rather than interrupting it, which silently turns a
'revoked' close into a flush, confirmed by a probe where the full chunk landed.**

**`readable()`/`writable()` stop at the broker layer in this landing (2026-09-15, A184) --
still open, not forgotten.** They are real, adapter-level WHATWG streams, proven directly against
a real fd (`node-fs-adapter-open.test.ts`), and `../transport/relay/port-pump.ts`/`port-sink.ts`
are already generic enough to relay either one over a socket's dedicated port the same way
`net.connect`'s byte pump does; nothing about them is TCP-specific. What is missing is the wiring
itself: a control-channel case that mints a port pair for a `FileHandle` the way `net.connect`'s
`deliverTcpSocket` does for a `TcpSocket`, and the main-world stream construction on the preload
side (`main-world-socket.ts`'s `buildSocket` is the pattern to follow). It is deferred as a scope
decision, not a blocker (`docs/open-questions.md` A184). What that means a page cannot do yet: `window.orivon.fs.open(...)`'s returned object is deliberately
narrower than `FileHandle`, with no `readable`/`writable`, and its `closed` is not live-pushed
(revocation surfaces on the next operation attempted against the handle, not proactively).

### `fs.ts`: the quota counts what the files occupy

`fs.quotaBytes` is checked against the bytes the origin's files take up, which is what
`capability-api.md` A9 SS3 specifies, not against every byte ever written. A running count of
writes never went down: a database that rewrites its file on every load (nedb, as FreeTube uses
it, writes a temporary file and renames it over the original) reached any quota within one
session, however small the data.

- **Measured, not persisted.** The first operation that can change an origin's usage in a session
  (`writeFile`, `rm`, `rename`, `open`) first adds `BrokerFs.diskUsage(root)` to the count
  (`ensureMeasured`), so nothing has to survive a restart and nothing can drift across one.
- **`writeFile` charges growth.** The file's current size is read first; only the difference is
  reserved, and a smaller rewrite gives the rest back.
- **`rm` and `rename` give bytes back.** `rm` frees what `diskUsage` measured under the path just
  before removing it; a `rename` onto an existing file frees the replaced file.
- **What still over-counts, on purpose.** Writes through a `FileHandle` (positional `write`, and
  `writable()` streams) charge every byte they write, so rewriting a region of a file in place is
  charged again; `truncate` still charges growth and frees what it cuts. Concurrent `writeFile`s
  to one path each charge their own growth. Each of these errs towards `'limit'`, never past it.
- **What can under-count, and its bound.** A file removed or replaced while a handle to it is still
  open keeps its bytes on disk until that handle closes, but its bytes are given back at once.
  That is bounded by `LIMITS.concurrentFileHandles` open files and ends when they close or the
  session does. Files picked with `fs.userSelected` live outside the root: their writes charge the
  same count, but they are not part of the measurement.

### `web.ts` -- why a timed-out `evaluate` makes `closed` REJECT, not resolve

ADR-0019's own contract only names two `WebContext.closed` outcomes: reject `'revoked'` on
revocation, resolve on an *idle* close (`LIMITS.webContextIdleMs` with nothing running). A timed-
out `evaluate` is neither -- it is the broker force-closing a context that was doing something,
because a running script cannot be interrupted any other way. Two readings were possible, and
the resolving one was rejected:

- **Resolve, like the idle case.** Reads as "the platform's routine housekeeping recycled this,
  nothing is wrong" -- true for idle, false here. The app's own script overran its budget and got
  killed mid-flight; folding that into the same outcome as ordinary resource recycling would hide
  the one signal that tells an app it needs to write a faster or more defensive script.
- **Reject 'timeout' (chosen).** Matches what `evaluate` itself already rejects with, so an app
  awaiting `closed` learns the same thing an app awaiting `evaluate` learns, with no separate
  polling needed to tell "idle" from "killed" apart. It also reuses the exact mechanism this
  codebase already has for "a handle died rather than closed cleanly" --
  `HandleTable.fail(origin, handleId, code)`, the same call `net.ts`'s socket wrapper
  makes on a real I/O fault (a peer RST) -- rather than inventing a second one. `fail`'s own
  `CloseReason` is `'failed'`, which `../handles/handle-store.ts`'s `closeTree` already routes to
  a REJECTING `closed` (only `'closed'` resolves it); nothing new had to be taught to that file.

The deadline is `LIMITS.webContextEvaluateMs` unless the caller passes a shorter `timeoutMs`
(`evaluateDeadline`, clamped to the platform's, never extending it), and a caller-chosen deadline
closes the context exactly as the platform's does: it is the same interrupted-script problem.

Guarded against a narrow race: if a concurrent revoke already closed the same handle through its
own cascade by the time the timeout branch runs, `handleTable.fail` throws (the id is no longer
registered) rather than silently doing nothing -- caught and discarded here, because the timeout
error is still the right thing for `evaluate` to reject with regardless of which path actually
tore the context down.
