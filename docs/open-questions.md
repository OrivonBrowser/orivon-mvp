# Open questions, contradictions and unknowns

Living document. Entries are resolved into decision records (and then removed, with a link
left behind) or explicitly parked.

Legend: **[OWNER]** product/philosophy/irreversible — never decided by an AI ·
**[AI-REC]** technical, AI proposes · **[RESEARCH]** needs investigation first.

---

## RESOLVED — see the linked record

| Was | Resolution |
|---|---|
| A1 What is the MVP for? | **Owner:** the funding plan in `roadmap.mdx` is **outdated**. MVP target is **100 active users in EU/USA, active = 25 h/month**, to attract A+ contributors, validate the product with real data, and support funding. The MVP must have real-world use |
| A2 Which capability is the thesis? | **Owner:** **A** (run any Web3 program from a URL) is primary; **B** (Web3 Scores) also important; **C** (wallet) simplified and deferred, keep architecture ready; **D** (pluggable domains) a long-term note |
| A3 Is "bitcoind in WASM" in scope? | **Owner:** it is a *future* goal for the execution layer, not an MVP claim → `ADR-0001` (flagship is BitTorrent streaming) |
| A5 Who writes the code? | **Owner:** solo; no Rust, C++ basics; Claude Max; Electron MVP, Chromium fork long-term → `ADR-0002` (TypeScript only, WASM deferred) |
| B1 Four incompatible architectures | → `ADR-0002`. Capability API is the durable asset; broker in Electron main; `orivon-runtime` deferred, not cancelled. Answers the unanswered heading in `technical/orivon-core` |
| B5 Same bytecode, two capability environments | → `ADR-0002`. Two named environments: *frontend* (renderer, ordinary web powers) and *app backend* (broker-side, capability-gated) |
| B6 "Web4 era starter" vs roadmap ordering | Dissolved: the funding plan is outdated. The product creates the movement |
| Telemetry | → `ADR-0004`. **Opt-out** with prominent first-run disclosure, self-hosted, inspectable, minimal payload. (Owner reversed an earlier opt-in decision for measurement efficiency; reversal recorded in the ADR) |
| Local vs remote app data | → `ADR-0003`. Local-first, per-origin isolation, no Orivon server for app data |
| Bundling apps vs URL delivery | → `ADR-0005`. Apps are URL-addressed and cached; flagship pre-cached, not bundled |
| A4b Site-level Trustlessity blocked on resolution | **Owner caught this.** DDOC anchors in DNS, forgeable on ICANN domains without DNSSEC → site L2 and DDOC leave the MVP; trustless resolution (D) is a **prerequisite** for them, which reorders the public roadmap. Everything else in the spectrum turned out to be automatic → `ADR-0006` |
| A4a Advertising priced by trustlessity level | **Owner decision, accepted.** Ad priority and price are keyed to trustlessity level as in `economical-strategy.md`: lower level ⇒ higher price and lower priority, as a deliberate penalty on centralised entrants. See "Accepted tradeoffs" below |
| Trust indicator scope | → `ADR-0006`. Full spectrum from observed behaviour + delivery provenance; ships the attestation hook, not a judge |
| Flagship first-run grants | **Owner (validation pass):** the real grant prompt appears in the clip — the flagship holds zero silent privileges, and the prompt showcases the permission system on camera |
| App-update re-consent friction | **Owner (validation pass):** publisher-key TOFU → `ADR-0005`. **Superseded the same day by the audit** — signing was unspecified and unscheduled, and the amendment's central claim was false (a keyless compromised host serves a 302). Now: hash-pinning + pattern-subset check + version floor |
| Telemetry EU posture | **Owner (validation pass):** first-run explicit choice, [Keep on]/[Turn off], no preselected default → `ADR-0004` amended. ~85–90% retention, defensible as consent under GDPR |
| Video format in v0 | **Owner (audit):** MP4/H.264 only; state it in-product, shoot the clip on an MP4 torrent. MSE cannot demux Matroska and neither can Chromium's `<video>`, so MKV has no path without a remuxer — post-launch (`libav-wasm`) |
| Trust indicator, given two independent breaks | **Owner (audit):** **fix it properly (~2 days)** rather than reduce or cut → `ADR-0006` amendment. Partition CSP so the manifest genuinely bounds network reach, persisted per-origin summaries, byte-asymmetry signal, evidence-first UI |
| Signed/unsigned trust tier | **Owner (audit):** **cut from v0.** Capability-identical in v0, mechanism specified nowhere, and it would have put a red UNSIGNED badge on the flagship in the clip → `ADR-0002` §4 amendment, `ADR-0005` evening amendment |
| What the metric counts | **Owner (audit):** split `activeSec` from `backgroundSec`, state the metric on `activeSec` → `ADR-0004`. A seeding tab previously satisfied 25 h/month on its own, making the daily-use hypothesis unfalsifiable in its own favour |
| Install-count arithmetic | **Corrected, owner-side.** The "115–130 installs" figure applied only the telemetry consent rate — no retention, no activation. Honest requirement is in the **thousands of downloads**. Funnel sizing and channel selection are explicitly **outside the technical work session** |
| C0 Renderer-side webtorrent (the week-0 spike) | **Resolved 2026-08-25 — architecture PASS.** Gates 0/1a/1b/2 pass with hard evidence; gate 4 (throughput) beats the actual product requirement 10x despite failing its literal relative-to-native-control threshold; gate 3 (video playback) is blocked on an unresolved Playwright/`_electron` tooling issue, not a product failure. Full verdict: `planning/spike-verdict.md`. `utilityProcess` fallback was not needed |
| A6 Go / no-go on `readiness.md` | **Owner: GO**, 2026-08-25, conditional on reviewing the spike's execution plan first → `planning/week-0-spike-plan.md` |
| A11 How a cached bundle is served at its origin | **Owner (2026-08-25):** keep the app's real origin, intercepting inside the app's `session` partition only → `ADR-0007`. Chosen over a custom scheme because changing the origin would fork storage, grants and the derived identity key between the cached and live states, with no export path to recover the lost key |
| A10 Handle contracts | **Resolved 2026-08-26.** Full specification written: `architecture/handle-contracts.md` (the five handle types, the closed error enum, close/half-close semantics, a credit-window backpressure design, the revocation cascade). Direction decision (WHATWG streams, owner, 2026-08-25) recorded as `ADR-0008`, which also rescopes `capability-api.md` design rule 1 to the shim rather than the capability layer. One further owner decision taken while writing it: error detail is real for any address an app was permitted to attempt; `denied` stays uniform across every reason for denial |

