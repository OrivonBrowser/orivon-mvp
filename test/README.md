# `test/` — the end-to-end suites and the harness they share

**What lives here.** The end-to-end specs, one folder per area (the Layout table below), the shared harness
in [`support/`](support/), and [`apps/`](apps/), the apps those specs serve. Unit tests are colocated
(`src/**/*.test.ts`, `scripts/**/*.test.ts`) and do not belong here.

**What it depends on.** `@playwright/test`, `electron`, and `pngjs` and `pixelmatch` for the visual helpers.

**What it must never import.** Nothing is forbidden in the harness or the specs.
[`apps/`](apps/) is the exception and the point: nothing under it may import anything from
`src/` at runtime, because each one is an ordinary URL-delivered app holding only the
capabilities its manifest declares.

## Layout

A spec goes in the folder of the area it proves. A helper used by one area lives in that area; one used by
more goes in `support/`. A new area is a new folder and a new row here; `npm run check:test-paths` fails a
spec left at the top of `test/` and a folder with no row. File names keep their `e2e-` prefix.

| Folder | What it proves |
|---|---|
| [`app-behaviours/`](app-behaviours/README.md) | What a working app relies on: the catalogue, the specs for what no other area proves, and the rule for when a row and a spec are required |
| `app-loading/` | How an app is found, consented to, pinned, served and isolated: the loader, install consent, served policy, session partitions |
| `capabilities/` | `orivon.*` grants enforced from a real page: net, fs, id, request routing, `web.embed`, web contexts, the permission gate |
| `node-runtime/` | The Node shim in an app tab: child processes, native addons, WASI, sqlite, threads, `Buffer` |
| `ported-apps/` | Real upstream apps running unchanged (the ones that need a ports checkout skip without it) |
| `web3/` | `.eth` names, IPFS, Website level and Web3 Score |
| `extensions/` | Chrome extensions: loading, permissions, popups, the store, `webRequest`, uninstall |
| `tabs/` | The tab strip, groups, moves and drags, sleeping, crashes, split view, opening links |
| `toolbar/` | The address bar, its dropdown, search engines and toolbar popups |
| `library/` | Bookmarks, history, downloads, import and the side panel |
| `sites/` | Per-site permissions, privacy, sign-in, certificates and passwords |
| `page/` | What a page in a tab gets: find, zoom, dialogs, tools, menus, load errors, fullscreen, the reader |
| `shell-pages/` | Settings, the internal pages, the intro screen and the UI kit |
| `window/` | Launch and start-up, profiles, windows, menus, overlays, shortcuts and theme |
| `qa/` | The QA machinery proving itself: the layout audit, visual states, the failure-evidence bundle, journeys |
| [`support/`](support/) | The shared harness: `launch-electron.mjs`, `smoke-helpers.mjs`, `e2e-helpers.ts`, the `qa-*` files, `question-support.ts`, and the teardown unit test |
| [`apps/`](apps/), `fixtures/` | The apps and static pages the specs serve |

`vitest.e2e.config.ts` selects every `test/**/*.test.ts` except `apps/`; CI, `npm run test:e2e` and the
scripts cite it by that path.

## `support/launch-electron.mjs` — the only correct way to start Electron in this repo

**This machine has `ELECTRON_RUN_AS_NODE=1` set in the ambient shell.** It makes the Electron
binary run as plain Node: no windows, no `MessagePortMain`, no renderer. **It does not fail
loudly** — the process starts, prints nothing unusual, and every test hangs or silently passes
against nothing.

`launchElectron()` strips it and verifies the launch is real. **Never launch Electron
directly.** See [`.claude/skills/orivon-electron/SKILL.md`](../.claude/skills/orivon-electron/SKILL.md).

## Every launch tears itself down, by construction

`launchElectron()` registers its own `--user-data-dir` temp profile and its own root pid the
moment it creates them (`registerLaunchForTeardown`) -- a caller cannot forget this, because it
is not the caller's step to remember. `closeElectron()` is the one teardown path every e2e file
shares: it runs a caller's own graceful steps (e.g. `closeElectronApp` in `support/e2e-helpers.ts`
closing every tab first, working around `_electron`'s own `app.close()` hang), races
`app.close()` against `APP_CLOSE_RACE_MS`, then UNCONDITIONALLY SIGKILLs whatever is left of the
process tree (real Electron forks GPU/zygote/renderer helpers, so "the tree", not just the root
pid) and removes the temp profile -- in a `finally`, so a thrown graceful step or a hung
`app.close()` still leaves nothing on disk or in the process table. `assertNoElectronSurvivors()`
is the suite's own self-check: called once, in a file's top-level `afterAll`, it fails the run if
any pid the file has closed is still a live Electron process (resolved via `/proc/<pid>/exe`,
never a command-line match -- `pgrep -f node_modules/electron/dist/electron` matches its own
argv too).

`support/launch-electron-teardown.test.ts` unit-tests all of this against plain `node` child processes,
never a real Electron launch -- see its own header for exactly what that approach can and cannot
prove.

## Failure evidence and visual QA

| File | Job |
|---|---|
| `support/qa-evidence.mjs` | Records each launched app and snapshots it at close; writes the bundle of a failed test. Called by `launch-electron.mjs`; it never throws into a launch or a teardown |
| `support/qa-setup.ts`, `support/qa-global-setup.ts` | Vitest setup: decide per test whether to write or drop the held bundles, and clear `qa-artifacts/latest/` once per run |
| `support/qa-layout-audit.mjs` | The in-page layout audit. Plain JavaScript and self-contained: Playwright serialises the function, so it may close over nothing |
| `support/qa-visual.ts` | The audit wrapper, the machine-local pixel baseline, `captureState` and `checkState` |
| `support/qa-helpers.ts` | A port-0 fixture server, a launched shell, and navigation that waits on what it asserts |
| `qa/` | The specs (`e2e-qa-*`, `qa-visual`, `qa-evidence`); `docs/development/testing.md` §Visual QA and failure evidence lists what each proves |

`launchElectron({ reuseProfile })` relaunches on a profile that `closeElectron(app, { keepProfile: true })`
kept, for a test that needs the first run's state on disk; only a temp `orivon-test-*` directory the
launcher made is accepted, so a spec still cannot reach the real profile.

## Known risk

Spike gate 3 is **BLOCKED, not failed**: the app works, confirmed by a direct non-Playwright
launch, but Playwright's `_electron` driver could not attach to that window, for a cause still
unidentified ([`open-questions.md`](../docs/open-questions.md) C6). Build step 2's end-to-end
test uses the same driver. **Check this early**, not the day the test is due.
