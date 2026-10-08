# `scripts/ci/`

How CI decides which end-to-end specs to run and how it splits them, and how to run Orivon on Windows and macOS
from any machine. Each script is an exported pure function
with a CLI block, unit tested in `tests/`; they import `node:*` and sibling guard scripts, nothing from `src/`.

| Script | Does |
|---|---|
| `select-e2e.mjs` | Prints a plan: `none`, `impacted` (the specs the changed files reach) or `full`, and the shards. The `scope` job of `ci.yml` runs it with the event, the base ref and the labels. Run it yourself to see what CI would run for your branch: `node scripts/ci/select-e2e.mjs --base origin/main` (`--explain` lists each changed file's rule, `--json` the shards). It enforces nothing |
| `check-impact-map.mjs` | The guard behind `npm run check:impact-map`: every directory directly under `src/` and `src/main/` has a rule in `test/impact-map.json`, every rule names real areas and matches real files, every area folder of `test/` has a rule for edits to its own specs |
| `refresh-weights.mjs` | Rewrites `test/spec-weights.json` (seconds per spec file) from the log of a CI e2e job: `gh api repos/<owner>/<repo>/actions/jobs/<job id>/logs \| node scripts/ci/refresh-weights.mjs`. The weights only balance the shards |
| `cross-os.mjs` | Starts `.github/workflows/cross-os.yml` (or `release.yml` with `--packaged`) on the pushed branch, waits, downloads what each system saw and prints a summary (section Other systems). Its `--matrix` mode is the workflow's own list of systems |
| `live-session.mjs` | Starts `.github/workflows/live-session.yml` and drives Orivon on one runner step by step from a terminal (section Live sessions) |
| `live-host.mjs` | The runner's side of a live session: launches Orivon, runs the caller's Playwright code, opens the tunnel |

## The rules

| Event | e2e |
|---|---|
| push to `main`, the nightly run, the `ci:e2e-full` label, a dispatch with `areas=all` | every spec |
| a pull request from this repository | the specs its changed files reach |
| a pull request from a fork | none, until a maintainer adds the `ci:e2e` label; then as above |
| only documentation, devlog, history or unit-test files changed | none |
| a changed file the map does not know, or one that wires everything | every spec |

`test/impact-map.json` holds the rules. The most specific prefix wins; `*` at the end of a prefix is a name
prefix. A rule runs `@core` (the app core: every spec the catalogue names as proof, plus `capabilities`,
`app-loading`, `node-runtime` and the adversarial QA spec), `@full`, or area folders of `test/`. The broker,
contracts, preload, loader and shim map to the app core, so a change there always runs every proof of what an
app relies on. A new `src/` directory fails `check:impact-map` until it has a rule.

## Shards

The selected specs are packed, longest first, onto the lightest of at most ten shards of about four minutes each
(`TARGET_SECONDS`, `MAX_SHARDS` in `select-e2e.mjs`), by the weights in `test/spec-weights.json`; a file with no
weight counts as the median. Each shard runs on its own runner. Refresh the weights when the suite's shape
changes enough that shards drift well apart.

## Other systems

[`cross-os.yml`](../../.github/workflows/cross-os.yml) runs Orivon from source on GitHub's Windows and macOS runners,
the way a person on that system runs it: `npm ci`, whose `postinstall` runs the Rule 8 guard over that system's own
dependency tree, the build `npm start` makes, `smoke`, then e2e specs, by default the QA
states spec, which saves a screenshot of every state it reaches. It runs every night on `main`, on a pull request that
changes the install, the launch scripts, `package.json` or `src/main/os/` (install and `smoke` only), and on demand:

```bash
git push                                         # the runners test the branch as it is on GitHub
node scripts/ci/cross-os.mjs                     # Windows and macOS, smoke and the QA states
node scripts/ci/cross-os.mjs --systems windows --specs "test/window/e2e-launch.test.ts"
node scripts/ci/cross-os.mjs --specs none        # install, build and smoke only
node scripts/ci/cross-os.mjs --packaged          # release.yml: build, install and launch each package
node scripts/ci/cross-os.mjs --run latest        # read main's last nightly run, start nothing
```

It polls quietly, so it can run in the background; a run takes about five minutes. The summary names each failed step
and smoke check; the evidence lands in `qa-artifacts/cross-os/<run id>/<system>/`: `smoke.out`, `install.log`, the
failed job's `job.log`, and `qa-artifacts/latest/` with the screenshots and `inspect.md`, read as the `orivon-qa`
skill says. Pixel baselines are never compared there (`CI=true`): read the screenshots, do not diff them.

### Live sessions

When one run's screenshots do not settle a question, [`live-session.yml`](../../.github/workflows/live-session.yml)
keeps Orivon running on one runner and takes Playwright code from a terminal one call at a time, as a local e2e
session does:

```bash
git push                                                   # a branch, never main: the runner builds it as it is on GitHub
node scripts/ci/live-session.mjs start --system windows    # about five minutes; says when it is live
node scripts/ci/live-session.mjs eval --system windows "app.windows().map((p) => p.url())"
node scripts/ci/live-session.mjs eval --system windows --file probe.js --timeout 120000
node scripts/ci/live-session.mjs shot --system windows     # the whole screen; `shot <url part>` for one view
node scripts/ci/live-session.mjs log --system windows      # the main process's last 300 lines
node scripts/ci/live-session.mjs restart --system windows  # a fresh launch; --options '<launchElectron options>'
node scripts/ci/live-session.mjs status                    # every session this machine started
node scripts/ci/live-session.mjs stop --system windows
```

The code is the body of an async function that sees `app` (Playwright's `ElectronApplication`), `chrome` (the
shell's page), `page(urlPart)`, `shot(target, name)`, `log(...)` and `helpers` (`test/support/smoke-helpers.mjs`); a
lone expression is returned. One call runs at most 90 seconds, because Cloudflare ends a response at 100; split
longer work into several calls, which run one at a time. Pictures land in `qa-artifacts/live/<run id>/`. The runner
is reached through a Cloudflare quick tunnel. It is given only the SHA-256 of a token made on the caller's machine
and kept in `qa-artifacts/live/<system>.json`, and it refuses every request without that token. Whatever the session
prints, Orivon's own log included, is uploaded with the run's evidence, which anyone can read. A session ends on
`stop`, after `--minutes` (60 by default, at most 300), or after 20 minutes without a request. A pull request that
changes the live session's files starts one on each system and drives it once through the tunnel.