---

## A. Awaiting owner decision

None of these block starting the week-0 spike.

| | Decision | Needed by |
|---|---|---|
| A7 | Canonical **DDOC** expansion — recommendation: *Domain Data Ownership **Confirmation*** (`glossary.md`, B2) | before correcting public docs |
| A8 | **`+Privacy`** attaches to L4 (published) or L5 (private)? (`glossary.md`) | before correcting public docs |
| A9 | Three capability-API items. **Defaults now proposed** in `architecture/capability-api.md` — `net.listen` grantable to unsigned apps with a declared port range and no privileged ports · grants keyed on `(origin, capability)`, with bundle-hash changes handled by the separate pin-break prompt · `fs.quotaBytes` enforced via a running per-origin counter | **Build proceeds on these unless overruled.** Cheap to change before any third-party app exists |
| A12 | **`orivon.fs` option bags are unspecified.** `capability-api.md` names the entry points (`readFile(path, opts)`, `writeFile(path, data, opts)`, `mkdir / readdir / stat / rm / rename`) but never says what `opts` contains or what `readFile` returns | **Build step 2.** Provisional signatures are in `src/contracts/capability-api.ts` and marked as such |
| A14 | **RESOLVED 2026-08-26 (owner):** a trailing DNS dot is stripped, so `https://x.example.` and `https://x.example` are ONE origin. Deliberately deviates from `URL.origin`. Exactly one dot; a host still carrying an empty label is rejected | Implemented in `src/broker/policy/origin.ts` |
| A13 | **Are `app.manifest()` and `app.grants()` async?** `capability-api.md` §v0 surface writes them as `=> Manifest` and `=> Grant[]`, but design rule 2 in the same document says *"All entry points return Promises"* | **Build step 2.** Transcribed as Promises; see below |
| A15 | **`src/broker/policy/paths.ts` assumes app root directory names are single-case hex.** True today (`sha256(canonical_origin)`, T13b) but the owner is reworking `broker-01-origin` to also check data hashes | **Before merging the reworked origin derivation.** See below |
| A16 | **A derived origin does not carry whether it may be PERSISTED.** T13c forbids ever writing a grant for a loopback or plain-`http` origin to disk, but `originFromUrl` returns a plain string — `http://127.0.0.1:8080` is shape-identical to `https://x.example`, so every caller must remember to re-parse and check | **Build step 2**, when the code that persists grants exists. Owner decided 2026-08-27 to keep the return type a plain string for now rather than change a durable interface before its consumer exists. See below |

