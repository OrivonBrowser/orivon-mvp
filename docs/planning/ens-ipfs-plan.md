# ENS names and IPFS delivery: the plan

> **In progress.** Written 2026-09-24 against `main` at `e218ca4`, after the owner's decisions of
> the same day (§Decisions taken). EI-1 to EI-9 and EI-11's Settings section are built on
> `stream/ens-ipfs`; [§Where it stands](#where-it-stands) says what is left, and where the build
> departed from the text below.

**What this is.** The work queue for making `name.eth` load in this build as `https://name.eth`,
with every byte checked locally against what the Ethereum chain says the name points to. External
servers supply availability only: none of them is trusted for correctness. It follows
[`step-4-app-loader-plan.md`](step-4-app-loader-plan.md)'s shape: items ordered by dependency,
each ending in an exit criterion that must be demonstrably true. Where this sits in the roadmap is
decided elsewhere; nothing here assumes an order relative to other work.

**Read first.** The canonical pages this plan implements:
[Web3 scores](https://docs.orivonstack.com/docs/implementations/web3-score),
[DNS resolution](https://docs.orivonstack.com/docs/implementations/dns-resolution),
[Data gathering](https://docs.orivonstack.com/docs/implementations/data-gathering), and
[Native DDOC](https://docs.orivonstack.com/docs/implementations/native-ddoc-specs). In this
repository: [`mvp-scope.md`](../mvp-scope.md) (both features sit in its OUT table until EI-0
lands), [ADR-0006](../decisions/ADR-0006-trust-indicator-from-observed-behaviour.md) (the trust
indicator, which EI-0 amends), and
[ADR-0007](../decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md) (a bundle is
served at its own origin).

---

## The one-sentence shape

A person types `vitalik.eth`. A light client, running since launch, proves the name's contenthash
at a recent finalized block. A trustless IPFS gateway supplies the blocks, and each block is hashed
against its CID before any of it is used. The page then runs at `https://vitalik.eth` like any
other site, installable like any other app, and the site-info popover shows **Website Level 2**:
DDOC met by the protocol.

## The verification chain

    vitalik.eth
      |  ENSIP-15 normalise, namehash                                          local
      v
    beacon API (untrusted)   -- sync-committee signatures -->  finalized header
      |  checked against the release's checkpoint, or the last one this install verified
      v
    execution RPC (untrusted) -- eth_getProof + local EVM (Helios) -->  Universal Resolver -> contenthash
      |  a CCIP-Read answer is fed back through the same proven call
      v
    contenthash, ENSIP-7 decoded locally
      |-- ipfs://<cid>          every pointer verified                 Website Level 2
      |-- ipns://<key>          signed IPNS record, highest sequence    Website Level 2
      '-- ipns://<dns name>     DNSLink TXT record: forgeable           Website Level 1
      v
    trustless gateway (untrusted) -- raw blocks or CAR -->  every block hashed against its CID
      v
    a tab (EI-7), or loader staging -> bundle hash -> pin -> served from cache (EI-9)

The root of trust is the checkpoint, plus the standard light-client assumption that the sync
committee is honest. A server can withhold, delay within the freshness bound, and observe what is
asked of it. It cannot make Orivon use a byte it changed.

## Decisions taken

Owner, 2026-09-24. EI-0 records each in the decision log.

1. **Trustlessity levels follow the canonical
   [Web3 scores](https://docs.orivonstack.com/docs/implementations/web3-score) page.** On every
   site, `.eth` or not, the person sees its **Website level**. Only Level 1 (no DDOC) and Level 2
   (DDOC) are detected automatically. Level 3 and above come only from a Web3 Score provider
   assessing the site's content identifier: the bundle hash of a hash-pinned app, or the CID of
   IPFS content. No provider exists, so this build shows Level 1 or 2 with the evidence beneath,
   and marks the higher levels as needing a provider. This overrides ADR-0006's level list, which
   calls Level 3 ("runs entirely locally") automatic and half of Level 4 automatic.
2. **Every trust question follows the canonical pages.** An IPNS-key name is IPFS content, where
   DDOC is met by the protocol, so it gets Level 2.
3. **Offchain (CCIP-Read) names are allowed.** The resolver contract checks the gateway's answer
   inside the proven call. The evidence says "offchain resolver".
4. **The light client starts at launch.** Its state is visible in a Settings section, and in a row
   of the site-info popover on `.eth` pages.
5. **Built in, in the canonical shape.** ENS resolution and IPFS data gathering are built into
   Orivon as its default providers. They sit behind internal interfaces that match the canonical
   [DNS resolution](https://docs.orivonstack.com/docs/implementations/dns-resolution) and
   [Data gathering](https://docs.orivonstack.com/docs/implementations/data-gathering) pages: a
   resolver returns records for its top-level domain; a gatherer loads from those records and
   reports DDOC; each top-level domain has an ordered provider list with fallback. Opening those
   interfaces to third-party Apps is a later `src/contracts/` change, not part of this plan.

**Two consequences, derived from decision 1 rather than decided by the owner:**

- **A DNSLink name (`uniswap.eth`) is Level 1.** DDOC means the data is exactly what the domain
  owner wanted. A DNSLink's last hop is a DNS TXT record, which is forgeable on ICANN domains,
  the same reason `mvp-scope.md` gives for DDOC's own DNS anchor (A4b). The bytes are still
  verified against the CID that DNS returned, and the evidence says so.
- **Third-party code does not break Level 2.** Level 2 holds while every byte from the site's own
  origin is verified. The canonical Level 3 is the one that forbids executing external code
  without consent, which puts third-party code in the provider's hands, and it matches the owner's
  position recorded in ADR-0006's 2026-09-15 amendment: third-party code costs score, not
  correctness. Third-party loads show as evidence (pin coverage).

## Checked before writing

Measured 2026-09-24 in a scratch tree, so the plan does not rest on memory.

| Question | Answer |
|---|---|
| Do the IPFS primitives pass `check:natives`? | Yes. `multiformats`, `@ipld/car`, `ipfs-unixfs-exporter`, `ipns`, `@noble/curves`, `viem`, `@a16z/helios`: no offenders, no prebuilt binaries, zero advisories |
| Can Helia or `@helia/verified-fetch` be used? | **No.** `helia` -> `@helia/libp2p` -> `@libp2p/webrtc` -> `node-datachannel`, the cmake-js chain [`check-no-native-modules.mjs`](../../scripts/check-no-native-modules.mjs) names as the reason webtorrent ships as an app asset. `@helia/http` alone is a config helper; block verification lives in `helia`. So the gatherer is ours (EI-3), built on the primitives above |
| Helios (`@a16z/helios` 0.11.1) | Two JS dependencies. A 3.1 MB WASM module inlined as a `data:` URL (11.7 MB unpacked). npm SLSA provenance attestation present. One execution RPC and one consensus RPC per instance. `dbType` defaults to `localstorage`; `config` is the Node setting. `helios_getCurrentCheckpoint` returns the latest verified checkpoint. **The WASM embeds a fallback checkpoint-provider list** (`raw.githubusercontent.com/ethpandaops/checkpoint-sync-health-checks`), which EI-5's egress allowlist exists to keep unreachable |
| viem over an EIP-1193 provider | viem 2.56.8's ENS actions call the Universal Resolver with CCIP-Read; a contenthash lookup is the same call shape as `getEnsText` |

What real names point at, read through an ordinary unverified RPC. These are facts about the
names, not a test of this design:

| Name | Contenthash | Website level |
|---|---|---|
| `vitalik.eth`, `ens.eth`, `tornadocash.eth` | `ipfs://<cid>` | 2 |
| `app.ens.eth` | `ipns://<ed25519 key>` | 2 |
| `uniswap.eth` | `ipns://app.uniswap.org`, a DNSLink in identity-hash form | 1 |

## What already works, so nobody rebuilds it

| Piece | Where | State |
|---|---|---|
| Serving a pinned bundle at its own origin inside its partition | [`src/loader/electron-serve.ts`](../../src/loader/electron-serve.ts), [`serve.ts`](../../src/loader/serve.ts) | Built (ADR-0007). Serves an installed `.eth` app unchanged |
| Loader fetch through an injected `Fetch` | [`fetch-bundle.ts`](../../src/loader/fetch-bundle.ts), `fetch-budget.ts:78` | Built. Every manifest and asset request goes through it, so `.eth` needs only a dispatching `Fetch` |
| `https://name.eth` as a canonical, persistable origin | [`src/broker/policy/origin.ts`](../../src/broker/policy/origin.ts) | Works today: `originFromUrl` and `isPersistableOrigin` accept it, and partitions hash any origin |
| The site-info popover's Web3 Score page | [`src/renderer/site-info/web3-view.ts`](../../src/renderer/site-info/web3-view.ts), [`site-trust.ts`](../../src/main/browsing/site-trust.ts) | Built. It shows delivery rungs and pin coverage, and no level; EI-10 adds the level |
| The D-ladder, including content-addressed rungs | [`delivery-ladder.ts`](../../src/trust/delivery-ladder.ts) | Built; `site-trust.ts` hardcodes the content-addressed inputs `false`. It stays as evidence beneath the level |
| Pin coverage: pinned versus third-party loads per page | [`src/loader/pin-coverage.ts`](../../src/loader/pin-coverage.ts) | Built. The evidence for third-party code on a Level 2 site |
| The Settings page | [`src/renderer/settings/`](../../src/renderer/settings/), [`settings-ipc.ts`](../../src/main/ipc/settings-ipc.ts) | Built, with one section (Permissions). EI-11 adds the light-client section |
| Mapping `.eth` hosts to loopback, honoured by the default session and every partition | [`src/main/dev/eth-resolver.ts`](../../src/main/dev/eth-resolver.ts) | Built for dev names, verified in Electron 44 |
| A `.eth` tab proven to be a secure context | [`test/e2e-eth-secure-context.test.ts`](../../test/e2e-eth-secure-context.test.ts) | The pattern to reuse |
| Content types, byte ranges | [`serve-content-type.ts`](../../src/loader/serve-content-type.ts), [`serve-range.ts`](../../src/loader/serve-range.ts) | Reuse: no second map (code-guidelines Rule 3) |
| Address classification: public unicast, loopback, private | [`src/broker/policy/address.ts`](../../src/broker/policy/address.ts) | Reuse for every URL a resolver contract or a DNSLink names |
| A hook on every session through `session-created` | [`src/main/sessions/permission-gate.ts`](../../src/main/sessions/permission-gate.ts) | The model for installing a certificate check everywhere |

## The thirteen items

Ordered by dependency, not by size. Estimates are working days for one person with agents.

### EI-0: scope, ADRs, and the guard that would fight this work (~0.5 day)

**Why first:** until it lands, the work is out of scope by Rule 4, the scope-creep hookify rule
warns on every `src/` edit that names IPFS or ENS, and ADR-0006 still states a level list that
decision 1 overrides.

Docs only, one PR, merged first.

- `mvp-scope.md`: move "Trustless resolution (ENS and friends)" and "IPFS" to IN, scoped to this
  build as `.eth` names and IPFS content; Arweave and DDOC's native DNS record stay OUT. The
  README's "No ENS, no IPFS" bullet is rewritten. `build-plan.md` is not touched.
- `.claude/hookify.scope-creep.local.md`: drop `ipfs` and `ens\b` from the pattern.
- **ADR-0006 amended in place:** Website levels follow the canonical page; only Levels 1 and 2 are
  automatic; Level 3 and above come only from a provider assessing a content identifier (bundle
  hash or CID). "Runs entirely locally" and the consent half of Level 4 leave the level list and
  stay as evidence. The popover leads with the level and keeps the evidence beneath it.
  `open-questions.md` B3, which ADR-0006 resolved in favour of the private "Level 3 = runs
  locally" list, is reopened and answered the other way. `ARCHITECTURE.md`'s "trust is shown as
  observed behaviour, never as a grade" is rewritten to say what is true after this.
- **ADR-0030, `.eth` names are origins** (numbered 0029 when this plan was written; DDOC took it).
  - Each name loads at `https://<name>.eth`.
  - Resolution and gathering are built-in providers behind the canonical interfaces (decision 5).
  - Content comes from IPFS, verified per block. The name is verified by a light client that
    starts at launch.
  - Failure is fail-closed, with no unverified fallback.
  - The Website level follows each contenthash kind (decisions 1-2 and the DNSLink consequence).
  - The bundle hash is unchanged (ADR-0009 stands). The CID is kept as provenance and as the
    identifier a provider assesses.
  - The serving mechanism stays *provisional* until EI-1a settles it.
- **ADR-0031, Helios is admitted.** A Rust-built WASM dependency: why it breaches neither ADR-0002
  (which bounds code written here) nor Rule 8 (nothing compiles at install), and its conditions:
  exact version pin, provenance attestation checked on every bump, runs only in the verifier host
  behind an egress allowlist, always given a checkpoint.
- ADR-0005 amended in place (its "IPFS and ENS-addressed delivery later" line).
  `open-questions.md` C5 answered for ENS and IPFS. Decision-log rows for decisions 1-5 and both
  consequences, from `d-0106` (`d-0101` to `d-0105` were taken by DDOC and the roadmap).

**Exit:** merged; an edit naming `ipfs` under `src/` raises no scope warning; ADR-0006 and
`ARCHITECTURE.md` no longer contradict decision 1.

### EI-1: spike, three questions (~2-3 days)

In a throwaway worktree. Results go to `docs/planning/spike-results/`; no code from here is kept.

**EI-1a, the serving mechanism.** EI-7 serves `.eth` tabs from a loopback TLS server that
Chromium reaches through a `MAP *.eth` resolver rule, so every other request keeps Chromium's own
CORS, cookie and WebSocket handling. That design passes only if all four hold in Electron 44,
headless:

1. A wildcard `MAP *.eth 127.0.0.1:<port>` rule works in the default session and in a partition,
   and the dev names' own `MAP` rules still win for their names.
2. A per-run self-signed certificate, accepted by `setCertificateVerifyProc` for `.eth` hosts only,
   yields a secure context with no interstitial.
3. **A loopback-served `.eth` document gains no local-network privilege.** Its requests to another
   loopback or LAN service are treated exactly as a public `https` page's are. Chromium assigns a
   document's address space from the IP it came from, so this needs `treat-as-public-address` in
   the response CSP, or an equivalent. If nothing works, the design fails.
4. A port chosen synchronously in `beforeReady` and bound in `afterReady` is reliable, and a bind
   failure surfaces as an error page rather than a hang. It must be synchronous because the
   registry's `beforeReady` is `() => void` and the switch must be set before ready.

**The fallback if any gate fails:** every `.eth` origin always gets its own partition (a third arm
in `partitionForTarget`, amending ADR-0018), with one dispatching `protocol.handle('https')`
handler: pinned cache first, then verified IPFS for the origin itself, then pass-through for other
hosts. The cost sits in the pass-through. Electron 44 enforces no CORS on a handled response
([`serve-reach-cors.ts`](../../src/loader/serve-reach-cors.ts)), so pass-through must reuse that
enforcement and the public-unicast guard, and it needs its own security review.

**EI-1b, Helios in a utility process, started at launch.**
- WASM initialisation under an Electron 44 `utilityProcess`, with the entry's body inside a
  function and never a top-level `await`.
- Proof that spawning the host and syncing never delays the first window.
- `dbType: 'config'`. Time to `waitSynced` from checkpoints 1 and 10 days old.
- What Helios does with a checkpoint past its age limit. The expectation is that it warns and
  continues, so Orivon enforces the age itself.
- Observed egress with a `fetch` allowlist in place: nothing outside the two endpoints, and the
  fallback list never contacted.
- Memory held over an hour of idle running.
- The five names above, plus one CCIP-Read name, resolved through viem. A proxy that alters one
  `eth_getProof` field must make resolution fail.
- Whether the Universal Resolver address viem ships is ENS's current one.

**EI-1c, IPFS fetch.**
- `vitalik.eth`'s CID from two trustless gateways: raw blocks with bounded parallelism against one
  CAR per entity, for a small page and a ~30 MB asset.
- A proxy that flips one byte is caught.
- `app.ens.eth`'s IPNS record verifies, and `app.uniswap.org`'s DNSLink resolves.

Also a shortlist of default endpoints: at least two per hop, no API key, with support for
`eth_getProof`, `eth_createAccessList` and the beacon light-client API.

**Exit:** one results note with numbers and a go or no-go on EI-1a; ADR-0030's mechanism section
settled.

### EI-2: `src/resolution/`, the canonical interfaces (durable, ~0.5 day)

The two shapes the canonical pages give Apps, as internal TypeScript, plus the registry that
orders them. Electron-free, with a README.

- **`NameResolver`** (canonical DNS resolution): the top-level domains it supports; `resolve(name)`
  returning a list of records, each with its provenance: verified on chain at block N, offchain
  resolver, or via DNS. ENS has no enumerable record list, so the ENS resolver returns every
  record a gatherer in this build can use (the contenthash). A second gatherer adds a record kind,
  not a new interface.
- **`DataGatherer`** (canonical Data gathering): whether it can load from a record list;
  `open(records, path, range)` returning verified bytes; and a DDOC report per navigation: met,
  not met (with the reason), or failed (with the resource).
- **The registry:** an ordered list of resolvers per top-level domain (`.eth` -> the ENS
  resolver), an ordered list of gatherers, and the canonical fallback: when one fails, the next is
  tried. Each list has one entry in this build. The rule is built now so a second entry needs no
  refactor.

Ordinary ICANN names never pass through this registry in this build; Chromium resolves them as
before.

**Exit:** unit tests of the registry's ordering and fallback with stub providers.

### EI-3: `src/ipfs/`, the IPFS gatherer (durable, ~3 days)

Implements `DataGatherer`. Electron-free TypeScript over an injected `fetch`. Its README says it
depends on `multiformats`, `@ipld/car`, `@ipld/dag-pb`, `ipfs-unixfs-exporter` and `ipns`, and
never imports `electron`, `src/main/` or `src/loader/`.

- A blockstore whose `get(cid)` fetches from a trustless gateway (`?format=raw`, or a CAR per
  EI-1c) and returns bytes only after hashing them against the CID. It accepts `sha2-256` and
  inline identity CIDs only; any other hash function is refused, never skipped. Codecs: `dag-pb`
  and `raw`.
- Path resolution and file reads through `ipfs-unixfs-exporter` over that blockstore, so every
  link walked is verified. HAMT directories included; `index.html` for a directory.
- Limits on block size, DAG depth, links per node, bytes per request, idle and total time, and
  gateway concurrency. Hitting a limit is an error, never a truncated success.
- Gateways tried in order with failover. A gateway that returns a bad block is dropped for the
  session, and the navigation's DDOC report records the refusal.
- IPNS: fetch the record (`?format=ipns-record`), verify its signature and validity, keep the
  highest sequence per key through an injected store, and refuse a lower one.
- DNSLink: parse `_dnslink.<domain>` through an injected TXT resolver, and mark the resulting
  record "via DNS". A chained `/ipns/` target goes through the IPNS path, with a depth limit.
- **DDOC report:** met when every pointer from the name to the root CID was verified and every
  byte served for the site's own origin verified. A pointer "via DNS" means not met.

**Exit:** unit tests cover a tampered block, a wrong hash function, an oversized block, a depth
bomb, a lower IPNS sequence, a bad signature, and a DNSLink chain reported as DDOC-not-met. An
opt-in live test fetches `vitalik.eth`'s current CID.

### EI-4: `src/ens/`, the ENS resolver (durable, ~1.5 days)

Implements `NameResolver` for `.eth`. Electron-free, over an injected EIP-1193 provider through
viem's `custom` transport.

- ENSIP-15 normalisation. An invalid name is refused before any request.
- The contenthash through the Universal Resolver, with CCIP-Read on and viem's `ccipRead.request`
  replaced by an injected function. EI-5 supplies one that allows `https:` only, public-unicast
  addresses only (`address.ts`), no cross-host redirects, and a size and time cap.
- ENSIP-7 decoding to `ipfs(cid) | ipns-key(key) | dnslink(domain) | unsupported(kind)`. Swarm,
  Arweave and the rest are `unsupported` and shown as such.
- Each record carries the block number it was proven at, and whether an offchain lookup took part.

**Exit:** unit tests run against a stub provider. Decode vectors are built from the real
contenthash bytes of the five names above. A CCIP URL pointing at loopback, a private range, or
`http:` is refused.

### EI-5: the verifier host process, started at launch (disposable, ~2 days)

An Electron `utilityProcess` that owns every untrusted parser (CAR, dag-pb, IPNS protobuf, the
Helios WASM, CCIP answers), so a bug in any of them never runs in the main process. It is the
first utility process in this repository: the main build's single `rollupOptions.input` in
`electron.vite.config.ts` becomes an object with a second entry.

- **Started at launch** by a non-critical subsystem, after the first window is shown, so it never
  delays startup. Helios begins syncing at once. Offline, it retries with backoff. A `.eth` load
  that arrives before sync completes waits a bounded time, then gets the "cannot verify yet" page,
  which shows the status.
- Before Helios loads, `globalThis.fetch` is replaced by one that reaches only the configured
  execution and consensus endpoints. The IPFS gatherer, the CCIP function and DNSLink use their
  own guarded paths. Anything else throws.
- Helios is created with `dbType: 'config'` and the checkpoint main passes in (EI-6), never
  without one.
- One RPC surface over `MessagePortMain`: `resolve(name)`, `open(records, path, range)` streaming
  verified bytes, `provenance(host)`, `checkpoint()`, and `status()` with change notifications for
  EI-11.
- An environment switch turns the light client off. Every `.eth` load then fails closed; `smoke`
  and the e2e suite set it, so no test run contacts mainnet endpoints.
- Code lives in `src/verifier-host/` (the process) and `src/main/verifier/` (main's side, which
  also restarts the host with backoff after a crash).

**Exit:** the host starts headless under the e2e harness without delaying the first window; a
unit test proves a request to an unlisted host is refused; killing the host mid-load produces the
"cannot verify" page, not a hang.

### EI-6: the checkpoint (~1 day)

- A mainnet checkpoint shipped with each release, plus `scripts/refresh-eth-checkpoint.mjs`. The
  script reads the finalized block root from at least two independent beacon APIs, requires them
  to agree, and prints it for the owner to commit. A new release-checklist item runs it.
- After each successful sync, `helios_getCurrentCheckpoint` is stored in the profile's app data.
  Because the client runs on every launch, an install in regular use never ages out.
- Orivon takes the newer of the two, and refuses one older than a maximum age that EI-1b sets. If
  both are too old, resolution fails closed and names the reason.
- The self-updater only notifies (`src/main/self-update/`), so a stale install recovers only when
  a person installs a release. The status and the error page say so.

**Exit:** a test for each branch: stored fresh; stored stale with the shipped one fresh; both
stale.

### EI-7: `.eth` in a tab (~3-4 days)

Built on the mechanism EI-1a settles. This describes the loopback design.

- One owner of `--host-resolver-rules`: `eth-resolver.ts`'s dev `MAP` rules first, then
  `MAP *.eth 127.0.0.1:<port>`, composed in one pass with the injection-safe validation that file
  applies today.
- The loopback server, in the verifier host:
  - `GET` and `HEAD` for `*.eth` hosts only, resolved and gathered through the EI-2 registry.
  - `Range` through the shared range logic, and the content type from `serve-content-type.ts`'s
    map.
  - The CSP from EI-1a on every response, and cache headers keyed on the CID.
  - Four error pages (cannot verify yet, cannot verify, not found, unsupported contenthash), each
    with `default-src 'none'`.
- A per-run key and self-signed certificate. The X.509 builder is `@peculiar/x509`, vetted with
  `/ca:add-dep` and `check:natives`. A `setCertificateVerifyProc`, installed on every session
  through `session-created`, accepts that one certificate for `.eth` hosts and returns Chromium's
  own verdict for every other host. A process squatting the port without the per-run key fails
  TLS.
- Omnibox: a bare `name.eth` becomes `https://name.eth/`, unless dev mode maps that name, which
  keeps `http://` as today.
- A test seam mapping `fixture.eth` to a CID with no light client. It is gated on the same
  `__ORIVON_DEV_GRANT_ENABLED__` build flag as the dev grant, and its global's name joins
  `DEV_MARKERS` in `scripts/check-dev-grant-absent.mjs`.
- A fixture trustless gateway under `test/apps/`. It serves a DAG built at test time
  (`ipfs-unixfs-importer`, a vetted dev dependency) and has a tamper mode and a request counter.
  Its ports stay clear of orivon-ports' 8875, 8876 and 8885.

**Exit:** headless e2e shows three things. `fixture.eth` loads and is a secure context. With tamper
mode on, the altered resource fails and nothing from it renders. A fetch from the `.eth` page to a
loopback fixture is treated as it is from a public `https` page (T12).

### EI-8: ENS in the host (~1.5 days)

The EI-4 resolver wired to Helios inside the host, with EI-4's guarded CCIP function and a name
cache holding the latest proven records and block per name, with a short TTL. The e2e suite keeps
using the test seam; real resolution is covered by an opt-in live test.

**Exit (live, opt-in):** the five names resolve through Helios to the kinds above. Behind the
tampering RPC proxy from EI-1b, resolution fails and the tab shows "cannot verify".

### EI-9: installing a `.eth` app (~2-3 days)

- A dispatching `Fetch` in `src/loader/subsystem.ts`: `.eth` origins go to the host's verified
  `open`, everything else to `electronFetch`. **One bundle, one CID:** the name is resolved once
  per `load()`, and every manifest and asset request of that load reads the same records, carried
  on `LoadContext`.
- The `ensurePublicUnicastOrigin` call in `fetch-bundle.ts` gets a `.eth` branch with no DNS
  lookup, since no request goes to that host.
- `PinRecord` gains an optional content address: CID, contenthash kind, block, and whether every
  pointer was verified. `parsePinRecord` and `fromBundleTree` carry it. `schema` stays 1, because a
  bump would force re-consent on every installed app.
- The update check in `load()`, between the interval gate and the fetch (`index.ts:414-419`),
  resolves the name and compares the CID with the pinned one. Equal means `up-to-date` with no
  gateway request. Different means a full fetch and the ordinary update decision.
- Discovery needs nothing new. The page renders through EI-7 and carries its
  `<link rel="orivon-manifest">`, so the existing hint listener fires.

**Exit:** an e2e fixture `.eth` app with a manifest installs, and `pin.json` carries the CID. It
opens offline from cache. A second load with an unchanged CID makes zero gateway requests,
according to the fixture's counter, and a changed CID reaches the update decision.

### EI-10: the Website level, on every site (~2 days)

Decision 1 applies to every page, so this item changes the Web3 Score page for ordinary sites too.

- `site-trust.ts` computes the **Website level**:
  - **Level 2** when DDOC is met: the gatherer's report for a live `.eth` page, or the pin's
    content address for an installed one.
  - **Level 1** otherwise.
  - Native DDOC (the `DDOC` DNS record and `.hashes` files) is not in this build, so an ordinary
    HTTPS site is Level 1, pinned or not.
- `web3-view.ts` leads with the level and its one-line canonical meaning (summarised, linked, never
  copied from the vision corpus).
  - Levels 3 and above show as grey `?`, marked as needing a Web3 Score provider, with none
    configured.
  - The page names **the identifier a provider would assess**: the CID for IPFS content, the
    bundle hash for a hash-pinned app, and nothing for a page that has neither.
- **The evidence stays beneath the level:**
  - The delivery rungs, with the content-addressed inputs now derived from provenance.
  - Pin coverage (third-party loads).
  - For `.eth`, the name chain: block, offchain resolver, IPNS key, or "via DNS: `<domain>`".
  - A block a gateway sent that failed verification is named as refused, since the canonical
    DDOC page calls for alerting the person.
- The header comments in `web3-view.ts` ("never a number or letter") and `delivery-ladder.ts` ("D4
  unreachable") are rewritten to say what is true.

**Exit:** e2e shows an `ipfs` fixture name at Level 2 with its CID, a DNSLink fixture at Level 1
naming the domain, and an ordinary HTTPS fixture at Level 1. None of them shows Level 3 or above.

### EI-11: is the light client working? (~1.5 days)

- **Settings section, "Ethereum light client",** beside Permissions. It is read-only, and it sits
  where the canonical Nodes Configuration settings would later live. It shows, live:
  - the state (starting, syncing, synced at block N, or failed with the reason and the next
    retry);
  - the checkpoint's age and source (shipped with the release, or last verified here);
  - the endpoints in use for each hop, and the last error.
- **Popover row on `.eth` pages:** "name verified by the light client at block N, M minutes ago",
  or why it could not be verified.
- Status reaches the renderer through the Settings command channel (`settings-ipc.ts`) plus a push
  on change. It is never polled from the page.

**Exit:** e2e with the light client switched off shows "off" in Settings. With the test seam, a
forced failure shows "failed" and its reason, and killing the host shows the failure, then the
recovery after restart.

### EI-12: hardening, docs, review (~2-3 days)

- `security-model.md` gets the rows below, from T27. Run `/security-review` and
  `adversarial-reviewer` on the verifier host and `src/ipfs/`.
- Docs to update:
  - `ARCHITECTURE.md` §Where things live: `src/resolution/`, `src/ens/` and `src/ipfs/` are not
    tied to Electron; `src/verifier-host/` is entirely tied to it.
  - A README per new directory.
  - Glossary: contenthash, CID, trustless gateway, checkpoint, DNSLink, Website level.
  - `compatibility-matrix.md` rows, and `capability-api.md` §How a URL becomes an app.
  - `setup.md` for the dev path, and the light-client switch.
  - A stream row in `parallel-work.md`.
- The README names the endpoints contacted at every launch.
- Release checklist §3 (run from source on Windows and macOS), run once with Helios in the tree.
- A devlog bullet.

**Exit:** every review finding is addressed or acknowledged.

## Threats this adds

Numbers are assigned when `security-model.md` is edited, from T27.

| Threat | Mitigation | Item |
|---|---|---|
| A gateway alters content | Every block hashed against its CID before use; fail closed | EI-3 |
| An RPC or beacon API lies about a name | Light-client verification; no unverified fallback | EI-8 |
| The Website level overclaims | Level 2 only when every pointer and every own-origin byte verified; a pointer via DNS is Level 1; nothing above Level 2 without a provider | EI-3, EI-10 |
| A stale or forged checkpoint | Shipped per release, refreshed from the last verified sync, maximum age enforced by Orivon | EI-6 |
| A resolver contract's CCIP URL, or a DNSLink, points a privileged process at loopback or the LAN | `https:` only, public-unicast check (`address.ts`), no cross-host redirects, size and time caps | EI-4, EI-5 |
| A loopback-served page gains local-network privilege | EI-1a gate 3 and its e2e | EI-7 |
| A local process squats the loopback port | Per-run certificate pinned by the verify proc, `.eth` hosts only | EI-7 |
| A hostile DAG exhausts memory or time | Block, depth, fan-out and byte limits | EI-3 |
| IPNS rollback | Highest sequence kept per key | EI-3 |
| A parser or WASM bug | All untrusted parsing in the verifier host, never in main | EI-5 |
| Helios supply chain | Exact pin, provenance checked on each bump, egress allowlist | EI-0, EI-5 |
| Every launch contacts a beacon API and an RPC, and they learn which names are looked up; gateways learn CIDs | Named in the README and in the Settings section; lookups happen only on navigation or an app's own load | EI-11, EI-12 |

## What is deliberately not here

- **Third-party resolver and data-gathering Apps**, and the canonical per-domain priority table in
  Settings and the toolbar switcher. The interfaces and the fallback rule exist (EI-2); exposing
  them to Apps is a later `src/contracts/` change.
- **A Web3 Score provider.** This build names the identifier a provider would assess and shows
  Level 3 and above as unassessed.
- **Native DDOC for ordinary sites** (the `DDOC` DNS record and `.hashes` files). Without it an
  HTTPS site is Level 1.
- **The canonical Connection and Operation levels.** The Web3 Score page keeps showing them as it
  does today.
- **Typed `ipfs://` and `ipns://` URLs.** A bare CID has no name to anchor an origin, and ADR-0007
  refused both custom schemes and synthetic subdomains. It needs its own ADR.
- **Names outside `.eth`**, such as DNS names imported into ENS. In this build, a `.eth` suffix is
  the whole rule for when the ENS resolver is consulted.
- **Swarm, Arweave and other contenthash kinds**, shown as unsupported.
- **`_redirects` for single-page apps, and a disk cache for sites that are not installed.**
- **Running an IPFS node**: bitswap, providing, or pinning content for others. Gateways supply
  availability; nothing here makes Orivon a peer.
- **Editing endpoints in Settings**, and a way to paste a checkpoint.
- **`window.ethereum`, wallets, ENS text records and avatars.**
- **An L2 light client.** L2 names resolve through CCIP-Read with proofs that the L1 resolver
  contract checks, so the L1 light client covers them.

## Order and what may run at once

    EI-0 --> EI-1 --+--> EI-2 --+--> EI-3 -------------------+--> EI-7 --> EI-9 --+
                    |           '--> EI-4 --+                 |                     +--> EI-10 --> EI-12
                    +--> EI-5 --------------+--> EI-8 --------+--> EI-11 ----------+
                    '--> EI-6 --------------'

EI-7 also needs EI-5; EI-11 needs EI-5 and EI-8. EI-10's Level 1 half (every ordinary site, and
the new page layout) needs only EI-0, so it can start early and finish once EI-9 supplies
content-addressed pins.

EI-3, EI-4, EI-5 and EI-6 can run in parallel worktrees once EI-2 is in. EI-7 lands the whole IPFS
path behind the test seam before any ENS code is wired in, so EI-8 is the only item that needs a
live chain.

Files that serialise items:
- `src/main/subsystems.ts` is touched by EI-5 and EI-7.
- `site-trust.ts` is touched by EI-10 and EI-11.
- `src/loader/index.ts` and `fetch-bundle.ts` belong to EI-9 alone, as `eth-resolver.ts` does to
  EI-7, and the Settings files to EI-11.
- `src/broker/policy/pin.ts` belongs to the broker stream, so EI-9's PR names it.

No item is expected to change `src/contracts/`; if one finds that it must, that change goes first
in its own PR.

Roughly five working weeks done one after another. EI-0 is its own PR; the rest group into one or
two PRs a day.

## Where it stands

Updated 2026-09-24. Built on `stream/ens-ipfs`, each item to its exit criterion unless noted.

| Item | State |
|---|---|
| EI-0 | **Partly.** `ADR-0030` and `ADR-0031` are written, and open questions A251 to A255 filed. The amendments (scope, `ADR-0005`, `ADR-0006`, `ADR-0029`, the hookify rule, the decision log) wait for the roadmap change, which edits the same lines and is not yet on `main` |
| EI-1 | Done: [`spike-results/ens-ipfs.md`](spike-results/ens-ipfs.md). GO for the loopback design |
| EI-2, EI-3, EI-4, EI-6 | Done, with unit tests |
| EI-5, EI-7 | Done. `test/e2e-eth-verified.test.ts`: a fixture name loads verified, a tampered block is refused, and the Local Network Access canary holds |
| EI-8 | Done. An opt-in live test resolves the five names through Helios and refuses a tampered proof; the real shell loads `vitalik.eth` from mainnet |
| EI-9 | Done. `test/e2e-eth-install.test.ts` installs a `.eth` app through the real hint; its pin carries the CID and it opens from cache with the gateway gone |
| EI-10 | **Not started.** Waits on A254 (does a same-host DDOC tree make Level 2?) and on the roadmap change, which edits `site-trust.ts` and `delivery-ladder.ts` |
| EI-11 | Settings section done (`test/e2e-eth-light-client-status.test.ts`). The popover row on `.eth` pages goes with EI-10 |
| EI-12 | **Partly.** A README for each new directory. The rest edits the same pages as the roadmap change |

**Where the build departed from the text above, and why:**

- **A name is proven at the newest block the light client has verified**, not the finalized one.
  Public RPCs serve storage proofs only for recent blocks, and finality lags by about 80 blocks.
  `ADR-0030` records it as provisional.
- **Execution RPCs fail over per request**, since the light client verifies every answer; one RPC
  per instance, as Helios takes, failed intermittently.
- **The loopback certificate is DER-encoded in the verifier host**, not built with `@peculiar/x509`,
  which needs a process-global `reflect-metadata` polyfill (`src/verifier-host/README.md`).
- **The gatherer reads file bytes with its own walker**; the exporter's reader can end the process
  on a deep block failure. The exporter still resolves paths.
- **IPNS records may also come from a w3name-style name service**: `app.ens.eth` publishes nowhere
  a gateway looks.
- **The IPFS limits were tightened** to what real sites measured, and `ipfs.io` left the gateway list,
  since it now redirects trustless requests to `trustless-gateway.link`.
- **`uniswap.eth`'s DNSLink no longer exists**, so a fixture stands in for the live Level 1 example.
- **The fixture seam and a readiness flag** share one global, `__orivonDevEthFixtures`, which joins
  `check-dev-grant-absent.mjs`'s markers.

