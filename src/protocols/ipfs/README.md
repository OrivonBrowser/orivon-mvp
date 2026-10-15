# `src/protocols/ipfs/`: the IPFS protocol

**What lives here.** The IPFS protocol ([`protocol.ts`](protocol.ts)): its descriptor, the `ipfs`
and `ipns` schemes, the resolvers for those addresses, and the `DataGatherer`
([`../resolution/`](../resolution/)) that loads every record naming IPFS content, a `.eth` name's
included. It reads a CID, an IPNS key or a DNSLink domain over trustless HTTP, from Orivon's own node on this
computer ([`../ipfs-node/`](../ipfs-node/)) or from public gateways as the person chose, each trusted for
availability only, and hashes every block against its CID before any of it is used.
[`ADR-0030`](../../../docs/decisions/ADR-0030-a-eth-name-is-an-origin-served-by-a-verifier.md) is
the design, and its 2026-09-26 amendment the gateway scheduling.

**Not tied to Electron.** Durable. It runs over an injected `fetch` and an injected TXT resolver.

**What it depends on.** [`../resolution/`](../resolution/); `multiformats`, `@ipld/dag-pb`,
`ipfs-unixfs`, `ipfs-unixfs-exporter` (path resolution, HAMT directories included) and `ipns`
(record parsing and signature checks): the primitives beneath Helia, which pulls in a native
module (Rule 8).

**What it must never import.** `electron`, `src/main/`, `src/loader/`, `src/broker/`, and any
`node:*` module. The verifier host gives it a `fetch` that reaches only the configured gateways,
and a TXT resolver.

**Owner stream.** `ens-ipfs`.

## Design notes

**[`blockstore.ts`](blockstore.ts) is the whole defence.** The exporter decodes whatever its
blockstore returns and never hashes a block, so it must only ever read through this one, which
returns a block only after [`verify-block.ts`](verify-block.ts) has checked it.

**The exporter's own file reader must not be used** ([`file-reader.ts`](file-reader.ts)). A block
failing two or more levels down escapes it as an unhandled rejection, which would end the verifier
host on one bad block from a hostile gateway. The exporter resolves paths only.

Why raw blocks and not CARs, and the limits' real-site figures:
[`spike-results/ens-ipfs.md`](../../../docs/planning/spike-results/ens-ipfs.md) section EI-1c.

**The node is one endpoint, read as a gateway is.** [`node-first.ts`](node-first.ts) mounts from the node when
the host says it is ready. When the node cannot serve (not ready, or ready but unable to find the content: an `unavailable` failure only) it mounts from
the gateways only if the person said yes for this load (`takeConsent`, which uses the yes up), labelling the mounted site (`servedFrom`) so the
person can be told, and otherwise throws `GatewaysOffered` (`../resolution/records.ts`), which the registry keeps through its aggregate
failure and the host's error page turns into the offer. The node's gatherer is the same one, built with `localNode`, with limits from what the real
node measured (`gatherer.ts` has the figures: blocks with a provider in 0.3 to 2.3 s, a lookup that finds
nothing in 25 to 93 s): 12 concurrent block reads, a 45 s block timeout, a 15 s IPNS record timeout so a name
service is asked inside a mount, a 5xx taken as the node's answer that it found nothing (so no retry passes and no
cooldown), and a block that fails its hash sits the node out for 30 seconds instead of dropping it for the
session. The hedge delay (2 s) is unchanged: a hedge has no second endpoint to ask here.

**A block the node could not give is asked for again, patiently.** The node remembers an empty lookup for
about 30 s, and a handshake a peer cut makes it answer a misleading instant 404 for as long. A page's files hit
that window together, and Chromium never asks again for a stylesheet, script or image that got an error page. So
`block-fetch.ts` asks again after `LOCAL_NODE_MISS_MEMORY_MS` (32 s, the memory plus a margin), twice at most, a
retry starting no later than 90 s after the first try began and only while the request is still wanted
(`retryWhileWanted`, in [`../gateways/fetch-passes.ts`](../gateways/fetch-passes.ts); the figures and what they
mean for the worst wait are with `LOCAL_NODE_BLOCK_RETRY` in `gatherer.ts`). Only an `unavailable` failure is
asked again: a lie or an unsupported block never is, and a block the node lacks is never asked of a public
gateway. A mount keeps its own budget. The gateways' own passes are the retry for public gateways and set no
`blockRetry`.
