# ENS and IPFS spike: results

The three measurements [`ens-ipfs-plan.md`](../ens-ipfs-plan.md) §EI-1 asked for, taken on
2026-09-24 with Electron 44.0.0 (Chromium 152), Node 24, on Linux x64, from one residential line.
One client and one afternoon, so the timings are indicative, not a benchmark. The raw numbers are
in `ens-ipfs-ei1a.json`, `ens-ipfs-ei1b.json` and `ens-ipfs-ei1c.json` beside this note. No spike
code is kept.

## EI-1a: how a `.eth` tab is served. GO for the loopback design

The design: a TLS server on `127.0.0.1:<port>` serves every `.eth` host, Chromium reaches it
through one `MAP *.eth 127.0.0.1:<port>` resolver rule, and each session accepts its certificate
by fingerprint only.

| Gate | Result |
|---|---|
| 1. Wildcard rule in the default session and in a partition, dev names still winning | **Pass**, with the dev clauses first: the first matching `MAP` clause wins. `appendSwitch` twice replaces the value rather than adding to it, so the whole value is built in one call |
| 2. A per-run self-signed certificate accepted by `setCertificateVerifyProc`, `.eth` hosts only | **Pass** in both sessions: secure context, `crypto.subtle`, a service worker registers, no certificate error. The fingerprint alone decides; the name in the certificate makes no difference. A partition without its own verify proc fails, so it goes on every session |
| 3. A loopback-served `.eth` page gains no local-network privilege | **Passes only because nothing is restricted.** Electron 44 turns Chromium's Local Network Access checks off, and `--enable-features` cannot turn them back on. Any page, public or `.eth`, reaches loopback services with no prompt |
| 4. A port chosen synchronously before ready, bound after | **Pass.** A bare `listen(0)` binds synchronously in about a millisecond. The utility process binds 70 to 190 ms after it is forked. A bind failure shows as an error page within 60 ms, except a squatter that accepts and stays silent, which times out at 30 s |

The conditions on the GO, all built: one resolver-rules value with dev names first; the verify
proc on every session through `session-created`; an end-to-end canary that fails if Local Network
Access starts being enforced (`test/e2e-eth-verified.test.ts`); and a `security-model.md` row for
the loopback socket, since T15 as written says "no localhost socket".

The fallback, sized but not built: one partition per `.eth` origin, with `protocol.handle('https')`
passing other hosts through. It loses a handled response's `Set-Cookie`, and pass-through enforces
no CORS and sends no `Origin` header.

## EI-1b: the light client

**Helios 0.11.1 works as the verifier host's light client, with four additions around it.** It
initialises in an Electron 44 utility process (263 ms median for WASM and construction), never
delays the first window (ready-to-show 501 to 527 ms with or without it), and syncs in 1 to 2 s
from a checkpoint up to 10 days old. Through the Universal Resolver it proved all five names,
CCIP-Read names included, and never returned a wrong value under tampering: an altered proof or
code hash fails the call, and a single altered answer is re-fetched and ignored.

| What Helios needs around it | Why |
|---|---|
| A `WorkerGlobalScope` shim before it loads | Otherwise the first consensus request that fails, including going offline, panics its WASM timer and kills it. With the shim it rode out a 45 s beacon outage |
| Its revert text turned into `{ code: 3, data }` | It throws `execution reverted: <hex>`; viem then never sees `OffchainLookup`, and every offchain name fails |
| Checkpoint checks of Orivon's own | It enforces no age at all, and a malformed checkpoint silently falls back to one compiled in, about a year old. Orivon validates the format and enforces **14 days**, Helios's own default for mainnet that its JavaScript build drops |
| A deadline on each resolution | A persistent lie about code bytes was retried for 67 s |

**Which block a name is proven at.** The plan said "a recent finalized block". In practice a
public RPC serves storage proofs only for recent blocks, finality lags the head by 81 to 86 blocks,
and calls at the finalized block failed with "distance to target block exceeds maximum proof
window" whenever the lag passed that window. The resolver proves at the newest block the light
client has verified instead, and a request that any execution RPC refuses goes to the next one.
Helios verifies every answer, so which RPC serves it changes nothing about trust.

