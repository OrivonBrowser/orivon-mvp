# ADR-0077: Swarm content is verified chunk by chunk and read only from a Bee node the person runs

- **Status:** accepted. The node Orivon will configure is a later step; until then this build opens no Swarm content outside tests (*provisional* on how that node is installed and found).
- **Date:** 2026-10-12
- **Type:** architecture / security
- **Decided by:** owner (items 1 to 4); AI recommendation accepted by default (the rest)

## Decision

Swarm is a built-in protocol under `src/protocols/swarm/`, shaped like IPFS: a descriptor, a `bzz://` address resolver, a `DataGatherer`, and one function (`swarmProtocol`) the verifier host calls. `bzz://<reference>/path` opens a site, and a `.eth` name whose contenthash names Swarm content opens it too, a feed included. Every chunk is hashed against its address before any byte of it is used.

1. **Chunks come only from Bee-API endpoints, and the one Orivon will configure is a node on the person's own machine.** No public gateway is ever asked. The default endpoint list is empty: a `bzz://` address still canonicalises and a contenthash still decodes, but opening the content fails as `unavailable` with a plain sentence, and no request is made. Config is `HostConfig.swarmEndpoints`; the test seam is `ORIVON_TEST_SWARM_ENDPOINTS`.
2. **Feeds never depend on a node's `/feeds` route**, which the local node does not serve. The newest update is found over `/chunks` alone: from the highest index this install has seen (or a `/feeds` answer, where an endpoint gives one, as a first guess that is still verified), forward by doubling steps until an index has no chunk, then by binary search, every hit's signature verified and the probes bounded. A miss is "no endpoint has it", never a refusal.
3. **`swarm/` says "endpoints", not "gateways"**, since what it asks is a node.
4. **A `.eth` name keeps showing `ipfs://`** whichever network its content is on, and the shell's loading screen for a `.eth` name names no network. Showing `bzz://` or `ipfs://` by where the content lives is shell work for a later change.
5. **The canonical spelling of a reference is a CIDv1** of codec swarm-manifest (0xfa) over keccak-256, 61 characters in base32, because 64 hex characters cannot be one host label (63 at most). `bzz://<64 hex>` redirects to it, `https://<cid>.bzz.orivon/` is the origin, and the same CID is the content root for the install pin, the update offer and Web3 Score ids.
6. **Named limits, each refused in words:** encrypted references, Mantaray 0.1, epoch feeds, a manifest's `website-error-document`, and the DNS-tamper fallback (IPFS only).

## Context

The owner asked for Swarm, trustless and permissionless, built like IPFS. Public Bee gateways serve `/chunks`, but each is an operator that sees every chunk the person asks for (so the site they open), and some redirect chunks their content filter refuses. A node on the person's machine sees nothing outside it and has no filter.

## Trust

| Hop | How it is verified |
|---|---|
| `.eth` to reference | Helios proves the contenthash, unchanged |
| reference to chunk | Content-addressed chunk: `keccak256(span, bmtRoot(payload))` equals the address |
| file tree | Each intermediate chunk lists its children's addresses, so the root commits to every byte; a child's span must equal the bytes its parent says it covers |
| manifest | Mantaray nodes are files read through the same verified joiner |
| feed to update | Single-owner chunk: address `keccak256(id, owner)`, `id = keccak256(topic, index as 8 bytes big-endian)`, and the signature over `keccak256(id, wrapped chunk address)` (EIP-191 prefix) recovers to the feed owner |
| feed freshness | Not provable: an endpoint can withhold the newest update. The search starts from the highest index this install has seen, persisted as IPNS sequences are, and never goes below it |

`chunk-fetch.ts` is the whole defence: nothing else reads an endpoint's bytes. An endpoint that sends a chunk failing its address is refused that chunk and quarantined for 30 seconds, not for the session, since the one local node can send a truncated answer once after a restart. The end of a feed is only a 404 from every endpoint; an endpoint that does not answer makes the lookup `unavailable`, never an older update.

## Alternatives considered

- **Public gateways as the default list.** Rejected by the owner: each sees what the person opens, and a gateway can refuse content by redirect.
- **A single `/feeds` call for the newest index.** Rejected: the local node does not serve it, and the answer is unproven.
- **Reading a Swarm site through the node's `/bzz` route.** Rejected: it returns bytes with nothing to check them against.
- **Porting Bee's erasure-coding tables.** Rejected: the data references are the leading ones whose spans sum to the parent's span, so parity references are recognised without the tables and never fetched.

## Reasoning

Verification by chunk address makes the endpoint's honesty irrelevant to correctness, so the only question left is who may see the requests, and the answer is the person's own node. Probing for the feed index over `/chunks` uses the one route every node serves.

## Consequences

- Until a node is configured, Swarm content cannot be opened outside tests. The settings page lists "Swarm endpoints" as empty.
- Feed freshness rests on the endpoint not hiding the newest update; the persisted floor stops a rollback after one honest answer.
- ENS content on Swarm shows as `ipfs://<name>` for now.
- Shared gateway scheduling lives in `src/protocols/gateways/`; the IPFS and Swarm protocols both read through it.

## Reversibility

- **Cost to reverse:** cheap for the endpoint list (one constant); moderate for the CID spelling, which becomes an origin.
- **What would make us revisit:** a person who cannot run a local node needing a hosted endpoint, which would be a new decision about who may see their requests.
