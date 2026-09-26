# Security model

Deliberately short. It earns its place because Orivon brokers OS access to web content, which
an ordinary browser never does.

## The honest headline

**A Node broker is not a sandbox.** Orivon's boundary is *authorisation* (apps only reach what
they were granted) rather than *containment*. If the broker has a hole, a hostile app has the user's
machine.

This is stated in the product (`mvp-scope.md` non-goals), it is why developer mode carries a
real warning rather than a reassuring one, and it is the concrete reason `orivon-runtime`
exists on the roadmap (`ADR-0002`).

## Assets
User's filesystem · the machine's network position (an app can reach the LAN, localhost, and
arbitrary hosts) · identity seed and derived keys · other apps' data · attention and privacy.

## Adversaries
1. **A hostile app**, installed via developer mode. The primary adversary.
2. **A compromised app host.** A legitimate app, an attacker-controlled server, serving new code.
3. **A hostile peer** in the torrent swarm.
4. **A network observer.**
5. **An ordinary hostile website** in a normal tab, attempting to reach `orivon.*`.
6. **A same-user local process.** The relevant attacker for the seed, the grant ledger and the
   app cache. `safeStorage` does not defend against it (T24).

## Trust boundaries
- **renderer ↔ broker**: *the* boundary. Everything below hangs off it.
- **broker ↔ OS**: the broker holds full user authority and must never widen it.
- **app ↔ app**: enforced by per-origin storage and session partitions (`ADR-0003`).
- **browser ↔ network**: untrusted by definition.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | Hostile app reads or writes outside its directory | `fs` rooted per origin; resolve then verify prefix; reject `..`. **Unit-tested**, because a silent bug here is a full compromise |
| T2 | Hostile app obtains a capability it never declared | Grants are checked against the *pinned* manifest, not a runtime-supplied one. Absence means denial; there is no default-allow |
| T3 | Compromised renderer forges IPC to impersonate another app | The broker derives origin from **`event.senderFrame`, captured synchronously at message receipt**: per *frame*, never per `WebContents`, and re-derived on every call. It reads **both `url` and `origin`, and denies when they disagree** (see the T3/T13b note below). **An origin in the IPC *payload* is never trusted**, since that is the renderer-supplied identity this threat is about |
| T4 | Ordinary website reaches `orivon.*` | **Two separate preload files**, chosen by the broker from the app registry and never from anything renderer-supplied. The ordinary-tab preload exposes `window.nostr` only and does not reference `orivon.*` at all. See the T4 note below |
| T5 | Renderer escape into Node | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no remote module. Non-negotiable |
| T6 | Compromised host silently swaps app code that already holds grants | Bundle hash pinned at install; any change re-prompts before running (`ADR-0005`, `ADR-0006` D2). The hash tree a site publishes (DDOC, `ADR-0029`) is evidence, not a defence here: it sits on the same host, so a host that swaps the code can swap the tree too |
| T7 | App escapes its manifest by rewriting its own code | Code cache is **read-only to the app**; only the broker writes it (`ADR-0003`) |
| T8 | Identity key exfiltration | Seed in `safeStorage`, never exposed; apps receive **derived** keys and secrets only (`orivon.id`, and `orivon.secrets` under a distinct salt, [`ADR-0033`](../decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md)); raw export is not a capability at any tier. **Scope of that protection:** `safeStorage` defends against another OS user and against offline disk access, but not against same-user code (T24) |
| T8b | A connected site silently signs destructive or authenticating events with a named identity | Named identities expose `signEvent(obj)`, **never raw-payload signing**. The broker screens `kind`: 1/6/7 silent; **0, 3, 5, 22242 and any delegation prompt**. Derive a separate secret per `(label, curve)` via length-prefixed HKDF, never one scalar across two schemes. `nip04`/`nip44` decrypt, if offered at all, is a **separate grant** from signing. A local append-only signing log (origin, identity, kind, time) with a viewer is the missing repudiation control |
| T9 | Cross-app identity correlation | App keys derive per origin, so apps cannot link a user silently. **Named identities** (e.g. Nostr) are cross-origin *by explicit consent only*; the connect prompt is the boundary (`capability-api.md`) |
| T10 | Hostile peer serves corrupt torrent data | Piece verification against the infohash, inherent to BitTorrent and not something Orivon adds |
| T11 | Resource exhaustion (disk, sockets, bandwidth) | `fs.quotaBytes` enforcement, socket count limits, disk-usage UI (`ADR-0003`). Quota default must be a fraction of **free disk measured at grant time**, not the absolute 50 GiB constant in the manifest example |
| T11b | One app saturates the broker and freezes every tab | The broker runs on the UI thread, so a loop of `orivon.fs.stat()` hangs the whole browser. Per-origin in-flight cap and a token-bucket rate limit on IPC dispatch; all `fs` work genuinely async |
| T11c | Handle IDs are forgeable across origins | **Per-origin handle tables** plus an ownership check on every operation. A single global map with sequential integers lets one app read another's open file or write its socket |
| T12 | App reaches localhost or the LAN to attack other services | **Manifest patterns must be checked against resolved addresses, not hostnames**, because otherwise DNS rebinding defeats them. Private ranges denied unless explicitly declared. `net.connectSecure` matches by name only while default certificate verification binds the name to the peer; any TLS option that unbinds it (`rejectUnauthorized: false`, the app's own `ca`, another `servername`) adds the resolve-once address check |
| T13 | Telemetry endpoint used to correlate users | Random install ID, no third party, **monthly aggregate rather than a per-session timeline**, since session timestamps against a stable ID are a daily activity pattern, and the metric needs a sum (`ADR-0004`). The client **ignores the response body entirely**: no server-driven config, no kill switch, no remote-control channel |
| T13b | Origin-as-path collapses distinct origins, or escapes the app root | Directory names are `sha256(canonical_origin)`, never the origin string, because otherwise `https://Example.com` and `https://example.com` share a directory on macOS/Windows. Code and data live under **separate roots**, so a one-level `fs` escape reaches an empty parent rather than executable code. Opaque origins (`data:`, `blob:`, `file:`, sandboxed frames) are rejected outright |
| T13c | Grants persist on a loopback origin and are inherited by an unrelated local server on the same port | Never persist grants for loopback, `file:` or plain-`http` origins. Session-scoped only, re-prompt each launch, permanent insecure marker in the tab. Developer mode must be UI-only: unreachable from renderer IPC *and* from any command-line flag |
| T14 | Electron CVEs | Track upstream releases. A browser is a high-value target; upgrading is maintenance, not optional |
| T15 | An app-run localhost server (e.g. media streaming) is reachable by every local process and every other app | **No localhost socket.** Media is served over a range-capable custom scheme via `protocol.handle()`, or webtorrent's Service-Worker `createServer({controller})`, both renderer-local and origin-scoped, so no local process can reach them. Strictly stronger than guarding a 127.0.0.1 server with a token. **One exception, the `.eth` verifier** (T35): it answers only `.eth` names, serves nothing user-specific, and a page can trust it only by its per-run certificate, which the shell pins by fingerprint |
| T16 | Any website probes `window.nostr` to fingerprint Orivon or read the user's pubkey | Presence is detectable, as it is for every NIP-07 extension. The pubkey and signing are gated behind a per-site connect prompt; no identity data leaks without consent. **Note the disanalogy:** an extension is a deliberate install of a key the user generated and can back up; this identity is silent, shipped to 100% of installs, and not exportable in v0 |
| T17 | An app transfers a live socket `MessagePort` to an unauthorised origin | **The raw port never crosses into the main world.** The preload holds it in the isolated world and exposes only `contextBridge` closures. `MessagePort` is transferable and carries **no sender identity**, so a transferred port is a bearer capability: the fast implementation is the insecure one |
| T18 | Compromised host navigates a granted app to attacker content, or embeds it in a subframe | A navigation that takes an app tab to another origin swaps the tab into that origin's own session (`ADR-0018`, `src/main/shell/tab-view.ts`), so the app's partition, and the pinned cache served in it, never hold another origin's document; `setWindowOpenHandler` makes every popup a tab, never an OS window, and a popup into an isolated app always opens in that app's own session (a popup the app opens onto the open web keeps the app's session until its opener closes, A230); **`orivon.*` is absent from subframes**, since the preload runs only in a tab's top-level frame; `webviewTag: false`. Without this, a 302 would run another origin's document inside the app's partition, defeating hash pinning with no key required |
| T19 | Silent update widens capability *patterns* without adding a capability *kind* | Re-consent triggers on a **subset check over granted patterns**, not a kind comparison. `["api.example.com:443"]` → `["*:*"]` must prompt. Plus a per-origin **version floor** that only ever rises, so a validly-signed older bundle is never installed unnoticed (see the T19 note below: it is warned and chosen, never silent) |
| T20 | `orivon.net` bypasses a configured proxy, de-anonymising the user | Node `net`/`dgram` do not honour Chromium's proxy settings. **Fail closed:** if a proxy is configured, socket capabilities refuse to open and the prompt says why. Never silently direct-connect around a proxy. Same for DNS resolution |
| T21 | Cached app code is served in a way that loses the pin | Serve cached assets at the app's own https origin via a session `protocol` interceptor and **fail closed**: a same-origin request whose path is not in the pinned asset set is denied, not fetched. Re-verify the cached tree hash **at every load**, not only at fetch |
| T22 | App reaches arbitrary hosts via `fetch`/WebSocket/WebRTC, invisible to the broker | Broker-injected CSP on each app's session partition (`connect-src` limited to the bundle plus the origin's *granted* patterns; see the T22 note below), applied via `onHeadersReceived` so the app cannot relax it. Bounds `fetch`/WebSocket only; WebRTC is unmitigated (`docs/open-questions.md` A41) and the name-vs-address gap is open (A42). Without this the grant does not bound network reach and the trust indicator reports what it cannot see (`ADR-0006`) |
| T23 | `magnet:` handler abused | Validate the URI against a strict grammar before it reaches any other code, and drop argv entries that do not parse (protocol-handler argument injection is a known Electron class). Magnet navigation from web content requires a confirm dialog, because otherwise any page can silently place the user's IP in a swarm of its choosing. Manifest protocol claims need their own prompt; declaration alone never wins the default |
| T24 | A same-user local process reads the seed, grant ledger, or app cache | Named explicitly as an adversary. `safeStorage` protects against *another OS user* and offline disk access, but **not** against code running as the same user, which can simply ask the OS to decrypt |
| T25 | The address bar displays a misleading origin (IDN/punycode homograph, embedded userinfo, an overlong subdomain pushing the real host out of view) | The shell is the first component to render an origin to the user, and `capability-api.md` requires the grant prompt to be origin-first (T18-adjacent). An IDN host is punycoded and userinfo stripped before an origin is rendered. The grant prompt keeps only the host's last three dot-separated labels (`src/main/consent/grant-prompt-render.ts`'s `formatOriginForDisplay`, A115), so the label that decides authority is always visible and `accounts.google.com.attacker.example` cannot pass for Google. The prompt shows the origin only in its `title`, a field some platforms drop (A127, partially resolved). The address bar itself shows the tab's full URL as Electron reports it (`src/renderer/main.ts`); showing the host distinctly from path and query there is not built |
| T26 | An app cannot tell an Orivon-vetted cryptographic primitive from a third-party polyfill reached through the identical name (`docs/open-questions.md` A132) | **The placement is the mitigation, and it is why admitting third-party polyfills is survivable at all.** The shim runs inside the untrusted renderer, on the app's own side of the renderer/broker boundary this document opens with, so a backdoored polyfill has no reach beyond what the app itself already had; it cannot make an unauthorised socket appear, only misbehave within a boundary the broker still enforces. **What is not mitigated:** `src/shim/module-map.ts` presents `crypto-browserify` to apps as `crypto`, with no marking that distinguishes it from Orivon's own identity cryptography (`policy/derive.ts`, WebCrypto, golden vectors checked in CI against an independent implementation). An app calling `crypto.createHash()` cannot tell, from the name alone, which footing it is standing on, and the two differ: `crypto-browserify` carries a third-party advisory today (A121) that WebCrypto does not. No API distinguishes them, and building one is a `src/contracts/` change outside this entry's scope; recorded as an honest, open naming gap rather than a defect in the boundary itself |
| T27 | An IPFS gateway alters a `.eth` site's content | Every block is hashed against its CID before any byte of it is used or cached (`src/ipfs/blockstore.ts`). A gateway that sends one bad block is not asked again that session. A block that fails from every source fails the page closed, with an error page naming it; nothing unverified is served in its place |
| T28 | An RPC or beacon API lies about what a `.eth` name points to | The name is proven by the Helios light client through ENS's Universal Resolver, against the newest block it has verified (`ADR-0030`, `ADR-0031`). A proof that fails is refused, and there is no fallback to an unverified lookup |
| T29 | The Web3 Score page claims a Website level the site has not earned | Level 2 only when DDOC holds: every byte of a `.eth` site checked against its CID, or an installed site's files matching its published tree. Level 3 and above only from a provider; with none configured they show grey `?`. How the anchor is held (a proven name, a DNSLink, the site's own host) is evidence beside the level (`ADR-0006`) |
| T30 | A stale or forged light-client checkpoint | A checkpoint ships with each release, is replaced by the newest one the light client verified, and is refused past 14 days or when dated after the clock (`src/main/verifier/checkpoint.ts`). The release checklist refreshes it from two beacon APIs that must agree |
| T31 | A resolver contract's CCIP-Read URL, or a DNSLink, points the verifier at loopback or the LAN | CCIP-Read requests are `https:` only, every address the host resolves to must be public unicast (`src/broker/policy/address.ts`), redirects stay on the same origin, answers are capped in size and time, and one name makes at most eight such queries (`src/verifier-host/egress.ts`). A DNSLink only ever names content, which is then hashed |
| T32 | A hostile DAG exhausts the verifier's memory or time | Limits on block size, links per node, blocks and bytes per request, depth and pointer hops (`src/ipfs/limits.ts`); only a small look-ahead of blocks is held; a request's work stops when its client leaves; 64 mounted names and four concurrent proofs at most |
| T33 | An IPNS record is rolled back to an older value | The highest sequence seen per key is kept across runs, and a lower one is refused |
| T34 | A parser or WebAssembly bug in the ENS or IPFS stack compromises the shell | Every untrusted parser (UnixFS, dag-pb, IPNS protobuf, CCIP answers, the light client's WebAssembly) runs in the verifier host, a utility process, never in main. The host's network access is allowlisted per purpose |
| T35 | The verifier's loopback socket, which T15 otherwise forbids, is reached or squatted by a local process | It answers only `.eth` hosts on port 443 and only GET and HEAD. A process that takes its port cannot pass for it, because each session accepts a `.eth` certificate only by the run's fingerprint. What a local process can do is fetch public content, time responses, and use Orivon as a resolver (`ADR-0030`) |
| T36 | A web page times a `.eth` request to learn which names the person opened | The verifier's caches are kept per top-level page origin, which the shell stamps on every page's `.eth` request, stripping any a request set itself; a request with no frame keeps nothing unless Chromium marks it as no page's or the name's own worker's, and the host bypasses the HTTP cache. What remains is listed in `ADR-0030`: a top-level window opened on a name, shared slots and cache bounds, one bit for a `.eth` site embedded elsewhere, and public gateways' own caches |
| T37 | The light client's supply chain | `@a16z/helios` is pinned to an exact version, its provenance is checked on each bump, and it reaches only its allowlisted RPC and beacon endpoints, always from a checkpoint Orivon chose (`ADR-0031`) |
| T38 | Every launch tells an RPC and a beacon API that this machine runs Orivon, and lookups tell servers which names and content the person opens | Named in the README and in the Settings section, with every server listed. A name is looked up only on a navigation or an app's own load, and gateways see CIDs, not the page that asked |
| T39 | A lying system resolver, or a tampered DNS-over-HTTPS answer, steers the verifier's direct gateway connection (`ADR-0030`) at an address of its choosing | Taken only after `net.fetch` has failed the gateway with a transport error, and only for a gateway with no proxy configured; every candidate address is checked public-unicast before use, exactly as T12 requires elsewhere, so a private or loopback address is never dialled. TLS still verifies the certificate against the gateway's real hostname, so a forged address without a valid certificate for that name still fails the connection. Never used when a proxy is configured, so a corporate or privacy proxy's own routing is never bypassed |

T12 is the one most likely to be got wrong: a naive `net` implementation that matches on the
hostname string lets an app declare `example.com` and then have DNS resolve it to `127.0.0.1`.
Three precision requirements, since the general statement permits a wrong implementation:
- **`*` means public unicast only.** A P2P app declares `tcp.connect: ["*:*"]`, so this must
  be specified, not inferred: private ranges, loopback, link-local, broadcast and multicast are
  denied unless separately declared.
- **Resolve once, validate every returned address, then connect to the IP literal.** Checking a
  hostname and then dialling that hostname re-resolves and is defeated by a TTL-0 server. Node
  24 defaults `autoSelectFamily: true`, so *all* candidate addresses must be validated.
- **`net.listen` must declare its bind interface.** Node defaults to `0.0.0.0`, which exposes
  the service to the whole LAN; the prompt must distinguish "reachable from the internet" from
  "reachable from your local network".

## Notes on the subtlest rows

Four rows above have reasoning that does not fit in a table cell.

**T3, why origin is per-frame and captured synchronously.** A `WebContents` is a *tab*, not
an origin, and Electron re-injects preloads on **every navigation**. An app holding
`tcp.connect *:*` could navigate itself to a hostile origin, which would then run with the
Orivon preload while the grant ledger still resolved to the app. This also defeated
`ADR-0005`'s publisher-key amendment outright: a compromised host does not need the signing
key, it serves a redirect. Origin is therefore derived per-frame and captured synchronously (an
async handler can resolve after the frame is detached or navigated).

> **Why the mitigation reads both `url` and `origin`.**
>
> Preloads are **not** re-injected into iframes by default.
> Electron injects the preload into subframes only when `nodeIntegrationInSubFrames: true`,
> which this project does not set and `.claude/hookify.electron-webprefs.local.md` blocks.
> Verified against real Electron 44. Navigation is the load-bearing half.
>
> Neither `event.senderFrame.origin` nor `frame.url` is
> renderer-supplied: Electron computes both in the browser process, from
> `GetLastCommittedURL()` and the RFC 6454 serialisation of `GetLastCommittedOrigin()`. A
> renderer can set neither. The renderer-supplied identity T3 is actually about is an origin
> field in the **IPC payload**.
>
> **Neither field is sufficient alone**, which is why the mitigation reads *both*:
>
> - `url` alone cannot see an **opaque** origin. A top-level document served with
>   `Content-Security-Policy: sandbox` keeps its ordinary `https:` URL while Chromium gives it
>   no origin at all. Measured: url `http://127.0.0.1:PORT/sandboxed`, origin `null`.
>   Deriving from the URL alone hands it the embedding app's entire grant set, which is exactly
>   what **T13b** forbids when it names sandboxed frames.
> - `origin` alone cannot see a **borrowed** origin. `blob:https://x.example/u` serialises to
>   the real `https://x.example`, and an `about:blank` child frame inherits its parent's origin
>   while its url stays `about:blank`. T13b refuses both; the origin field reports both as
>   ordinary.
>
> So: derive from `url`, require `origin` to agree, deny otherwise. Compare **after**
> canonicalisation, because A14 strips the trailing DNS root label and Chromium does not, so a raw
> string comparison would deny every trailing-dot app by way of our own deviation.

**T4, why the invariant is two preload files.** Ordinary tabs are not preload-free:
`window.nostr` is injected into them by design (`capability-api.md`). The invariant that
actually holds is two distinct preload files. A single wrong
`webPreferences.preload` path, or one shared preload branching on renderer-influenced state,
would turn every website into a fully capable Orivon app.

**T22, why CSP is derived from grants rather than the manifest.**
`src/broker/policy/connect-src.ts` derives `connect-src` from the origin's
*granted* `tcp.connect` patterns, never `manifest.capabilities.net.tcp.connect` directly, the
same distinction `src/broker/index.ts`'s own `connect()` already draws (a manifest may *declare*
`*:*` while the user grants a single host). Deriving CSP from the manifest instead would let the
header permit network reach the user explicitly refused.

