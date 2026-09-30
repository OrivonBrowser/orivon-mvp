---
name: "orivon-qa"
description: Use after changing the shell UI, a user flow, or code that touches the broker, IPC, preload, natives, the filesystem or the network; before calling any such change done; when an e2e spec fails and you need its evidence; when a screenshot has to be read against what it should show; and when a visual baseline mismatches. Holds which QA to run after which change, how to read a failure, the fix loop, and the rules that stop a check being weakened to pass.
---

# Orivon QA: running the real shell, reading what it shows, fixing what is wrong

The shell is driven through its real UI by the Electron e2e suite (Playwright's `_electron`
library, run by Vitest). This skill is the loop around it. Mechanics and layout are in
`docs/development/testing.md` §Visual QA and failure evidence; launch hygiene (headless only, no
window on the owner's screen, silent audio) is in `orivon-electron` and CLAUDE.md §Local quirks.

## Commands

| Command | Runs | Use |
|---|---|---|
| `npm run qa` | the QA specs below, then `qa:report` | before calling a UI, flow or boundary change done |
| `npm run qa:visual` | layout-audit proof, unit tests of the pixel tools, the shell-state specs | after any change to what the shell draws |
| `npm run qa:report` | writes `qa-artifacts/latest/inspect.md` | to read states against expectations |
| `npm run test:e2e` | every e2e spec, each leaving evidence on failure | before a PR that touches `src/main/`, `src/preload/`, `src/renderer/` |
| `npm run smoke` | the real shell once, JSON failure list | when `src/main/` changed |

One spec: `node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/<file> -t "<name>"`
(after `node scripts/build-e2e.mjs`). Never launch Electron any other way.

| Spec | Proves |
|---|---|
| `e2e-qa-audit` | each layout-audit rule fires on a page broken on purpose and none on a clean page |
| `e2e-qa-visual` | eleven shell states: audit clean, no shell errors, painted, baseline match, record for reading |
| `e2e-qa-journey` | star a bookmark, see it on disk, relaunch on the same profile, unstar, relaunch again |
| `e2e-qa-adversarial` | corrupt profile files, tab churn, a killed renderer, an abandoned load |
| `e2e-qa-evidence` | the failure bundle holds console, page errors, failed requests, a dead renderer, main log, real pixels |

## Which QA after which change

1. **Look first.** Open the specs for the area (`ls test/e2e-*`, grep the flow) before changing behaviour.
   An existing spec is the statement of what the flow must do.
2. **UI change** (`src/renderer/`, popups, internal pages): `npm run qa:visual`, then read the
   screenshots (below). A baseline mismatch after an intended change is expected: look at the new
   PNG and the diff, then re-record.
3. **Flow change** (tabs, navigation, bookmarks, settings, profiles): the matching `e2e-*` spec
   plus `e2e-qa-journey` and `e2e-qa-adversarial`.
4. **Boundary change** (broker, IPC, preload, natives, filesystem, network, grants): the capability
   specs (`e2e-capability-boundary`, `e2e-udp-capability`, `e2e-loopback-grant`, `e2e-connect-secure-capability`
   and the ones for what you touched), then `e2e-qa-adversarial`. Never relax a boundary to make a
   test pass; if the test is wrong, say why in the change.
5. **Before done**: `npm run qa`, then the full `npm run test:e2e` for anything in 3 or 4. Compiling is not done.

## Reading a failure

A failed spec leaves `qa-artifacts/latest/<spec>/<test>/`, linked from `qa-artifacts/latest/index.md`
(CI uploads the same folder). Start at `summary.md`, then in this order:

1. `launch-N/screenshots/window-0-composite.png`: the whole window as the person saw it.
2. `launch-N/aria/*.txt`: what each page exposed; an empty tree is a blank page.
3. `console.json`, `page-errors.json`, `failed-requests.json`: what each page logged, threw, could not fetch.
4. `main.log`, `main-events.json`: the main process's output; `render-process-gone` and `child-process-gone`.
5. `crashes.json`; `trace.zip` when the run had `ORIVON_QA_TRACE=1` (`npx playwright show-trace`).

Hidden tabs have an ARIA tree and DOM but no screenshot: a hidden view cannot paint.

## The fix loop

```
run -> fail -> read the evidence -> classify -> (real bug) smallest safe fix
    -> the targeted spec -> the related specs -> the full relevant suite
```

Classify before touching anything:

- **Real bug**: the product broke its own stated rule. Fix it, and add a regression test in the same
  change (an assertion in a spec that would have failed before).
- **Wrong expectation**: the product is right and the test was not. Change the test only after
  finding the requirement in the code, `docs/`, or surrounding behaviour; say which in the change.
- **Flaky**: it passes and fails on the same code. Find the race (an unwaited state, an absence
  polled instead of settled, a port clash) and wait on the state. Retries are off; do not add one.
- **Environment**: a leftover process, a held port (`ss -ltn`), a stale build (`node scripts/build-e2e.mjs`).
- **Cannot tell**: mark it `needs-human-review`. File it in `docs/open-questions.md` if it is a
  contradiction (CLAUDE.md Rule 3). Never invent an explanation.

## Reading screenshots

`npm run qa:visual && npm run qa:report`, then for each entry in `qa-artifacts/latest/inspect.md`:
`Read` its PNG, compare it with the **Expected** line and the recorded audit, errors and baseline, and
fill the **Verdict**: `expected-variation`, `harmless`, `defect`, `functional-bug` or `needs-human-review`.

- A state passes on **positive evidence** that what Expected describes is on screen. "It did not crash"
  and "the audit is clean" are not evidence; a wrong page can be clean.
- Name what is wrong in words a newcomer could act on: where, what it should be, what it is.
- Check whether a finding is yours before filing it. A grey rectangle that turned out to be the
  capture's own gap filler cost a false product bug once: read the DOM and the code first.
- A design call you cannot settle from pixels (is this overlap intended?) is `needs-human-review`.

## Baselines

Pixel baselines are machine-local, in `$XDG_CACHE_HOME/orivon-qa/baselines/<platform>/` (or
`ORIVON_QA_BASELINES`), shared by every worktree on the machine and never committed. Only `npm run qa`
and `qa:visual` compare (they set `ORIVON_QA_PIXELS=1`); a plain `test:e2e` and `CI=true` skip it, because a
baseline only means something on the machine and fonts that made it. The first run records;
`ORIVON_QA_UPDATE_BASELINES=1` re-records. The tolerance is 0.005% of the window
(about 50 pixels): measured, an unchanged state differs by 0.000% and a one-pixel font change by
0.02% or more. Do not loosen it; mask a region that legitimately changes (`ignore`) instead.

## Rules

- **Never weaken a check to pass.** No dropped assertion, looser tolerance, added retry or
  `skip` to get green. An allowlisted audit finding needs a `reason` that says why it is intended.
- **Never touch a production security switch for a test.** Sandbox, CSP, session partitions,
  `nodeIntegration`, the dev-grant hook's absence from ordinary builds (`check:dev-grant-absent`).
- **Wait on state, never on the clock.** A refusal or removal is an absence and cannot be polled for:
  wait for a positive signal, settle (`ABSENCE_SETTLE_MS`), then read once.
- **Every real bug fixed gets a regression test.**
- **A check must be shown to fail.** When you add one, break the thing it guards and watch it go red,
  then restore. `e2e-qa-audit` and the bookmark journey were built this way.
- **Nothing on the owner's screen or speakers.** Launch only through `scripts/run-headless.mjs`.
- **Port clashes are real here**: other processes hold fixed ports on this machine. New specs use
  port 0 (`qa-helpers.ts` `startServer`); check `ss -ltn` before an e2e run.

## Invariants the suite must keep true

These come from `docs/development/testing.md` and the security model; a failure on one is a real bug
until shown otherwise.

- A capability is checked at the call site against what was **granted**, not what the manifest asks for.
- An `fs` path outside its root is refused; an origin derives to one identity.
- A scheme the address bar should refuse never navigates; the address bar never names a page the tab is not on.
- A tab page reaches no Node, no `require`, no `process`.
- Every launch uses a fresh profile; no spec touches the real one. Closing leaves no process behind.
- The tab strip and the main process agree on which tabs exist; one dead renderer takes nothing else with it.
- A damaged profile file never stops the shell from starting.

## Known limits

- Native consent dialogs (`dialog.showMessageBox`) are not web views: specs replace them and assert
  the text, and the screenshots cannot show them.
- `capturePage()` fails under this machine's GPU-less xvfb; screenshots go through Playwright's own
  capture of each view, which works, and the window composite pairs views to pages by URL then size.
- An uncaught exception in the main process raises a blocking error dialog, so no spec provokes one.
- A control hidden by `opacity` is not audited: hover-revealed buttons make that mostly intended.
- Malformed calls to `window.orivon.*` from a page are not yet covered; they need the page-script
  and dev-grant machinery of `e2e-capability-boundary`.