---

### A12 — what `orivon.fs` actually takes and returns **[AI-REC]**

Found while transcribing `capability-api.md` into `src/contracts/` (2026-08-26). The
document specifies the *fs* entry points by name only. Everything else in the v0 surface has a
full signature; these do not.

**Provisional reading, implemented and marked provisional in the file:** the contract layer is
byte-oriented — `readFile(path) => Promise<Uint8Array>`, `writeFile(path, data: Uint8Array)` —
with no encoding option, because `ADR-0008` puts bytes and streams underneath and Node's shapes
in `orivon-node-shim` one layer up. Encoding handling therefore belongs to the shim, alongside
the file cursor it already owns (`handle-contracts.md` §FileHandle).

**Why it is flagged rather than decided:** this is the `fs` half of the durable interface, and
`ADR-0002` makes that the artefact the whole project is built to outlive. A guess promoted
silently would be exactly the failure `CLAUDE.md` Rule 1 exists to prevent.

### A13 — synchronous or async app introspection **[AI-REC]**

A direct contradiction inside `capability-api.md`, found the same way. §Design rules 2 states
that all entry points return Promises because sockets cannot be constructed synchronously
across an IPC boundary. §v0 surface then writes `orivon.app.manifest() // => Manifest` and
`orivon.app.grants() // => Grant[]` without one.

**Both readings are defensible.** Design rule 2 is stated as binding. But
`handle-contracts.md`'s own rule — *anything Node exposes synchronously is resolved before the
acquisition promise settles and handed over already populated* — argues the other way: the
manifest and the grant set are both known before the app's first line runs, so they could be
plain values with no round trip.

**Transcribed as Promises**, because design rule 2 is the more explicit statement and widening
a Promise to a plain value later is a smaller break than the reverse. Cheap to change before any
third-party app exists.

---

### A15 — path confinement's case-sensitivity assumes single-case-hex root names **[AI-REC]**

Found while checking whether `stream/broker-04-path-confine` (merged as `ae9a13d`) is safe to
accept while `stream/broker-01-origin` is being reworked to also check data hashes, not just the
URL. The two branches are structurally independent — disjoint files, `broker-04` is not stacked
on `broker-01`, and `confinePath(root, requested, realpath)` takes `root` as a parameter, never
derives it — so nothing in the merged commit is invalidated by the origin rework.

One assumption in `paths.ts` is worth carrying forward, though. Its comparison between a
canonicalised path and the root is deliberately **case-sensitive**, justified by a comment citing
T13b: *"Cross-platform roots are sha256(origin) hex, single-case, so nothing legitimate
collides."* That is true only as long as the root directory name stays lowercase hex. `sha256(...)`
of anything is still lowercase hex, so folding a data hash into the string being hashed is fine —
but if the reworked origin ever names a root some other way (e.g. a raw base58 CIDv0 or base64
encoding, both mixed-case), the case-sensitive comparison in `confinePath` could reject legitimate
paths as a spurious `symlink-escape` on case-insensitive filesystems (macOS, Windows).

**Not a security hole either way** — the failure direction is fail-closed (an app breaks, the
sandbox does not leak) — but worth a decision now rather than a confusing bug report later.

