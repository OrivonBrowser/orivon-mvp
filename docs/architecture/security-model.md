# Security model

Deliberately short. It earns its place because Orivon brokers OS access to web content, which
an ordinary browser never does.

## The honest headline

**A Node broker is not a sandbox.** Orivon's boundary is *authorisation* — apps only reach what
they were granted — not *containment*. If the broker has a hole, a hostile app has the user's
machine.

This is stated in the product (`mvp-scope.md` non-goals), it is why developer mode carries a
real warning rather than a reassuring one, and it is the concrete reason `orivon-runtime`
exists on the roadmap (`ADR-0002`).

## Assets
User's filesystem · the machine's network position (an app can reach the LAN, localhost, and
arbitrary hosts) · identity seed and derived keys · other apps' data · attention and privacy.

## Adversaries
1. **A hostile app**, installed via developer mode. The primary adversary.
2. **A compromised app host** — legitimate app, attacker-controlled server, serving new code.
3. **A hostile peer** in the torrent swarm.
4. **A network observer.**
5. **An ordinary hostile website** in a normal tab, attempting to reach `orivon.*`.
6. **A same-user local process.** The relevant attacker for the seed, the grant ledger and the
   app cache — `safeStorage` does not defend against it (T24).

## Trust boundaries
- **renderer ↔ broker** — *the* boundary. Everything below hangs off it.
- **broker ↔ OS** — the broker holds full user authority and must never widen it.
- **app ↔ app** — enforced by per-origin storage and session partitions (`ADR-0003`).
- **browser ↔ network** — untrusted by definition.

## Threats and mitigations

