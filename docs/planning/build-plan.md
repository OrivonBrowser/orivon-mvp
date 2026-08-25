# Build plan

Dependency-ordered. One solo developer with AI assistance, one month.
Scope is fixed by `mvp-scope.md`; decisions by `docs/decisions/`.

**webtorrent is 3.0.21**, verified against live package metadata 2026-08-25 — not the 2.x
this document originally assumed. See `week-0-spike-plan.md` §Verified facts for the full list
of corrections found the same way.

## Week 0 — the gate

**Nothing else starts until this resolves.**

> **Spike (timeboxed to 2 days): can `webtorrent` run in a renderer over shimmed
> `net`/`dgram`, fetching *ordinary* torrents, with no native modules and a working
> video path?**

**Rewritten 2026-08-25 after the multi-agent audit** (`audit-2026-08-25.md`). The previous
criterion — "sustained throughput sufficient for 1080p playback" — was the wrong gate. Four
independent audits agreed: measured `MessagePort` transfer is ~310 MB/s and per-message p50
~0.5 ms, against the 1–5 MB/s that 1080p streaming needs. **The old spike would have returned
PASS while three genuine blockers went untested.**

Run the checks **in this order** and stop at the first that fails:

**1. Does it fetch an ordinary torrent at all?** *(the real risk)*
webtorrent's `browser` field maps `net`, `bittorrent-dht`, `ut_pex`, `utp` and `conn-pool` to
`false`, so a naive renderer bundle is **WebRTC-only — Brave parity**, which is precisely what
`ADR-0001` reason 3 exists to beat. Required: per-module resolution overrides (Node resolution
aliased to the shim for the socket modules, browser resolution for `webrtc-polyfill`).
**Pass = completes a piece from a non-WebRTC TCP peer, and completes a DHT lookup over shimmed
`dgram`.**

**2. Is the shell dependency tree free of native modules?**
`node-datachannel` is a **hard, non-optional** transitive dependency (CMake + libdatachannel),
not the `utp-native` this plan originally flagged. It breaks Windows/macOS run-from-source.
**Pass = zero `binding.gyp` / `prebuilds/` anywhere under the shell's `node_modules`**, which
the intended design achieves by shipping webtorrent as a pre-built *app asset* rather than a
shell dependency. Add the check as a `postinstall` script while here.

**3. Does video actually play?** *(~2 hours)*
Play one MP4/H.264 magnet end to end and confirm the format story holds. MKV is **out of v0 by
owner decision** — MSE cannot demux Matroska and neither can Chromium's `<video>`, so there is
no fallback path, only a remuxer (post-launch). **Pass = MP4/H.264 plays with seeking.**

**4. Throughput.** *(last, and expect a pass)*
Use a **local seeder** so swarm health is not an input, and measure against a **control**: the
same webtorrent running natively. **Pass = shimmed ≥60% of control, ≥25 Mbps absolute, ≥100
concurrent peer sockets, main-process CPU headroom intact and no UI frame drops, RSS stable
over 10 minutes.** Record *which* sub-criterion fails — CPU-bound, latency-bound and
architecturally-impossible have different fallbacks. Structure as day 1 naive → day 2 with
64–256 KB batching.

> **Corrected 2026-08-25 by gate 0.** This step used to say "day 2 with transferable
> `ArrayBuffer`s and 64–256 KB batching", and called "passes, but only with transferables" the
> likeliest outcome. **Transferables are not available on this path**, so batching is the only
> day-2 lever. See gate 0 below — this does not endanger the gate, because copying already
> exceeds the requirement by two orders of magnitude.

