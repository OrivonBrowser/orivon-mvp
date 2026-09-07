# `src/broker/adapters/` — the seam where a decision becomes real I/O

**What lives here.** The Node implementations injected into `createBroker` — dialling a TCP
socket, binding a UDP one, resolving a host, reading and writing files, and tearing a socket
down.

**What it depends on.** `node:net`, `node:dgram`, `node:dns/promises`, `node:fs`, `node:stream`,
[`../broker-contracts.ts`](../broker-contracts.ts) and [`../policy/connect.ts`](../policy/connect.ts).

**What it must never import.** `electron` — this layer is the *Node* seam, not the Electron one
([`../transport/`](../transport/) is where Electron lives). Nothing here may make a policy
decision; it performs one already taken.

**Owner stream.** `broker` — build step 2.

## Why a directory for one file

`node-adapters.ts` is the whole of it today, and that is the point rather than an oversight:
this is the **only** place in the broker where a real address is dialled or a real path is
opened, so an auditor asking "where does this program touch the network or the disk?" has one
answer. It is also the layer `ADR-0002` calls disposable — a different engine replaces this
directory and leaves [`../handles/`](../handles/) and [`../policy/`](../policy/) untouched.
`udp.send`, `tcp.listen` and the fs quota reconciliation all land here when they are built.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**`destroySocket`'s `CLOSE_DRAIN_TIMEOUT_MS` closes half of A84.** A clean close
(`socket.end(cb)`) does not settle until every queued byte has drained into the peer's receive
window, and a peer that stops reading never lets that happen — the deadline guarantees `closed`
still resolves. See [`../README.md`](../README.md)'s design notes for the other half (the unlink
hook) and why both were needed together.

**`nodeFs.readFile` copies rather than views its buffer.** `fs/promises.readFile` happens to
allocate exact-size today, so the zero-copy alternative is not actually leaking anything right
now — but that is an unspecified Node implementation detail, not a guarantee, and structured
clone (the path this value takes to the renderer) serialises an `ArrayBufferView`'s whole backing
`ArrayBuffer`. A pooled view would hand the page bytes it never read. One `memcpy` removes the
dependence on that detail entirely rather than relying on it holding.

### [`udp-adapter.ts`](udp-adapter.ts) — why one queuing strategy enforces two bounds

The inbound window has a count bound and a byte bound, and needs both
(`docs/open-questions.md` A86). Checking them separately would mean two numbers that can drift
apart and two places to get the drop decision right. Instead the readable's high-water mark is
the **byte** bound, and every datagram is charged at least `window / count` — so a flood of tiny
datagrams exhausts the byte budget after exactly `LIMITS.inboundDatagramWindow` of them, and the
count bound falls out of the same arithmetic. One strategy, one drop decision, both bounds.

The bound is approximate by at most one maximum datagram, because WHATWG lets a queue overshoot
its high-water mark by whatever chunk was last enqueued. Accepted deliberately: refusing a
datagram that *would* overshoot means a 65507-byte packet becomes undeliverable whenever the
queue is nearly full, which is a worse failure than 64 KiB of slack.

### Why `send` returns a value and never throws

`BoundUdpSocket.send` resolves to a `SendOutcome` rather than rejecting, including for a
permission denial. The reason is not style: the app's outbound side is a
`WritableStream<Datagram>`, a WritableStream reports one failed write only by rejecting its
sink's promise, and that errors the stream **permanently**. A DHT peer list routinely names
addresses outside a grant, so the first excluded peer would tear down a working swarm. The
refusal is counted instead — `docs/open-questions.md` A87 records the decision and its honest
cost.

`sendOne` therefore also catches `socket.send`'s **synchronous** throw (a closed socket, a
malformed address), which the callback never sees. A throw escaping there would reach the app's
writable and do exactly what the value return exists to prevent.

### Why the drop lives here rather than in the relay

`controller.desiredSize` is the only honest reading of how full the queue actually is, and it is
only available at the point a datagram is either taken or not. Putting a second drop point in
the transport relay would mean two places deciding the same thing with two different views of
the queue.
