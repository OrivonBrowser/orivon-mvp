---
name: "orivon-electron"
description: Use when writing or debugging code that runs webtorrent (or anything with a similar Node-dependency graph) inside an Orivon Electron renderer, when building the real orivon-node-shim, when an Electron+Vite renderer build fails with a confusing module-resolution error, when a gate/test hangs with no error under Playwright's _electron driver, or when anything Electron-related behaves inexplicably in this repository's dev environment. Captures knowledge from the week-0 spike (2026-08-25) that exists nowhere else.
---

# Orivon + Electron: what the week-0 spike learned

This knowledge came from building four passing gates and one blocked one
(`docs/planning/spike-verdict.md`, `docs/planning/spike-results/*.json`). It is not written
down anywhere else. Read this before repeating any of it from scratch.

## First: check the environment for poison

**This machine has `ELECTRON_RUN_AS_NODE=1` set in the ambient shell environment.** It makes
the Electron binary run as plain Node — no windows, no `require('electron')`, no
`MessagePortMain`. It does not fail loudly; it fails in ways that look like unrelated bugs (it
once presented as a module-format error that had nothing to do with module formats, costing
about an hour before being caught).

**Never launch Electron directly.** Always go through `spike/launch.mjs`'s `launchElectron()`,
which strips the variable and asserts `MessageChannelMain` exists before returning. If you are
writing new Electron-launching code outside the spike, port this pattern — check
`process.env.ELECTRON_RUN_AS_NODE` and strip it before spawning, or a "gate" (or later, a real
test) can produce a confident, completely false result.

```js
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [appPath], env })
const isReal = await app.evaluate(({ app, MessageChannelMain }) =>
  typeof app?.getVersion === 'function' && typeof MessageChannelMain === 'function')
if (!isReal) throw new Error('not real Electron — refuse to trust any result from this run')
```

## The renderer bundling recipe

webtorrent's `browser` field maps `net`, `bittorrent-dht`, `ut_pex`, `conn-pool`, `crypto`,
`fs`, `http`, `os` and more to `false`, which makes it WebRTC-only — precisely the outcome
`ADR-0001` reason 3 exists to defeat. Beating this needs a specific, non-obvious set of Vite
aliases. This is the complete, verified list (`spike/gate1b/vite.config.js` is the reference
implementation — it is the superset; `gate1a`'s config is missing several of these because it
predates DHT/MSE work, do not copy it as "the full list").

| Alias target | Replacement | Why |
|---|---|---|
| `net` | `shim/net.js` (project-specific) | **The load-bearing one.** webtorrent's `torrent.js` refuses all TCP unless `typeof net.connect === 'function'`. Must also export `isIP`/`isIPv4`/`isIPv6` — see "The isIP incident" below. |
| `dgram` | `shim/dgram.js` (project-specific) | Only if DHT is needed. An `EventEmitter`, not a stream — `bind()`, `send(msg, port, host, cb)`, `'message'`/`'listening'`/`'error'` events. `address()` must be **synchronous**, so cache it from the `'listening'` broker message rather than round-tripping. |
| `./mse.js` | real `bittorrent-protocol/mse.js` | Protocol encryption. **Use the real file, not a stub** — see "MSE actually works" below. |
| `crypto` | `crypto-browserify` | Needed by both MSE and DHT node-ID hashing. Pure JS. |
| `stream`, `string_decoder` | `stream-browserify`, its own polyfill | `crypto-browserify`'s `Hash` extends `cipher-base`, which extends `stream.Transform`. Skip these and the failure reads `Cannot read properties of undefined (reading 'call')` deep inside the hash constructor, naming neither `stream` nor `crypto`. |
| `path` | `path-browserify` | Genuinely **called** at runtime (`webtorrent/index.js` uses `path.basename`). Skipping it produces the single most misleading error in this whole list — see below. |
| `events`, `buffer`, `process`, `util` | their respective browser polyfills | Named imports from Vite's empty externalized-module stub are hard build errors, not warnings. |
| `bittorrent-dht` | real package, or a disabled stub | Pure JS, no native deps. Stub it (export `Client: undefined`) when a gate doesn't need DHT — `torrent-discovery` checks `typeof DHT !== 'function'` and disables gracefully, exactly matching webtorrent's own browser-build behaviour. |
| `webtorrent`, `streamx` | resolve into the isolated app tree | webtorrent is a pre-built **app asset**, never a shell dependency (Rule 8) — see "Why this isn't in package.json" below. |

