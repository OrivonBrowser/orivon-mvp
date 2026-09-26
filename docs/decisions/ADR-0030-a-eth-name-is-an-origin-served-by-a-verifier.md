# ADR-0030: A `.eth` name is an origin, served by a verifier that checks every byte

- **Status:** accepted, **amended 2026-09-25**: a DNSLink name is Website Level 2, the DDOC
  anchor is confirmed, and the verifier's caches are kept per site. **Amended 2026-09-26**: a
  gateway is scheduled by its own recent health rather than tried in a fixed order, a name a
  re-prove fails keeps serving its last proven root for a while, one bad light-client refresh no
  longer un-syncs the client, and a gateway a resolver appears to be lying about may be reached
  directly at an address confirmed over DNS-over-HTTPS (both amendments are at the end). One
  part is *provisional*, named in the Decision.
- **Date:** 2026-09-24
- **Type:** architecture / security
- **Decided by:** owner, for what a `.eth` name loads as and how its trust is shown
  (`ens-ipfs-plan.md` §Decisions taken). AI recommendation, for the serving mechanism, the block a
  name is proven at, and which ENS record anchors DDOC.

## Decision

A `.eth` name loads at `https://<name>.eth`, an origin like any other: it is consented, installed
and served from its pin exactly as an HTTPS app is (`ADR-0005`, `ADR-0007`, `ADR-0018`).

- **The name is proven, not looked up.** A light client (`ADR-0031`), started at launch, proves the
  name's contenthash through ENS's Universal Resolver, CCIP-Read included, at the newest block it
  has verified. The contenthash is decoded here (ENSIP-7).
- **The content is checked, not trusted.** IPFS content comes from trustless gateways, raw block by
  raw block, and each block is hashed against its CID before any of it is used. A signed IPNS
  record is checked against its key and never accepted below the highest sequence already seen. A
  DNSLink is followed, and marked as unverified.
- **Failure is closed.** Nothing unverified is ever served in place of what could not be checked:
  the tab gets an error page naming what failed instead. If the verifier host itself dies
  mid-load, its socket is gone and Chromium shows its own connection error.
- **Both halves sit behind the canonical provider shapes** (`src/resolution/`): a name resolver per
  top-level domain and an ordered list of data gatherers, each with the canonical fallback to the
  next. Each list has one built-in entry in this build.
- **Serving.** Every `.eth` host resolves, through one `--host-resolver-rules` value, to a TLS
  server on loopback inside the verifier host, a utility process. Its certificate is created per
  run, and each session's verify proc accepts a `.eth` host only with that certificate's
  fingerprint. It answers a name on port 443 only, so a name is one origin, and every response
  carries `treat-as-public-address`. Chromium keeps its own CORS, cookie and WebSocket handling
  for everything else.
- **One bundle, one root.** An install names the root CID it began with on every request, and the
  server refuses a request once the name points elsewhere. The pin records the content address:
  the CID, what the contenthash named, the block, and whether every pointer was verified. The
  bundle hash is unchanged (`ADR-0009`); the CID is provenance, and the identifier a Web3 Score
  provider would assess.
- **Website level.** A name whose every pointer and every byte was verified meets DDOC, Level 2. A
  DNSLink's last hop is a DNS TXT record, forgeable on ICANN domains, so a DNSLink name is Level 1
  though its bytes are still checked. *(Amended 2026-09-25, below: a DNSLink name is Level 2 too.)*

Two parts were *provisional*; the second is settled by the Amendment below:

- **The block a name is proven at** is the newest the light client has verified, not the finalized
  one. Public RPCs serve storage proofs only for recent blocks, and finality lags the head by about
  80 blocks, so calls at the finalized block failed whenever that lag passed an RPC's proof window.
  An RPC with a longer window would settle it the other way.
- **DDOC's off-host anchor for a `.eth` name is its contenthash.** The CID commits to every file,
  the published hash tree at
  `/.well-known/orivon-ddoc.json` included, so the tree is anchored off the host with no second
  record. The owner's confirmation would settle it. *(Confirmed 2026-09-25.)*

