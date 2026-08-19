# Build plan

Dependency-ordered. One solo developer with AI assistance, one month.
Scope is fixed by `mvp-scope.md`; decisions by `docs/decisions/`.

## Week 0 — the gate

**Nothing else starts until this resolves.**

> **Spike (timeboxed to 2 days): can `webtorrent` run in a renderer over shimmed
> `net`/`dgram` at usable throughput?**
> Socket data over `MessageChannelMain` ports, video via MediaSource.
> Target: sustained throughput sufficient for 1080p playback while downloading.

- **Pass** → the torrent app is a genuine URL-delivered app; proceed as planned (`ADR-0005`).
- **Fail** → run `webtorrent` privileged in the main process for the MVP, record as known debt,
  and continue. The flagship still ships; only its status as "an ordinary app" is lost.

Failing here costs 2 days. Discovering it in week 4 costs the month.

**Also in week 0:** repo scaffold, `electron-vite` + TypeScript, Node 24 (already installed).
No Rust toolchain is required (`ADR-0002`).

## Platform policy

**Linux is the packaged target** (AppImage + deb) — no code-signing cost, and the audience
skews Linux.

**Windows and macOS are supported from day one via run-from-source**: `git clone`,
`npm install`, `npm start`. This sidesteps both Windows SmartScreen and macOS Gatekeeper
without buying certificates, and widens the reachable audience. Those users count toward the
metric and their telemetry must work identically.

Two constraints follow, and they are not optional:

1. **Pure-JS dependencies only.** No native modules requiring compilation — notably avoid
   webtorrent's optional `utp-native`. If `npm install` needs node-gyp and Visual Studio Build
   Tools, run-from-source is a worse wall than the certificate it was meant to avoid.
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

**4. App loader** — fetch manifest + assets from URL, cache, hash-pin, re-consent on change.
Depends on broker storage. The pinning here is also what `ADR-0006` and the future attestation
model rest on.

**5. Torrent app** — `webtorrent` via the shim, streaming server, player UI, magnet input,
file list, resume. Lift player components from MIT-licensed `webtorrent-desktop`.
**End of this step = the clip exists. Begin distribution now, not at the end of the month.**

**6. Trust indicator** — delivery ladder, connection ladder from the broker's per-app
connection log, operation scoring. Click-through shows the actual evidence, not a grade
(`ADR-0006`).

**7. Nostr** — inject `window.nostr` (NIP-07) backed by `orivon.id`. Verify against two or
three real clients before trusting the ~1 day estimate (`open-questions.md` C4).

**8. Telemetry** — collection, first-run disclosure view showing the literal JSON, in-product
"what has been sent" page. The disclosure UI is not optional (`ADR-0004`).

**9. Developer mode** — unpacked loader, plainly-worded opt-in, unsigned marking, developer
docs. This is journey 3.

**10. Packaging** — `electron-builder`, AppImage + deb, auto-update via `electron-updater`
against GitHub Releases. Plus a documented, tested run-from-source path in the README for
Windows and macOS.

## Milestones

| | |
|---|---|
| End week 1 | Spike resolved · shell running · broker skeleton enforcing one capability |
| End week 2 | Shim + app loader + torrent app → **the clip exists; distribution starts** |
| End week 3 | Trust indicator · Nostr · telemetry |
| End week 4 | Developer mode + docs · packaging · polish · **pre-announce telemetry, then ship** |

## Testing

Deliberately minimal, concentrated where silent failure is plausible and costly.

**Unit tests — security-critical logic only:**
- capability pattern matching (host/port globs, port ranges)
- `fs` path-traversal rejection — resolve, then verify the prefix
- origin derivation and normalisation
- per-origin key derivation determinism

**One end-to-end smoke test:** launch → load app → grant capability → open socket → data flows.

**Manual checklist:** the three journeys in `mvp-scope.md`, before each release —
**run-from-source on Windows and macOS included**, since that is now a supported path and it
is the one most likely to break silently.

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
