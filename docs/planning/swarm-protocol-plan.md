# Swarm as a built-in protocol: plan

**Need.** The owner asked for Swarm support, trustless and permissionless, built like IPFS: a
folder under `src/protocols/` and one function the verifier host calls. `docs/roadmap.md`
section Later lists "content-addressed stores other than IPFS"; this delivers Swarm from that line.

**Outcome.** `bzz://<reference>/path` opens a Swarm site, and a `.eth` name whose contenthash
names Swarm content opens it too, feeds included (`swarm.eth` itself is a feed). Every chunk is
hashed against its address before any byte is used; a gateway is trusted for availability only.
No API key, no account, no node of our own: any public Bee gateway with `/chunks` works.

## Owner decisions (they override anything below)

1. **Local node only, never public gateways.** Chunks come only from Bee-API endpoints, and the one
   Orivon will configure is a local Swarm node on the user's machine (a later step, not this PR).
   This PR's default endpoint list is **empty**: a `bzz://` address still canonicalises and a
   `.eth` contenthash still decodes, but `mount` throws `unavailable` in plain words (this build
   has no Swarm node to load from yet), with no request made. Config: `HostConfig.swarmEndpoints`,
   test seam `ORIVON_TEST_SWARM_ENDPOINTS`. No public gateway host appears in any tracked file.
2. **Feeds never depend on `/feeds`**, which the local node does not serve: the latest sequence
   index is found over `/chunks`, from the floor, by forward exponential probes and then a binary
   search, every hit's SOC verified, probes bounded (64). A miss is "no endpoint has it", never a
   refusal. A `/feeds` `swarm-feed-index` header, where an endpoint answers one, is only a starting
   guess, still verified and confirmed by probing guess+1.
3. **`swarm/` says "endpoints", not "gateways".** `SwarmGathererOptions.endpoints`, in order.
4. **A `.eth` name shows `bzz://` or `ipfs://` by where it lives**: shell work in a follow-up PR.
   This PR keeps `displayScheme: 'ipfs'` on ENS, gives ENS a neutral `loadingScreen` (no network
   named), and files no open question. Decision-log row `d-0602` records 1, 4 and "Swarm built in
   under `protocols/`".
5. **Name no Swarm client other than Bee** in any tracked file, commit or PR.

## Trust model

| Hop | How it is verified |
|---|---|
| `.eth` -> reference | Helios proves the contenthash, unchanged from today |
| reference -> chunk | Content-addressed chunk (CAC): `keccak256(span ‖ bmtRoot(payload))` must equal the address |
| file tree | Each intermediate chunk lists its children's addresses, so the root address commits to every byte; a child's span must equal the bytes its parent says it covers |
| manifest | Mantaray nodes are files read through the same verified joiner |
| feed -> update | Single-owner chunk (SOC): `address = keccak256(id ‖ owner)`, `id = keccak256(topic ‖ index as 8-byte big-endian)`, and the signature over `keccak256(id ‖ wrappedCacAddress)` (EIP-191 personal-message prefix) recovers to the feed owner |
| feed freshness | Not provable: a gateway can withhold the newest update. The index comes from the gateways' `/feeds` hint, never below the highest index this install has seen (persisted, as IPNS sequences are) |

## Measured facts (2026-10-12, live, from this machine)

- **Public Bee gateways from three operators** serve `/chunks/<hex>` and
  `/feeds/<owner>/<topic>`; a missing chunk is a 404 in about 0.5 s. Two of them redirect chunks
  their content filter refuses (the first chunk of an HTML page is one). None is used: Swarm loads
  only from a local node (Owner decisions). A redirect stays a per-chunk miss, never a strike
  against the endpoint, and `allowlisted` still follows none.
- **Erasure coding is in use.** `swarm.eth`'s `index.html` root chunk has span bytes
  `06 1d 01 00 00 00 00 81`. If the top byte is over 128, it carries the redundancy level
  (`byte & 0x7f`). The real span is the low 7 bytes (72966). The payload then lists 18 data refs
  followed by 5 parity refs. Do not port Bee's parity tables. The data refs are the leading refs whose
  spans sum to the parent's span: child 0's span is the unit, every non-last data child has exactly
  that span, and the last has the rest. Refs past those are parity and are never fetched. Leaves
  carry plain spans.
