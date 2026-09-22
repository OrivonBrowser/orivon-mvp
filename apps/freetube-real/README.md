# `apps/freetube-real/`: upstream FreeTube, unmodified, as an Orivon app

**What lives here.** A manifest, a prepare/build step, a plain static server, and the bridge that
lets upstream's own **Electron renderer** run as an Orivon app: a manifest, a webpack config that
compiles that renderer instead of the browser build, and `window.ftElectron` rebuilt over
`orivon.*`. **No FreeTube source and no FreeTube build output is in this repository** -- it is
AGPL-3.0-or-later and it stays in its own clone (`~/git/freetube-src` below).

**What this answers, that [`../freetube/`](../freetube/) cannot.** That directory is an app
written for Orivon. This one is somebody else's real application, built by its own toolchain,
with the manifest, the discovery hint, and (for the Electron build) a bridge script added and
**nothing else changed**. It measures how much of a third-party app works when the only thing
done for it is granting its URL the network and standing in for the Electron main process it
expects.

| File | What it is |
|---|---|
| [`orivon.json`](orivon.json) | The manifest, including `web.contexts: ["https://www.youtube.com"]` (ADR-0019) -- see [How `generatePoToken` uses `web.context`](#how-generatepotoken-uses-webcontext) |
| [`prepare.mjs`](prepare.mjs) | Turns a build into an Orivon app (manifest + discovery hint), and (`--build`) runs the Electron-renderer build itself first |
| [`serve.mjs`](serve.mjs) | A plain static file server. Also decodes a pre-compressed `.br` asset via `Content-Encoding`, which upstream's own Electron build relies on -- see below |
| [`webpack.orivon.config.cjs`](webpack.orivon.config.cjs) | Our own build wrapper, moved out of the clone's untracked `_scripts/webpack.web-localapi.config.js` |
| [`webpack.orivon-datastore.config.cjs`](webpack.orivon-datastore.config.cjs) | Compiles upstream's own main-process datastore code (nedb) to run in the page -- see [Storage](#storage-nedb-files-under-orivons-fs-not-indexeddb) |
| [`build-shim.mjs`](build-shim.mjs) | Pre-compiles the one `src/shim/` module the datastore bundle needs (`node-fs.ts`) into plain JS with esbuild, since the datastore bundle's own webpack has no TypeScript loader |
| [`bridge/ft-datastore-entry.js`](bridge/ft-datastore-entry.js) | The datastore bundle's own entry point -- exposes upstream's datastore handlers on `globalThis.__orivonFtDatastore` |
| [`bridge/ft-electron-bridge.js`](bridge/ft-electron-bridge.js) | `window.ftElectron`, 34 members upstream's renderer calls, rebuilt over `orivon.*`, plus a splice point for the six `db*` members below |
| [`bridge/ft-electron-bridge-db.js`](bridge/ft-electron-bridge-db.js) | The six `db*` members (`dbSettings`, `dbHistory`, `dbProfiles`, `dbPlaylists`, `dbSearchHistory`, `dbSubscriptionCache`), spliced into the served script above by `bridge/splice-bridge-source.mjs` |
| [`bridge/ft-electron-bridge.test.ts`](bridge/ft-electron-bridge.test.ts) | Unit coverage for the original 34 -- see [Testing the bridge](#testing-the-bridge) for how to run it |
| [`bridge/ft-electron-bridge-db.test.ts`](bridge/ft-electron-bridge-db.test.ts) | Unit coverage for the six `db*` members and every one of their actions |

## Setting it up

```bash
git clone --depth 1 https://github.com/FreeTubeApp/FreeTube.git ~/git/freetube-src
cd ~/git/freetube-src && pnpm install && pnpm run pack:web
cd -   # back to this repo
node apps/freetube-real/prepare.mjs
node apps/freetube-real/serve.mjs      # http://127.0.0.1:8875
```

Then `npm run dev` in another terminal, navigate to `http://127.0.0.1:8875`, and accept the
prompt. `prepare.mjs` copies the build, injects `<link rel="orivon-manifest">` into `index.html`
and drops [`orivon.json`](orivon.json) at `/.well-known/`. The server reads files off disk and
does nothing else (plus, for a `.br` asset, sets `Content-Encoding` -- still just describing what
is already on disk, not transforming it).

## Three builds, because they answer different questions

| Build | What it is | Backend | PoToken |
|---|---|---|---|
| `dist/orivon-web` | `pnpm run pack:web`, verbatim | **Invidious only** | n/a (no Local API) |
| `dist/orivon-web-localapi` | the same build with the Local API left in | YouTube directly, via `youtubei.js` | silently absent; metadata still loads, playback does not (see below) |
| `dist/orivon-electron` | upstream's **Electron renderer**, `window.ftElectron` rebuilt over `orivon.*` | YouTube directly | real, minted through `orivon.web.openContext` (ADR-0019); metadata loads and playback works (see below) |

**Upstream compiles the web target with `SUPPORTS_LOCAL_API: false` and `externals:
{'youtubei.js': '{}'}`** -- the Local API is stripped, because a browser cannot reach YouTube
directly: CORS refuses the origin and the request needs headers a page is forbidden to set. That
is the exact wall Orivon removes, so the second and third builds ask what removing it buys.

### `dist/orivon-web-localapi`: the web build, Local API left in

A config-level change (`_scripts/webpack.web-localapi.config.js` in the clone, which requires
upstream's own config and flips two settings), not a fork:

```bash
cd ~/git/freetube-src && npx webpack --mode=production --config-node-env=production \
  --config _scripts/webpack.web-localapi.config.js
cd - && node apps/freetube-real/prepare.mjs --out ~/git/freetube-src/dist/orivon-web-localapi
node apps/freetube-real/serve.mjs --root ~/git/freetube-src/dist/orivon-web-localapi
```

### `dist/orivon-electron`: upstream's own Electron renderer

Why this build exists rather than stopping at the one above: the web build compiles
`IS_ELECTRON` to `false`, and that removes the only code path that mints a PoToken
(`src/renderer/helpers/api/local.js`'s `window.ftElectron.generatePoToken`) -- without one,
YouTube's SABR stream cannot start. Compiling with `IS_ELECTRON: true` restores that path and
makes the renderer call `window.ftElectron.*` for everything privileged, which is what
`bridge/ft-electron-bridge.js` supplies. This is **still the same renderer source FreeTube ships
in its desktop app** -- nothing here is a fork.

```bash
node apps/freetube-real/prepare.mjs --build --clone ~/git/freetube-src
node apps/freetube-real/serve.mjs --root ~/git/freetube-src/dist/orivon-electron --port 8876
```

`--build` runs, inside the clone and under its own lock: `webpack.orivon.config.cjs` (which
requires the clone's own `_scripts/webpack.web.config.js` and patches it, never forks it) into
`dist/orivon-electron-web`, then `pnpm run pack:botGuardScript` for `dist/botGuardScript.js`. It
then does what the plain `prepare.mjs` above does, plus: injects
`<script src="/orivon/ft-electron-bridge.js">` as the first script in `<head>` (classic,
synchronous, so it exists before FreeTube's own bundle -- `src/renderer/main.js` calls
`window.ftElectron.handleChangeView` at module top level), and copies `bridge/ft-electron-bridge.js`
and `botGuardScript.js` under `dist/orivon-electron/orivon/`.

`webpack.orivon.config.cjs` changes exactly four things in upstream's own web config, each guarded
by an assertion that fails loudly if upstream's config shape changes: `SUPPORTS_LOCAL_API` and
`IS_ELECTRON` true in the one `DefinePlugin`; `externals` deleted (so `youtubei.js` is bundled);
the same Node-builtin `resolve.fallback` list the web-localapi wrapper already uses; and two fixes
the plain "flip two defines" approach does not mention, both found by actually running the build
end to end rather than assumed from reading the source -- see
[What running the build found wrong with that plan](#what-running-the-build-found-wrong-with-that-plan).

The entry list stays upstream's single `main.js`, with no `orivon-sig-eval.js` added: with
`IS_ELECTRON` true, `local.js`'s own branch posts to `#sigFrame` for n/sig deciphering, and that
branch is now compiled IN rather than eliminated, so the override this repo's other two builds
need does not apply here. `prepare.mjs`'s existing sigFrame-injection code stays harmless dead
code for this build (it checks for `id="sigFrame"` first, and finds it already there).

### What running the build found wrong with that plan

Two things the "flip `IS_ELECTRON` and `SUPPORTS_LOCAL_API`, otherwise reuse the web config as-is"
plan did not anticipate, both discovered by running the build and driving the result in a real
window rather than reading source:

1. **Compiled locales, not the plain ones.** `src/renderer/i18n/index.js` fetches
   `${locale}.json.br` instead of `${locale}.json` once `IS_ELECTRON` is true ("locales are only
   compressed in our production Electron builds" -- its own comment). Upstream reaches that by
   constructing `ProcessLocalesPlugin` with `compress: true` in its OWN Electron config
   (`_scripts/webpack.renderer.config.js`); the web config's instance is built with `compress:
   false` and constructed before this wrapper ever sees it. `webpack.orivon.config.cjs` patches the
   already-built instance's `.compress` field instead of forking the config to construct a new
   one. Missing this made every locale fetch 404 before the renderer ever mounted (`SyntaxError:
   Unexpected token 'o', "not found" is not valid JSON` -- serve.mjs's own 404 body, parsed as
   JSON) -- `#app` never got past Vue's initial `<!---->` placeholder, with **zero console errors**,
   because the failing dispatch was never awaited by its caller. `serve.mjs` gained matching
   support: a `.br` file on disk is pre-compressed, so it is served with `Content-Encoding: br`
   and Chromium decodes it exactly as it would over a real network.
2. **A second `CopyWebpackPlugin` writes to a HARDCODED path, not `output.path`.** Upstream's web
   config copies `static/` (locales aside), `pwabuilder-sw.js`, and the Shaka Player locale files
   via absolute `to:` paths built from `path.join(__dirname, '../dist/web/...')` -- unlike its
   first `CopyWebpackPlugin` (the swiper CSS, a relative `to:` that DOES follow `output.path`).
   Changing `config.output.path` to this build's own directory does nothing to those hardcoded
   ones. **Caught only because it happened**: an early build here wrote into `dist/web/static`,
   the directory `parallel-work.md`'s own rule says never to touch, because another agent's run
   may depend on its contents. `webpack.orivon.config.cjs` now rewrites every `CopyWebpackPlugin`
   pattern whose `to:` starts with the old `dist/web` prefix onto this build's own output path.
   Left unfixed, this build would have `/static/invidious-instances.json`,
   `/static/geolocations/*.json`, and `/static/external-player-map.json` all 404 -- three of the
   Vuex actions `App.vue`'s `onMounted` fires (unawaited) throw as unhandled rejections for each.

## Storage: nedb files under Orivon's `fs`, not IndexedDB

`dist/orivon-electron`'s alias switch (above) already gets `IS_ELECTRON`/`SUPPORTS_LOCAL_API`
right for playback. Storage needed a second, independent decision: upstream's web webpack config
aliases `DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$` to `src/datastores/handlers/web.js`, which loads
nedb's **browser** build (`localForage`, IndexedDB) regardless of `IS_ELECTRON`. `orivon.json`
declares an `fs` grant and the consent prompt shows it, but nothing used it. `webpack.orivon.config.cjs`
now points that same alias at `src/datastores/handlers/electron.js` instead -- upstream's own
Electron-renderer handler, which dispatches through `window.ftElectron.db*` exactly as it does in
real FreeTube desktop.

### The renderer-vs-web config diff, and what each difference is

`_scripts/webpack.renderer.config.js` (upstream's own Electron config) and `_scripts/webpack.web.config.js`
(the one this build wraps) were diffed in full. Four differences were already handled by the
existing wrapper before this change (`SUPPORTS_LOCAL_API`/`IS_ELECTRON`, the `externals` deletion,
the locale-compression patch, the `CopyWebpackPlugin` rewrite -- all above). Everything else found:

| Difference | Decision |
|---|---|
| `DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$` alias (`handlers/web.js` vs `handlers/electron.js`) | **Applied.** The subject of this section. |
| `dompurify$` alias (renderer only, stubs the module to `export default undefined`) | **Applied.** Its one consumer, `vSaferHtml.js`, gates every `DOMPurify.sanitize(...)` call behind `USE_NATIVE_SANITIZER = process.env.IS_ELECTRON \|\| (...)`, which is already `true` here (`IS_ELECTRON` is compiled in) -- confirmed by reading that file, not assumed. The alias only stops webpack bundling an already-dead dependency; it changes no runtime behaviour. |
| `process.platform` define (`'${process.platform}'` vs the literal `undefined`) | **Not applied.** This would bake the machine that RUNS THE BUILD's own OS into one bundle served to every visitor, regardless of theirs -- `TopNav.vue`, `SideNav.vue`, `ft-shaka-video-player.js` and `helpers/utils.js` all branch on it for Cmd-vs-Ctrl shortcut labels. Real Electron gets this right because electron-builder compiles a separate binary per target OS; a single served bundle cannot. Left as upstream's web config already has it (`undefined`), so every one of those checks reads consistently false rather than reading one build machine's OS for every visitor. |
| `webpack.ProvidePlugin({ process: 'process/browser.js' })` (web only) | **Kept (already present, unchanged).** Real Electron's renderer has a native `process` global; this build runs as an ordinary page with none, so the polyfill web.config already carries stays load-bearing here for the same reason it is in the other two builds. |
| `'youtubei.js$': 'youtubei.js/web'` alias (renderer only) | **Not needed.** Checked the installed package's own `exports` map: the `"."` export's `browser` AND `default` conditions both already point at `dist/src/platform/web.js` -- the same file this alias would force. With `target: 'web'` (unchanged from web.config) webpack already resolves there without it. |
| `HtmlWebpackPlugin`'s `excludeChunks: ['processTaskWorker']` (web only) | **Left as web.config has it.** No entry or dynamically-imported chunk named `processTaskWorker` exists anywhere in the current source tree (checked), so this is inert either way; not worth a risk for zero effect. |
| `JsonMinimizerPlugin` in `optimization.minimizer` (web only) | **Left as web.config has it.** Minification-only, no behavioural difference. |
| `name: 'web'` vs `'renderer'`, `entry` key name, `output.path`, `infrastructureLogging` | **Cosmetic / already handled generically.** Webpack's own internal bundle name and the entry's output filename; `output.path` is already rewritten to this build's own directory regardless. |
| `target: 'web'` | **No difference at all** -- both configs already set the same value. |
| Everything else (`module.rules`, `VueLoaderPlugin`, `MiniCssExtractPlugin`, the swiper `CopyWebpackPlugin` pattern, `resolve.extensions`, the Vue/Vite defines) | **Identical between the two configs.** |

### The second bundle: FreeTube's own main-process datastore code, running in the page

`src/datastores/handlers/electron.js` only dispatches to `window.ftElectron.db*` -- something has to
answer those calls. Rather than reimplement FreeTube's storage logic, `webpack.orivon-datastore.config.cjs`
compiles upstream's **own, unmodified** `src/datastores/handlers/base.js` (the same module real
FreeTube's main process uses) into a second, independent bundle:

- **`process.env.IS_ELECTRON_MAIN` is defined `false`.** `src/datastores/index.js` branches on it:
  false takes the `dbPath = (dbName) => \`${dbName}.db\`` / `autoload: true` path (a bare relative
  filename, nedb loading itself on construction) instead of the real main process's
  `app.getPath('userData')` + `require('electron')` branch -- which that same `false` also folds
  away as dead code during webpack's own parse, so `electron` is never even resolved.
- **`resolve.aliasFields: []`** disables webpack's default browser-field remapping for every
  package in the graph, not only a top-level one -- `@seald-io/nedb`'s own `package.json` remaps
  `lib/storage.js`/`customUtils.js`/`byline.js` to its `browser-version/` (localForage) files, and
  webpack applies that remap during nedb's own internal `require()`s too, not only at import time.
  This is the actual mechanism behind "the Node build, not the browser field".
- **Every Node builtin nedb's real storage layer imports** -- read directly from
  `lib/storage.js`/`persistence.js`/`byline.js`/`datastore.js`/`cursor.js`/`customUtils.js`, not
  guessed: `fs`, `path`, `stream`, `events`, `buffer`, `crypto`, `util`, `timers` -- is aliased.
  `fs` is the one `src/shim/` module this needs (`node-fs.ts`, over `orivon.fs`); `path`, `stream`,
  `events`, `buffer` and `crypto` are `module-map.ts`'s own already-approved packages
  (`path-browserify`, `stream-browserify`, `events`, `buffer`, `crypto-browserify`); `util` is the
  real npm `util` package (also already approved, previously unused) rather than
  `src/shim/node-util.ts`, which is deliberately narrowed to one export (`inherits`) for a
  different dependency graph and has neither `deprecate` nor `callbackify`, both of which nedb
  needs. `timers` (`timers.setImmediate`, one call site in `byline.js`) has no `src/shim/` entry at
  all and needs none: a five-line local polyfill (`bridge/ft-datastore-timers-shim.js`,
  `setTimeout(fn, 0, ...args)`) covers the one call, and stays out of `src/shim/` on purpose.
- **`build-shim.mjs` runs first**, always, compiling THIS repository's `src/shim/node-fs.ts` (and
  everything it imports inside `src/shim/`/`src/shim-electron/`) into one plain ES module with this
  repo's own `esbuild` -- webpack has no TypeScript loader, so it can only consume that output, never
  `src/shim/` directly. Whatever is in `src/shim/` in the tree being built is what gets compiled in;
  nothing here copies or forks it (`prepare.mjs`'s `--build` step runs this before the datastore
  webpack build, every time). Its own `external` list names every module-map.ts `kind: 'package'`
  specifier the datastore webpack config already aliases (buffer, stream, path, events, crypto,
  util), not only the ones `node-fs.ts` happens to import today -- this broke twice in a row
  ("Could not resolve 'stream'", then 'path') as `src/shim/`'s own dependency graph for `fs.ts`
  changed shape on a timeline this repository does not control, each time only caught by rebuilding
  against a real merge and reading the esbuild error. Listing every already-aliased specifier up
  front, whether or not anything reaches it yet, is cheaper than a third silent break -- esbuild
  never resolves an external specifier nothing imports, so this costs nothing today.
- The result is `dist/orivon-electron-datastore/datastore.js`, copied to `orivon/ft-datastore.js`
  and exposed on `globalThis.__orivonFtDatastore` (see `bridge/ft-datastore-entry.js`).

### The bridge: six `db*` members, one script

`bridge/ft-electron-bridge-db.js` (spliced into the single served `ft-electron-bridge.js` by
`bridge/splice-bridge-source.mjs` -- see its own header for why this is two source files but one
runtime script) adds `dbSettings`, `dbHistory`, `dbProfiles`, `dbPlaylists`, `dbSearchHistory` and
`dbSubscriptionCache`, each `(action, data)`. Every action name, value and `switch` is copied from
FreeTube's own `ipcMain.handle(IpcChannels.DB_*, ...)` handlers (`src/main/index.js`, around line
1699) and `DBActions`/`IpcChannels` (`src/constants.js`) -- read directly, not guessed. Two things
upstream's handlers do that these deliberately do not:

- **`syncOtherWindows(...)` calls are dropped.** They exist to keep a second open Electron window's
  renderer in sync after a write; this bridge has exactly one window, the one FreeTube's own chrome
  already assumes throughout.
- **The `DB_SETTINGS` menu/tray/theme side effects are dropped**, not reproduced as a no-op
  (`setMenu()`, tray visibility, native theme on `baseTheme`) -- Electron-shell state this bridge
  has no shell to update, the same category `refusedApi()` already excludes elsewhere in this file.

The `screenshotFolderPath` upsert guard IS reproduced verbatim (upstream reserves that write for
its `CHOOSE_DEFAULT_FOLDER` flow alone), and so is the error handling: `ipcMain.handle`'s own
`catch (err) { throw typeof err === 'string' ? err : err.toString() }`, an IPC-serialisation habit
kept here for parity even though nothing here crosses that boundary.

**Read lazily, not at install time.** `prepare.mjs` injects three `<script>` tags in order: the
bridge, then `ft-datastore.js`, then FreeTube's own bundle. The bridge's own top-level
`installFtElectronBridge(...)` call runs before the second script has, so each `db*` member reads
`globalThis.__orivonFtDatastore` fresh, at call time -- not once, captured early as `undefined`.
When it is missing (an older prepared build, or `prepare.mjs` run without `--build`), every `db*`
member refuses by name (`FtBridgeError`, reason `not-built`) instead of throwing a bare
`TypeError`, synchronously, the same convention `refusedApi()` already uses.

### Where the data lands

`app.getPath('userData')` (`src/shim-electron/app.ts`) deliberately returns `'.'`, not an absolute
path -- `orivon.fs` rejects an absolute path outright. With `IS_ELECTRON_MAIN` false, nedb never
actually calls that: `src/datastores/index.js`'s own `else` branch already produces the bare
relative filenames `settings.db`, `profiles.db`, `playlists.db`, `history.db`, `search-history.db`
and `subscription-cache.db`, which land at exactly the same place `getPath('userData')` names --
the app's own confined `fs` root, under the `fs.quotaBytes` grant `orivon.json` already declares.
These are the same NDJSON-per-line files FreeTube desktop keeps in its own `userData` folder,
written by upstream's own nedb code, unmodified.

### The dependency this needed, and the exact failure without it

`src/shim/node-fs.ts` refuses every `fs.promises.*` member except `open` (`refuseShim(..., 'unimplemented')`),
and nedb's real Node storage layer (`lib/storage.js`) uses `fsPromises.access`, `.rename`,
`.writeFile`, `.unlink`, `.appendFile`, `.readFile`, `.mkdir` and `.open` exclusively -- never the
callback-style `fs.*` this shim already implements. **Measured against the real compiled datastore
bundle** (a fake `orivon.fs` that resolves `mkdir` and refuses everything else, loaded and run
under plain Node): the first call nedb's own autoload sequence makes is
`ensureParentDirectoryExistsAsync`'s `fs.promises.mkdir`, refused with reason `unimplemented`, not
`fs.promises.access` as a plain top-to-bottom read of `storage.js` would suggest -- nedb creates
the parent directory before it ever checks whether the datafile itself exists. Every `settings.find()`
call currently rejects for exactly this reason, unhandled, until that gap closes.

**A second, separate gap, found the same way, not yet reached by the first:** `node-fs.ts`'s
default export sets `constants: undefined` explicitly (not routed through its usual named-refusal
proxy, since `fs.constants` is data, not a function). `storage.js`'s `existsAsync` reads
`fs.constants.F_OK` -- once `fs.promises.mkdir`/`.access` are real, this throws next
(`TypeError: Cannot read properties of undefined (reading 'F_OK')`) unless `fs.constants` is added
too. Not fixed here (`src/shim/` is out of this stream's paths); flagging it so it is not
rediscovered from scratch once the first gap closes.

### Testing the datastore bundle and bridge

`bridge/ft-electron-bridge-db.test.ts` covers all six `db*` members and every one of their actions
against a fake `globalThis.__orivonFtDatastore`, split from `ft-electron-bridge.test.ts` the same
way the source is (`code-guidelines.md` Rule 2); both share `ft-electron-bridge.test-helpers.ts`'s
vm-sandbox harness. Same run command as below, since both are `apps/freetube-real/**/*.test.ts`.

`webpack.orivon-datastore.config.cjs` and `build-shim.mjs` are exercised by `prepare.mjs --build`
itself (below) -- there is no separate unit test for the webpack config, the same way
`webpack.orivon.config.cjs` has none: both are config, verified by actually building with them.

## Opening a video works (`dist/orivon-web-localapi`)

Measured 2026-09-17, `dist/orivon-web-localapi`, against live YouTube:

```
url:   http://127.0.0.1:8875/#/watch/dQw4w9WgXcQ
title: Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster) - FreeTube
page:  Published on 25 Oct 2009 - 1,816,738,329 views - 19,394,151 likes
       Rick Astley - Subscribe - 4.5m - full description
```

**That is upstream's own Local API code, calling YouTube's InnerTube through the routed fetch.**
It is the thing upstream compiles OUT of the web build because a browser cannot do it.

Getting there needed three fixes, and only the first was Orivon's:

1. **A routed-fetch bug** (`src/preload/fetch-route.ts`). It read the request URL as
   `typeof input === 'string' ? input : input.url`, which accepts a string and a `Request` but
   **rejects a `URL` object** -- and `youtubei.js` passes one. WHATWG fetch takes
   `Request | USVString` and converts anything that is not a Request with `ToString`, which is why
   `fetch(new URL(...))` works in every browser. Fixed to follow the spec. This was a real
   platform divergence, found only because a third-party library exercised the path.
2. **The n/sig evaluator.** FreeTube sets `Platform.shim.eval` in
   `src/renderer/helpers/api/local.js`, but its working half sits behind
   `if (process.env.IS_ELECTRON)`, which webpack folds to `false` for a web build and eliminates.
   `_scripts/orivon-sig-eval.js` in the clone re-implements exactly that branch.
3. **The `#sigFrame` iframe** it posts to, which `src/index.ejs` also renders only under
   `IS_ELECTRON`. [`prepare.mjs`](prepare.mjs) injects it, built from FreeTube's own
   `sigFrameConfig`, so the sandboxed script and its CSP hash are upstream's bytes.

Neither 2 nor 3 is an Orivon gap: both are upstream build decisions that follow from "the web
cannot reach YouTube", which is the premise Orivon removes.

### Playback on the web-localapi build: blocked on the PoToken, traced to the exact line

**Not blocked by Orivon.** Measured with an unminified build, the failure is three frames deep:

```
TypeError: Cannot read properties of undefined (reading 'replace')
  at base64ToU8        (googlevideo/dist/src/utils/shared.js)
  at setupSabrScheme   (src/renderer/helpers/player/SabrSchemePlugin.js)
  at setup             (src/renderer/components/ft-shaka-video-player/...)
```

YouTube now serves the Local API path over **SABR** (server-side ABR), and SABR requires a
proof-of-origin token. `Watch.js` takes the SABR branch whenever
`streaming_data.server_abr_streaming_url` exists, passing the `poToken` it was given.
`local.js` only ever produces one inside `if (process.env.IS_ELECTRON)`, by calling
`window.ftElectron.generatePoToken(...)` -- BotGuard, executed in FreeTube's main process. **This
build compiles that block out**, so the token is `undefined`, `base64ToU8(undefined)` throws, and
the throw takes the whole player component's `setup()` with it. **That is why no `<video>`
element exists at all** on this build -- the player never mounts, so only the thumbnail shows.
Metadata (title, description, view count) loads fine first, because it is fetched before the
player component ever runs.

This is the same `GENERATE_PO_TOKEN` handler
[`freetube-port-recon.md`](../../docs/planning/freetube-port-recon.md) listed as *Unassessed*,
and it is now assessed twice over: it is load-bearing, and it is the single thing between this
build and working playback.

### Playback on the Electron-renderer build: it plays

On `dist/orivon-electron`, `IS_ELECTRON` is compiled IN rather than out, so `local.js`'s own
branch actually runs: `window.ftElectron.generatePoToken(...)` -- `bridge/ft-electron-bridge.js`'s
own implementation -- opens a private, empty document at `https://www.youtube.com` through
`orivon.web.openContext` (`OrivonWeb`, ADR-0019, `docs/decisions/ADR-0019-*.md`), evaluates
FreeTube's own BotGuard script inside it, and returns the token. `getLocalVideoInfo` calls this
BEFORE it fetches either the player response or the `/next` metadata response (the second needs
`contentPoToken` for `serviceIntegrityDimensions`), so a working mint is load-bearing for the
whole video, not only its stream -- see
[How `generatePoToken` uses `web.context`](#how-generatepotoken-uses-webcontext) for the mechanism.

Measured 2026-09-18, live YouTube, `dist/orivon-electron`, `#/watch/dQw4w9WgXcQ`, through
`test/e2e-freetube-real.test.ts`:

| | |
|---|---|
| Watch page populated (title, description, view count) | yes |
| `generatePoToken` (fetch the script once, open the context, evaluate, close) | ~440-450 ms |
| Minted token length | 132 characters |
| Navigating to `#/watch/...` to `<video>.currentTime > 0` | ~3.2-3.9 s |
| `<video>.currentTime` past 3 s and still advancing 2 s later | yes |

The granted origin carries both the pre-existing `https.connect` grant and a `web.context` grant
for `https://www.youtube.com` (`orivon.app.grants()`, confirmed from the same run) -- the second is
what makes the mint above possible at all.

**About half of all mints stall inside BotGuard, and the bridge retries them.** Measured
2026-09-18 on the headless harness (`scripts/run-headless.mjs`: Xvfb, no GPU), against live YouTube.
In a stalled mint:

- BotGuard fetches its interpreter (`www.google.com/js/th/*.js`, ~150 ms);
- it calls `GenerateIT`, which **answers** (`200`, ~150 ms);
- then its own synchronous code never yields again. A 1-second heartbeat injected into the context
  ticked **zero times in 46 s**, while the context stayed open.

So the stall is a non-yielding block in Google's obfuscated script, after its server answered. It is
not a slow server, and not a stuck request. Nothing in the app tab's routed fetch, the context's
reach-only fetch, `openContext`, `evaluate` or the CORS wrapper showed a defect in stalled or clean
runs. The WebRTC guard is ruled out by an A/B: 10 of 10 mints succeeded with and without it. So is
the environment on its own: `WebGL1 blocklisted`, "No available adapters" and a 0x0 offscreen
viewport appear in clean runs exactly as in stalled ones.

**`generatePoToken` therefore gives each attempt 15 s**, far above the ~0.5 s a clean mint takes.
On the deadline it closes that context, which also ends the blocked renderer, and retries in a fresh
one, up to 3 attempts, one at a time. A real rejection is never retried. When every attempt stalls,
it throws a named `PoTokenMintStalledError`.

Measured over 4 real runs: **4 of 4 played**, 2 needing exactly one retry, none needing a second.
Whether a real desktop, with a GPU and a visible window, stalls as often is not measured.

## What else is measured

**It boots, mounts, and renders its real chrome, on both builds.** `test/e2e-freetube-real.test.ts`
drives the real shell against a prepared build (`ORIVON_FREETUBE_REAL_ROOT` selects which one):
the app is granted from its URL, FreeTube mounts its Vue app inside the resulting app tab, and it
renders its real chrome -- top nav, side nav, Subscriptions/Channels/Trending/Playlists/History/
Settings -- with `document.title` of `Subscriptions - FreeTube` and exactly the two known,
expected console errors below.

**Nothing about its data layer is measured yet beyond that**, and one thing about it is already
known to be broken through no fault of Orivon's: **all seven Invidious instances FreeTube bundles
are down** (measured 2026-09-17: three fail DNS, one 401, two 404, one 502). The stock web build
has no other backend, so it can render and cannot fetch. That is why the Local API builds exist.

Two console errors are present and expected on every build here, both already the capability
boundary working correctly, not a bug:

- `fetch to api.github.com refused` (or, on the Electron build, the same refusal surfacing as a
  JSON-parse error on the refusal body) -- FreeTube's update check. `api.github.com` is **not** in
  [`orivon.json`](orivon.json), left undeclared on purpose: an app asking whether a desktop
  release exists has no business reaching GitHub here.
- A `fetchInvidiousInstances` JSON-parse error -- one of the seven bundled Invidious instances
  answered with a body FreeTube could not parse. Not Orivon's: the instances are down, above.

### Testing the bridge

`bridge/ft-electron-bridge.test.ts` covers all 34 original `window.ftElectron` members and
`bridge/ft-electron-bridge-db.test.ts` covers the six `db*` members against a fake
`globalThis.__orivonFtDatastore`, against a fake `window`/`document`/`navigator`/`fetch`/`orivon`,
loading the bridge's own (spliced) source into a fresh `node:vm` context per test (it is a classic
script, not a module, so it has nothing to `import` at runtime -- `bridge/ft-electron-bridge.test-helpers.ts`
is the one exception, a real ES module only the tests themselves import).
**Not picked up by `npm test` yet** -- `vitest.config.ts`'s include pattern is `src/**/*.test.ts`
and `scripts/**/*.test.ts`, and `apps/` is neither (the same gap `apps/fixture/manifest.test.ts`
already notes, with whether `apps/**` should join that include left open). Naming the file on
the command line does not help, because vitest filters inside its include pattern rather than
widening it. A temporary config outside the repository does work:

```bash
printf "export default { test: { environment: 'node', include: ['apps/freetube-real/**/*.test.ts'] } }\n" > /tmp/vitest.apps.mjs
npx vitest run --config /tmp/vitest.apps.mjs --root .
```

### Running the real build against a real window

To see it play, from a clean checkout:

```bash
node apps/freetube-real/prepare.mjs --build          # builds dist/orivon-electron, under the clone lock
node apps/freetube-real/serve.mjs --root ~/git/freetube-src/dist/orivon-electron
npm run dev
```

Then open `http://127.0.0.1:8875` (or whatever port `serve.mjs` printed) and accept the consent
prompt -- it now lists both `https.connect` and *"Run code as www.youtube.com, in a private, empty
session"* (`web.context`). Navigate to a video (e.g. the Trending tab, or `#/watch/dQw4w9WgXcQ`
typed into the page itself) and it plays. `index.html` now loads three scripts in order: the
bridge, `orivon/ft-datastore.js`, then FreeTube's own bundle (see
[Storage](#storage-nedb-files-under-orivons-fs-not-indexeddb) for why that order matters).

**Storage will not work yet on an unpatched `src/shim/`.** Every `db*` call currently rejects at
`fs.promises.mkdir` (see [The dependency this needed](#the-dependency-this-needed-and-the-exact-failure-without-it))
until `src/shim/`'s `fs.promises` gap closes -- playback, metadata and the rest of the chrome are
unaffected, since none of those read or write through nedb.

To drive the same thing headlessly, as CI does:

```bash
node scripts/build-ordinary.mjs
ORIVON_FREETUBE_REAL_ROOT=~/git/freetube-src/dist/orivon-electron ORIVON_ORDINARY_BUILD=1 \
  npx vitest run --config test/vitest.e2e.config.ts test/e2e-freetube-real.test.ts
```

The playback assertion (`<video>.currentTime` exceeds 3s and is still advancing 2s later) is now
**on by default whenever the prepared build's own manifest declares `web`** -- true for
`dist/orivon-electron` since `orivon.json` gained `web.contexts` above, still false for
`dist/orivon-web`/`dist/orivon-web-localapi`, which get only the metadata checks. Override either
way: `ORIVON_FREETUBE_REAL_PLAYBACK=0` forces it off, `=1` forces it on regardless of the manifest.

## How `generatePoToken` uses `web.context`

`bridge/ft-electron-bridge.js`'s `generatePoToken` is written against `OrivonWeb.openContext`
(`capability-api.ts`, ADR-0019): fetch and cache `botGuardScript.js` once, rewrite its
`export{X as default};` tail into a call carrying this mint's own arguments -- exactly
`src/main/poTokenGenerator.js`'s own rewrite, except the video id is `JSON.stringify`-encoded
rather than spliced as a bare string (below) -- open a context at `https://www.youtube.com`,
evaluate the rewritten script, close the context in a `finally`, and queue mints one at a time as
upstream does. Unit-tested against a fake `orivon.web` (`bridge/ft-electron-bridge.test.ts`) and,
end to end against the real capability, measured above.

**The video id is JSON-encoded, not spliced as a literal, unlike `context`/
`initialAttestationData`/`ytConfig`.** Those three arrive already `JSON.stringify`d by FreeTube's
own call site (`local.js`), so splicing them verbatim reproduces upstream's own Electron build
exactly. The video id does not: it traces back to the URL (`#/watch/<id>`, a route a page
navigates FreeTube to, including this app's own address bar), so a bare `"${videoId}"` splice would
let a crafted id break out of the string literal and inject script into the youtube.com context
this runs in. `JSON.stringify(videoId)` closes that -- covered by
`bridge/ft-electron-bridge.test.ts`'s hostile-id test, which proves the payload lands as one inert
string argument, not executable code.

## Spike results: can BotGuard run in an isolated child?

Measured 2026-09-18 in Electron 44.0.0 (Chrome 152.0.7977.54) against live YouTube, from a
throwaway harness kept outside this repository because it drives upstream's AGPL script. The
question: can an opaque-origin child with no `orivon.*`, which talks to its parent only by
`postMessage`, mint the proof-of-origin token upstream needs? That child is the shape of a
manifest-declared sandbox page.

**It cannot. The reason rules out every isolation primitive, not only this one.**

| # | Question | Answer |
|---|---|---|
| 1 | Does BotGuard produce a token from an opaque origin? | **No.** The token is bound to the document origin, and only `https://www.youtube.com` gets one |
| 2 | Does BotGuard need `eval`? | **Yes.** The interpreter calls it itself; withholding `'unsafe-eval'` stops it loading |
| 3 | Can a sandbox page be enforced on a live origin? | **Yes, but not through the loader.** A response header added in `onHeadersReceived` works |
| 4 | Is the CSP `sandbox` directive honoured on a `protocol.handle` response? | **Yes**, framed and top-level |
| 5 | Does a `srcdoc` child's meta CSP block requests before the handler sees them? | **Yes** |
| 6 | Are sandboxed iframes process-isolated in Electron 44? | **Yes**, with no flag |
| 7 | Does fingerprinting reject a child that has real dimensions but is out of view? | **Could not be measured.** Question 1 fails first |

### 1: the token is bound to the document origin

Upstream's own `src/botGuardScript.js` was bundled unmodified and run in contexts that change one
thing at a time. Except for the first row, every request went through the same relay: a Node
`fetch` in the main process, which is how Orivon's routed fetch reaches the network.

| Context | Document origin | Network | `GenerateIT` answered | Tokens |
|---|---|---|---|---|
| upstream's `generatePoToken`, reproduced verbatim | `https://www.youtube.com` | Chromium | `["<token>",43200,100]` | 2 of 2 |
| that same view | `https://www.youtube.com` | relay | `["<token>",43200,100]` | 3 of 3 |
| that same view | `https://example.org` | relay | `[null,43200,null,"Mk..."]` | 0 of 3 |
| that same view | opaque, top-level | relay | `[null,43200,null,"Mk..."]` | 0 of 2 |
| sandboxed `srcdoc` child of a live origin, in view | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 1 |
| the same child, 1920x1080 and positioned off-screen | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 3 |
| the same child, 1x1 | opaque | relay | `[null,43200,null,"Mk..."]` | 0 of 1 |

The one-variable rows ran alone, each as the first mint in a fresh process, so the result does not
depend on order.

In every row BotGuard ran to completion: the interpreter loaded, the snapshot was taken, and
`GenerateIT` answered `200`. **Google's server declined to issue the token**, and the only thing
that differs between the rows that got one and the rows that did not is the document origin. The
relay is not the cause, since it gets a token for a youtube.com document.

Upstream reaches that origin by loading a `data:` URL with
`baseURLForDataURL: 'https://www.youtube.com/'` into a `WebContentsView`. That is a privilege of
the embedding application. A web page cannot put a document at another site's origin, because
that is the web's origin model working. So no child context Orivon could hand an app reaches it
either: not a sandbox page, not a `srcdoc` frame, not a worker with delegated ports, and not a
child at the app's own origin.

**This is where the isolated-child route stops.** A token could only come from Orivon itself
creating a document at a foreign origin on an app's behalf. That is a different kind of capability
(an app acting as another site, towards that site), not a missing piece of this one.

Whether YouTube then *accepts* a token for playback was not reached, and cannot be checked cheaply.
For the WEB client, `/player` answered `OK` with or without a token, and its formats carried no
direct URLs (SABR only). Any real check has to make a SABR request.

### 2: BotGuard needs `eval`

The interpreter (`www.google.com/js/th/*.js`, 63 KB) evaluates code at runtime from three call
sites: a direct `eval(T)` that is one of its VM instructions, and two Trusted Types
`createScript` -> `.eval` probes. Measured: in a child whose CSP withholds `'unsafe-eval'`, with
the interpreter loaded as a real `<script>` instead of upstream's `new Function`,
`BotGuardClient.create` fails with `EGOU: BotGuard unavailable`. It also creates an iframe of its
own, with `sandbox="allow-same-origin allow-scripts allow-forms allow-popups"`.

### 3 to 6: the platform primitive itself works

- **3.** `src/loader/serve.ts` serves only installed origins, so it can never give a sandbox page on
  a live origin a header. A live origin's responses do pass through
  `session.webRequest.onHeadersReceived`, however: A110 records that the listener never fires for a
  `protocol.handle` response, and a live origin is not one. Adding
  `Content-Security-Policy: sandbox allow-scripts` there made the page opaque, framed and
  top-level. Its `self.origin` read `"null"`, and `localStorage`, `document.cookie` and
  `parent.document` each threw `SecurityError`. The same page without the header kept its real
  origin. The primitive therefore needs two mechanisms: the served header for installed apps, and
  `onHeadersReceived` for live origins. Nothing in `src/` registers `onHeadersReceived` today.
- **4.** A `protocol.handle('https')` response carrying `Content-Security-Policy: sandbox
  allow-scripts` got the same result as 3: opaque, framed and top-level.
- **5.** Under a parent served by `protocol.handle`, a sandboxed `srcdoc` child whose meta CSP was
  `default-src 'none'` had its `fetch` and `<img>` refused in the renderer, with `connect-src` and
  `img-src` violations. **Neither request reached the handler.** The same child without the meta
  CSP reached the handler with both. So without a CSP, a sandboxed child's requests do arrive at
  the handler, which on the installed path is `fetchThirdParty`.
- **6.** Every sandboxed frame, whether `srcdoc` or a URL carrying the CSP `sandbox` header, ran in
  a different OS process from its parent (parent pid 65583, sandboxed children 65611). A
  same-origin, unsandboxed child shared the parent's process. Sandboxed children of one site share
  one process with each other.

### 7: masked by 1

The in-view, off-screen and 1x1 children all failed at the same step, `GenerateIT` answering
`null`, like every other context that was not youtube.com. The origin check fires first, so
dimensions cannot be isolated from an opaque child. Upstream's metric spoofing (DevTools
`Emulation.setDeviceMetricsOverride`) was reproduced in the control rows, but whether it is
necessary was not tested: for an opaque context it cannot change the outcome.

## Design notes

**Why `prepare.mjs` injects rather than the server.** A server that rewrites what it serves is
executing app logic, and the owner's standing position is that an app's host is a plain static
file server. Injection is a build step; serving is a file read. `serve.mjs`'s `.br` handling stays
on the read side of that line -- it describes an existing file's encoding, the same way the
`MIME_TYPES` table already does, rather than transforming any file's bytes.

**Why the manifest declares `*:*` next to sixteen literal hosts.** Video bytes come from
googlevideo.com hosts whose names rotate per video and per request
(`rr1---sn-4g5ednsk.googlevideo.com`). A connect pattern cannot be a sub-glob, so nothing narrower
than `*:*` reaches them. The sixteen literals are every other host FreeTube is known to reach: the
seven Invidious instances, YouTube's API and image hosts, SponsorBlock and Return YouTube Dislike.
On a live origin no Orivon CSP applies, so the wildcard costs nothing there. On the installed path
the served CSP omits it, which costs the app its images, for the reason
[`../freetube/README.md`](../freetube/README.md) gives.

**`consentGranularity` is `all-or-nothing` here, unlike the port next door.** That is the honest
setting for an app that never knew Orivon existed: FreeTube has no code path for a capability it
declared being refused, and the manifest contract says silence means exactly this. The port next
door declares `per-capability` because it was written to degrade.

**Why the bridge duplicates `FtBridgeError`/`REFUSAL_REASONS` instead of importing
`apps/freetube/lib/ft-electron.js`'s.** Each app stands alone (parallel-work.md); the pattern is
copied, the code is not. It is also a classic `<script>`, not a module, so it has no `import` to
reach for regardless.