## Context

`ens-ipfs-plan.md` is the work queue this ADR records the shape of, and its §Decisions taken are the
owner's. `docs/planning/spike-results/ens-ipfs.md` has the measurements the mechanism rests on:
the loopback design passed all four of its gates in Electron 44, with one caveat on the third.

## Alternatives considered

**One partition per `.eth` origin, served by `protocol.handle('https')`.** The measured fallback.
Every other host would have to pass through the handler, and on a handled response Electron 44
enforces no CORS, drops `Set-Cookie`, and sends no `Origin` upstream. Re-implementing those is a
larger attack surface than one loopback socket.

**A custom scheme, or a synthetic subdomain of a gateway.** `ADR-0007` refused both: the origin
would not be the name, and the page would not be a secure context without further exceptions.

**Helia or `@helia/verified-fetch`.** Both pull in `node-datachannel`, a native module (Rule 8).
The gatherer is built on the primitives beneath them instead (`src/ipfs/README.md`).

**A public HTTP gateway's rendered responses, or eth.limo.** Fast, and nothing checked: the
gateway, or the name service, would decide what the page is.

**Finalized blocks only.** See the provisional part above.

**A text record carrying the bundle root, as DDOC's anchor.** It would let a `.eth` name anchor an
app hosted on HTTPS, which needs a way to load a `.eth` name from HTTPS at all. This build loads
`.eth` names from IPFS only, where the contenthash already anchors everything.

## Reasoning

The one thing this build sets out to show about names is that a server can withhold, delay and
observe, but cannot make Orivon use a byte it changed. Every choice above keeps that true with the
least new machinery: the name is proven by a light client rather than read from an RPC, every
block is hashed before use, the page runs at an ordinary origin so the permission model applies
unchanged, and Chromium's own network stack stays in charge of everything that is not the page's
own content.

## Consequences

- **A loopback socket, which `security-model.md` T15 otherwise forbids.** Every local process can
  reach it. It can fetch public content, time responses to learn what is cached, and use Orivon as
  a resolver. It cannot inject content, because the certificate is pinned by fingerprint. The
  socket serves nothing user-specific (`security-model.md` T35).
- **Any web page can time a request to a `.eth` URL.** A name opened in the last two minutes
  answers from the verifier's memory, in milliseconds; one that was not needs a proof, in seconds.
  So a page can learn which names were opened recently, across sites (`open-questions.md` A256).
  *(Amended 2026-09-25, below: the verifier's caches are kept per site, which closes this for
  requests a page makes.)*
- **Any web page can make the verifier look names up**, as many as it likes. Each lookup is bounded:
  eight offchain queries per name, four names proven at once, 64 kept.
- **Local Network Access is not enforced in Electron 44**, so any page, `.eth` or not, can reach
  loopback services today. An end-to-end canary fails if that changes (`open-questions.md` A252).
- **Every launch contacts the light client's RPC and beacon API**, about 20 MB an hour of beacon
  traffic, and gateways learn the CIDs a person opens. The Settings panel names every server Orivon
  chooses; a name's resolver contract may send its offchain lookup to a server of its own.
- **A resolver that answers wrongly about DNS for gateway names** (one consumer ISP does, for two of
  the three defaults) leaves `.eth` loads on that line to the gateways it spares, and fails them
  closed if it spares none (`open-questions.md` A251). *(Amended 2026-09-26, below: a gateway the
  system resolver appears to be lying about may be reached directly at an address DNS-over-HTTPS
  confirms, resolving A251.)*
- **ENS's Universal Resolver is an upgradable proxy**, so ENS's proxy admin is part of what a
  resolution trusts.
- **Internationalised `.eth` names do not resolve**: a punycode host is refused until IDNA and
  ENSIP-15 are checked against each other.
- **A developer-mode name from `orivon-ports`' names file** skips all of this and stays plain HTTP
  on loopback; its resolver clauses come first.

