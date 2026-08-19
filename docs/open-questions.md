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

---

## A. Awaiting owner decision

None of these block starting the week-0 spike.

| | Decision | Needed by |
|---|---|---|
| **A6** | **Go / no-go on `planning/readiness.md`** | before any code |
| A7 | Canonical **DDOC** expansion — recommendation: *Domain Data Ownership **Confirmation*** (`glossary.md`, B2) | before correcting public docs |
| A8 | **`+Privacy`** attaches to L4 (published) or L5 (private)? (`glossary.md`) | before correcting public docs |
| A9 | Three capability-API items: is `net.listen` grantable to unsigned apps · are grants keyed on origin or origin + manifest version · is `fs.quotaBytes` enforced or advisory | during build step 2; AI will propose defaults if not decided |

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

### B4. Zero-setup auto-connecting accounts — partially resolved
`La Piramide dei Pilastri` and `OrivonBook` both state that accounts are pre-installed with
no setup and auto-connect to sites. **Design resolution adopted:** `orivon.id` issues
**per-origin derived keys** — no cross-origin linkage, no funds, no raw key export
(`capability-api.md`). A funds-bearing wallet is a separate, setup-requiring thing named
differently in the UI. Nostr via NIP-07 is the first consumer and validates the model.
**Still open:** the exact UI language distinguishing the two, so users never confuse a
throwaway identity with a wallet.

---

## C. Technical unknowns

### C0. Renderer-side webtorrent throughput **[RESEARCH — week 1 spike, highest priority]**
Can `webtorrent` run in a renderer over shimmed `net`/`dgram` at acceptable throughput, with
`MessageChannelMain` ports for socket data? ADR-0005 depends on the answer. If it fails, the
fallback is privileged main-process webtorrent for the MVP, recorded as debt. **Failing in
week 1 is cheap; failing in week 4 is not.**

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
lower level ⇒ higher price and lower priority. The intent is a deliberate penalty on
centralised entrants and a subsidy to decentralised ones — a tax on centralisation, not a
sale of trust.

**Known structural tension, accepted:** revenue then scales with low scores, so an
Orivon-operated score provider would profit when scores are low. Raised twice, reaffirmed
twice; it is a business-model call and it is post-MVP and reversible.

**Mitigation available if it is ever wanted** (not a condition, just recorded): price ads
using a *third-party* provider's attestations rather than Orivon's own, which removes the
self-dealing while keeping the pricing model exactly as intended. `ADR-0006` makes this cheap,
since attestations are portable signed statements over bundle hashes.

**Unaffected and independently sound:** charging for *faster evaluation*. `ADR-0006` shows
attestation lag is real friction, so reducing it is a legitimate paid service.

---

## D. Parked (post-MVP)
Dashboard widget grid · App store · Web3 search · Wallet Crypto/Address-book layers and
`CapabilityDescriptor` · Mobile · DAO / tokenomics · Proxy chains and VPN mode · Client
Profile separation · DDOC · Trustless resolution · `subprocess` and `hid` capabilities ·
Identity export/backup · Cross-device sync.