**T19, what reaching the version floor actually does.** A below-floor version is never silently
blocked and never silently installed. The first time a given origin offers one, the user is
warned and asked whether to proceed with it or keep the cached version. Once they have said yes
once for that origin, a later below-floor version from it that asks for nothing new (same
authority, same bytes as what is already pinned) installs with an ongoing, passive,
non-blocking notice rather than asking again.

A below-floor version that ALSO widens the granted pattern set, or serves bytes that do not match
what is pinned, still produces `capability-prompt` or `reconsent` exactly as an ordinary
at-or-above-floor update carrying the same change would; the passive notice never overrides
those. Without that rule, one benign user-approved rollback would set `rollbackAcknowledged` for
the origin and let anyone who later controlled it serve arbitrarily different code, or a widened
capability set, under an already-forgiven version number with no prompt at all. The floor itself
only ever rises (`GrantLedger.versionFloor`, persisted, A57). See `ADR-0013` for the full
reasoning and the mechanics `src/broker/policy/update.ts`'s `decideUpdate()` implements.

**A granted IPv6 literal cannot be represented in CSP at all.** CSP's host grammar is `ALPHA / DIGIT / "-"`, with no `[`, `]` or `:`, and Chromium drops
a bracketed source outright rather than partially honouring it (confirmed in Electron 44.0.0 /
Chrome 152). `connectSrcFor` omits an IPv6 pattern with reason `host-ipv6-literal` rather than
emitting a token the browser silently discards. Same consequence as a `*` grant (open-questions.md
A43): the pattern is `fetch`-blocked, not merely CSP-uncovered, and `omitted` is what lets a later
build step explain why.

## Capabilities excluded from v0, on security grounds
`subprocess` and `hid` are absent from the v0 API entirely, for signed apps too, not merely
unsigned ones (`capability-api.md`). No MVP app needs them, and they are the largest available
attack surface. Adding either requires an ADR.

## Cross-platform note
`safeStorage` is Keychain on macOS and DPAPI on Windows, but on Linux requires an available
keyring; `isAsyncEncryptionAvailable()` resolves false without one, and Electron's own
`'basic_text'`/`'unknown'` `getSelectedStorageBackend()` values mean the same thing by a
different route. **Never a silent plaintext fallback.** `src/main/keyring/seed-store.ts`
([`ADR-0033`](../decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md))
generates an ephemeral, session-only identity for that launch instead, and never writes it to
disk; the choice is not shown to the person for now, only logged.

## Not defended against, stated plainly
- A hostile app that a user deliberately installs in developer mode and grants capabilities to.
  That is the point of developer mode, and containment arrives with `orivon-runtime`.
- A compromised build machine or a malicious release. There is no reproducible build and, on
  Linux, no signing in month 1.
- Traffic analysis. No Tor integration in the MVP.
