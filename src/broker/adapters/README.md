# `src/broker/adapters/`: the seam where a decision becomes real I/O

**What lives here.** The Node implementations injected into `createBroker`: dialling a TCP or
TLS socket, binding a UDP one, resolving a host, reading and writing files, and tearing a socket
down. This is the only place in the broker a real address is dialled or a real path opened
([`ADR-0015`](../../../docs/decisions/ADR-0015-the-broker-is-organised-by-job.md)), so an
auditor asking what the program can reach starts here.

**What it depends on.** `node:net`, `node:tls`, `node:dgram`, `node:dns/promises`, `node:fs`, `node:stream`,
[`../broker-contracts.ts`](../broker-contracts.ts) and [`../policy/connect.ts`](../policy/connect.ts).

**What it must never import.** `electron`; this layer is the *Node* seam, not the Electron one
([`../transport/`](../transport/) is where Electron lives). Nothing here may make a policy
decision; it performs one already taken.

**Tied to Electron?** No `electron` import, but it is the engine-specific layer: a different
engine would replace this directory and leave [`../handles/`](../handles/) and
[`../policy/`](../policy/) untouched
([`ADR-0002`](../../../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**Owner stream.** `broker`.

## Design notes

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

**Clean closes.** `destroySocket`'s drain deadline and the reason a file's `destroy` has none:
`CLOSE_DRAIN_TIMEOUT_MS`'s doc in `node-adapters.ts`, `node-fs-adapter.ts`'s `openFile` doc, and
A184.
