---
name: "orivon-porting"
description: Use when porting a third-party Electron application to run as an Orivon app, when estimating whether a named app is portable at all before committing to it, when writing or reviewing an `apps/<app>/bridge/` file, when an app's own build config fights the port, or when deciding whether a missing power belongs in the per-app bridge, in `src/shim-*`, or in a new capability. Captures the method and the traps from the one completed port (`apps/freetube-real/`, upstream FreeTube unmodified) so the next port does not re-derive them.
---

# Porting a third-party Electron app to Orivon

**The deliverable is never a fork.** A port is a manifest, a build wrapper, a static server, and
one bridge file. The app's own source stays in its own clone, under its own licence, unmodified.
If you find yourself editing the app's source, stop and re-read *The escape test* below -- you are
either in the one case that genuinely requires it, or you have taken a shortcut that makes the
port unrepeatable against the app's next release.

`apps/freetube-real/` is the worked example. Every number in this page is measured there.

## Why an app needs a bridge at all

A desktop Electron app is two programs: a renderer (a web page) and a main process (privileged).
They meet at a **preload script** -- the only code that sees both Node and the page's `window`.
It publishes a hand-written object via `contextBridge.exposeInMainWorld('<name>', api)`, and the
page calls `window.<name>.<member>()`, which forwards over IPC to main.

Orivon takes main's place and grants powers to the page directly. The renderer bundle is kept; the
preload and main are dropped. But the bundle still *references* the names the preload defined, and
calling `undefined` throws.

So a port re-creates the **shape** the preload exposed, backed by `orivon.*` instead of IPC.

**It cannot be shared across apps.** The names are each app's own inventions with no standard
behind them -- only that app's source says what `chooseDefaultFolder` was meant to do. This is the
fourth adapter family in `app-compatibility.md`; families 1-3 (`node` stdlib, `electron` module,
web ecosystem) are shared code in `src/` and a port should push work into them wherever it fits.

**The seam is a process boundary, not a namespace.** `window.*` is only where it is visible,
because `exposeInMainWorld` is the one place a preload can put things. The test for any symbol is:
*is its definition in the bundle I am loading, or in the code I dropped?*

## Step 0 -- triage, before committing to an app

Five minutes, and it is the single question that separates a cheap port from an open-ended one.
Grep the app's preload for `exposeInMainWorld` and look at the object it passes:

- **Named members, one per distinct call** -- countable. Multiply by roughly six lines of code
  each and that is your bridge. FreeTube: ~41 members exposed, 34 actually called, 203 lines of
  code plus 132 of comment.
- **A generic forwarder** -- `invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)`.
  One member, and the real surface is invisible from the preload: it is every channel string main
  handles. Go count `ipcMain.handle` and `ipcMain.on` in the main process instead, and treat *that*
  as the member count.

The generic-forwarder shape is the one that can be hundreds. It is also the shape Electron's own
security guidance argues against, so a well-behaved app is usually the cheap one.

## Step 1 -- recon the renderer

Answer one question: **how much of the app is already a web page?** The commands that produced
the FreeTube recon, in order of what they settle:

```bash
CLONE=~/git/<app>-src
grep -rlE "require\(['\"]node:|from ['\"](fs|path|os|net|crypto|stream|zlib|util|events)" $CLONE/src/renderer | head
grep -rl "from 'electron'\|require('electron')" $CLONE/src/renderer | head
grep -rhoE '\bfetch\(' $CLONE/src/renderer | wc -l
grep -rn 'exposeInMainWorld' $CLONE/src/preload
grep -rhoE "window\.<bridgeName>\.[a-zA-Z]+" $CLONE/src/renderer | sort -u
grep -rc 'ipcMain\.handle\|ipcMain\.on' $CLONE/src/main
```

FreeTube's answers: **zero** Node builtins, **zero** `electron` imports, 32 `fetch` call sites, one
bridge, 34 called members, 25 handlers. A renderer that imports no Node and no `electron` gets
nothing from `src/shim-node/` or `src/shim-electron/` -- families 1 and 2 never reach it, and the
whole port is family 4 plus routed `fetch`.

**Note the trap:** the *better* an app follows Electron's security guidance (`contextIsolation`
plus a narrow preload), the *less* its renderer touches `electron` directly, and the more the port
concentrates in the bridge. A clean app is not a cheaper app -- it is a differently-shaped one.

**Write the recon down before writing code.** `docs/planning/freetube-port-recon.md` is the shape:
a table of facts with `file:line` evidence, a handler inventory grouped by what Orivon needs, and
an explicit verdict. It is what makes the cost estimable rather than open-ended.

## Step 2 -- enumerate the seam from two sources, and cross-check

Never trust one:

1. **The preload** (`exposeInMainWorld`'s object) gives names, arity, and async-ness -- an
   `ipcRenderer.invoke` member returns a promise, a `send` member does not.
2. **The renderer** (`grep -rhoE "window\.<name>\.[a-zA-Z]+" src/renderer | sort -u`) gives what is
   actually called.

Exposed-but-never-called members are free to skip. **Called-but-not-exposed is a hard error in your
own enumeration** -- find it before runtime does. Neither source is provably complete: computed
keys and `Object.assign` defeat static reading, so treat the union as a floor.

## Step 3 -- classify every member into five buckets

FreeTube's 34, as the baseline to expect:

| Bucket | Count | What it means |
|---|:--:|---|
| The browser already does it | 7 | fullscreen, PiP, zoom, wake lock, `navigator.language`. No capability at all |
| Inert | 19 | There is no second process left to sync with. Record the callback, never fire it |
| Refused by name | 5 | Excluded by decision, or shell-owned. Must throw with a reason, never be absent |
| Needs a capability | 2 | `orivon.fs` |
| Needs a capability | 1 | `orivon.web.context` (ADR-0019) |

**33 of 34 needed no capability Orivon did not already have.** A bridge is large because there are
names to route, not because there are things missing. Expect the same skew: most of a bigger app is
more inert members, which is volume, not difficulty.

**The bucket that actually costs you is none of these** -- it is a member with no capability
underneath *and* no honest refusal, e.g. one needing `session.webRequest`. One of those blocks a
port that 2,000 inert lines would not. Watch the capability ratio, not the line count.

## The escape test -- does the human-required fix stay in the bridge?

Most judgment calls are bridge-local and cheap to express. One class is not. The criterion:

**Does the value escape into app code?**

- **No** -- the app passes data in and gets back nothing, or something opaque. The bridge controls
  the whole exchange, so any decision can live inside `window.*`. FreeTube's downloads group is
  twelve lines: `chooseDefaultFolder` returns *nothing* and `writeToDefaultFolder` takes a *name*,
  so the folder handle never crosses into renderer code.
- **Yes** -- the app receives a value it then joins, parses, displays or stores. The bridge's
  control ends at `return`; it cannot reach the `path.join` three files later. This is the one case
  that forces app edits, and it breaks the unmodified-bundle property.

The canonical instance: `showOpenDialog` hands the renderer host path strings, while
`orivon.fs.userSelected` returns an opaque handle and never a path (A187). Code written in paths
cannot be translated -- it must be re-designed around the handle. **Do not "solve" this by
manufacturing a path-shaped string**; the shape exists to stop paths leaking, and faking one
reintroduces exactly what it prevents, silently, in a file that looks fine.

FreeTube needed zero app edits because its own preload API was already handle-shaped. That is luck,
not design. Check it per app, early -- it decides whether the port stays repeatable.

## Step 4 -- write the bridge

Conventions, all load-bearing, all visible in `apps/freetube-real/bridge/ft-electron-bridge.js`:

- **Lives in `apps/<app>/bridge/`, never in `src/`.** It is a consumer of `orivon.*`, not part of
  it. Anything general enough for `src/shim-electron/` belongs there instead -- whatever the shim
  covers, every future port gets free.
- **A classic, synchronous script, injected first in `<head>`.** Apps call bridge members at module
  top level, so it must already exist when the bundle's first line runs. Not a module: it has
  nothing to import, and it must not be deferred.
- **Refuse by name, never by absence.** A member Orivon cannot honour throws a named error with a
  machine-readable reason (`excluded`, `shell-owned`, `not-built`). An absent member produces
  `undefined is not a function` at a call site that explains nothing.
- **Group members into small factories** (`webPlatformApi()`, `playerCacheApi()`, `downloadApi(fs)`,
  `listenersApi()`), one per reason-for-existing, each with a header saying why the group is
  answered the way it is.
- **Each app stands alone.** Reproduce a pattern from a sibling port rather than importing it. Two
  ports sharing a file is two apps that break together.
- **The comments are the deliverable.** 132 of the file's 365 lines are comment, and that is
  correct: a generator can emit `isWaylandPlatform: () => false`, but only a person can write down
  that the app's own `DefinePlugin` compiles `process.platform` to `undefined`, so the guard around
  the one call site never fires. Follow `orivon-comments` for where rationale goes.

## Step 5 -- the build wrapper, and the two traps that cost the most

A port compiles the app's **Electron renderer** target, not its web target -- the web target is
usually the crippled one (upstream FreeTube strips its Local API for the web build precisely
because a browser cannot reach YouTube directly). Wrap the app's own config; never fork it.

Both of these were found by running the build and driving the result in a real window. Neither is
visible by reading source, and both fail without a useful error:

1. **An `IS_ELECTRON` flag can change what the app *fetches at runtime*, not just what it
   compiles.** FreeTube's i18n switches to `${locale}.json.br` under Electron, because upstream's
   own Electron config builds its locale plugin with `compress: true`. Reusing the web config with
   the flag flipped gives you the Electron code path against web assets: every locale 404s, the
   renderer never mounts, and there are **zero console errors** because the failing dispatch is
   never awaited. Patch the already-built plugin instance rather than forking the config, and teach
   the static server to serve a `.br` file on disk with `Content-Encoding: br`.
2. **A `CopyWebpackPlugin` pattern with an absolute `to:` ignores `output.path`.** Changing the
   output directory moves nothing that was written with `path.join(__dirname, '../dist/web/...')`.
   Two consequences: assets 404 in your build, and **the build writes into another target's
   `dist/`** -- which `parallel-work.md` forbids, because another agent's run may depend on it.
   Rewrite every pattern whose `to:` starts with the old prefix onto your own output path.

**The general lesson: run it, drive it, look at the window.** Both traps produced a blank page or a
silent 404, not a stack trace.

## Step 6 -- manifest, host, and consent

The app is served by a **plain static file server** reading files off disk. `prepare.mjs` copies
the build, drops `orivon.json` at `/.well-known/`, injects the `<link rel="orivon-manifest">`
discovery hint, and (on `--build`) inserts the bridge `<script>`. That is the entire integration.

**Grants attach to the URL, not to an install** -- consent is per-origin, read once on visit,
before any of the app's code runs. The manifest is what the consent dialog renders, so every
capability the bridge will reach for must be declared there and must read honestly to a person.

## Step 7 -- test the bridge, and the app

- **Unit-test every member**, including the inert and refused ones, against a fake
  `window`/`document`/`navigator`/`fetch`/`orivon`. Load the bridge's source into a fresh
  `node:vm` context per test -- it is a classic script with nothing to import.
- **`vitest.config.ts` does not include `apps/`** (its patterns are `src/**` and `scripts/**`), and
  naming a file on the command line does not help, because vitest filters *inside* its include
  pattern rather than widening it. Use a temporary config outside the repository:

  ```bash
  printf "export default { test: { environment: 'node', include: ['apps/<app>/**/*.test.ts'] } }\n" > /tmp/vitest.apps.mjs
  npx vitest run --config /tmp/vitest.apps.mjs --root .
  ```
- **End-to-end, assert the thing the app is for.** Metadata loading is not playback. Gate the
  expensive assertion on what the prepared build's own manifest declares, with an env override
  both ways.

## When to stop -- an app that is not a target

A bridge pushing `code-guidelines.md`'s 500-line limit is not a file problem. It is the app saying
it is deeply an Electron *program* rather than a web frontend over a narrow helper. The honest
answer then is "not a tier-2 target", not "write the lines". Say so, with the member count and the
capability ratio as the evidence.

**Scope discipline (Rule 4).** Tooling to generate bridges automatically is a real idea and is
already recorded as the third way to shrink the file in `app-compatibility.md`. It pays back at
app #3, which is also where the genericity test says the design gets measured. With one port
completed it is tooling for a sample of one.

What such a generator could and could not do, so the question does not get re-opened from scratch:
it **can** emit the member list, arity and a refuse-by-name stub from the preload AST cross-checked
against renderer call sites. It **cannot** decide semantics -- the preload is only a forwarder, and
the behaviour lives in arbitrary main-process Node that would have to be translated into a
deliberately *smaller* capability set. And it cannot be trusted to bind capabilities unattended:
its input is the app's own code, which is the untrusted party, so inferring a binding from it
automates away the exact step a person is there to perform.

## Reference: files this knowledge came from

| File | What it holds |
|---|---|
| `apps/freetube-real/README.md` | The worked port: three builds and what each answers, the build traps in full, playback evidence, the `web.context` spike |
| `apps/freetube-real/bridge/ft-electron-bridge.js` | The bridge itself -- refusal machinery, the five groups, the comments that carry the judgment |
| `apps/freetube-real/bridge/ft-electron-bridge.test.ts` | The `node:vm`-per-test pattern over a faked host |
| `apps/freetube-real/prepare.mjs` | Manifest drop, discovery hint, bridge injection, the `--build` path |
| `apps/freetube-real/webpack.orivon.config.cjs` | The wrapper, including both build-trap fixes |
| `docs/planning/freetube-port-recon.md` | The recon shape: evidence table, handler inventory, verdict |
| `docs/architecture/app-compatibility.md` | Why family 4 cannot be shared, the three ways to shrink it, the genericity test |
| `apps/freetube/` | An app written *for* Orivon -- the contrast case, and the source of patterns to reproduce |

**Licensing.** The app's source and build output stay in their own clone and out of this
repository. FreeTube is AGPL-3.0-or-later; check each target's licence before any file crosses in.