- **`/feeds` answers with headers** `swarm-feed-index: 000000000000005b` (hex uint64) and
  `swarm-feed-index-next`; read the index header only and cancel the body.
- **The feed update is legacy.** The wrapped CAC has span 40, and its payload is an 8-byte timestamp
  followed by a 32-byte reference. A wrapped CAC of any other size (except 72, an encrypted ref: unsupported) is
  itself the content's root chunk (Bee's "v2" feeds), its address computed locally.
- **ENS contenthash** of `swarm.eth`: `0xe4 01` then the CID `01 fa01 1b 20 <32 bytes>`
  (swarm-manifest 0xfa, keccak-256 0x1b). `fairdrive.eth` uses codec bytes `fa 03`. Accept
  any codec whose multihash is keccak-256 with a 32-byte digest, and canonicalise to 0xfa. The
  content is self-describing and fully verified, so the codec label changes nothing about trust.
- **Mantaray 0.2** (verified on `swarm.eth`): 32-byte obfuscation key, then everything after it
  XORed with that key repeating; 31 bytes = first 31 of `keccak256("mantaray:0.2")`; 1 byte ref
  size (32; 64 is encrypted and unsupported); entry; 32-byte fork bitmap (bit `b` = byte `b>>3`,
  mask `1 << (b & 7)`); per set bit in order: type (2 value, 4 edge, 8 path separator,
  16 metadata), prefix length (1..30), prefix padded to 30, child ref; with type & 16, a 2-byte
  big-endian length then that much JSON (string values only; `\n` padding). Site metadata
  (`website-index-document`, `website-error-document`) and feed metadata (`swarm-feed-owner`,
  `swarm-feed-topic`, `swarm-feed-type: Sequence`) sit on the fork with prefix `/`. File
  forks carry `Content-Type` and `Filename`.

A throwaway prototype walked `swarm.eth` end to end (ENS, feed, SOC, manifest, erasure-coded
file): 24 chunks, all verified. The real metadata chunks it captured (no page content) are
`src/protocols/swarm/tests/live-vectors.ts`.

## Design

### First commit: shared gateway scheduling

`ipfs/gateways.ts`, `ipfs/gateway-health.ts` and `ipfs/race.ts` know nothing about IPFS. Move them
and their tests, with `git mv`, to a new `src/protocols/gateways/`, with a `README.md` (durable;
depends on `resolution/` only). Update the imports in `ipfs/` and `verifier-host/egress.ts`, and make
the "no IPFS gateway configured" message generic. Move `BlockCache`'s partition logic only if it is
already generic over string keys; otherwise Swarm keeps its own small cache. Nothing else in the
first commit.

### `src/protocols/swarm/` (durable; depends on `resolution/`, `gateways/`, `multiformats`, `viem`)

