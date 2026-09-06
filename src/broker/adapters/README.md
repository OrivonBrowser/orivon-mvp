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