**Needed by:** whoever finishes the `broker-01-origin` rework, before the root-naming scheme
changes. Keep root names single-case (hex, or lowercase the encoding) — or `paths.ts`'s
case-sensitivity comment and its case-sensitivity tests need to be revisited together.

---

### A16 — a derived origin does not say whether it may be persisted **[AI-REC]**

Found while reviewing `stream/broker-01-origin` (2026-08-27). T13c forbids ever writing a
grant for a loopback, `file:` or plain-`http` origin to disk — session-scoped only, re-prompt
each launch. But `originFromUrl` returns a plain string, and `http://127.0.0.1:8080` has the
same type and shape as `https://x.example`. The rule is therefore enforceable only by every
caller remembering to re-parse the string and check, which is the shape of rule that gets
followed four times and forgotten on the fifth.

**Owner decision, 2026-08-27: keep the plain string for now.** The alternatives — returning
`{ origin, persistable }`, or adding an `isPersistableOrigin()` helper — both change or extend
a **durable** interface before the code that persists grants exists, and `ADR-0002` makes that
interface the artefact the project is built to outlive. Deciding its shape against a real
consumer at build step 2 is better than guessing now. `originFromUrl`'s doc comment states the
gap explicitly so a caller meets it at the point of use.

**Needed by:** build step 2, specifically whoever writes the grant ledger's persist path.

### A14 addendum — an argument against the trailing-dot merge, recorded after the decision

A14 (resolved by the owner 2026-08-26) strips the trailing DNS root label, so `https://x.example.`
and `https://x.example` are one origin. **The decision stands, re-confirmed by the owner on
2026-08-27.** This records an argument that surfaced during review afterwards, so that a future
reader does not mistake it for something nobody considered.

The reasoning behind A14 was that both spellings are the same DNS name, served by the same
operator under the same certificate. The first half is always true; **the second is not
guaranteed.** Browsers send `Host: x.example.` verbatim, and virtual-host matching is an exact
string comparison — nginx's `server_name x.example;` does not match it. On a host configured
that way the request falls through to the **default vhost**, which may serve different content
under a different operator's control. Merged origins mean that content inherits the app's
grants, storage domain and identity key.

**Why the decision was kept anyway:** exploiting it also requires a certificate valid for the
trailing-dot name, browsers generally strip the dot before certificate matching, and the
alternative costs a real user-visible failure — one mistyped character silently produces a
second, empty copy of the app that has to be re-granted everything. `ADR-0003` makes this
unfixable after the first grant is persisted, so it is recorded here rather than left implicit.

---

## B. Contradictions still to fix

### B2. What does DDOC stand for?
Three expansions across three documents, one of them public: *Domain Data Ownership
**Confirmation*** (`orivon.mdx`), *Domain Data Ownership **Certification***
(`Posts/Technical Specifications`), ***Data Domain** Ownership Certification* (`Glossario`).
Trivial to fix; needs one canonical form in `glossary.md`.

### B3. Two different trustlessity ladders — RESOLVED, public docs need updating
Public `web3-score.md` gives websites **4** levels; private `Web3 Verification levels` gives
**5**, including *"full-stack runs entirely locally"* as L3 — a level that vanished publicly
even though local-executability is central to the "installable Web3sites" argument.

→ `ADR-0006` resolves this **in favour of the private version**: "runs entirely locally" is
reinstated, and it is automatically decidable. **Action outstanding: correct the public docs**
to reinstate that level and to mark which levels are automatic versus judged. The `+Privacy`
placement (L4 publicly, L5 privately) still needs one canonical answer.

### B4. Zero-setup auto-connecting accounts — resolved, with a validation correction
`La Piramide dei Pilastri` and `OrivonBook` both state that accounts are pre-installed with
no setup and auto-connect to sites.