**Endpoints.** Execution RPCs that pass with no API key: `eth.drpc.org` (fastest),
`rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`, and two slower ones. Only one keyless HTTPS
beacon API passes: `ethereum-beacon-api.publicnode.com`. Nimbus's two pass over plain HTTP only,
and Lodestar's does not serve the full blocks Helios asks for. One consensus endpoint is a single
point of failure; filed as `open-questions.md` A253.

**Cost of running it from launch.** About 150 to 200 MB of resident memory in the host after an
hour idle, and about **20 MB an hour** from the beacon API: Helios fetches every new beacon block
in full. Filed with the endpoint question, since both bear on "the light client starts at launch".

**The Universal Resolver.** viem's address, `0xeeee...eeee`, is the one ENS's docs list; it is an
upgradable proxy whose implementation Helios proved to be the address ENS's contracts repository
publishes. ENS's proxy admin is therefore part of what a resolution trusts.

## EI-1c: IPFS from untrusted gateways

**Raw blocks, not CARs.** Fetching a 30 MB file took 4 to 7 s as raw blocks with 8 to 16 in
flight, in every condition. One CAR per file took 5 to 70 s, and was never under 10 s cold. A CAR
is also one stream with no failover partway through. So raw blocks are the one method the gatherer
uses; a CAR could later seed the same verified cache as a prefetch.

**Tampering is caught where it should be.** A flipped byte in a raw block, inside a CAR, or in a
CID inside a directory node was refused at the block's hash, before use. The exporter never hashes
a block itself, so the blockstore is the whole defence.

**The exporter's file reader can end the process.** A block failing two or more levels down a
file's DAG is raised a second time as an unhandled rejection. The gatherer therefore reads file
bytes with its own walker, and uses the exporter for paths only (`src/ipfs/README.md`).

**Real sites, measured.** Largest block 318 KB, at most 289 links in one node, file DAGs up to six
levels deep, and no ENS site using a HAMT. The limits in `src/ipfs/limits.ts` sit well above these.

**Gateways.** `trustless-gateway.link` first; `ipfs.orbitor.dev`, whose independence from it is not
established; `ipfs.filebase.io` as a slow fallback. `ipfs.io`, `dweb.link` and `w3s.link` now
redirect trustless requests to the first. Several others were rejected, mostly for answering a
trustless request with something else.

**Three findings the plan did not expect:**

- **One consumer ISP's resolver answers the main gateway names with block or landing pages.** The
  real addresses, looked up elsewhere, connect fine. Nothing unverified is used either way, but on
  such a line every `.eth` load fails closed. Filed as `open-questions.md` A251.
- **`app.ens.eth`'s IPNS record is on no gateway.** It is published only to w3name. The gatherer
  now also asks w3name-style name services, after the gateways, and checks the record the same
  way.
- **`uniswap.eth`'s DNSLink no longer exists**, so it cannot be the live Level 1 example. A
  DNSLink fixture covers that case in the suite.

**The five names today**, read through an ordinary RPC. These are facts about the names, not a
test of the design:

| Name | Contenthash |
|---|---|
| `vitalik.eth` | `ipfs://bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi` |
| `ens.eth` | `ipfs://bafybeifnx3u22ngv4ygpnj32qkwzrpgizw4i7e3swp4v6am5piiih3ude4` |
| `tornadocash.eth` | `ipfs://bafybeigduniojgqrz7e4vntsgmovdli3oi7a2pnzzvz2gfxlvj3yqwk75a` |
| `app.ens.eth` | `ipns://k51qzi5uqu5dipklqpo2uq7advlajxx5wxob0mwyqbxb5zu4htblc4bjipy834` |
| `uniswap.eth` | `ipns://app.uniswap.org`, a DNSLink whose TXT record is gone |
