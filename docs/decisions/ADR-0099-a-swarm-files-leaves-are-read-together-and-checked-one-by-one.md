# ADR-0099: A Swarm file's leaves are read together from the node and checked one by one

- **Status:** accepted. Amends [`ADR-0077`](ADR-0077-swarm-content-is-verified-chunk-by-chunk-from-a-local-node.md): its alternative "Reading a Swarm site through the node's `/bzz` route" stays rejected, and `/bytes` is read only as described here. Its read-ahead of 256 leaves is amended by `d-0741`: 1024, with the node keeping 250 peers.
- **Date:** 2026-10-27
- **Type:** architecture / security
- **Decided by:** AI recommendation accepted by default, under the owner's ask that Swarm load as fast as IPFS while staying trustless and served only by the person's own node

## Decision

The Swarm gatherer reads the leaves under one intermediate chunk (up to 128 leaves of 4 KB, 512 KB of a file) in one `/bytes/<intermediate address>` request to the node for the whole subtree, whose leading bytes the read already holds are skipped. Each leaf is rebuilt as the chunk its parent lists (the span the parent declares, then its bytes) and used only once its address, recomputed from those bytes, is the one the parent lists. A leaf the answer does not hold, or holds wrong, and every leaf after it in that answer, is fetched alone over `/chunks` as before. The root, the intermediate chunks, manifest nodes and feed updates are still read over `/chunks` alone. A failed bulk read is not noted against the node, so it never cools the node for the per-chunk reads that follow. Each leaf is shared with every other read of it, as a chunk is, so a page and the first-visit keeper reading one file at once send one request per subtree between them.

## Context

The owner found Swarm sites, feeds most of all, far slower to open than the same app on IPFS, and asked for Swarm as fast as IPFS or faster, trustless and decentralized. Measured on the WebTorrent app (an 8.9 MB main script) with Orivon's own node, each run from a cold node with a fresh peer set, under a cap of two cores at the lowest CPU priority:

| How the leaves were read | The page and its script |
|---|---|
| one `/chunks` request per leaf, 6 at a time, 16 ahead within one intermediate chunk | 141 s, 2,222 requests |
| one per leaf, 64 at a time, 256 ahead across the file | 32 s, 2,222 requests |
| one `/bytes` request per intermediate chunk, 256 leaves ahead | 25 s, 87 requests |
| the same, 2,048 leaves ahead (every intermediate chunk at once) | 32 s: each answer took about 24 s |

An IPFS block is 256 KB, so the same script on IPFS is about 36 verified reads. The node's own retrieval, about 0.4 to 0.7 MB/s however it is asked, is what is left.

## Trust

Unchanged from ADR-0077. Every byte used is in a chunk whose address was recomputed from it: a leaf from `/bytes` is checked against the address its verified parent lists, under the size that parent declares, exactly as a leaf from `/chunks` is checked against the address it was asked by. `/bytes` is a transport here, never a source of truth: a node that sends wrong bytes, or none, costs the per-chunk reads it would have cost anyway, never a byte the page sees.

## Alternatives considered

- **Reading whole files over `/bytes` or `/bzz` and trusting them.** Rejected: nothing would check the bytes, which ADR-0077 already refused.
- **More concurrent `/chunks` requests alone.** Kept as the fallback and raised to 64, but not enough: 128 at a time was no faster than 64 (35 s), and each 4 KB request costs the node more than its share of a `/bytes` answer.
- **One `/bytes` request for a whole file, checked as the intermediate chunks arrive.** Not taken: the leaves would have to be buffered until the chunks that list them are verified, and a failure would cost the whole file; one request per intermediate chunk keeps every check local to one verified parent.
- **A `Range` for only the leaves a read needs.** Not taken: measured on the node, a ranged answer for 483 KB of a 487 KB subtree took 28 to 29 s, the same subtree whole 2.5 s. A read of part of a subtree costs at most 512 KB more than it needs.
- **Every intermediate chunk's leaves asked for at once.** Not taken: measured above, the node splits its throughput between them and the file arrives no sooner; 256 leaves ahead (1 MB, two intermediate chunks) keeps it busy.
- **Recording a wrong leaf from `/bytes` as a refusal and quarantining the node.** Not taken: the node's own joiner or a redundancy encoding it applies may legitimately produce an answer this check cannot use, and with one node a quarantine would stop the per-chunk reads too. A wrong leaf is simply not used.

## Reasoning

The cost of a Swarm file was round trips, not bytes or hashing. Reading 128 leaves per request removes 127 of every 128 round trips while every leaf is still checked against a verified parent, so the endpoint is trusted no more than before and stays the person's own node.

## Consequences

- A file is read about as many requests as its intermediate chunks plus the intermediate chunks themselves, a few dozen for a typical app.
- A node without `/bytes`, or one that answers it wrongly, still serves every site at the speed of `/chunks`.
- `askGateway` takes an `unnoted` request, shared with IPFS but used only here.

## Reversibility

- **Cost to reverse:** cheap: the joiner works without the bulk read, which is one optional argument.
- **What would make us revisit:** a node whose `/bytes` answers cannot be checked leaf by leaf (an encoding of leaf spans this rebuild does not reproduce), seen as `swarm: a bulk read gave` lines in a report's log; or a node whose ranged answers cost what whole ones do.
