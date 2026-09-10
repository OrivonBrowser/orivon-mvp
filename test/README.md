# `test/` — shared test infrastructure

**What lives here.** Helpers used by the smoke check and, later, the end-to-end test.

**What it depends on.** `@playwright/test`, `electron`.

**What it must never import.** Nothing is forbidden here, but keep assertions out — this
directory holds the machinery, not the tests. Unit tests are colocated (`src/**/*.test.ts`).

## `launch-electron.mjs` — the only correct way to start Electron in this repo

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
shares: it runs a caller's own graceful steps (e.g. `closeElectronApp` in `e2e-helpers.ts`
closing every tab first, working around `_electron`'s own `app.close()` hang), races
`app.close()` against `APP_CLOSE_RACE_MS`, then UNCONDITIONALLY SIGKILLs whatever is left of the
process tree (real Electron forks GPU/zygote/renderer helpers, so "the tree", not just the root
pid) and removes the temp profile -- in a `finally`, so a thrown graceful step or a hung
`app.close()` still leaves nothing on disk or in the process table. `assertNoElectronSurvivors()`
is the suite's own self-check: called once, in a file's top-level `afterAll`, it fails the run if
any pid the file has closed is still a live Electron process (resolved via `/proc/<pid>/exe`,
never a command-line match -- `pgrep -f node_modules/electron/dist/electron` matches its own
argv too).

`launch-electron-teardown.test.ts` unit-tests all of this against plain `node` child processes,
never a real Electron launch -- see its own header for exactly what that approach can and cannot
prove.

## Known risk

Spike gate 3 is **BLOCKED, not failed**: the app works, confirmed by a direct non-Playwright
launch, but Playwright's `_electron` driver could not attach to that window, for a cause still
unidentified ([`open-questions.md`](../docs/open-questions.md) C6). Build step 2's end-to-end
test uses the same driver. **Check this early**, not the day the test is due.