**Correction found in the validation pass:** the first resolution ("per-origin keys only, no
cross-origin linkage, NIP-07 as first consumer") was **internally contradictory** — a Nostr
identity must be the *same* across every client site, or follows and posts fragment per
client. Nobody caught this until the validation read.

**Corrected model** (`capability-api.md`): silent **per-origin app keys** for apps, plus
**named identities** that are cross-origin *by explicit consent* — a per-site connect prompt,
revocable. NIP-07 rides the named-identity path, not the per-origin path. A funds-bearing
wallet remains a separate, setup-requiring thing named differently in the UI.
**Still open:** the exact UI language distinguishing throwaway keys / named identities /
wallets.

---

## C. Technical unknowns

### C1. DDOC's trust root is DNS — worth anything on ICANN domains? **[RESEARCH]**
Deferred with A4b. Also unexamined: `Glossario`'s claim that DDOC justifies **self-signed
HTTPS** on compliant sites. That needs hard scrutiny before it is repeated publicly.

### C2. DDOC's unlisted-file rule looks unsound **[RESEARCH]**
`Archivio/Struttura Stack` argues a file absent from the hash-tree is nevertheless valid
because the load chain started from an owned root. Implemented literally, any page induced to
fetch an unlisted resource escapes DDOC entirely — defeating the stated goal of detecting
server compromise. Needs a strict-mode rule.

### C3. Capability API open items **[AI-REC]**
Listed at the end of `architecture/capability-api.md`: whether `net.listen` is grantable to
unsigned apps; whether grants are keyed per origin or per origin + manifest version; whether
`fs.quotaBytes` is enforced or advisory.

### C4. NIP-07 injection conformance **[RESEARCH — cheap]**
The ~1 day Nostr estimate assumes existing clients accept an injected `window.nostr` cleanly.
Verify against two or three real clients before treating the estimate as settled. Licences
also need checking per client — several are AGPL.

### C5. Reuse-vs-build not yet analysed **[RESEARCH]**
Outstanding for: ENS resolution, IPFS (embedded vs. Kubo subprocess vs. gateway), the DDOC
generator. Settled for: WASM host (deferred), Electron shell (build, do not fork), torrent
engine (`webtorrent` library), Nostr (inject NIP-07, reuse third-party clients).

### C6. Playwright `_electron` fails to attach to one window — cause unknown **[RESEARCH]**
Found during the week-0 spike (gate 3, video playback). A direct, non-Playwright launch of the
app loads and plays normally — confirmed via `dom-ready`/`did-finish-load` firing and matching
renderer console output to every other gate. Launched through Playwright's `_electron.launch()`
then `app.firstWindow()`, the call times out after 30s. Playwright's own CDP session to the
main process is healthy (`DEBUG=pw:electron,pw:browser` shows the browser-level DevTools
connection succeeding), but no target-created event for the window is ever logged — so this
looks like an Electron/Chromium CDP auto-attach issue, not a Playwright installation problem.
Six causes ruled out (full trail: `planning/spike-results/gate-3.json`); the `<video>` element
and a raw-CDP-client test remain untried. **Matters because `build-plan.md`'s single
highest-value automated test (the capability-rejection e2e) uses the identical `_electron`
driver** — not confirmed affected (gates 0/1a/1b/4 all attach fine on the same driver), but
worth a five-minute check the first time that test is written, before build step 2 is called
done on the strength of it.

**Narrowed 2026-08-26, build step 1.** A minimal `BaseWindow` with two `WebContentsView`s
(one chrome-style view, one content view — the exact composition the shell now uses)
attaches cleanly under `_electron`: `app.windows()` reports both with correct URLs, and
`app.firstWindow()` resolves immediately with no timeout, in view-add order. **So the failure
is not `BaseWindow`/multiple-`WebContentsView`s in general** — it is specific to something in
gate 3's actual composition (video element, service worker, or the
`protocol.registerSchemesAsPrivileged()` call, none of which this probe exercised). Practical
consequence for the shell: `app.firstWindow()` is not reliable long-term (it depends on
view-add order, which is an implementation detail, not a contract) — the shell's own smoke
test matches windows by URL/title via `app.windows()` instead of relying on first-added
ordering.

---

## BB. Public-docs corrections — and what is *not* one

**The MVP being narrower than the vision is not a contradiction.** It is expected, and nothing
in `mvp-scope.md`'s non-goals implies the final product is limited the same way. Those
non-goals are MVP-scoped only.

