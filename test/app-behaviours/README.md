# `test/app-behaviours/`: what an app relies on

An app that runs on Orivon counts on behaviours the browser keeps: its stored data survives a restart, a
`*:*` grant never reaches loopback, a second tab waits for a Web Lock. This folder is where those are
written down and proven, so that a change anywhere, `src/broker/` included, that breaks a working app fails a
test whose title names the behaviour.

| File | Role |
|---|---|
| [`catalogue.md`](catalogue.md) | One row per behaviour: id, the sentence, who relies on it, and the end-to-end spec that proves it. Ends with the **Capability coverage** table, one line per capability kind |
| `e2e-app-*.test.ts` | Generic specs for what no other area proves: stored data across a restart, the page platform on an app origin, the broker's TCP, quota, path and TLS rules, an app's camera, microphone and screen |
| `app-behaviour-support.ts` | The helper they share: a loopback server on port 0, the developer-only grant, a page call that `window.orivon` answers |
| `contracts-surface.txt` | `src/contracts/` without its comments: every export, capability kind, error code and `LIMITS` value an app can write against |
| [`../../scripts/app-behaviours/`](../../scripts/app-behaviours/README.md) | The two guards that keep all of this true, and their tests |

Specs that prove a row but belong to another area (`app-loading/`, `sites/`, `node-runtime/`, ...) stay in that
area. The catalogue links them, and each carries `[app:<id>]` in the title of the test that proves the row.

## When a row and a spec are required

| You are... | Then |
|---|---|
| **Adding a capability kind** or an `orivon.*` member (`src/contracts/`, `src/broker/`) | Add its line under **Capability coverage**, and a row for each thing an app can now count on, each with a spec. CI fails a kind with no line. The contract change also changes `contracts-surface.txt` and needs a *Changed for apps* line |
| **Porting an app** (`../orivon-ports`, its porting guide Step 7) | List what the app relies on and look each up here. A gap the port finds is fixed generically in Orivon, never patched in the port. A behaviour with no proven row is a row and a spec in this folder, or `not covered: <reason>`; never a spec that names the app |
| **Fixing a bug an app reported** | The fix comes with a row and a spec that fail without it |
| **Changing or removing a row's sentence**, or downgrading a row to `not covered` | Edit the row and add a line under `### Changed for apps` in `CHANGELOG.md`: the id, what apps must now do, which ports to recheck. CI fails the pull request without it |
| **Changing `src/contracts/`** | `node scripts/app-behaviours/check-contracts-surface.mjs --update`, and a *Changed for apps* line naming `` `contracts/<file>` `` |

## Adding a row

1. State the behaviour generically and observably ("data an app writes to IndexedDB survives a browser
   restart"), never as one app's feature. The title and the file name carry the behaviour; the app
   that inspired the row is named, if at all, in a code comment ([`CLAUDE.md`](../../CLAUDE.md) Rule 20).
2. Find the e2e spec that proves it through the real shell (page, preload, IPC, broker, network or disk). A
   unit test may be listed beside it but never proves a row alone: it exercises a function in isolation,
   cannot see a wiring that broke, and is edited in the same pull request as the code it tests. Where no spec
   exists, write a small generic one here: the smallest page that shows the behaviour, loopback only,
   `startAppServer` on port 0, several behaviours to one launch, waiting on state and never on the clock, no
   app name and no copied app code.
3. Put `[app:<id>]` in the title of the `it` that proves it, as a plain string (several ids may share a title).
   It carries no modifier, except `skipIf(!ORDINARY_BUILD)` for a spec that needs the build without the
   developer-only hooks; that spec must then be listed in the `e2e-ordinary` job of `ci.yml`. A skipped,
   narrowed or interpolated test proves nothing, so the guard refuses it.
4. Watch it fail: break the behaviour in the code, see the test go red, restore it. Say so in the pull request.
5. Add the row, or `not covered: <reason>`; the reason is the debt.

## A failing `[app:<id>]` test

An app that relies on that behaviour is broken. Read the row, which names the apps and ports, then either fix
the change or change the behaviour on purpose with the record above. Never edit the test until it passes, and
never skip it.

## Commands

```
npm run check:app-behaviours       rows, specs, markers and capability coverage agree
npm run check:contracts-surface    the snapshot matches src/contracts/
node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/
```

The specs need the e2e build (`node scripts/build-e2e.mjs`). Launch Electron only through the headless runner.
