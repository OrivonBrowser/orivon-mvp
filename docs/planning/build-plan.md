# Build plan

Dependency-ordered. One solo developer with AI assistance, one month.
Scope is fixed by `mvp-scope.md`; decisions by `docs/decisions/`.

**webtorrent is 3.0.21.** `week-0-spike-plan.md` §Verified facts lists the other package facts
checked against live metadata.

## Week 0: the gate

**Nothing else starts until this resolves.**

> **Spike (timeboxed to 2 days): can `webtorrent` run in a renderer over shimmed
> `net`/`dgram`, fetching *ordinary* torrents, with no native modules and a working
> video path?**

**Throughput is not the gate.** Measured `MessagePort` transfer is ~310 MB/s and per-message p50
~0.5 ms (`audit-2026-08-25.md`), against the 1-5 MB/s that 1080p streaming needs, so a
throughput criterion would return PASS while the three genuine blockers below went untested.

Run the checks **in this order** and stop at the first that fails:

**1. Does it fetch an ordinary torrent at all?** *(the real risk)*
webtorrent's `browser` field maps `net`, `bittorrent-dht`, `ut_pex`, `utp` and `conn-pool` to
`false`, so a naive renderer bundle is **WebRTC-only, at Brave parity**, which is precisely what
`ADR-0001` reason 3 exists to beat. Required: per-module resolution overrides (Node resolution
aliased to the shim for the socket modules, browser resolution for `webrtc-polyfill`).
**Pass = completes a piece from a non-WebRTC TCP peer, and completes a DHT lookup over shimmed
`dgram`.**

**2. Is the shell dependency tree free of native modules?**
`node-datachannel` is a **hard, non-optional** transitive dependency (CMake + libdatachannel);
`utp-native` is optional and is not the blocker. It breaks Windows/macOS run-from-source.
**Pass = zero `binding.gyp` / `prebuilds/` anywhere under the shell's `node_modules`**, which
the intended design achieves by shipping webtorrent as a pre-built *app asset* rather than a
shell dependency. Add the check as a `postinstall` script while here.

**3. Does video actually play?** *(~2 hours)*
Play one MP4/H.264 magnet end to end and confirm the format story holds. MKV is **out of v0 by
decision**: MSE cannot demux Matroska and neither can Chromium's `<video>`, so there is
no fallback path, only a remuxer (post-launch). **Pass = MP4/H.264 plays with seeking.**

**4. Throughput.** *(last, and expect a pass)*
Use a **local seeder** so swarm health is not an input, and measure against a **control**: the
same webtorrent running natively. **Pass = shimmed ≥60% of control, ≥25 Mbps absolute, ≥100
concurrent peer sockets, main-process CPU headroom intact and no UI frame drops, RSS stable
over 10 minutes.** Record *which* sub-criterion fails: CPU-bound, latency-bound and
architecturally-impossible have different fallbacks. Structure as day 1 naive → day 2 with
64-256 KB batching.

> **Transferables are not available on this path** (gate 0), so batching is the only day-2
> lever. That does not endanger the gate, because copying already exceeds the requirement by two
> orders of magnitude.