**0. Does `MessagePortMain` carry bytes renderer → main at all?** *(added 2026-08-25, ~2 h)*
Runs before any webtorrent work, because every later gate and the whole of
`capability-api.md` §Throughput sits on this path.
**RESOLVED — PASS**, measured on Electron 44.0.0 / Chromium 152, through the `contextBridge`
closures rather than a raw port. Byte-exact in both directions at 64 KB / 256 KB / 1 MB;
**1134.8 MB/s renderer → main** and **313.4 MB/s main → renderer**, against the 1–5 MB/s that
1080p needs.
**Finding:** [electron#34905](https://github.com/electron/electron/issues/34905) reproduces and
is worse than reported — a transferable `ArrayBuffer` sent renderer → main **does not throw and
never arrives**. Silent total loss at every size. Consequences are recorded in
`capability-api.md` §Throughput; the practical rules are *never transfer on this path* and
*every reply-carrying protocol over `MessagePortMain` needs a timeout, because this transport
fails by silence.*

- **Pass** → the torrent app is a genuine URL-delivered app; proceed as planned (`ADR-0005`).
- **Fail** → run `webtorrent` in an Electron **`utilityProcess`**, *not* the main process. It
  has full Node, no ambient main-process authority, and the cheapest measured IPC path — so the
  recorded debt is far smaller than the original "privileged in main" fallback. The flagship
  still ships; only its status as "an ordinary app" is reduced.

Failing here costs 2 days. Discovering it in week 4 costs the month.

**Also in week 0:** repo scaffold, `electron-vite` + TypeScript, Node 24 (already installed).
No Rust toolchain is required (`ADR-0002`). Decide the test stack now — **Vitest**
(`environment: 'node'`, inherits the vite transform), **Playwright `_electron`** for the single
e2e, and one GitHub Actions job on push. With no code reviewer, CI *is* the reviewer.

**Structural decision, day 1, zero cost:** `src/broker/policy/*.ts` holds pure functions with
**no Electron imports and no I/O**; the broker is constructed as
`createBroker({ dial, resolve, now, fs, keychain })`. Every capability test then runs against
stubs. Deciding this later costs a day of refactor exactly when the schedule is tightest.

## Platform policy

**Linux is the packaged target** (AppImage + deb) — no code-signing cost, and the audience
skews Linux.

**Windows and macOS are supported from day one via run-from-source**: `git clone`,
`npm install`, `npm start`. This sidesteps both Windows SmartScreen and macOS Gatekeeper
without buying certificates, and widens the reachable audience. Those users count toward the
metric and their telemetry must work identically.

Two constraints follow, and they are not optional:

1. **Pure-JS dependencies only.** No native modules requiring compilation. If `npm install`
   needs node-gyp and Visual Studio Build Tools, run-from-source is a worse wall than the
   certificate it was meant to avoid.
   **Corrected 2026-08-25:** the real blocker is not `utp-native` (optional) but
   **`node-datachannel`** — a *hard* transitive dependency of webtorrent via
   `@thaunknown/simple-peer → webrtc-polyfill`, requiring **CMake and a C++ toolchain** when a
   prebuild is missing. Also present: `bufferutil`, `utf-8-validate`, `fs-native-extensions`
   (optional, but npm installs optionals by default).
   **Therefore: webtorrent is shipped as a pre-built app asset, not a shell dependency**, so
   the shell's `npm install` never resolves it. Enforce with a `postinstall` check that fails
   the build on any `binding.gyp` or `prebuilds/` under `node_modules`.
2. **No platform-specific paths.** All storage goes through `app.getPath('userData')`, never a
   hardcoded XDG path, so data persists correctly on all three platforms (`ADR-0003`).

Known caveat: `safeStorage` differs per platform — Keychain on macOS, DPAPI on Windows, and on
Linux it needs an available keyring, with `isEncryptionAvailable()` returning false otherwise.
A documented fallback is required; see `security-model.md`.

Side benefit worth noting: anyone willing to clone and `npm start` self-selects as a potential
contributor, which is precisely the population the MVP is meant to attract.

## Critical path

```
spike → shell → broker → shim → app loader → torrent app → THE CLIP
```

Everything not on this line is deferrable within the month. The clip is what unblocks
distribution, so it is reached as early as possible rather than last.

## Sequence

**1. Shell** — `WebContentsView` tabs, omnibox, back/forward, window chrome.
No dependencies. Use the prior prototype's GUI as *visual reference only* (`ADR-0002`).

**2. Capability broker** — manifest parsing, grant model, per-origin enforcement, grant
prompts, per-app `session` partitions. Depends on the shell for preload/IPC.
**Settle the origin definition here** — it keys storage, partitions, grants and derived keys,
and changing it after the first grant is persisted orphans every app (`ADR-0003`).

**3. `orivon-node-shim`** — `net`, `dgram`, `fs` over `orivon.*`. Depends on the broker.
Load-bearing for the flagship, not a developer nicety (`ADR-0005`).

**4. App loader** — discover the manifest at `/.well-known/orivon.json`
(`capability-api.md`), fetch + cache assets, pin the publisher key and record per-version
hashes; silent update on same key + unchanged capabilities (`ADR-0005` amendment).
Depends on broker storage. The pinning here is also what `ADR-0006` and the future attestation
model rest on.

**5. Torrent app** — `webtorrent` via the shim, player UI, magnet input, file list, resume.
Ships as a pre-built app asset (see Platform policy).

Media path, decided 2026-08-25: **serve pieces to `<video>` over a range-capable custom
scheme**, not MSE and not a localhost HTTP server. MSE would require fMP4 you do not have and
forces hand-implemented seeking; a localhost socket is `security-model.md` T15. A
`protocol.handle()` streaming response — or webtorrent's Service-Worker
`createServer({ controller })`, which is renderer-local and origin-scoped — gives seeking and
track selection to Chromium for free and is **unreachable by other local processes**, which is
strictly stronger than T15's token mitigation.

**`createServer` takes a second parameter, confirmed 2026-08-25 and not documented anywhere
else in this corpus:** `client.createServer(opts, force)`, where `force: 'browser' | 'node'`
exists specifically for environments that run both Node and a browser context — Electron is
named explicitly in webtorrent's own docs as the intended use case. Without it, webtorrent may
select its Node implementation in the renderer and attempt to open a real listening socket
rather than using the Service-Worker path. Call it as
`client.createServer({ controller }, 'browser')`.

Separately confirmed by the spike (`week-0-spike-plan.md` §Gate 3): Electron treats a `file://`
origin loaded via `loadFile()` as a secure context, so service worker registration for this
path does not need the fallback originally assumed — `navigator.serviceWorker.register(...)`
succeeds without any extra scheme registration. The `protocol.handle()` custom-scheme path
described above remains the documented fallback if that ever changes.

**Format support in v0 is MP4/H.264 only** (owner decision). MSE cannot demux Matroska and
neither can Chromium's `<video>`, so MKV has no path without a remuxer — deferred to
post-launch (`libav-wasm`, pure-WASM). Stock Electron does ship H.264/AAC
(`proprietary_codecs = true`), so this needs no extra work; HEVC is hardware-decode-only and
therefore out.

Lift **presentation only** from `webtorrent-desktop` — control layout, keyboard shortcuts,
subtitle rendering, file-list UI. Its playback plumbing is stale (last release 2020, pinned to
Electron 27 and webtorrent 1.9.7) and points at the localhost-server + VLC-handoff design that
v0 rejects. Same status as `orivon-browser-v2`: **visual reference only.**

Known limitations, stated in-product rather than hidden: **MP4/H.264 only in v0**; swarm peers
see the user's IP (no Tor in the MVP); seeding behind NAT is reduced without port forwarding
(no UPnP in v0); local peer discovery is unavailable (no multicast bind in the manifest
grammar).

> **Protocol encryption (MSE): available, and it should be ON. Resolved 2026-08-25 by gate 1a.**
>
> This entry first recorded MSE as a *limitation*, on the reasoning that it needs
> Diffie-Hellman, a synchronous SHA-1 and RC4 which WebCrypto does not usefully provide. **That
> was wrong, and the owner was right to challenge it.** Measured instead of assumed:
> - `mse.js` already ships a **complete pure-JS RC4 fallback**, selected whenever
>   `nativeRC4` is false. RC4 was never a problem.
> - The only genuinely missing pieces were `createHash('sha1')` and `createDiffieHellman`,
>   and **`crypto-browserify` supplies both**, in pure JS — so Rule 8 is unaffected.
> - Aliasing `crypto` → `crypto-browserify` and restoring the real `mse.js` produced a
>   **successful encrypted handshake at `secure: 2`** — RC4 required, *no plaintext fallback* —
>   against a Node seeder using native crypto. A piece verified in 479 ms.
>
> **Cost:** the renderer bundle grows from 427 KB to 1.70 MB (95 KB → 336 KB gzipped).
> Irrelevant against Electron's ~150–200 MB floor (`ADR-0005`), and it buys reachability with
> peers that require encryption plus resistance to ISP shaping of plaintext BitTorrent.
>
> **Recommendation: ship `secure: 1`** (encrypt, fall back to plaintext) — maximum swarm
> reach. `secure: 2` also works but refuses plaintext-only peers.
>
> **Honesty note for the UI:** MSE is *obfuscation, not privacy*. Its DH exchange is
> unauthenticated and RC4 is broken; it exists to defeat traffic shaping, not eavesdroppers.
> It must never be presented as making torrenting private — the IP-visibility limitation above
> is the one that actually governs, and `ADR-0006` exists to prevent exactly this kind of
> overclaim.

**End of this step = the clip exists. Begin distribution now, not at the end of the month.**

**6. Trust indicator** — delivery ladder, connection ladder from the broker's per-app
connection log, operation scoring. Click-through shows the actual evidence, not a grade
(`ADR-0006`).

**7. Nostr** — inject `window.nostr` (NIP-07) backed by `orivon.id`. Verify against two or
three real clients before trusting the ~1 day estimate (`open-questions.md` C4).

**8. Telemetry** — collection, first-run disclosure showing the literal JSON with equal
[Keep on] / [Turn off] buttons and no preselected default, in-product "what has been sent"
page. The disclosure UI is not optional (`ADR-0004`).

**9. Developer mode** — unpacked loader, plainly-worded opt-in, unsigned marking, developer
docs. This is journey 3.

**10. Packaging** — `electron-builder`, AppImage + deb. Plus a documented, tested
run-from-source path in the README for Windows and macOS.

**Auto-install is cut (owner decision, 2026-08-25).** Unsigned `electron-updater` on Linux
verifies only a SHA-512 fetched from the *same host* that serves the binary, making it a
standing remote-code-execution channel keyed to a GitHub token — weaker than what `ADR-0005`
demands of third-party apps, which is the wrong way round. v0 **checks and notifies**, linking
to the release. Signing the update manifest with an offline key is the post-MVP upgrade.

Two packaging facts that shape the choice, verified 2026-08-25:
- **AppImage is the only seamless auto-update target**; deb/rpm updates require a privilege
  prompt. Moot for v0 given the above, but it constrains the post-MVP path.
- **Only deb can register as the default browser.** `xdg-settings set default-web-browser`
  needs an installed `.desktop` file with the right `MimeType=` entries, and a bare AppImage
  does not self-integrate. For a metric measured in daily-driver hours that is not cosmetic:
  **deb is the primary artefact**, AppImage is for trial and clip audiences, and AppImage users
  get a first-run "install desktop entry" flow.
- AppImage caveats to document: needs `libfuse2` on Ubuntu 22.10+; `chrome-sandbox` SUID error
  because AppImages mount read-only; build on the oldest LTS you intend to support.

## Milestones

| | |
|---|---|
| End week 1 | Spike resolved · shell running · broker skeleton enforcing one capability |
| End week 2 | Shim + app loader + torrent app → **the clip exists; distribution starts** |
| End week 3 | Trust indicator · Nostr · telemetry |
| End week 4 | Developer mode + docs · packaging · polish · **pre-announce telemetry, then ship** |

## Testing

Deliberately minimal, concentrated where silent failure is plausible and costly.

**Unit tests — security-critical logic only** (revised 2026-08-25 after the QA audit; each is a
pure function against stubs, 30 min–3 h):

1. **Capability checking at the call site**, not just the matcher — `checkConnect(manifest,
   hostArg, resolveFn)` with an injected stub resolver, plus an `isPrivateAddress` table
   covering 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, `fc00::/7`, IPv4-mapped
   `::ffff:127.0.0.1`, and integer/octal literal forms. *A correct glob matcher fed a hostname
   is still fully defeated by rebinding — the original test covered the harmless half of T12.*
2. **`fs` path-traversal rejection** — `path.relative(root, resolved)` must be non-empty, not
   start with `..`, and not be absolute; **plus `realpath` the parent** so a planted symlink
   cannot escape. *A string-prefix check passes `/apps/foo-evil` against root `/apps/foo`, and
   `path.resolve` does not follow symlinks.* Table must cover `..`, absolute paths, symlink
   escape, NUL bytes, sibling-prefix, Windows separators / drive letters / `\\?\` UNC /
   reserved names, and macOS case-insensitivity. One `fast-check` property: for random segment
   arrays, the resolved path is always inside root. **This is also the flagship's happy path —
   a `.torrent` declares its own file paths, and `../../../.ssh/authorized_keys` is a real
   BitTorrent CVE class, so T1 and T10 combine here.**
3. **Origin derivation, split into two** — (i) URL → origin normalisation (default ports,
   trailing dots, case, punycode/IDN, userinfo, `file:`/`data:` rejection); (ii) **`senderFrame`
   → origin**, asserting a renderer-supplied origin field is ignored and unbound frames are
   rejected (`security-model.md` T3).
4. **Key derivation as frozen golden vectors**, not determinism — hardcode seed / origin / curve
   → expected public key hex, for both the `"app"` and `"identity"` labels, and assert the two
   labels differ. *Same-input-same-output is near-tautological for a KDF; the real risk is the
   derivation changing between releases and silently orphaning every user's identity, with no
   export path to recover from (`ADR-0003`).*
5. **The update decision table** — `decideUpdate({pinnedHash, newHash, grantedPatterns,
   newPatterns, version, versionFloor}) → 'silent' | 'reconsent' | 'capability-prompt' |
   'reject'`, ~8 rows. *Its failure mode is "no prompt appeared", which no manual checklist
   catches, and the capability at stake is `tcp.connect *:*`.*
6. **Telemetry session accounting** as a pure fold over an event stream — start/stop,
   suspend/resume, tab switch, **active vs background attribution**, month rollover, and
   abnormal termination (assert a periodic checkpoint so a crash loses minutes, not a session).
   *This is the number the project is judged on, and its likeliest bug biases it downward —
   making a succeeding product look like a failing one.*

**One end-to-end smoke test**, covering four of five critical-path layers in a single launch:
fixture app served over **localhost HTTP with a real `/.well-known/orivon.json`** → loaded via
the app loader → grant accepted → `require('net')` **through the shim** connects to a local
echo server and moves bytes → **then the same app attempts a connection outside its manifest
patterns and is rejected.**

> That last clause is the highest-value assertion in the plan. As previously written, **nothing
> failed if capability enforcement degraded to allow-all** — unit tests check the matcher in
> isolation, the e2e tested only the allow path, and all journeys are happy paths. A broker
> regression that skipped the check entirely would pass every test while the product appeared
> to work perfectly. It costs ~30 lines to close.

The fixture app is also **app #3** for the genericity test and the developer-mode example
(`mvp-scope.md`).

**Manual checklist:** the journeys in `mvp-scope.md`, before each release —
**run-from-source on Windows and macOS included**, since that is now a supported path and it
is the one most likely to break silently.

They need writing up as an executable checklist (`docs/testing/release-checklist.md`) with a
precondition, a fixed input and a falsifiable assertion each — as prose in a scope document
they cannot be run identically twice. Specifically: journey 1 needs a **named, pinned,
well-seeded MP4 torrent**, not "a magnet link", or pass/fail tracks swarm health that day;
journey 3 must name **three Nostr clients pinned at a version** and assert the displayed npub
is **byte-identical across two of them** — the check that would have caught the per-origin-key
contradiction (`open-questions.md` B4). Two items belong on the list regardless of journey:
the **telemetry first-run screen** (literal JSON, two equal buttons, no preselected default,
nothing sent before the choice) and **launch with no keyring available**
(`--password-store=basic`), confirming the seed is never silently written in plaintext.

No UI tests, no coverage targets. At this scale they cost more than they return — but the four
unit-tested areas above are where a silent bug is a security bug, so they are not optional.

## Risks

| Risk | Handling |
|---|---|
| Spike fails | Documented fallback, decided in week 0 rather than discovered later |
| Shell or broker overruns | They are the critical path; cut the trust indicator first, Nostr second |
| A dependency pulls in native modules | Audit at install time; it silently breaks Windows/macOS run-from-source |
| NIP-07 injection non-conformance | Verify early (C4); only ~1 day, so it can slip to week 4 |
| Electron CVEs | Track releases; a browser is a high-value target and this is not optional maintenance |
| Torrent disk exhaustion | `fs.quotaBytes` enforcement + the disk-usage UI (`ADR-0003`) |
| Scope creep from the vision docs | `mvp-scope.md` non-goals; anything absent from IN is out by default |

## Not in this plan
Rust, Wasmtime, Chromium, mobile, DDOC, ENS, IPFS, app store, dashboard, wallet, and signed
Windows/macOS installers. See `mvp-scope.md`.