| File | Holds |
|---|---|
| `descriptor.ts` | `describeProtocol({ id: 'swarm', schemes: ['bzz'], topLevelDomains: [], loadingScreen: { title: 'Loading from Swarm', detail: 'Every chunk is checked against its content address before it is shown.' } })` |
| `reference.ts` | Parse a reference from 64 hex (any case) or a CID (keccak-256, 32 bytes); 128 hex is refused as encrypted. `referenceCid` is CIDv1, codec 0xfa, base32: 61 characters, so it fits one 63-character host label where 64 hex cannot. That CID is the canonical spelling. |
| `chunk.ts` | `bmtRoot`, `cacAddress`, `readSpan` (size + level, refusing a size over `Number.MAX_SAFE_INTEGER`), `verifyCac`, `verifySoc` (viem `keccak256(bytes, 'bytes')` and `recoverMessageAddress({ message: { raw } })`). No new dependency |
| `chunk-fetch.ts` | One verified chunk from the pool, written like `ipfs/block-fetch.ts`: `GET <gateway>/chunks/<hex>`, capped read, verify, and a `Refusal` plus drop for a liar. **The whole defence**: nothing else reads a gateway's bytes |
| `joiner.ts` | A file from its root reference: size first, then a body that yields only verified leaves, in order, with a bounded window of children in flight (16), for a `GatherRange` too (skip whole subtrees by span) |
| `mantaray.ts` | Decode a node with bounds checks on every length, then `lookup(path)`, loading child nodes through the joiner |
| `feed.ts` | Detect a feed manifest; take the index hint (raced over the gateways) and the floor; fetch and verify the SOC; return the target root and a `PointerStep` |
| `gatherer.ts` | The `DataGatherer`. `supports` is a `swarm` pointer; `mount` follows feeds (`maxPointerHops`); `open` behaves as Bee does: an empty path or one ending in `/` serves the index document (`index.html` when none is named); a missing path tries `<path>/<index>`; otherwise `not-found`. Metadata `Content-Type` is used only for a path with no extension, and only when it matches a strict `type/subtype[; charset=x]` pattern. `ddoc` as `ipfs/gatherer.ts` |
| `address-resolver.ts` | `bzz:` resolver. `canonicalName` is the CID, and `resolve` refuses any other spelling, exactly as `ipfs/address-resolver.ts` does |
| `limits.ts` | Max bytes per open 1 GiB; tree depth 8; manifest node 1 MiB; 256 nodes per lookup; pointer hops 4; chunk timeout 30 s; 6 per gateway; hedge 1.5 s |
| `protocol.ts` | `export function swarmProtocol (options: SwarmGathererOptions): Protocol`, the single function |
| `README.md` | Shaped like `ipfs/README.md`: what lives here, its dependencies, what it must never import, and design notes (the trust table above, and that `chunk-fetch.ts` is the whole defence) |

Not Mantaray 0.2 is `unsupported`, as under Bee's `/bzz`. Named limits, refused in words:
encrypted references, Mantaray 0.1, epoch feeds, `website-error-document`.

### Shared types (`src/protocols/resolution/records.ts`)

- `ContentPointer` gains `{ kind: 'swarm', cid: string }`.
- `PointerStep` gains `{ step: 'swarm-feed', owner: string, topic: string, index: bigint, target: string }`.
- `ContentRoot.kind` becomes `'ipfs' | 'swarm'`, with `cid` still a CIDv1 base32 string. For Swarm
  this keeps the install pin, the update offer, `x-orivon-content-root`, the etag and Web3 Score ids
  (`cid:<swarm cid>`) working without a reshape. `CID_PATTERN` in `broker/policy/pin.ts` already
  matches.
- `pointer-chain.ts`: a `swarm-feed` step is verified (it is signed).

Fix each switch typecheck flags, then grep `'ipfs'` in `src/main`, `src/loader`, `src/renderer`. Known:
`main/verifier/host-messages.ts` (validators for the new kind, step, root and message),
`name-evidence.ts` (rows and the live line), `content-address.ts`, and
`main/browsing/page-score-lookup.ts`, which reads `*.ipfs.orivon` hosts (extend it to `*.bzz.orivon`
if that is direct).

### Wiring

- `ens/contenthash.ts`: decode 0xe4 to `{ kind: 'swarm', cid }`, building the CID inline with
  `multiformats`, never importing `swarm/`. A malformed value is `unsupported('swarm (malformed)')`.
- `ens/descriptor.ts`: its comment ("every name the verifier loads is IPFS content") is now false.
  Fix it. Keep `displayScheme: 'ipfs'` until the owner answers the question below.
- `builtin.ts`: add `SWARM`.
- `verifier-host/protocols.ts`: add `startSwarm(config, deps)`, with
  `allowlisted(config.swarmEndpoints, deps.fetch, 'the Swarm gatherer')` and a feed-index store
  built like `sequenceStore`, posting `{ type: 'swarm-feed-index', feed, index }`. The protocols
  become `[ens, ipfs, swarm]`.
- `verifier-host/protocol.ts`: add `HostConfig.swarmEndpoints` and
  `swarmFeedIndexes: Record<'<owner>/<topic>', decimal>`, plus the new `FromHost` message.
- `verifier-host/fixture-resolver.ts`: accept `bzz://<reference>`.
- `main/verifier/endpoints.ts`: `swarmEndpoints: []` (Owner decision 1).
- `main/verifier/verifier-store.ts`: persist feed indexes beside IPNS sequences, with their own key
  check (`/^[0-9a-f]{40}\/[0-9a-f]{64}$/`) and cap. `verifier-subsystem.ts` passes the config and
  stores the message. `test-seam.ts` reads `ORIVON_TEST_SWARM_ENDPOINTS`. `status-view.ts` lists "Swarm endpoints".