Also mandatory:
- **`base: './'`** in the Vite config. The default `/` resolves to the filesystem root under
  `file://`, giving a blank page with `ERR_FILE_NOT_FOUND`.
- **A `globals.js` shim, imported FIRST**, before any other import in the renderer entry
  point. A sandboxed renderer has no `process`/`global`/`Buffer`, and several dependencies read
  them at *module-evaluation time*, not lazily — import order matters.
- **A `package.json` in the app directory.** Electron cannot find the app without one, even for
  a throwaway test harness.
- **`sw.min.js` (for the Service-Worker media path) must be copied into `dist/` after every
  build.** Vite does not include it automatically — it's fetched dynamically by
  `navigator.serviceWorker.register()`, not referenced from HTML, so Vite's asset pipeline never
  sees it. The real path is `node_modules/webtorrent/dist/sw.min.js` — note the `dist/`; a path
  without it looks plausible and fails as a silent 404.

## `file://` counts as a secure context — `serviceWorker.register()` needs no fallback

The week-0 plan assumed `navigator.serviceWorker.register()` would need a fallback for the media
path, because service workers are ordinarily gated to secure contexts (`https:` or `localhost`)
and a packaged app serves its files over `file://`. **That assumption was wrong for
registration, and confirmed empirically rather than left standing** (gate 3, 2026-08-25):
Electron treats a `file://` origin loaded via `loadFile()` as a secure context, and
`navigator.serviceWorker.register()` succeeds with no flag and no workaround needed. Don't build
a registration fallback speculatively — `docs/planning/spike-verdict.md` (its Gate 3 section)
has the evidence.

**What this does not prove:** gate 3 itself is **BLOCKED**, not passed — `register()` succeeding
is confirmed, but the end-to-end media path through the `<video>` element is still unproven,
because Playwright can't attach to that gate's window (see the known-unsolved-issue section
below) and the element itself is explicitly "not yet tested" in `spike-verdict.md`.

## The `path` polyfill incident — when an error names the wrong thing entirely

A missing `path` alias did not produce a "cannot find module 'path'" error. It produced:

```
ConnPool.join is not a function
```