## Amendment, 2026-09-25: DNSLink names are Level 2, the anchor is confirmed, caches are per site

**A DNSLink name is Website Level 2**, *provisionally*, until the owner confirms it. The owner
settled that a site meets DDOC, and so is Level 2, when its files match the hashes its owner
published, whatever holds that anchor: a tree on the site's own host counts (`ADR-0029`). IPFS
content meets DDOC by design, so a name whose last hop is a DNSLink follows as Level 2. The DNS hop stays unproven: the evidence names it, and the delivery
ladder leaves D4 unmet. The gatherer's DDOC report is therefore met or failed; whether the
pointers were proven is read from the pointers themselves.

**The DDOC anchor is confirmed**: a `.eth` name's contenthash, as the Decision's second
provisional part proposed.

**The verifier's caches are kept per site.** Mounted names, in-flight mounts and verified blocks
are keyed by the top-level page origin a request belongs to, the way Chromium partitions its own
HTTP cache, and the verifier host bypasses Electron's HTTP cache. The shell stamps every page's
`.eth` request with that origin in a `webRequest` listener on the default session, where every
page that can reach the verifier runs, and strips whatever a request set itself; a top-level
navigation belongs to the page it opens. A request with no frame gets the name's own partition
only when Chromium marks it as started by no page (`Sec-Fetch-Site: none`: the favicon fetch, the
loader) or as the name's own worker's (`same-origin`), marks no page can forge. Any other request
is served and nothing it fetched is kept.

What remains:
- **As in any browser with partitioned caches:** a page that opens a name as a top-level window,
  and times it, probes that name's own partition; the four mount slots and each gateway's own
  concurrency limit are shared across every site, so one site's load can slow another's (the
  2026-09-26 amendment below narrows this from a single shared pool to per-gateway ones, but does
  not remove it); and the verifier's caches are bounded (64 names, 64 MB of blocks), so a page
  that fills them can tell how much other `.eth` activity there was, though not which names.
- **A `.eth` site embedded on another site** can learn one bit about itself: its own worker's
  requests use its own partition, warm if the person opened it as a top-level page.
- **Outside the verifier:** fetching a rare CID warms a public gateway's edge cache near the
  person, and any page can time a gateway itself. Nothing on this machine can partition that.
  Whether the light client caches proofs between calls is not measured; if it does, the window
  is about one block.

## Amendment, 2026-09-26: gateway scheduling, a stale-name grace period, and a direct fallback for a lying resolver

Filed against reports that `.eth` pages sometimes rendered unstyled or missing parts, and that a
tab's loading spinner sometimes ran long after the page had visibly finished -- both traced to a
line whose ISP resolver answers two of the three default gateways with a block page (`A251`) and
whose remaining gateway rate-limits under the burst one page's assets create, and separately to a
light client that treated one bad refresh as fully unsynced.

