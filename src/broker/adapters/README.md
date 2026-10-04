# `src/broker/adapters/`: the seam where a decision becomes real I/O

**What lives here.** The Node implementations injected into `createBroker`: dialling a TCP or
TLS socket, binding a UDP one, resolving a host, reading and writing files, and tearing a socket
down. This is the only place in the broker a real address is dialled or a real path opened
([`ADR-0015`](../../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md)), so an
auditor asking what the program can reach starts here. `atomic-write.ts` is the plain-Node I/O
helper every store under `src/main/` and `src/broker/grants/` writes its small JSON files
through: a sync `writeFileAtomic` and an async `writeFileAtomicAsync`, both temp-file-then-rename.

**What it depends on.** `node:net`, `node:tls`, `node:dgram`, `node:dns/promises`, `node:fs`,
`node:fs/promises`, `node:stream`, [`../broker-contracts.ts`](../broker-contracts.ts),
[`../policy/connect.ts`](../policy/connect.ts) and
[`../policy/bind-scope.ts`](../policy/bind-scope.ts), for the address a scope binds.

**What it must never import.** `electron`; this layer is the *Node* seam, not the Electron one
([`../transport/`](../transport/) is where Electron lives). Nothing here may make a policy
decision; it performs one already taken.

**Tied to Electron?** No `electron` import, but it is the engine-specific layer: a different
engine would replace this directory and leave [`../handles/`](../handles/) and
[`../policy/`](../policy/) untouched
([`ADR-0002`](../../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**Owner stream.** `broker`.

## Design notes

**One deadline bounds a whole dial, and the addresses race.** `dialTcp` and `createDialTls` hand
their resolved addresses to `staggered-dial.ts`, which alternates the families, starts the next
address 250 ms after the last (at once when one fails), and stops everything at the first
success or at one 30 s deadline. A deadline per address multiplies: four addresses that drop
packets would cost 120 s, past the renderer's 35 s budget for a `net` call, and the app would
get a bare transport timeout instead of the broker's `timeout`. A TLS dial stops at a failure
past the connect, because the next address would answer the same.

**`nodeFs.readFile` copies rather than views its buffer.** A Node Buffer can be a window into a
shared pool slab, and structured clone (the path this value takes to the renderer) sends a
view's whole backing `ArrayBuffer`, so a view could hand the page bytes it never read.
`fs/promises.readFile` allocates exact-size today, but that is an unspecified Node detail; one
`memcpy` removes the dependence on it.

**UDP (`udp-adapter.ts`).** The inbound queue drops rather than queues past its window, in
`readableOf`, the one point that can read `controller.desiredSize`; a byte high-water mark with a
per-datagram floor enforces both the byte and the count bound (A86). `send` resolves a
`SendOutcome` and never throws, since a rejection would error the app's `WritableStream` for good
(A87). The code comments have the arithmetic.

**The interface a bind opens follows its scope, and only `'network'` widens.** `listenTcp` and
`bindUdp` take the scope the broker chose: `'local'` binds `127.0.0.1`, `'network'` binds
`0.0.0.0`, and any other value binds loopback. `localAddress` reports what was actually bound.

**Clean closes.** `destroySocket`'s drain deadline and the reason a file's `destroy` has none:
`CLOSE_DRAIN_TIMEOUT_MS`'s doc in `node-adapters.ts`, `node-fs-adapter.ts`'s `openFile` doc, and
A184.

**TCP and TLS sockets are wrapped in WHATWG streams by hand (`socket-streams.ts`), not by
`node:stream`'s `Duplex.toWeb`.** That adapter's own `finished()`-driven bookkeeping has a
confirmed, currently-unfixed Node engine bug
([nodejs/node#63761](https://github.com/nodejs/node/issues/63761)): under socket teardown churn
it can throw a bare `TypeError` (`Cannot read properties of undefined (reading 'error')`) out of
a socket's own async completion, with nowhere for `dialOne`'s, `wrapAccepted`'s or
`tls-adapter.ts`'s `dialOneSecure`'s caller to catch it -- taking the whole Electron main process
down through `index.ts`'s `uncaughtException` policy. A `TLSSocket` is a `net.Socket`
(`tls-adapter.ts`'s own header), so the same pair of functions covers both without a TLS-specific
copy. `socket-streams.ts`'s own readable/writable pair tracks one local `settled` flag per
direction instead, so a racing `reader.cancel()`, `writer.abort()` and the handle table's own
`destroySocket` call can never reach a second `controller.close()`/`controller.error()` call.
One behavioural difference this carries: the A69 half-close case (a peer FIN auto-ending our
writable under `allowHalfOpen: false`) is now reported deterministically, from an up-front
`socket.writable` check (`WRITABLE_ALREADY_ENDED_CODE`), not inferred from an error shape Node's
old adapter happened to produce -- `../transport/relay/port-sink.ts`'s `isWritableAlreadyEnded`
checks for it.