Rollup externalizes an unresolved Node builtin to an empty object, and it does this for
`conn-pool.js` (webtorrent's own module, correctly browser-excluded) as well as for `path`
(which Vite doesn't know is needed). **Rollup gave both the same generated identifier**, so the
error named `ConnPool` when the real problem was `path`. **When a Rollup/Vite build error names
something that makes no sense given the code you wrote, `grep` the built bundle
(`dist/assets/*.js`) around the line number in the stack trace** — do not trust the symbol name
alone.

## MSE actually works — do not assume otherwise

The original assumption was that BitTorrent protocol encryption (MSE) can't run in a renderer,
because it needs Diffie-Hellman, a synchronous SHA-1, and RC4 — none of which WebCrypto usefully
provides. **This was wrong, and it took a direct challenge to catch:**

- `bittorrent-protocol/mse.js` already ships a **complete pure-JS RC4 fallback**, selected
  automatically whenever `crypto.createCipheriv('rc4', ...)` throws (which it does, on
  `crypto-browserify`). RC4 was never actually the blocker — reading the `nativeRC4` detection
  line and stopping there, without reading the fifteen lines under it, is what produced the
  wrong conclusion the first time.
- The only genuinely missing pieces are `createHash('sha1')` and `createDiffieHellman`, and
  `crypto-browserify` supplies both, in pure JS.
- Verified end to end: a full encrypted handshake at `secure: 2` (RC4 required, **no** plaintext
  fallback) against a Node seeder using native crypto. A piece verified in 480 ms.

**Ship `secure: 1`** (encrypt when possible, plaintext fallback) for maximum swarm reach. Cost
is real but small: the renderer bundle grows from ~427 KB to ~1.7 MB (95 KB → 336 KB gzipped),
irrelevant against Electron's ~150–200 MB floor.

**UI honesty note:** MSE is obfuscation against ISP traffic shaping, not privacy against
eavesdroppers. Its DH exchange is unauthenticated and RC4 is a broken cipher. Never present it
as making torrenting private.

## `MessagePortMain` fails by silence, not by error

Confirmed by direct measurement (`gate-0.json`): passing an `ArrayBuffer` in the transfer list
of `MessagePortMain.postMessage` **renderer → main** does not throw and does not corrupt the
payload — **the message never arrives, at all**, for any size tested. This reproduces
[electron#34905](https://github.com/electron/electron/issues/34905), and the real behaviour is
worse than the issue as filed.

**Consequences, both load-bearing:**
- **Never design a reply-carrying protocol over `MessagePortMain` without a timeout.** The
  first version of the gate-0 test hung indefinitely on exactly this — a reply promise with no
  timeout, waiting for a message that had already been silently dropped.
- **Do not reach for transferables as a throughput optimisation on this path.** They are not
  available. Structured clone (which copies) is not a fallback for a rescue plan — it is the
  *only* mechanism, and it is fast enough on its own: 313–1134 MB/s measured, against a
  1–5 MB/s product requirement.

## A shim must mirror the whole surface a dependency touches, not the obvious methods

`bittorrent-dht`'s RPC layer calls `net.isIP(peer.host)` before every send, to decide whether to
send directly or resolve via DNS first. The project's `net` shim implemented `connect`,
`createServer`, and `Socket` — a complete-looking socket API — but not `isIP`. The result: the
DHT bound its listening socket successfully, then **sent nothing, ever**, with no error and no
warning.

The reason it was silent compounds the lesson: the throw happened inside a `process.nextTick`
callback, and this project's `globals.js` polyfills `nextTick` with `queueMicrotask`. **Node's
real `nextTick` surfaces an uncaught exception to the process; `queueMicrotask` does not route
into the same handlers.** A polyfill chosen for API-shape compatibility silently changed error
visibility in exactly the wrong direction for code whose job is partly security-relevant.

**When building the real `orivon-node-shim` (A10): audit every Node timing primitive
(`nextTick`, `setImmediate`, microtask ordering) for this class of behavioural change, not just
for call-signature compatibility.** A shim that type-checks and passes a synthetic test can
still be a black hole for real dependency errors.

## Why webtorrent isn't in the shell `package.json`

`node-datachannel` (`@thaunknown/simple-peer → webrtc-polyfill → node-datachannel`) is a
**hard, non-optional** transitive dependency of webtorrent. Its install script is:

```
prebuild-install -r napi || (npm install --ignore-scripts --production=false && npm run _prebuild)
```

It tries a prebuild and **falls back to compiling with CMake** when no prebuild matches the
platform/ABI — exactly the Rule 8 threat (breaks `npm install` on a machine without a C++
toolchain, i.e. most contributors on Windows/macOS). This is why webtorrent lives in an isolated
`spike/app/` (soon: a real app-asset tree) with its own `package.json`, never installed at the
shell level. The built renderer bundle contains zero `node-datachannel` references — confirmed
by grepping `dist/assets/*.js` — because `@thaunknown/simple-peer`/`webrtc-polyfill` are
deliberately left **unaliased**, so they keep browser resolution and the renderer uses
Chromium's native WebRTC instead.

`npm install --omit=optional` is **not a safe install mode** for the shell tree — it skips
Rollup's platform-specific native binary (itself an optional dependency the build genuinely
needs) and the build crashes with `MODULE_NOT_FOUND`. `check:natives` passes under either
install mode (correctly — a missing prebuilt binary isn't a Rule 8 violation), so the guard
alone will not catch this. Contributors and CI must use a plain `npm install`.

## `ready-to-show` is typed on `BrowserWindow` only, but fires identically on `BaseWindow`

Symptom: TypeScript's own types — and context7's docs — show `ready-to-show` only on
`BrowserWindow`'s typed event union (`electron.d.ts:4704-4708`, electron 44.0.0). Nothing in
either source suggests it exists on `BaseWindow` at all.

Cause: this is a **typing/documentation gap, not a runtime one**. `ready-to-show` fires
identically on `BaseWindow` — confirmed empirically (`src/main/window.ts`, 2026-08-26; see the
next section for the one real caveat, which is about *when* it fires, not *whether* it exists).

**Corrected 2026-09-01:** an earlier version of this section made the same claim for
`titleBarStyle`, `titleBarOverlay` and `trafficLightPosition`. That was false — checked directly
against `node_modules/electron/electron.d.ts` (v44.0.0): all three are declared inside
`BaseWindowConstructorOptions` itself (`titleBarOverlay` at line 4039, `titleBarStyle` at line
4043, `trafficLightPosition` at line 4049), and `setTitleBarOverlay(...)` is a method on the
`BaseWindow` class (line 3569). Only `ready-to-show` is actually `BrowserWindow`-only. The
mistaken belief is itself the lesson below: check the `.d.ts` before assuming a gap, in either
direction.

**Fix: when context7 — or the `.d.ts` itself — is silent about `BaseWindow` for something
documented only on `BrowserWindow`, treat the silence as "unconfirmed", not "no".** Verify
empirically (a throwaway probe app is enough, or a direct grep of `electron.d.ts`) before
assuming either way. Subscribing to `ready-to-show` needs a narrow cast past the typed event
union — cast the method, not the whole object, so a genuine `BaseWindow`/`BrowserWindow`
mismatch would still be caught by the type-checker:

```ts
;(win as unknown as { once: (event: 'ready-to-show', cb: () => void) => void })
  .once('ready-to-show', showOnce)
```

## `ready-to-show` does not fire reliably when loading from a dev server

Build step 1 (2026-08-26): a `show: false` + `win.once('ready-to-show', () => win.show())`
window (`src/main/window.ts`) **never appeared** under `npm run dev` — no error, no crash, a
completely healthy process tree (main, GPU process, both renderers, confirmed repeatedly via
`ps`). It worked fine every time under Playwright-launched diagnostics and under the production
`loadFile()` path (`npm run smoke`). The difference: `npm run dev`'s chrome view loads via
`chrome.webContents.loadURL(devServerUrl)` (electron-vite's Vite dev server), not a built file.

**Root-caused only by adding `console.error` at every step of window creation and having a human
run `npm run dev` directly and paste the actual output** — every automated diagnostic this
session (querying `win.isVisible()`/`isFocused()`/`getBounds()` through Playwright) reported the
window as fully correct, because those diagnostics never exercised the dev-server load path at
all. The trace showed `chrome did-finish-load` firing normally, then **`ready-to-show` simply
never firing** within several seconds — `show()` was never called, on an otherwise perfectly
healthy window.

**Fix: race `ready-to-show` against a short fallback timer** (`src/main/window.ts`'s `showOnce`),
guarded so `show()` never runs twice if the event fires late, after the fallback already ran.
Do not rely on `ready-to-show` alone for a window whose content may come from a dev server —
only for the production `loadFile()` path is it proven prompt and reliable here.

**Process lesson, worth repeating for the next hard-to-reproduce Electron bug:** two plausible-
looking diagnoses were tried and both were dead ends before this one — a "wrong monitor"
misdiagnosis (misreading a display's reported dimensions as an unusual portrait monitor when it
was actually the user's real main screen) and, worse, a **regression** while chasing it (forcing
`ozone-platform: x11` to make explicit window positioning work, which segfaulted the GPU process
under XWayland on this machine). Both are recorded, not deleted, in the git history
(`04d44bc`) — they are exactly the kind of trap this file exists to save the next session from
re-discovering. The thing that actually worked was the least exotic tool available: ask the
human running the real environment to paste what they actually see, before trusting any
automated proxy for it again.

## `getContentBounds()` read inside a `'resize'` handler can return stale, pre-resize bounds

Symptom: laying out child `WebContentsView`s from `win.getContentBounds()` inside a `'resize'`
listener works fine for an ordinary drag-resize, but a **`maximize()`-triggered** resize leaves
the chrome and tab views at their pre-maximize width — no error, no crash, just a visibly wrong
layout the moment the window is maximized.

Cause: the stale read was measured here, on this X11 window manager; whether the staleness is
specific to this window manager or general to Electron/Chromium's resize dispatch was not
isolated. What **was** confirmed directly against `node_modules/electron/electron.d.ts`
(v44.0.0, lines 2373-2398, on the `BaseWindow` class): `'resize'` fires immediately on
`maximize()`, but a *synchronous* read of `win.getContentBounds()` inside that same handler
returns the bounds from **before** the resize, not after. `queueMicrotask` does not fix it — it
observes the same stale value. Only deferring to the next **macrotask** (`setImmediate`) sees the
settled bounds.

Electron's `'resized'` event, which exists specifically to sidestep this class of bug, is
declared `@platform darwin,win32` in the `.d.ts` — **it does not exist on Linux at all, on any
window manager**, so it was never an option here regardless of which part of the cause above
turns out to be WM-specific. `mvp-scope.md` puts Linux (AppImage + deb) first in the packaging
IN table, so the `setImmediate` deferral below is the fix on the primary target, not a
workaround for one desktop.

Fix (`src/main/window.ts`, commit `18b2e12`):

```ts
win.on('resize', () => {
  setImmediate(() => {
    layoutChrome()
    tabs.layout()
  })
})
```

Ordinary drag-resize is unaffected either way — it already fires `'resize'` repeatedly as the
drag continues, so one tick of latency per frame is not observable. Only a single-shot resize
(`maximize()`, or a programmatic `setBounds`) exposes the staleness.

## Match windows by URL via `app.windows()`, never `app.firstWindow()`

Already stated in full in `CLAUDE.md` §Start here, with the underlying research in
`docs/open-questions.md` C6 — read those; this is only the pointer. Once a `BaseWindow` holds
more than one `WebContentsView` (the shell's actual composition), match windows by URL via
`app.windows()`, never `app.firstWindow()`: view-add order is an implementation detail, not a
contract.

`scripts/smoke.mjs` has the pattern in use:

```js
const win = app.windows().find((w) => w.url().endsWith('index.html'))
if (win === undefined) throw new Error('chrome view not found in app.windows()')
```

## Known unsolved issue: Playwright can't always attach to a gate's window

Gate 3 (video playback) is **blocked**, not failed, on this. The app itself is fine — confirmed
by a direct, non-Playwright launch, where `dom-ready` and `did-finish-load` both fire
immediately and the page behaves exactly as gates 0/1a/1b/4 do. But launched through
Playwright's `_electron.launch()` + `firstWindow()`, the call times out after 30 seconds, even
though `DEBUG=pw:electron,pw:browser` shows Playwright's own CDP session to the main process
connecting cleanly — the browser-level DevTools WebSocket connects, but **no target-created
event for the window is ever logged.**

Six things were ruled out (full trail: `docs/planning/spike-results/gate-3.json`): a new
`protocol.registerSchemesAsPrivileged()` call, the real `mse.js` vs. a stub, a stray Electron
process holding a single-instance lock, system resource starvation, and a silent preload crash.
**Not yet tested:** the `<video>` element itself (the one thing genuinely unique to that gate's
DOM), and whether a raw CDP client can see the window that Playwright's own target auto-attach
is missing.

Gates 0, 1a, 1b and 4 all attach fine through the identical `launchElectron()` path — 4 was
specifically probed standalone before its full test was built, to confirm the issue is narrow
to gate 3's configuration rather than systemic. **If you hit an unexplained `firstWindow()`
timeout on a new gate or test, check this first** rather than re-deriving the six ruled-out
hypotheses from scratch.

## Two smoke-test traps — written up in full in `testing.md`, not repeated here

Both cost real time and are easy to reintroduce, but the complete write-up already lives in
`docs/development/testing.md` §"What `npm run smoke` is, and what it is not" — read that; this
is only the pointer:

- **A `waitFor` helper must never be pointed at a condition the pre-action state already
  satisfies.** It returns the instant its predicate holds, so that is a no-op reporting green —
  this shipped twice in `scripts/smoke.mjs` and both passed while the exact regression they
  existed to catch was present (commit `5fc883b`). Establish an observable *transition* first, or
  settle and read once. A refusal — a navigation that must **not** happen — cannot be polled for
  at all, only waited out.
- **`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`** makes a launch hermetic
  *structurally*, not by assertion. Deliberately a whole-world blackhole rather than a per-host
  rule — a per-host rule only protects the host somebody thought of.

## Reference: files this knowledge came from

- `docs/planning/spike-verdict.md` — the readable summary, start there.
- `docs/planning/spike-results/gate-{0,1a,1b,2,3,4}.json` — raw measured evidence.
- `docs/planning/week-0-spike-plan.md` and `spike-remaining-gates-plan.md` — the execution
  plans, including the state table and traps list as they were understood mid-spike.
- `docs/architecture/capability-api.md` §Design rules, §Throughput — where the durable lessons
  (shim completeness, error visibility, transferables) are folded into the actual spec.
- `spike/launch.mjs`, `spike/gate1b/vite.config.js`, `spike/gate1b/shim/*.js` — the reference
  implementations. The `spike/` directory itself is throwaway and will be deleted once the
  owner has reviewed the verdict; this skill and the docs above are what should outlive it.
- `src/main/window.ts`'s `showOnce` — the `ready-to-show`-under-dev-server fix. Commit `04d44bc`
  (build step 1) has the full incident, including the two dead ends ruled out first.
- Commit `18b2e12` has the full `getContentBounds()`/`setImmediate` incident. It exists only on
  `stream/backlog-09-chrome-restyle`, a local branch not yet merged and not pushed to any remote
  as of this writing — `git show 18b2e12` fails for anyone who has not fetched that branch. The
  code block above is the whole fix, so nothing is lost if that branch never lands.
