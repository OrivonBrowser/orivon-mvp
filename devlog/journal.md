# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-08-24

### Done / results
- 2026-08-25: Set up the weekly devlog system (journal capture + /devlog compiler + Sunday cron draft).
- 2026-08-25: **Owner gave the go.** Preparation phase closed (A6); the week-0 spike is next.
- 2026-08-25: Two one-way doors decided — cached apps keep their real origin (ADR-0007), and capability handles are WHATWG streams underneath with Node shapes on top (A10 direction; full spec still to write).
- 2026-08-25: Week-0 spike execution plan written, gate by gate, with the throwaway/kept code line drawn explicitly.
- 2026-08-25: Live API check corrected four things the docs got wrong: webtorrent is 3.0.21 not 2.x, its `browser` field disables more than recorded, `createServer` has an Electron-specific `force` flag, and electron#34905 is still open — the last one added a new gate 0 to the spike.
- 2026-08-25: **First code committed.** Scaffold running (electron-vite + TS + Vitest + CI), window opens, preload reaches the page, nothing leaks into it.
- 2026-08-25: **Gate 0 PASS.** MessagePortMain measured at 1134 MB/s renderer→main and 313 MB/s main→renderer, byte-exact both ways — against the 1–5 MB/s 1080p needs. The data path the whole capability API rests on is sound.
- 2026-08-25: electron#34905 confirmed, and worse than the issue says: transferable ArrayBuffers renderer→main are silently dropped, never arriving, with no error. Killed the "day 2 with transferables" fallback in the build plan; harmless, since copying is already 60–200x past requirement.
- 2026-08-25: Native-module guard rewritten against build-plan's literal criterion — a naive `.node` check fails on Electron's own prebuilt deps, so it now fails on what needs a *compiler* instead.
- 2026-08-25: Lost about an hour to `ELECTRON_RUN_AS_NODE=1` being set in the environment, which makes the Electron binary run as plain Node. It presented as a module-format error. Every gate now launches through a helper that strips it and asserts it is really Electron.
- 2026-08-25: **Gate 1a PASS** — a renderer bundle fetched an ordinary non-WebRTC torrent (wire type `tcpOutgoing`, piece verified in 505ms). This was the risk four audits called the real one.
- 2026-08-25: Six bundling problems to get there, only one anticipated. Worst was a missing `path` polyfill that reported itself as `ConnPool.join is not a function`, because Rollup gave two externalised modules the same identifier.
- 2026-08-25: **BitTorrent encryption works after all.** Owner challenged the claim that it couldn't run in the renderer; `mse.js` already ships a pure-JS RC4 fallback and `crypto-browserify` covers the rest. Encrypted handshake verified at `secure: 2` (no plaintext fallback). Recommendation: ship `secure: 1`.
- 2026-08-25: **Gate 1b PASS** — DHT lookup over the shimmed `dgram`, peer found in 11ms with real KRPC traffic. Message-oriented transport works, not just streams.
- 2026-08-25: Gate 1b's bug is the most instructive yet: `net.isIP` was missing from the shim, so the DHT sent nothing at all — and the `process.nextTick` polyfill swallowed the TypeError, turning a loud failure silent. Both lessons belong in the real shim.
- 2026-08-25: Hardened the unattended Sunday devlog cron — writes scoped to `devlog/` only, after a first attempt that left a real escape to `$HOME`.
- 2026-08-25: **Gate 2 PASS** — shell tree needs no compiler either way, but `npm install --omit=optional` turned out to break the build outright (skips a required Rollup binary). Contributors must use a plain install.
- 2026-08-25: **Gate 4: 52 MB/s shimmed vs 190 MB/s native control** — fails the plan's literal 60%-of-control threshold, but that control is same-process/zero-IPC/RAM-speed. Against the real product need (1–5 MB/s for 1080p) it's 10.5x headroom. Concurrency: 100/100 sockets held up fine.
- 2026-08-25: **Gate 3 (video playback) blocked, not failed** — the app itself loads and plays fine under a direct Electron launch, but Playwright can't attach to its window specifically. Six causes ruled out; handed back with full evidence rather than guessed at further.
- 2026-08-25: Spike verdict written up and all corrections folded into the specs: webtorrent version, the `createServer` force param, and two shim-design lessons (mirror the whole surface a dependency touches; a `process.nextTick` polyfill can silently swallow errors) queued for the A10 handle contracts.
- 2026-08-25: Wrote the `orivon-electron` project skill capturing everything from the spike that would otherwise only live in chat history.

### In my head
- 2026-08-25: Wants a Sunday ritual: paste-ready team message plus bullet cues for a spontaneous voice note recalling the week's thinking.
- 2026-08-25: Keen to start building the browser; kept checking whether preparation was really finished. Accepted that the spike comes first once it was clear a spike failure would invalidate a week of shell work.
- 2026-08-25: Cost discipline — asked twice about when Opus is genuinely needed versus Sonnet, and wants the expensive model spent on judgment rather than on build-run-read-error loops. Switched to opusplan once the bundling recipe was established.
- 2026-08-25: Instinctively distrusted a "we can't do anything about it" answer and was right to. The challenge, not the analysis, is what produced the correct result.