**Gateways are scheduled by recent health, not a fixed order shared globally.** Each gateway keeps
its own concurrency limit (`src/ipfs/limits.ts`'s `perGatewayConcurrency`, 4) rather than one
limit shared by all of them (`gatewayConcurrency`, 8, before this amendment) -- a hung or
rate-limited gateway no longer holds back requests to the others. A 429 (honouring `Retry-After`
when given) or a transport failure cools that one gateway down for a while, doubling on repeat;
two timeouts in a row without a success in between count the same way, one alone does not, since
a gateway can hang on a block it does not have while answering everything else fine
(`src/ipfs/gateway-health.ts`). A block fetch tries the least-loaded non-cooling gateway first,
and hedges with a second after `hedgeDelayMs` (2 s) if nothing has verified yet -- the first
verified answer wins, the loser is abandoned (`src/ipfs/block-fetch.ts`). In-flight fetches for
the same block are shared per partition, the same way verified blocks already were, so two
concurrent requests for one asset cost one fetch (`src/ipfs/blockstore.ts`'s `SharedFetch`). IPNS
lookups go through the same per-gateway scheduling, sequentially, with no hedging.

**A name past its two-minute freshness window keeps serving its last proven root, stale, for up
to ten minutes (`STALE_SERVE_MS`, `src/verifier-host/serve/sites.ts`) while a single background
re-prove runs**, rather than blocking every request on a fresh proof or failing the site outright
on one re-prove's transient failure. A burst of requests past the window triggers one re-prove,
not one each; a successful re-prove replaces the served root and resets the freshness window; a
failed one is retried after a short pace (`FAILURE_TTL_MS`) without ever touching the last good
root. Past ten minutes with nothing but failed re-proves, a request waits on a fresh one instead
of serving a root that old.

**The light client tolerates one failed refresh.** A refresh that fails to read the chain's head
no longer un-syncs the client while the last proven head is under two minutes old
(`HEAD_GRACE_MS`, `src/verifier-host/light-client/light-client.ts`); past that window, or on a
second failure with no success between, the client drops to syncing and the next request waits up
to `SYNC_WAIT_MS` for a real answer, as before. A checkpoint read (a separate, non-essential RPC
call) failing never affects sync state at all, and retries follow sooner (5 s) after a failure
than the ordinary 60 s cadence.

**A gateway the system resolver appears to be lying about may be reached directly, resolving
A251.** Only once Electron's own `net.fetch` has failed a gateway with a transport error (never an
HTTP status), and only for a gateway main found to have no proxy configured
(`src/main/verifier/proxy-check.ts`, checked once per host start via `app.resolveProxy` -- the
call Electron's own typing says "is used when attempting to make requests using Net in the
utility process"), the verifier host compares the system resolver's addresses for that host
against a DNS-over-HTTPS answer from the same resolvers already trusted for DNSLink
(`src/verifier-host/doh.ts`'s `dohAddressResolver`, public-unicast answers only). Disjoint
addresses switch that gateway to a direct connection at the DoH address for ten minutes
(`src/verifier-host/dns-fallback.ts`), reached over `node:https` with a pinned DNS lookup but TLS
still verified against the real hostname -- neither of Electron's `net.fetch`/`net.request` can
pin a connection to a chosen address while keeping the real hostname for SNI (confirmed against
`electron.d.ts`, Electron 44, the same gap `loader/electron/fetch.ts` names for the install path)
-- GET/HEAD only, no redirect ever followed, `accept-encoding: identity` only (a compressed body
would fail its own hash check and wrongly frame an honest gateway as a liar). A direct attempt
that itself fails resets that gateway to the ordinary path. Agreeing addresses, or no proxy-free
gateway to try at all, leave every request exactly as before this amendment.

What remains:
- **Stale serving extends how out of date a proven root can be**, from two minutes to up to ten
  under sustained re-prove failure. An installed app stays protected regardless by the existing
  409 content-root check.
- **Gateway cooldown state is process-wide**, so one site's burst against a gateway can still slow
  another site's fetches through it -- narrower than the single shared concurrency limit before
  this amendment, not removed by it.
- **The direct path trusts Node's bundled CA roots, not the OS certificate store.** A machine with
  a TLS-inspecting local proxy but no configured system proxy would fail the direct connection,
  leaving that gateway simply cooling down -- no worse than before this amendment.
- **The proxy check is a snapshot taken at each verifier host start**, not live; a proxy toggled
  mid-run is not noticed until the next restart.
- **If the same resolver that lies about a gateway's address also lies about the DNS-over-HTTPS
  endpoints themselves**, this amendment has nothing left to fall back to.

## Reversibility

- **Cost to reverse:** moderate. The origin rule (`https://<name>.eth`) is visible to every
  installed `.eth` app and its grants; the serving mechanism behind it is internal and could be
  swapped for the partition design without changing any origin.
- **What would make us revisit:** Electron enforcing Local Network Access in a way the canary
  flags; a measured need to serve `.eth` names from something other than IPFS; or the owner
  choosing a different DDOC anchor.