**0. Does `MessagePortMain` carry bytes renderer → main at all?** *(~2 h)*
Runs before any webtorrent work, because every later gate and the whole of
`capability-api.md` §Throughput sits on this path.
**RESOLVED, PASS**, measured on Electron 44.0.0 / Chromium 152, through the `contextBridge`
closures rather than a raw port. Byte-exact in both directions at 64 KB / 256 KB / 1 MB;
**1134.8 MB/s renderer → main** and **313.4 MB/s main → renderer**, against the 1-5 MB/s that
1080p needs.
**Finding:** [electron#34905](https://github.com/electron/electron/issues/34905) reproduces and
is worse than reported: a transferable `ArrayBuffer` sent renderer → main **does not throw and
never arrives**. Silent total loss at every size. Consequences are recorded in
`capability-api.md` §Throughput; the practical rules are *never transfer on this path* and
*every reply-carrying protocol over `MessagePortMain` needs a timeout, because this transport
fails by silence.*

- **Pass** → a torrent client runs as a genuine URL-delivered app (`ADR-0005`).
- **Fail** → run `webtorrent` in an Electron **`utilityProcess`**, *not* the main process. It
  has full Node, no ambient main-process authority, and the cheapest measured IPC path, so the
  recorded debt is far smaller than the original "privileged in main" fallback. The app
  still ships; only its status as "an ordinary app" is reduced.

Failing here costs 2 days. Discovering it in week 4 costs the month.

**Also in week 0:** repo scaffold, `electron-vite` + TypeScript, Node 24 (already installed).
No Rust toolchain is required (`ADR-0002`). Decide the test stack now: **Vitest**
(`environment: 'node'`, inherits the vite transform), **Playwright `_electron`** for the single
e2e, and one GitHub Actions job on push. With no code reviewer, CI *is* the reviewer.

**Structural decision, day 1, zero cost:** `src/broker/policy/*.ts` holds pure functions with
**no Electron imports and no I/O**; the broker is constructed as
`createBroker({ dial, resolve, now, fs, keychain })`. Every capability test then runs against
stubs. Deciding this later costs a day of refactor exactly when the schedule is tightest.

## Platform policy

**Linux is the packaged target** (AppImage + deb), with no code-signing cost, and the audience
skews Linux.

**Windows and macOS are supported from day one via run-from-source**: `git clone`,
`npm install`, `npm start`. This sidesteps both Windows SmartScreen and macOS Gatekeeper
without buying certificates, and widens the reachable audience. Those users count toward the
metric and their telemetry must work identically.

Two constraints follow, and they are not optional:

1. **No native modules in the shell's dependencies.** Nothing may compile at install time;
   JavaScript and WebAssembly both pass (`ADR-0031`). If `npm install`
   needs node-gyp and Visual Studio Build Tools, run-from-source is a worse wall than the
   certificate it was meant to avoid.
   The real blocker is **`node-datachannel`** (`utp-native` is optional), a *hard* transitive
   dependency of webtorrent via
   `@thaunknown/simple-peer → webrtc-polyfill`, requiring **CMake and a C++ toolchain** when a
   prebuild is missing. Also present: `bufferutil`, `utf-8-validate`, `fs-native-extensions`
   (optional, but npm installs optionals by default).
   **Therefore: webtorrent, and any app dependency like it, ships as a pre-built app asset,
   not a shell dependency**, so the shell's `npm install` never resolves it. Enforce with a `postinstall` check that fails
   the build on any `binding.gyp` or `prebuilds/` under `node_modules`.
2. **No platform-specific paths.** All storage goes through `app.getPath('userData')`, never a
   hardcoded XDG path, so data persists correctly on all three platforms (`ADR-0003`).

Known caveat: `safeStorage` differs per platform: Keychain on macOS, DPAPI on Windows, and on
Linux it needs an available keyring, with `isEncryptionAvailable()` returning false otherwise.
A documented fallback is required; see `security-model.md`.

Side benefit worth noting: anyone willing to clone and `npm start` self-selects as a potential
contributor, which is precisely the population the MVP is meant to attract.

## Critical path

```
spike → shell → broker → shim → app loader → Node.js apps → ENS and IPFS
```

Everything not on this line is deferrable. Real apps running from a URL are what show the
thesis, so they come as early as possible rather than last.

## Sequence

**1. Shell.** `WebContentsView` tabs, omnibox, back/forward, window chrome.
No dependencies. Use the prior prototype's GUI as *visual reference only* (`ADR-0002`).

**2. Capability broker.** Manifest parsing, the grant model (the grant ledger and a headless
grant-decision interface, so the allow path is exercised end to end before any human sees it),
per-origin enforcement, per-app `session` partitions. Depends on the shell for preload/IPC.
**Settle the origin definition here**: it keys storage, partitions, grants and derived keys,
and changing it after the first grant is persisted orphans every app (`ADR-0003`).

> **The user-facing grant prompt is not built here**; it is step 4 below (`A20`/`A27`).
> This step builds the grant model headlessly.
>
> **`net.listen` is built here**, meaning accepted-socket handles, teardown and the revocation
> cascade. It is fully specified, including the unsigned-app port-range rules
> (`capability-api.md` §1), and it is what lets a P2P app serve peers as well as download
> rather than receive only. See `docs/open-questions.md` A97.

**3. `orivon-node-shim`.** `net`, `dgram`, `fs` over `orivon.*`. Depends on the broker.
Load-bearing for every Node.js app, not a developer nicety (`ADR-0005`).

**4. App loader.** Discover the manifest at `/.well-known/orivon.json`
(`capability-api.md`), fetch + cache assets, compute and pin the **bundle hash**
(`ADR-0009`, `bundle-hash.md`), drive `decideUpdate()` (`src/broker/policy/update.ts`) on
every re-fetch, and fetch the site's published hash tree for **DDOC** (`ADR-0029`), kept beside
the pin and compared with it on the Web3 Score page. **Also where the user-facing grant prompt is built**: the dialog a person actually reads, built once a real manifest exists to
render in it and `A20`/`A27` are settled. Depends on broker storage. The pinning here is also
what `ADR-0006` and the future attestation model rest on.

> **The permission prompt is in scope, not a deferred nicety.** It is
> what turns the platform work above into something a person can actually use, which is why
> `.claude/unattended-build-queue.md` gives it its own phase (Phase 4) with five review
> checkpoints rather than one at the end. See `docs/open-questions.md` A103.

Also where T22's CSP gets wired in: `src/broker/policy/connect-src.ts` computes the
`connect-src` header value (build step 2), but nothing calls
`session.webRequest.onHeadersReceived` with it yet. That file's own header has four numbered
facts whoever does this needs to read first, including whether `onHeadersReceived` fires at
all for the `protocol.handle`-served cached bundle (ADR-0007), which is unconfirmed anywhere in
the corpus and needs a live `context7` check before writing the wiring.

> **`onHeadersReceived` does not fire for a `protocol.handle` response in Electron 44** (`A110`),
> confirmed live. The CSP is set on the handler's own `Response` instead, computed fresh per
> request so a grant change narrows or widens the very next request without the app needing to
> be reinstalled. See `src/loader/README.md` and `src/broker/policy/connect-src.ts`.
>
> Every deliverable this step names is built and reachable from a real page: discovery, fetch,
> hash-pinning, cache, the update decision, DDOC, the consent dialog, and the CSP wiring above. The
> consent dialog fires once, before the app's own code runs, for its whole declared capability
> set (`ADR-0012`). See `docs/planning/compatibility-matrix.md` for the cell-by-cell detail.

> **There is no publisher key to pin.** Publisher signing is cut from v0 entirely (`ADR-0005`).
> What v0 ships is hash-pinning, fully specified by `ADR-0009` and `bundle-hash.md`, and the
> site's own published hash tree shown as DDOC evidence (`ADR-0029`).

**5. Node.js apps.** Port ordinary Node.js and Electron desktop apps to run from a URL over
`orivon.*`, as the platform's test cases. A port is a recipe, a manifest and one bridge file: the
app's own source is cloned at a pinned commit, built by its own toolchain, and never forked
(`ADR-0020`). The ports, and the harness that builds and serves them, live in `orivon-ports`;
nothing in this repository depends on that checkout. A gap a port finds is fixed here, for every
app (`mvp-scope.md` §The genericity test), and `compatibility-matrix.md` tracks what works cell by
cell.

`orivon-ports` has recipes for FreeTube, Element, AirGap Vault and ASGARDEX. They run as
developer-mode origins, which are never installed (`ADR-0029`), so the step ends at journey 1: a
named port, served from a public https origin, installs through the app loader and works
(`release-checklist.md` §Scheduled additions).

**6. ENS and IPFS, trust-minimised.** Load `name.eth` as `https://name.eth`, with every byte
checked on this machine against what the Ethereum chain says the name points to. A light client
proves the name's record at the newest block it has verified, the contenthash is decoded locally,
and every IPFS block is hashed against its CID before any of it is used. RPC servers and gateways
supply availability only, never correctness. The page keeps its own `.eth` origin and is
consented and installed like any other app (`ADR-0007`, `ADR-0018`). This is journey 3.

Three things arrive with it. **DDOC's off-host anchor:** a `.eth` name's contenthash commits to
every file, so a host compromised well enough to rewrite both its files and its tree is caught
(`ADR-0029`). **The Website level** leads the Web3 Score page on every site (`ADR-0006`). **The
Delivery level's proven-name rung** is reached (`src/trust/delivery-ladder.ts`). Rule 8 holds
here as everywhere: a library that pulls in a native module is out, however standard it is.

The work queue is [`ens-ipfs-plan.md`](ens-ipfs-plan.md); the mechanism is `ADR-0030` and the
light client `ADR-0031`.

**7. Trust indicator.** Delivery ladder, connection ladder from the broker's per-app
connection log, operation scoring. Click-through shows the actual evidence, not a grade
(`ADR-0006`).

**Judged score levels are part of this step:** site L4's "open source" half, site L5 and
operation depth, read from a Web3 Score provider's attestation over the bundle hash. The
provider need not be trustless in this build, and may run locally. Each judged level names the
provider that issued it, is shown apart from the observed evidence, and falls back to grey `?`
when no attestation matches the current hash. Which provider ships is open
(`open-questions.md` A250).

**8. Telemetry.** Collection, first-run disclosure showing the literal JSON with
[Keep on] / [Turn off] buttons and no preselected default, in-product "what has been sent"
page. The disclosure UI is not optional (`ADR-0004`). **[Keep on] is the primary button**, but neither choice is preselected and no keyboard default
activates one.

**9. Developer mode.** Unpacked loader, plainly-worded opt-in, unsigned marking, developer
docs. This is journey 4.

**10. Packaging.** `electron-builder`, AppImage + deb. Plus a documented, tested
run-from-source path in the README for Windows and macOS.

**Auto-install is cut.** Unsigned `electron-updater` on Linux
verifies only a SHA-512 fetched from the *same host* that serves the binary, making it a
standing remote-code-execution channel keyed to a GitHub token, weaker than what `ADR-0005`
demands of third-party apps, which is the wrong way round. v0 **checks and notifies**, linking
to the release. Signing the update manifest with an offline key is the post-MVP upgrade.

Two packaging facts that shape the choice, verified 2026-08-25:
- **AppImage is the only seamless auto-update target**; deb/rpm updates require a privilege
  prompt. Moot for v0 given the above, but it constrains the post-MVP path.
- **Only deb can register as the default browser.** `xdg-settings set default-web-browser`
  needs an installed `.desktop` file with the right `MimeType=` entries, and a bare AppImage
  does not self-integrate. For a metric measured in daily-driver hours that is not cosmetic:
  **deb is the primary artefact**, AppImage is for people trying it out, and AppImage users
  get a first-run "install desktop entry" flow.
- AppImage caveats to document: needs `libfuse2` on Ubuntu 22.10+; `chrome-sandbox` SUID error
  because AppImages mount read-only; build on the oldest LTS you intend to support.

## Milestones

| | |
|---|---|
| End week 1 | Spike resolved · shell running · broker skeleton enforcing one capability |
| End week 2 | Shim + app loader → **an app runs from a URL** |
| End week 3 | Node.js apps · ENS and IPFS · trust indicator · telemetry |
| End week 4 | Developer mode + docs · packaging · polish · **pre-announce telemetry, then ship** |

## Testing

Deliberately minimal, concentrated where silent failure is plausible and costly.

**Unit tests, security-critical logic only** (revised 2026-08-25 after the QA audit; each is a
pure function against stubs, 30 min to 3 h):

1. **Capability checking at the call site**, not just the matcher: `checkConnect(patterns,
   hostArg, port, resolveFn)` with an injected stub resolver, plus an `isPublicUnicast` table
   covering 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, `fc00::/7`, IPv4-mapped
   `::ffff:127.0.0.1`, and integer/octal literal forms. *A correct glob matcher fed a hostname
   is still fully defeated by rebinding; a test of the matcher alone covers only the harmless
   half of T12.* *(`patterns` is the GRANTED `readonly Pattern[]`, not a `Manifest` (A18); see
   [`testing.md`](../development/testing.md) §1.)*
2. **`fs` path-traversal rejection**: `path.relative(root, resolved)` must be non-empty, not
   start with `..`, and not be absolute; **plus `realpath` the parent** so a planted symlink
   cannot escape. *A string-prefix check passes `/apps/foo-evil` against root `/apps/foo`, and
   `path.resolve` does not follow symlinks.* Table must cover `..`, absolute paths, symlink
   escape, NUL bytes, sibling-prefix, Windows separators / drive letters / `\\?\` UNC /
   reserved names, and macOS case-insensitivity. One `fast-check` property: for random segment
   arrays, the resolved path is always inside root. **This is also a torrent client's happy path:
   a `.torrent` declares its own file paths, and `../../../.ssh/authorized_keys` is a real
   BitTorrent CVE class, so T1 and T10 combine here.**
3. **Origin derivation, split into two**: (i) URL → origin normalisation (default ports,
   trailing dots, case, punycode/IDN, userinfo, `file:`/`data:` rejection); (ii) **`senderFrame`
   → origin**, asserting an origin field **in the IPC payload** is ignored, that `url` and
   `frame.origin` must agree, that an opaque origin is rejected outright, and that unbound
   frames are rejected (`security-model.md` T3 and its 2026-08-27 amendment, T13b).
4. **Key derivation as frozen golden vectors**, not determinism: hardcode seed / origin / curve
   → expected public key hex, for both the `"app"` and `"identity"` labels, and assert the two
   labels differ. *Same-input-same-output is near-tautological for a KDF; the real risk is the
   derivation changing between releases and silently orphaning every user's identity, with no
   export path to recover from (`ADR-0003`).*
5. **The update decision table**: `decideUpdate({pinnedHash, newHash, grantedPatterns,
   newPatterns, version, versionFloor}) → 'silent' | 'reconsent' | 'capability-prompt' |
   'reject'`, ~8 rows. *Its failure mode is "no prompt appeared", which no manual checklist
   catches, and the capability at stake is `tcp.connect *:*`.*
6. **Telemetry session accounting** as a pure fold over an event stream: start/stop,
   suspend/resume, tab switch, **active vs background attribution**, month rollover, and
   abnormal termination (assert a periodic checkpoint so a crash loses minutes, not a session).
   *This is the number the project is judged on, and its likeliest bug biases it downward,
   making a succeeding product look like a failing one.*

**One end-to-end smoke test**, covering four of five critical-path layers in a single launch:
fixture app served over **localhost HTTP with a real `/.well-known/orivon.json`** → loaded via
the app loader → grant accepted → `require('net')` **through the shim** connects to a local
echo server and moves bytes → **then the same app attempts a connection outside its manifest
patterns and is rejected.**

> That last clause is the highest-value assertion in the plan. Without it, **nothing fails if
> capability enforcement degrades to allow-all**: unit tests check the matcher in isolation, the
> e2e would test only the allow path, and all journeys are happy paths. A broker
> regression that skipped the check entirely would pass every test while the product appeared
> to work perfectly. It costs ~30 lines to close.

The fixture app is also the smallest consumer in the genericity test and the developer-mode
example (`mvp-scope.md`).

**Manual checklist:** the journeys in `mvp-scope.md`, before each release,
**run-from-source on Windows and macOS included**, since that is a supported path and it
is the one most likely to break silently.

They need writing up as an executable checklist (`docs/development/release-checklist.md`)
with a precondition, a fixed input and a falsifiable assertion each, because as prose in a scope
document they cannot be run identically twice. Specifically: journey 1 needs a **named port,
pinned at its recipe commit and served from a public https origin**, not "a ported app", or
pass/fail tracks whichever upstream commit was current that day; journey 3 needs a **named
`.eth` name whose record is an `ipfs://` contenthash**, plus a second run through a gateway that
alters one block, which must fail rather than render. Two items belong on the list regardless of journey:
the **telemetry first-run screen** (literal JSON, two buttons, no preselected default,
nothing sent before the choice) and **launch with no keyring available**
(`--password-store=basic`), confirming the seed is never silently written in plaintext.

No UI tests, no coverage targets. At this scale they cost more than they return, but the four
unit-tested areas above are where a silent bug is a security bug, so they are not optional.

## Risks

| Risk | Handling |
|---|---|
| Spike fails | Documented fallback, decided in week 0 rather than discovered later |
| Shell or broker overruns | They are the critical path; cut the trust indicator first |
| A dependency pulls in native modules | Audit at install time; it silently breaks Windows/macOS run-from-source |
| Electron CVEs | Track releases; a browser is a high-value target and this is not optional maintenance |
| An app fills the disk | `fs.quotaBytes` enforcement + the disk-usage UI (`ADR-0003`) |
| Scope creep from the vision docs | `mvp-scope.md` non-goals; anything absent from IN is out by default |

## Not in this plan
Rust, Wasmtime, Chromium, mobile, app store, the dashboard widget platform, wallet, signed
Windows/macOS installers, and the two ideas in `mvp-scope.md` §LATER: a torrent app
([`torrent-app.md`](torrent-app.md)) and Nostr identity. See `mvp-scope.md`.
