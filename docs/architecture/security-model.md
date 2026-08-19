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
| T3 | Compromised renderer forges IPC to impersonate another app | The broker derives origin from the `WebContents` it received the message on. **Renderer-supplied identity is never trusted** |
| T4 | Ordinary website reaches `orivon.*` | `orivon.*` is exposed only in preload for loaded Orivon apps. Normal tabs get no preload and therefore no API |
| T5 | Renderer escape into Node | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no remote module. Non-negotiable |
| T6 | Compromised host silently swaps app code that already holds grants | Bundle hash pinned at install; any change re-prompts before running (`ADR-0005`, `ADR-0006` D2) |
| T7 | App escapes its manifest by rewriting its own code | Code cache is **read-only to the app**; only the broker writes it (`ADR-0003`) |
| T8 | Identity key exfiltration | Seed in `safeStorage`, never exposed; apps receive per-origin **derived** keys only; raw export is not a capability at any tier |
| T9 | Cross-app identity correlation | Keys derived per origin, so two apps cannot link the same user |
| T10 | Hostile peer serves corrupt torrent data | Piece verification against the infohash — inherent to BitTorrent, not something Orivon adds |
| T11 | Resource exhaustion (disk, sockets, bandwidth) | `fs.quotaBytes` enforcement, socket count limits, disk-usage UI (`ADR-0003`) |
| T12 | App reaches localhost or the LAN to attack other services | **Manifest patterns must be checked against resolved addresses, not hostnames** — otherwise DNS rebinding defeats them. Private ranges denied unless explicitly declared |
| T13 | Telemetry endpoint used to correlate users | Random install ID, IP discarded at ingest, no third party, minimal payload (`ADR-0004`) |
| T14 | Electron CVEs | Track upstream releases. A browser is a high-value target; upgrading is maintenance, not optional |

T12 is the one most likely to be got wrong: a naive `net` implementation that matches on the
hostname string lets an app declare `example.com` and then have DNS resolve it to `127.0.0.1`.

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