| # | Threat | Mitigation |
|---|---|---|
| T1 | Hostile app reads or writes outside its directory | `fs` rooted per origin; resolve then verify prefix; reject `..`. **Unit-tested** — a silent bug here is a full compromise |
| T2 | Hostile app obtains a capability it never declared | Grants are checked against the *pinned* manifest, not a runtime-supplied one. Absence means denial; there is no default-allow |
| T3 | Compromised renderer forges IPC to impersonate another app | The broker derives origin from **`event.senderFrame.origin`, captured synchronously at message receipt** — per *frame*, never per `WebContents`, and re-derived on every call. **Renderer-supplied identity is never trusted.** See the correction below |
| T4 | Ordinary website reaches `orivon.*` | **Two separate preload files**, chosen by the broker from the app registry and never from anything renderer-supplied. The ordinary-tab preload exposes `window.nostr` only and does not reference `orivon.*` at all. See the correction below |
| T5 | Renderer escape into Node | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no remote module. Non-negotiable |
| T6 | Compromised host silently swaps app code that already holds grants | Bundle hash pinned at install; any change re-prompts before running (`ADR-0005`, `ADR-0006` D2) |
| T7 | App escapes its manifest by rewriting its own code | Code cache is **read-only to the app**; only the broker writes it (`ADR-0003`) |
| T8 | Identity key exfiltration | Seed in `safeStorage`, never exposed; apps receive **derived** keys only; raw export is not a capability at any tier. **Scope of that protection:** `safeStorage` defends against another OS user and against offline disk access — not against same-user code (T24) |
| T8b | A connected site silently signs destructive or authenticating events with a named identity | Named identities expose `signEvent(obj)`, **never raw-payload signing**. The broker screens `kind`: 1/6/7 silent; **0, 3, 5, 22242 and any delegation prompt**. Derive a separate secret per `(label, curve)` via length-prefixed HKDF — never one scalar across two schemes. `nip04`/`nip44` decrypt, if offered at all, is a **separate grant** from signing. A local append-only signing log (origin, identity, kind, time) with a viewer is the missing repudiation control |
| T9 | Cross-app identity correlation | App keys derive per origin, so apps cannot link a user silently. **Named identities** (e.g. Nostr) are cross-origin *by explicit consent only* — the connect prompt is the boundary (`capability-api.md`) |
| T10 | Hostile peer serves corrupt torrent data | Piece verification against the infohash — inherent to BitTorrent, not something Orivon adds |
| T11 | Resource exhaustion (disk, sockets, bandwidth) | `fs.quotaBytes` enforcement, socket count limits, disk-usage UI (`ADR-0003`). Quota default must be a fraction of **free disk measured at grant time**, not the absolute 50 GiB constant in the manifest example |
| T11b | One app saturates the broker and freezes every tab | The broker runs on the UI thread, so a loop of `orivon.fs.stat()` hangs the whole browser. Per-origin in-flight cap and a token-bucket rate limit on IPC dispatch; all `fs` work genuinely async |
| T11c | Handle IDs are forgeable across origins | **Per-origin handle tables** plus an ownership check on every operation. A single global map with sequential integers lets one app read another's open file or write its socket |
| T12 | App reaches localhost or the LAN to attack other services | **Manifest patterns must be checked against resolved addresses, not hostnames** — otherwise DNS rebinding defeats them. Private ranges denied unless explicitly declared |
| T13 | Telemetry endpoint used to correlate users | Random install ID, no third party, **monthly aggregate rather than a per-session timeline** — session timestamps against a stable ID are a daily activity pattern, and the metric needs a sum (`ADR-0004`). The client **ignores the response body entirely**: no server-driven config, no kill switch, no remote-control channel |
| T13b | Origin-as-path collapses distinct origins, or escapes the app root | Directory names are `sha256(canonical_origin)`, never the origin string — otherwise `https://Example.com` and `https://example.com` share a directory on macOS/Windows. Code and data live under **separate roots**, so a one-level `fs` escape reaches an empty parent rather than executable code. Opaque origins (`data:`, `blob:`, `file:`, sandboxed frames) are rejected outright |
| T13c | Developer-mode grants persist on a loopback origin and are inherited by an unrelated local server | Never persist grants for loopback, `file:` or plain-`http` origins — session-scoped only, re-prompt each launch, permanent insecure marker in the tab. Developer mode must be UI-only: unreachable from renderer IPC *and* from any command-line flag |
| T14 | Electron CVEs | Track upstream releases. A browser is a high-value target; upgrading is maintenance, not optional |
| T15 | An app-run localhost server (e.g. media streaming) is reachable by every local process and every other app | **No localhost socket.** Media is served over a range-capable custom scheme via `protocol.handle()`, or webtorrent's Service-Worker `createServer({controller})` — both renderer-local and origin-scoped, so no local process can reach them. Strictly stronger than the token-on-127.0.0.1 mitigation this row previously settled for |
| T16 | Any website probes `window.nostr` to fingerprint Orivon or read the user's pubkey | Presence is detectable — true of every NIP-07 extension. The pubkey and signing are gated behind a per-site connect prompt; no identity data leaks without consent. **Note the disanalogy:** an extension is a deliberate install of a key the user generated and can back up; this identity is silent, shipped to 100% of installs, and not exportable in v0 |
| T17 | An app transfers a live socket `MessagePort` to an unauthorised origin | **The raw port never crosses into the main world.** The preload holds it in the isolated world and exposes only `contextBridge` closures. `MessagePort` is transferable and carries **no sender identity**, so a transferred port is a bearer capability — the fast implementation is the insecure one |
| T18 | Compromised host navigates a granted app to attacker content, or embeds it in a subframe | Block navigation away from the app's own origin (`will-navigate`, `setWindowOpenHandler`); **reject `orivon.*` from subframes outright in v0**; `webviewTag: false`. Without this, a 302 defeats the publisher-key pinning entirely — no signing key required |
| T19 | Silent update widens capability *patterns* without adding a capability *kind* | Re-consent triggers on a **subset check over granted patterns**, not a kind comparison. `["api.example.com:443"]` → `["*:*"]` must prompt. Plus a per-origin **version floor**, so a validly-signed older bundle cannot be replayed |
| T20 | `orivon.net` bypasses a configured proxy, de-anonymising the user | Node `net`/`dgram` do not honour Chromium's proxy settings. **Fail closed:** if a proxy is configured, socket capabilities refuse to open and the prompt says why. Never silently direct-connect around a proxy. Same for DNS resolution |
| T21 | Cached app code is served in a way that loses the pin | Serve cached assets at the app's own https origin via a session `protocol` interceptor and **fail closed** — a same-origin request whose path is not in the pinned asset set is denied, not fetched. Re-verify the cached tree hash **at every load**, not only at fetch |
| T22 | App reaches arbitrary hosts via `fetch`/WebSocket/WebRTC, invisible to the broker | Broker-injected CSP on each app's session partition (`connect-src` limited to the bundle plus manifest-declared hosts), applied via `onHeadersReceived` so the app cannot relax it. Without this the manifest does not bound network reach and the trust indicator reports what it cannot see (`ADR-0006`) |
| T23 | `magnet:` handler abused | Validate the URI against a strict grammar before it reaches any other code, and drop argv entries that do not parse (protocol-handler argument injection is a known Electron class). Magnet navigation from web content requires a confirm dialog — otherwise any page can silently place the user's IP in a swarm of its choosing. Manifest protocol claims need their own prompt; declaration alone never wins the default |
| T24 | A same-user local process reads the seed, grant ledger, or app cache | Named explicitly as an adversary. `safeStorage` protects against *another OS user* and offline disk access — **not** against code running as the same user, which can simply ask the OS to decrypt |
| T25 | The address bar displays a misleading origin (IDN/punycode homograph, embedded userinfo, an overlong subdomain pushing the real host out of view) | Newly reachable at build step 1 (2026-08-26) — the shell is the first component to render an origin to the user, and `capability-api.md`'s grant-prompt-must-be-origin-first requirement (T18-adjacent) exists for exactly this reason, one layer later. Mitigation not yet implemented in the shell itself: the address bar must show the resolved host distinctly from path/query, punycode must render in a form that reveals homograph confusables rather than the decoded Unicode alone, and userinfo (`user:pass@host`) must never be allowed to visually stand in for the host. Not consequential yet — nothing hangs a trust decision on the address bar's display until build step 4's grant prompt exists — but recorded now, before that step, rather than found late: the grant prompt cannot be trusted to be origin-first if the address bar one layer below it already is not |

