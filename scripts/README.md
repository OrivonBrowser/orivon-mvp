# `scripts/` — build and CI guards

**What lives here.** Standalone Node scripts run by `package.json` and by CI. Each guard is an
exported pure function over a root directory, plus a CLI block — so it is unit testable without
running the build.

`smoke.mjs` is the exception to that shape and to this directory's theme: it is the **shell's**
regression check, not a guard, it drives a real Electron app, and it is owned by the `shell`
stream rather than `packaging` ([`parallel-work.md`](../docs/development/parallel-work.md)).
It lives here because `npm run smoke` is where people look for it.

**What it depends on.** `node:*` builtins — plus, for `smoke.mjs` and `perf-probe.mjs` only, `playwright` via
[`test/support/launch-electron.mjs`](../test/support/launch-electron.mjs), and, for `install-electron.mjs`
only, the `electron` package's own `install.js`.

**What it must never import.** Anything under [`src/`](../src/). A guard that depended on the
code it guards could be disabled by the change it exists to catch.

| Script | Enforces |
|---|---|
| `check-no-native-modules.mjs` | **Rule 8.** No dependency may require a compiler at install time. Runs on `postinstall`, so it fires on every `npm install` |
| `check-contracts-pure.mjs` | `src/contracts/` is complete and references nothing outside itself |
| `check-no-secrets.mjs` | No credentials in git-tracked files |
| `check-vectors.mjs` | The golden derivation table `src/broker/policy/derive-vectors.json` matches an independent `node:crypto` implementation. A verifier: no mode writes the table |
| `check-manifest-parity.mjs` | Every field `src/contracts/manifest.ts` declares is in the loader's manifest allowlist, and the allowlist names no field the contract lacks. Both sides are read from their source text |
| `check-dev-grant-absent.mjs` | The developer-only grant path is absent from `out/` as it stands and from a fresh ordinary build, so only the e2e build carries it |
| `check-advisories.mjs` | No dependency carries a high or critical advisory; a registry that cannot be reached fails the run rather than passing it |
| `check-size.mjs` | **Rule 2.** No source file over 500 lines, no test file over 800. CI runs it in the `check` job |
| `check-comments.mjs` | **Rule 1.** No source file opens with more than 25 lines of comment, and no comment block in `.github/workflows/*.yml` or a root `*.config.ts` runs over 10 lines. `--exemptions` lists every file that opted out and why |
| `check-page-globals.mjs` | **ADR-0021.** A global Orivon installs on an app's window carries the platform's own descriptor, so an app can replace it. Reads an omitted `writable` as the lock it is; `// orivon:locked-global -- <why>` opts one out |
| `check-native-dialogs.mjs` | A question to the person is asked through `askQuestion`, in the tab's own window. Fails on `dialog.showMessageBox`, `showMessageBoxSync` or `showErrorBox` in `src/` (bracket, destructured and aliased forms included) outside the question panel's fallback and the start-up failure box; the OS file pickers are not matched |
| `check-questions.mjs` | No question ID is used twice across `docs/open-questions.md` and `docs/decisions/resolved-questions.md`, and no open entry runs past 12 lines |
| `check-devlog.mjs` | No devlog bullet over 25 words (`.claude/commands/devlog.md` rule C), in the journal and in every update compiled since that rule |
| [`app-behaviours/`](app-behaviours/README.md) | **Not one script:** the two guards of the app-behaviour suite, `check-app-behaviours.mjs` (catalogue, specs and capability coverage agree; a changed row needs a changelog record) and `check-contracts-surface.mjs` (the snapshot of `src/contracts/`), with their tests |
| `check-test-paths.mjs` | Every `test/...` path a tracked file names exists (a spec, a helper, a folder, a glob that matches something, a `../test/` link that resolves from its own folder), so a moved spec cannot leave a dead mention. History (CHANGELOG, decisions, devlog, most of `docs/planning/`) is exempt |
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
