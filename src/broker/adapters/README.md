# `src/broker/adapters/` — the seam where a decision becomes real I/O

**What lives here.** The Node implementations injected into `createBroker` — dialling a TCP
socket, resolving a host, reading and writing files, and tearing a socket down.

**What it depends on.** `node:net`, `node:dns/promises`, `node:fs`, `node:stream`,
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
