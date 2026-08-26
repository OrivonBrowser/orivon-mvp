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

## Known risk

Spike gate 3 is **BLOCKED, not failed**: the app works, confirmed by a direct non-Playwright
launch, but Playwright's `_electron` driver could not attach to that window, for a cause still
unidentified ([`open-questions.md`](../docs/open-questions.md) C6). Build step 2's end-to-end
test uses the same driver. **Check this early**, not the day the test is due.