T12 is the one most likely to be got wrong: a naive `net` implementation that matches on the
hostname string lets an app declare `example.com` and then have DNS resolve it to `127.0.0.1`.
Three precision requirements, since the general statement permits a wrong implementation:
- **`*` means public unicast only.** The flagship declares `tcp.connect: ["*:*"]`, so this must
  be specified, not inferred: private ranges, loopback, link-local, broadcast and multicast are
  denied unless separately declared.
- **Resolve once, validate every returned address, then connect to the IP literal.** Checking a
  hostname and then dialling that hostname re-resolves and is defeated by a TTL-0 server. Node
  24 defaults `autoSelectFamily: true`, so *all* candidate addresses must be validated.
- **`net.listen` must declare its bind interface.** Node defaults to `0.0.0.0`, which exposes
  the service to the whole LAN; the prompt must distinguish "reachable from the internet" from
  "reachable from your local network".

## Corrections found in the 2026-08-25 audit

Recorded rather than silently rewritten, because both were load-bearing claims.

**T3 said "the broker derives origin from the `WebContents`."** A `WebContents` is a *tab*, not
an origin, and Electron re-injects preloads on **every navigation** and into iframes by
default. An app holding `tcp.connect *:*` could navigate itself to a hostile origin, which
would then run with the Orivon preload while the grant ledger still resolved to the app. This
also defeated `ADR-0005`'s publisher-key amendment outright: a compromised host does not need
the signing key, it serves a redirect. Origin is now per-frame, captured synchronously (an
async handler can resolve after the frame is detached or navigated).

**T4 said "normal tabs get no preload and therefore no API."** That mitigation does not exist —
`window.nostr` is injected into ordinary tabs by design (`capability-api.md`). The real
invariant is two distinct preload files, and it had never been written down. A single wrong
`webPreferences.preload` path, or one shared preload branching on renderer-influenced state,
would turn every website into a fully capable Orivon app.

## Capabilities excluded from v0, on security grounds
`subprocess` and `hid` are absent from the v0 API entirely — for signed apps too, not merely
unsigned ones (`capability-api.md`). No MVP app needs them, and they are the largest available
attack surface. Adding either requires an ADR.

## Cross-platform note
`safeStorage` is Keychain on macOS and DPAPI on Windows, but on Linux requires an available
keyring; `isEncryptionAvailable()` returns false without one. Required behaviour: **do not
silently fall back to plaintext.** Either refuse to persist the seed and operate with an
ephemeral identity for the session, or tell the user plainly that the keyring is unavailable.
Silent plaintext storage of an identity seed would be the worst outcome and the easiest
mistake.

## Not defended against, stated plainly
- A hostile app that a user deliberately installs in developer mode and grants capabilities to.
  That is the point of developer mode, and containment arrives with `orivon-runtime`.
- A compromised build machine or a malicious release. There is no reproducible build and, on
  Linux, no signing in month 1.
- Traffic analysis. No Tor integration in the MVP.