- `broker/policy/pin.ts`: add `'swarm'` to `ContentAddress.via` and to `CONTENT_VIA`, and change the
  comment to "IPFS or Swarm". This file is broker code, so it gets a test and `/security-review`.

The DNS-tamper fallback (A251) stays IPFS-only in this step: a named limit.

## Tests

Unit tests in `src/protocols/swarm/tests/`, one file per module. Musts: the live vectors (addresses,
the level-encoded span, the SOC recovering `0xf77a13dc2f786b4523f5e0bf6db6757f4cf60ebb`, its legacy
payload giving `c9890fb2...`, the manifest's `/` giving `index.html` whose entry is `b72fa3b8...`);
joiner sizes 0, 1, 4096, 4097, 128x4096, 128x4096+1, 129x4096, ranges, parity refs never fetched,
a child span mismatch `unverifiable`; Mantaray with a non-zero obfuscation key, padded metadata,
prefix length 0 or 31 and truncation refused; a floor above a stale hint wins; a foreign signature
refused with `sourceFault`; the gatherer's index, directory index, not-found, content-type rules,
range, a tampered gateway refused while another serves, and DDOC. Update the tests that expected
Swarm to be unsupported (`ens/tests/contenthash`, `ens/tests/resolver:160`,
`ipfs/tests/gatherer:37`, `ipfs/tests/pointers:253`) and the host-messages, pin, verifier-store and
registry tests.

**Test encoder** `test/apps/swarm-gateway/encode.mjs`, standalone (nothing under `test/apps/` may
import `src/`, `test/README.md`): Bee's left-filled chunker with an optional level byte and fake
parity refs, the Mantaray 0.2 marshal, and the feed-update signer (viem
`privateKeyToAccount(...).signMessage({ message: { raw } })`). Unit tests import it if
`check:test-paths` allows. **Fixture gateway** `gateway.mjs` + `README.md` beside it, shaped like
`test/apps/ipfs-gateway/gateway.mjs`: `/chunks/<hex>`, `/feeds/<owner>/<topic>` with the index
headers, a request log, flip-a-byte and redirect-this-chunk switches.

**e2e** `test/web3/e2e-swarm-address.test.ts`, `[app:swarm-url-opens]`: a typed `bzz://<64 hex>`
is shown as `bzz://<cid>/`, runs at `https://<cid>.bzz.orivon/` as a secure context, and its script
runs; a `bzz://` link is followed; a fixture `site.eth` -> `bzz://<feed manifest>` with two updates
shows update 2; a gateway serving only tampered chunks gives the cannot-verify page. Catalogue row
`swarm-url-opens` in `test/app-behaviours/catalogue.md` section Names and addresses.

## Docs

- `ADR-0077-swarm-content-is-verified-chunk-by-chunk-over-untrusted-gateways.md`: the trust table,
  the CID as canonical spelling and root identity, feed freshness as hint plus floor, the three
  operators, Bee parity on index documents, the named limits. Decision-log row `d-0602`.
- `src/protocols/README.md` (lists `swarm/`, `gateways/`); `docs/features.md` (`bzz://`, `.eth` on
  Swarm); `docs/roadmap.md` Later ("other than IPFS and Swarm"); the compatibility matrix's `.eth`
  delivery row ("no Arweave", human-readable prose); `docs/architecture/security-model.md` and
  `SECURITY.md` wherever IPFS gateways are named as availability-only or as seeing the user's IP.

## PR shape

One PR from `stream/swarm`, commits in this order: gateway move; primitives with tests; gatherer,
resolver, protocol and wiring; feeds and persistence; main side and pin; fixture gateway and e2e;
docs and ADR. Before pushing: `npm run typecheck`, `npm run test:changed 2>&1 | tail -5`, the
`check:*` guards (`docs/development/testing.md`), and the specs `select-e2e` names, each through
`~/.claude/orivon-fleet/bin/heavy`. Body per `docs/development/pr-blueprint.md`.
