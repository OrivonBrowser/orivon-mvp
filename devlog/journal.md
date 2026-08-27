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
- 2026-08-26: **The repo is public** — github.com/OrivonBrowser/orivon-mvp, Apache-2.0, full history, CI green on the first run. Branch protection on `main`: CI must pass, changes go through a PR.
- 2026-08-26: `src/contracts/` written — the whole `orivon.*` surface as seven files of types, transcribed from capability-api.md and handle-contracts.md. It is the thing that lets sequentially-dependent build steps be worked on in parallel, and it is the fastest way for anyone to understand the product.
- 2026-08-26: Parallel-work system in place: worktree-per-stream, an ownership map with no overlapping paths, a composition root where adding a subsystem is two appended lines instead of an edit, and `merge=union` on the append-only files (verified by actually merging two divergent appends, not assumed).
- 2026-08-26: Repo made human-navigable — README, ARCHITECTURE, CONTRIBUTING, SECURITY, a docs index, setup/testing guides, and a README in every directory saying what it depends on and what it must never import. The map used to live only in CLAUDE.md, which is an agent file.
- 2026-08-26: Transcribing the contracts surfaced two real gaps in the spec docs (A12: `orivon.fs` option bags unspecified; A13: capability-api.md contradicts itself on whether `app.manifest()` is async). Recorded, not invented around.
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
- 2026-08-26: Branch merged — `spike/week-0` fast-forwarded into `master`, 19 commits. `spike/`'s untracked `node_modules` (53 MB) reclaimed; the 266 KB of tracked spike source kept for now (the `ELECTRON_RUN_AS_NODE` launcher pattern and the gate-3 Playwright-attach repro still live nowhere else).
- 2026-08-26: **A10 closed.** Full handle-contract spec written (`docs/architecture/handle-contracts.md`) plus `ADR-0008` recording the WHATWG-streams decision and rescoping `capability-api.md`'s Node-shape-mirroring rule to the shim layer. Build step 2 is unblocked. New owner call made while writing it: network errors carry the real reason for any address an app was permitted to attempt; a denial itself stays uniform so an app can't map the permission boundary by probing it.
- 2026-08-26: **Build step 1 (the shell) complete.** `BaseWindow` composing a chrome view (tabs, toolbar, address bar) and per-tab `WebContentsView`s, two-privilege preloads, IPC sender-checked by frame identity. Owner picked concept 2 ("dense, filled-pill active tab") from three published mockups before any chrome code was written. Verified end-to-end against the real built app throughout, not just typechecked — caught and fixed two real bugs this way: `createTab`'s URL argument was silently swallowed by the wrong parser (split into `parseOmniboxInput` vs `sanitizeDirectUrl`), and the very first tab didn't render on cold start because its state push raced the chrome page's own load (fixed with a `did-finish-load` re-sync). C6 narrowed: a minimal multi-view `BaseWindow` attaches to Playwright fine, so gate 3's failure is specific to its video/service-worker setup, not `BaseWindow` in general. Build step 2 (the broker) is next.
- 2026-08-26: **Real bug hunt: `npm run dev` never showed a window.** Two dead ends before the root cause — a "wrong monitor" misdiagnosis (the display was actually correct; misread its reported dimensions), then a genuine regression trying to fix that misdiagnosis (forcing X11/XWayland segfaulted the GPU process). Root-caused only once the owner ran `npm run dev` directly with traced logging and shared the output: `ready-to-show` doesn't fire reliably when loading from electron-vite's dev server. The window existed the whole time; `show()` was just never called. Fixed with a short fallback timer. The owner's own observations (working during probes, not during "real" launches; a specific terminal paste showing exactly where it stopped) did more to solve this than any of the automated diagnostics.
- 2026-08-27: **Smoke check extended, then the extension was reviewed and largely rewritten.** New coverage: two-tab history isolation, closing the last tab, the omnibox search branch, and dangerous-scheme rejection end-to-end (`javascript:`/`data:`/`file:` — the pure function was unit tested, the wiring never was). Review caught three real defects in the first version: the DuckDuckGo check passed with the network unplugged while still phoning out (the address bar shows the *requested* URL even for an error page, so it never tested the round trip it claimed to); a regression made the script hang and print nothing, breaking its own "read the JSON, not the exit code" promise; and the last-tab checks froze an undecided behaviour under names that misdiagnosed it. Proven by mutation testing rather than argued — two deliberate bugs planted in `tabs.ts`, before and after.
- 2026-08-27: Smoke is now hermetic and verified air-gapped (41/41 with all DNS blackholed), waits on conditions instead of fixed sleeps, and addresses tabs by `data-id` rather than `:not(.active)`. A16 filed: nobody ever decided what closing the last tab should do.

### In my head
- 2026-08-27: The mutation tests were worth more than any amount of reading. Three independent reviews agreed the DuckDuckGo check was the weakest thing in the PR, but it was planting a bug and watching what the check *did* that settled it — and the same technique showed the "no stray window" assertion would have blamed the wrong thing entirely if the last-tab behaviour ever changed. Worth reaching for whenever a test's value is in question.
- 2026-08-26: Readability check caught the same class of error a second time, opposite direction — the README stated MVP scope boundaries ("not a wallet, no DAO") as if they were permanent positions on Orivon, when both are real long-term goals with their own designs. Now a binding rule: never state an MVP boundary as a property of the project, or a long-term aim as a plan for this repo.
- 2026-08-26: **Readability check works, and caught three things on its first run.** Owner read README and ARCHITECTURE cold: no roadmap, no explanation of the Web3 connection, and an architecture section that read as "this repo is becoming a Chromium fork" when it meant "the interface is built to outlive the shell". All three fixed; the check is now a standing rule at the end of every build step.
- 2026-08-26: Standing policy set: the repo must be workable by a developer arriving alone with no AI, and the owner is the test for that — one artefact, one question, "where did you first get lost?"
- 2026-08-25: Wants a Sunday ritual: paste-ready team message plus bullet cues for a spontaneous voice note recalling the week's thinking.
- 2026-08-25: Keen to start building the browser; kept checking whether preparation was really finished. Accepted that the spike comes first once it was clear a spike failure would invalidate a week of shell work.
- 2026-08-25: Cost discipline — asked twice about when Opus is genuinely needed versus Sonnet, and wants the expensive model spent on judgment rather than on build-run-read-error loops. Switched to opusplan once the bundling recipe was established.
- 2026-08-25: Instinctively distrusted a "we can't do anything about it" answer and was right to. The challenge, not the analysis, is what produced the correct result.
- 2026-08-26: Pushed back hard on being asked to choose between "A10" and "build step 1" with no plain-language explanation of what either was — a standing correction now, not a one-off.
