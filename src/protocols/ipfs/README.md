# `src/protocols/ipfs/`: the IPFS protocol

**What lives here.** The IPFS protocol ([`protocol.ts`](protocol.ts)): its descriptor, the `ipfs`
and `ipns` schemes, the resolvers for those addresses, and the `DataGatherer`
([`../resolution/`](../resolution/)) that loads every record naming IPFS content, a `.eth` name's
included. It reads a CID, an IPNS key or a DNSLink domain over trustless HTTP gateways, trusted for
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
[`spike-results/ens-ipfs.md`](../../../docs/planning/spike-results/ens-ipfs.md) §EI-1c.
