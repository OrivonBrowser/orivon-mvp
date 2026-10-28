# `src/protocols/swarm/`: the Swarm protocol

**What lives here.** The Swarm protocol ([`protocol.ts`](protocol.ts)): its descriptor, the `bzz`
scheme and its resolver, and the `DataGatherer` ([`../resolution/`](../resolution/)) that loads
every record naming Swarm content, a `.eth` name's included. It reads a reference or a feed over
the Bee API's `/chunks` route, and a file's leaves over `/bytes`, and hashes every chunk against its
address before any of it is used.
A site is a Mantaray manifest over a chunk tree; a feed is a topic and an owner whose signed
updates name the content's newest root. [`ADR-0077`](../../../docs/decisions/ADR-0077-swarm-content-is-verified-chunk-by-chunk-from-a-local-node.md)
is the design; [`ADR-0099`](../../../docs/decisions/ADR-0099-a-swarm-files-leaves-are-read-together-and-checked-one-by-one.md)
adds the leaves read together, and [`ADR-0102`](../../../docs/decisions/ADR-0102-verified-swarm-chunks-are-kept-on-disk-per-site-in-the-verifier-host.md)
keeps verified chunks on disk, in the host that runs this code.

**Not tied to Electron.** Durable. It runs over an injected `fetch`.

**What it depends on.** [`../resolution/`](../resolution/), [`../gateways/`](../gateways/) (the
scheduling every content-addressed protocol shares), `multiformats` and `viem` (keccak-256 and
signature recovery).

**What it must never import.** `electron`, `src/main/`, `src/loader/`, `src/broker/`, any `node:*`
module, and another protocol's folder. The verifier host gives it a `fetch` that reaches only the
configured endpoints; with none configured, a mount fails as `unavailable` and nothing is asked.

**Owner stream.** `ens-ipfs`.

## Design notes

**[`chunk-fetch.ts`](chunk-fetch.ts) is the whole defence.** Nothing else reads an endpoint's
bytes. A chunk is used only after [`chunk.ts`](chunk.ts) has recomputed its address (content
chunks) or recovered its signer (single-owner chunks); an endpoint that sends bytes failing that is
quarantined for 30 seconds, not dropped, because the usual endpoint is the one node on this machine
and a restart can make it send one truncated answer. The refusal is still recorded.
A feed's end is only a 404 from every endpoint; an endpoint that does not answer makes the lookup
`unavailable`, never an older update.

| Hop | How it is verified |
|---|---|
| reference to chunk | `keccak256(span, bmtRoot(payload))` equals the address |
| leaf read with its siblings | rebuilt with the span its parent declares, it hashes to the address its parent lists |
| file tree | each intermediate chunk lists its children, and a child's span must equal the bytes its parent says it covers ([`joiner.ts`](joiner.ts)) |
| manifest | Mantaray nodes are files read through the same joiner ([`mantaray.ts`](mantaray.ts)) |
| feed to update | the single-owner chunk's signature recovers to the feed owner ([`feed.ts`](feed.ts)) |

**A file's leaves are read together.** Each 4 KB chunk is a round trip to the node, so a file is
read by its intermediate chunks: the up to 128 leaves under one are asked for in a single
`/bytes/<intermediate address>` request for the whole subtree (`ChunkSource.leaves`); a `Range`
makes the node's answer many times slower, so the bytes a read does not need are skipped. A leaf is used only once it hashes to the address its parent lists; a leaf
the answer does not hold, or holds wrong, and every one after it, is fetched alone over `/chunks`,
so a node that cannot answer in bulk costs time, never a byte. A failed bulk read is not held
against the node, and each leaf is shared with any other read of it, as a chunk is. [`joiner.ts`](joiner.ts) keeps `AHEAD` leaves in flight across the whole file,
not one intermediate chunk at a time, and asks for each intermediate chunk's first child as soon
as it arrives, since the others' sizes wait on it.

**The gatherer keeps verified chunks through an option, and never touches a disk.** `SwarmGathererOptions.memory` is the
`BlockMemory` ([`../gateways/cache.ts`](../gateways/cache.ts)) a gatherer keeps chunks in between mounts; unset, it is an in-memory
`BlockCache`. The verifier host passes one that also keeps them on disk
([`../verifier-host/swarm-chunk-database.ts`](../verifier-host/swarm-chunk-database.ts), which says where, keyed how and cleared how):
only content-addressed chunks (the ones `ChunkSource.get` and `ChunkSource.leaves` remember), never a single-owner chunk or a feed
update, which are asked for because they may have changed. A chunk read back is hashed against its address again by the store, so
nothing here trusts the disk. The disk is the optional `BlockMemory.recallKept`, a slower store behind the cache that answers on a turn
of the event loop of its own: `ChunkSource.get` asks it after the cache, and `ChunkSource.leaves` asks it for every leaf of a file
before the rest go to the node in one `/bytes` request, so a file read from disk never holds the process, and this directory still
imports nothing from `node:`. A mount with no partition keeps nothing in either place. The mount's log line, and a large file's,
say how many chunks `recallKept` took from disk for that mount or that read alone, whatever else was running.

**A reference is spelled as a CID.** 64 hex characters cannot be one host label, so the canonical
spelling is a CIDv1 of codec swarm-manifest over keccak-256 ([`reference.ts`](reference.ts)), 61
characters; the resolver refuses any other spelling so that one site has one origin.

**The newest feed update is found over `/chunks`.** A node need not serve `/feeds`. The search
starts at the highest index seen before (or an endpoint's `/feeds` answer, which is only a guess to
verify), doubles forward until an index has no chunk, then halves the gap; the probes are bounded.
The floor, the index after it and the `/feeds` guess are asked at once, so a feed with no new
update costs one round trip.
Freshness is not provable: an endpoint can hide the newest update, and the persisted floor only
stops a rollback.

**Erasure-coded files need no parity tables.** The top byte of a span above 128 carries the
redundancy level; the data references are the leading ones whose spans sum to the parent's span, so
parity references are recognised by arithmetic and never fetched.

**Zero bytes after a payload are accepted.** The address hashes every payload as if padded with zeros
to 4096 bytes, so a chunk stored padded and the same chunk unpadded are one address. The joiner reads
`span` bytes of a leaf and the references an intermediate chunk needs; a feed update reads its 40
bytes. A non-zero byte after any of them is refused, because that is content, not padding, and so is an
intermediate payload that is not a whole number of references.

**Named limits**, each refused in words: encrypted references, Mantaray 0.1, epoch feeds, and a
manifest's `website-error-document`.
