# `src/ipfs/`: the IPFS gatherer

**What lives here.** The `DataGatherer` ([`../resolution/`](../resolution/)) that loads a site
from an IPFS CID, an IPNS key or a DNSLink domain, over trustless HTTP gateways that are trusted
for availability only. Every block is hashed against its CID before any of it is used, every IPNS
record is checked against its key's signature, and the DDOC report of one navigation says whether
every pointer and every byte was verified.

**Not tied to Electron.** Durable. It runs over an injected `fetch` and an injected TXT resolver.

**What it depends on.** [`../resolution/`](../resolution/); `multiformats`, `@ipld/dag-pb`,
`ipfs-unixfs` and `ipfs-unixfs-exporter` (path resolution, HAMT directories included), and `ipns`
(record parsing and signature checks). Helia and `@helia/verified-fetch` are out: they pull in
`node-datachannel`, a native module (Rule 8).

**What it must never import.** `electron`, `src/main/`, `src/loader/`, `src/broker/`, and any
`node:*` module. The verifier host gives it a `fetch` that reaches only the configured gateways,
and a TXT resolver.

**Owner stream.** `ens-ipfs`.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**Verification lives in [`blockstore.ts`](blockstore.ts), not in the exporter.** The exporter
decodes whatever its blockstore returns and never hashes a block. So this blockstore is the one
place where bytes from the network become bytes the rest of the code may use, and it returns a
block only after [`verify-block.ts`](verify-block.ts) has checked it. It also refuses every codec
but `dag-pb` and `raw`, and every hash function but `sha2-256` and identity, before asking anyone,
even though the exporter could decode more. A CID this build cannot verify is `unsupported`, never
skipped.

**A refusal and an outage are different failures.** A gateway that sends bytes which fail their
hash has lied. It is dropped for the rest of the session, and the refusal goes into the DDOC
report, which the site-info popover names. A gateway that is down, answers 404 or times out has
only failed to help, so it stays in the pool. When every gateway has lied the failure is
`unverifiable`; when none answered it is `unavailable`. A block that hashed correctly but breaks a
limit is the site's own content, so no gateway is blamed for it.

**DDOC fails only when a resource could not be served verified from any source.** A refusal
followed by a verified copy from another gateway still meets DDOC, since nothing unverified was
used. A missing path, or no gateway answering, does not fail it either. [`gatherer.ts`](gatherer.ts)
records the first resource that failed as `unverifiable`.

**Limits are per request and count cache hits** ([`limits.ts`](limits.ts),
[`blockstore.ts`](blockstore.ts)'s `blockstoreFor`). The exporter walks a DAG recursively, so a
depth bomb is a chain of single-link nodes. Counting every block a request touches, cached or not,
bounds that walk without needing to see the depth. Verified blocks are cached across sites,
because a content-addressed block is the same block whoever links to it.

**An IPNS record older than one already seen is refused** ([`ipns.ts`](ipns.ts)). A gateway
could otherwise serve an old, validly signed record and roll a site back. The highest sequence
per key comes from an injected store; the verifier host keeps it across restarts. An expired
record is not treated as a lie, because it was genuinely signed.

**A path inside an IPNS or DNSLink target is refused** ([`names.ts`](names.ts)). `/ipfs/<cid>/sub`
would make a site's root a subdirectory of another DAG. That is legal IPFS, but nothing in this
build needs it, and refusing it keeps one root per site.

**Raw blocks, not CARs, are what this build fetches.** Measured against three public gateways,
raw blocks at 8 to 16 in flight fetched a 30 MB file in 4 to 7 seconds in every condition, while
one CAR per file took 5 to 70 seconds, streamed with no failover partway through. Raw also gives
failover per block, bounded work per request, and byte ranges without asking the gateway for them.

**A file's bytes are read by [`file-reader.ts`](file-reader.ts), not by the exporter.** The
exporter's own file reader raises a block failing two or more levels down a second time, as an
unhandled rejection, and an unhandled rejection ends the process running it. One bad block from a
hostile gateway would then take down the verifier host. The reader here walks the same UnixFS
nodes, starts at most eight fetches ahead with every failure observed, checks each child against
the size its parent declared, and refuses a DAG deeper than `maxDagDepth`. The exporter still
resolves paths, which is where HAMT directories need it.

**An IPNS record may come from a name service as well as a gateway**
([`ipns.ts`](ipns.ts)). Some names publish their record only to a service such as w3name, where
no gateway's routing finds it. A record from either is checked the same way, and a forged one is
refused and named as a refusal.
