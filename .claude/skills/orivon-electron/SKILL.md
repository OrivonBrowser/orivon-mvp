---
name: "orivon-electron"
description: Use when writing or debugging code that runs webtorrent (or anything with a similar Node-dependency graph) inside an Orivon Electron renderer, when building the real orivon-node-shim, when an Electron+Vite renderer build fails with a confusing module-resolution error, when a gate/test hangs with no error under Playwright's _electron driver, or when anything Electron-related behaves inexplicably in this repository's dev environment. Captures Electron behaviour measured in this repository that is written down nowhere else.
---

# Orivon + Electron: rules for every task, and an index

Everything here was measured in this repository, on Electron 44, and is written down nowhere else. The rules below
apply to every Electron task. Read a file in `references/` only when the task matches its line in the index.

## Rules for every task

1. **Never launch Electron directly.** This shell sets `ELECTRON_RUN_AS_NODE=1`, which turns the binary into plain
   Node: no windows, no `require('electron')`, no `MessagePortMain`, and failures that look like unrelated bugs (a
   module-format error). Launch through `test/support/launch-electron.mjs` or
   `env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs <command>`. New launching code strips the variable and
   asserts `MessageChannelMain` exists, or its results are not to be trusted.
2. **Every launch goes through `scripts/run-headless.mjs`**, never bare `xvfb-run` (on Wayland it opens a window on
   the owner's real screen). A launch that leaves a process, a zombie or a `/tmp/orivon-test-*` profile behind is not
   finished: teardown in a `finally`, SIGKILL the tree after a bounded `app.close()`, check for survivors, delete the
   profile. `pgrep -f node_modules/electron/dist/electron` matches its own command line; resolve `/proc/<pid>/exe`
   instead. A tree with `--user-data-dir=~/.config/orivon` and an `electron-vite dev` parent is the owner's: leave it.
3. **Match windows by URL through `app.windows()`, never `app.firstWindow()`.** The shell is one `BaseWindow` with
   several `WebContentsView`s; view-add order is not a contract. `scripts/smoke.mjs` has the pattern.
4. **`MessagePortMain` fails by silence.** An `ArrayBuffer` in the transfer list renderer to main never arrives, with
   no error. Every reply over a port needs a timeout, and transferables are not a throughput option there.
5. **Check `node_modules/electron/electron.d.ts` before trusting a claim about `BaseWindow`**, in either direction.
   `ready-to-show` is typed on `BrowserWindow` only but fires on `BaseWindow`; `titleBarStyle`, `titleBarOverlay` and
   `trafficLightPosition` are declared on `BaseWindowConstructorOptions`. Silence in the `.d.ts` or in context7 means
   "unconfirmed", not "no": probe it. Electron 44 is newer than training data.
6. **Never `flipFuses` a binary in `node_modules` directly**: `npm run install:electron` writes a new file and renames
   it, so a hard-linked worktree does not flip its sibling.
7. **`await` a main-process `clipboard.write`.** `src/main/start.ts` ends the browser on an unhandled rejection.
8. **An error naming something unrelated to your code**, from a Rollup/Vite build, is read in the built bundle
   (`dist/assets/*.js`), not by its symbol name.

## Index: read the file when the task is

| File in `references/` | Read it when |
|---|---|
| `headless-launch.md` | writing or fixing launch or teardown code, checking for leaked processes, a window appeared on the real screen, or a launch fails oddly (`ELECTRON_RUN_AS_NODE`, Wayland, ozone) |
| `renderer-bundling.md` | bundling a Node dependency graph into a renderer, editing the alias map, or a Vite/Rollup build error names the wrong module (`ConnPool.join is not a function`) |
| `webtorrent-and-node-deps.md` | running webtorrent, MSE or the DHT in a renderer, writing a Node-API shim (`net.isIP`, `nextTick`), or asking why webtorrent is not in `package.json` |
| `fuses-and-file-protocol.md` | a `file:` page, a service worker or cookie behaviour differs between a checkout and a package, or `install:electron` and the fuses are in question |
| `window-and-views.md` | `BaseWindow`, `WebContentsView` or window-size code: `ready-to-show`, a window that never shows under `npm run dev`, a layout stale after `maximize()` |
| `main-process-apis.md` | `MessagePortMain` timeouts and throughput, or `clipboard.write` and `writeText` promise behaviour |
| `playwright-electron.md` | a test or gate hangs or `firstWindow()` times out under `_electron`, `waitFor` or hermetic-launch traps, screenshots of views, hidden views, killing a renderer |
| `extensions-and-crashes.md` | Chrome extensions under Electron (sandbox, service-worker preload, `net.fetch`), or a main-process SIGSEGV to symbolicate |
| `spike-evidence.md` | the week-0 spike's gates, their raw results, or where a durable lesson was folded into a spec |