Only genuine errors belong here — statements wrong **independently of the MVP**:

| # | Correction | MVP-only? |
|---|---|---|
| 1 | `orivon.mdx`: *"bitcoind … would be **already** runnable as a site on Orivon"* states a future goal in the present tense. **Fix the tense, keep the ambition.** | **Yes, scoping** — but the tense makes it read as a current property, and it is the first claim a technical evaluator will test |
| 2 | `web3-score.md` is missing the site level *"full stack runs entirely locally"*, which is real and automatically detectable (`ADR-0006`) | **No** — it would be missing from the final product too |
| 3 | `roadmap.mdx` does not reflect that trustless resolution is a **prerequisite** for DDOC and site-level scores. DDOC anchors in a DNS record, forgeable on ICANN domains without DNSSEC | **No** — a permanent dependency in the final architecture |
| 4 | DDOC expansion differs across three documents (`glossary.md`, B2) | **No** |

Owner-side work. Not blocking the MVP, but worth doing before it draws attention.

---

## CC. Accepted tradeoffs

Decided, not open. Recorded so the reasoning is visible later rather than rediscovered.

### Advertising priced by trustlessity level
**Owner's decision.** Ad priority and price key to trustlessity level (`economical-strategy.md`):
lower level ⇒ higher price and lower priority. A deliberate penalty on centralised entrants and
a subsidy to decentralised ones — a tax on centralisation, not a sale of trust.

**Owner's reasoning, in full:**
1. Orivon is ultimately a for-profit company. It is incentivised to grow the ecosystem toward
   trustless solutions through sponsorship, but also to accept non-trustless sponsors when the
   money is materially better — because that money funds further innovation for Web3. A
   rational trade for the ecosystem's benefit, even if it sounds bad.
2. A score provider is incentivised to score accurately, because being trusted is the entire
   point of it. Trustlessness and security are what give the provider its value.

**AI counter-position, recorded once and then dropped.** Point 2 is correct in isolation, but
it does not address point 1 — the two are separate claims, and the difficulty is their
intersection: Orivon scoring the entities that pay Orivon.

The empirical record on reputation as discipline is specific: it holds when the scorer is *not*
paid by the scored, and fails when it is, independent of intent.
- Moody's and S&P rated CDOs AAA while paid by issuers; the "our reputation protects you"
  argument was made explicitly and publicly, and failed. Both remain profitable.
- Arthur Andersen and Enron: same structure, same outcome.
- EasyList, not paid by advertisers, has held its reputation for two decades. Eyeo's
  Acceptable Ads, which took payment for whitelisting, is distrusted in exactly the community
  Orivon targets.

The mechanism is not bad actors: reputation damage is slow and diffuse, revenue is immediate
and concentrated, and that asymmetry compounds.

On point 1 specifically, the objection is **timing, not principle**. Brave is the direct
precedent — ads, BAT, profitable — and was badly damaged by the 2020 affiliate-link injection
over small money, with precisely this audience. It survived because it already had millions of
users. At 100 users reputation *is* the whole asset, with no product moat to absorb a hit. The
strategy becomes survivable once there is something to lose that is not reputation.

**Mitigation available at zero revenue cost** (recorded, not a condition): price ads from a
*third-party* provider's attestations rather than Orivon's own. This removes the self-dealing
while keeping the pricing model exactly as intended. `ADR-0006` makes it nearly free, since
attestations are portable signed statements over bundle hashes.

**Unaffected and independently sound:** charging for *faster evaluation*. `ADR-0006` shows
attestation lag is real friction, so reducing it is a legitimate paid service.

**Status: owner-decided, post-MVP, reversible. Not to be re-raised.**

---

## D. Parked (post-MVP)
Dashboard widget grid · App store · Web3 search · Wallet Crypto/Address-book layers and
`CapabilityDescriptor` · Mobile · DAO / tokenomics · Proxy chains and VPN mode · Client
Profile separation · DDOC · Trustless resolution · `subprocess` and `hid` capabilities ·
Identity export/backup · Cross-device sync.
