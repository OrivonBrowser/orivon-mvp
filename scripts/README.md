# `scripts/` — build and CI guards

**What lives here.** Standalone Node scripts run by `package.json` and by CI. Each guard is an
exported pure function over a root directory, plus a CLI block — so it is unit testable without
running the build.

`smoke.mjs` is the exception to that shape and to this directory's theme: it is the **shell's**
regression check, not a guard, it drives a real Electron app, and it is owned by the `shell`
stream rather than `packaging` ([`parallel-work.md`](../docs/development/parallel-work.md)).
It lives here because `npm run smoke` is where people look for it.

**What it depends on.** `node:*` builtins — plus, for `smoke.mjs` and `perf-probe.mjs` only, `playwright` via
[`test/launch-electron.mjs`](../test/launch-electron.mjs), and, for `install-electron.mjs`
only, the `electron` package's own `install.js`.

**What it must never import.** Anything under [`src/`](../src/). A guard that depended on the
code it guards could be disabled by the change it exists to catch.

| Script | Enforces |
|---|---|
| `check-no-native-modules.mjs` | **Rule 8.** No dependency may require a compiler at install time. Runs on `postinstall`, so it fires on every `npm install` |
| `check-contracts-pure.mjs` | `src/contracts/` is complete and references nothing outside itself |
| `check-no-secrets.mjs` | No credentials in git-tracked files |
| `check-size.mjs` | **Rule 2.** No source file over 500 lines, no test file over 800. Not wired into `postinstall` or CI -- code-guidelines.md's own §Status leaves that to the owner |
| `check-comments.mjs` | **Rule 1.** No source file opens with more than 25 lines of comment, and no comment block in `.github/workflows/*.yml` or a root `*.config.ts` runs over 10 lines. `--exemptions` lists every file that opted out and why |
| `check-page-globals.mjs` | **ADR-0021.** A global Orivon installs on an app's window carries the platform's own descriptor, so an app can replace it. Reads an omitted `writable` as the lock it is; `// orivon:locked-global -- <why>` opts one out |
| `check-native-dialogs.mjs` | A question to the person is asked through `askQuestion`, in the tab's own window. Fails on `dialog.showMessageBox`, `showMessageBoxSync` or `showErrorBox` in `src/` (bracket, destructured and aliased forms included) outside the question panel's fallback and the start-up failure box; the OS file pickers are not matched |
| `check-questions.mjs` | No question ID is used twice across `docs/open-questions.md` and `docs/decisions/resolved-questions.md`, and no open entry runs past 12 lines |
| `check-devlog.mjs` | No devlog bullet over 25 words (`.claude/commands/devlog.md` rule C), in the journal and in every update compiled since that rule |
| `worktree-gc.mjs` | **Not a guard.** Lists linked worktrees whose branch is merged into `origin/main`; `--remove` removes the clean ones (CLAUDE.md Rule 10) |
| `install-electron.mjs` | **Not a guard.** Fetches Electron's binary on `postinstall`, because electron 44 no longer ships a postinstall hook of its own and electron-vite fails with a bare `Electron uninstall` without it. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` opts out; `npm run install:electron` re-runs it alone |
| `smoke.mjs` | The shell actually launches and works, driven with real clicks |
| `probe-view-visibility.mjs` | **Not a guard.** Every view that is on screen is shown: launches the built shell with a debugger on its main process only (no Playwright, which would keep every page visible), switches, splits, sleeps, moves and opens panels, and reads each view's `visibilityState` and a `requestAnimationFrame` round trip. Exit 1 names the steps that left a view hidden |
| `perf-probe.mjs` | **Not a guard.** `npm run perf:probe`: per-process CPU and memory of the built app through fixed scenes (idle, 10 and 31 tabs, a retitling tab, a 300-image load), for comparing a hot-path change before and after. Linux only; loopback only unless `--light-client` |
| `devlog-cron.sh` | The Sunday devlog job |

**Reading `npm run smoke` output:** it prints a JSON result and a failure list. **Read those,
not the exit code alone.** That holds even when it breaks — a thrown error becomes a failed
check rather than replacing the output, and every click is bounded, so a broken run still names
what broke instead of dying with a bare stack trace.

**`npm run smoke` needs no network, and cannot use one.** It launches Electron with
`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`: nothing but loopback resolves. So it
passes air-gapped, nothing leaves the machine, and a change that made it depend on the network
fails loudly here rather than quietly phoning out. If you are tempted to let it reach the real
network, read the comment above the search check first: the address bar shows the *requested*
URL whether or not the load succeeded, so a round trip adds no coverage there and hands a third
party a veto over the build.

**Before changing a check in `smoke.mjs`, read the three rules in its header.** They are short,
each was learned by getting it wrong, and the second one — never wait for a condition the
pre-action state already satisfies — silently turned two checks into no-ops that reported green
while the regressions they existed to catch were present.
