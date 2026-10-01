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

## Week of 2026-09-28

### Done / results

- Web3 Score shield back to its outline, coloured by level; a Web2/Web2.5/Web3 mark replaces the Orivon logo in the address bar.
- In dev mode, a local origin serving a DDOC tree shows Level 2, and the Web3 Score page says it counts only in dev mode.
- Direction set: this is Orivon Browser, not an MVP. Electron base, TypeScript, features land one at a time as needs arise.
- Apps can show a website inside their own page: `<webview>` under a `web.embed` grant, with the app's script running first in every shown page.
- A manifest can ask for cross-origin isolation, so a WebAssembly component built with threads gets `SharedArrayBuffer`.
- Review of three merged PRs found five HIGH regressions; all fixed, with `.eth` gateways, favicons and the chrome lock hardened.
- Merged favicon formats (#22) and `.eth` gateway reliability (#24); found and fixed a garbage-collection bug that silently killed apps' isolated web contexts.
- Built `ipfs://`/`ipns://`, shown as addresses but served over HTTPS; protocols now register through one function in `src/protocols/` (ADR-0038).
- Cut the instructions and docs every AI session reads by more than half, and turned repeated corrections into automatic checks.
- WASI programs now run inside an app's tab over orivon.fs, via `require('wasi')`; 63 of 72 conformance programs pass.
- `child_process` works for ported apps: `spawn` runs WebAssembly programs and `fork` runs app scripts, each in a Web Worker under the app's grants.
- Native addons load as their WebAssembly builds through Node-API for WebAssembly; the `.node` machine code never runs.
- A native addon reaches the app's files from a forked child of a cross-origin isolated app; that child's `fs.readFileSync` works too.
- A spawned program can open sockets: WASI 0.2 components run from jco's output, their sockets reaching orivon.net under the app's grants.
- Found and fixed: in Electron no accepted TCP connection ever reached an app. Listening apps and spawned daemons now receive them.
- Real Rust programs and napi-rs addons, built outside the repo, now run on Orivon's WebAssembly hosts; testing them caught two gaps.
- A real tokio program runs as a spawned component: timers, concurrent dials, a listener, UDP. Testing it found every tokio listen failing; fixed.
- Published napi-rs WebAssembly packages run unchanged in isolated apps, threads included; `worker_threads` and `vm` now import instead of breaking builds.

- Settings page at orivon://settings: a section per implemented feature, searchable, live-applied, remappable shortcuts, per-site zoom, local history, F12 on any tab.
- Tabs reorder, tear off and move between windows; two tabs split side by side or stacked, with a divider and edge-drag to make one.
- Profiles and private windows are separate processes: a second start of a profile hands over; a private session's directory is deleted when it ends.
- Two hostile reviews of that work found about twenty defects, from a leaked listener to history that could end the browser; all fixed with tests.
- A whole-repository security audit's findings fixed: a site's grants work only in its own session, and the picker refuses the browser's data.
- Tearing off a tab now previews where its window opens; Settings and History restyled; eight shell bugs from daily use fixed.
- Ported Node code gets threads, synchronous file calls in workers, and children that outlive their tab; three reviews' findings fixed.
- Volume Master works; link middle-clicks no longer crash; no white flashes; Settings updates live; extension popups close. Google sign-in still refused.
- Google's sign-in pages now get a Firefox identity (headers, user agent, no userAgentData); untested against a real account until the owner tries it.
- The compatibility matrix lists every Node module, Electron export, permission and protocol, checked against the code: about 1,500 rows, most of them gaps.
- Tabs pin, mute and reopen; start-up restores or offers the last session; find, print, save, screenshots and page menus landed; 54 review findings fixed.
- The Lounge runs its real, unmodified Node server in a forked Worker: accounts, IRC, SQLite scrollback, all driven end to end headless.
- Downloads, bookmark folders and manager, address-bar suggestions, History by session, import, About and a task manager landed; 56 review findings fixed.
- Extensions gained a menu with pinning, a permission sheet, command keys and history, bookmarks and search APIs; blockers run; 34 review findings fixed.
- Sites ask once for camera, location and more; passwords save and fill; privacy controls, sign-in sheets and certificate viewer landed; 61 review findings fixed.

### In my head
- Explored what `child_process` can safely mean: a WASI program in the app's own tab, native `subprocess` still excluded (`docs/planning/child-process-design.md`).
- WASM compatibility explored: JSPI works in Electron 44, so a WASI host over orivon.* needs no contracts change; no port needs it yet (docs/planning/wasm-compatibility.md).
- Audited how AI sessions spend their budget: most goes to very long sessions and a 700 KB questions file. Handoff written for Opus 5.5.
- Direction: the wallet moves from OUT to IN; explored as three provider layers behind one registry, mnemonic first, reads through Helios (`docs/planning/wallet-system-exploration.md`).
- Decided native modules, spawn and fork run only as WebAssembly under the broker; native machine code never runs for an app (ADR-0040).

### Non-repo
