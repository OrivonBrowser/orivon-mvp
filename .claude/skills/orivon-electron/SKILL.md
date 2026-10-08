---
name: "orivon-electron"
description: Use when writing or debugging code that runs webtorrent (or anything with a similar Node-dependency graph) inside an Orivon Electron renderer, when building the real orivon-node-shim, when an Electron+Vite renderer build fails with a confusing module-resolution error, when a gate/test hangs with no error under Playwright's _electron driver, or when anything Electron-related behaves inexplicably in this repository's dev environment. Captures Electron behaviour measured in this repository that is written down nowhere else.
---

# Orivon + Electron: measured behaviour and traps

Most of the evidence is in `docs/planning/spike-verdict.md` and
`docs/planning/spike-results/*.json` (four spike gates pass, one is blocked). None of this is
written down anywhere else. Read it before re-deriving any of it.

## First: check the environment for poison

**This machine has `ELECTRON_RUN_AS_NODE=1` set in the ambient shell environment.** It makes
the Electron binary run as plain Node — no windows, no `require('electron')`, no
`MessagePortMain`. It does not fail loudly; it fails in ways that look like unrelated bugs, such
as a module-format error that has nothing to do with module formats.

**Never launch Electron directly.** Go through `test/support/launch-electron.mjs` (or
`spike/launch.mjs`'s `launchElectron()` for a spike gate), which strips the variable and asserts
`MessageChannelMain` exists before returning. New Electron-launching code must do the same:
strip `ELECTRON_RUN_AS_NODE` before spawning, or a test can produce a confident, completely
false result.

```js
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [appPath], env })
const isReal = await app.evaluate(({ app, MessageChannelMain }) =>
  typeof app?.getVersion === 'function' && typeof MessageChannelMain === 'function')
if (!isReal) throw new Error('not real Electron — refuse to trust any result from this run')
```

## A launch that leaves anything behind is not a finished launch

The section above stops a launch being fake; this one stops a launch being permanent. What a
*failed* e2e run can leave behind on this machine: orphaned Electron processes reparented to
`systemd --user` (the runner exited and left the tree alive), `<defunct>` zombies, a launch with
**no `Xvfb` process at all** (so it painted on the real display), and abandoned
`/tmp/orivon-test-*` profile directories (77 of them, 105 MB, in one measured case).

Four rules, and they are part of the test contract rather than cleanup hygiene:

1. **`scripts/run-headless.mjs` on every launch, no exceptions.**
   `env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs ...`. The `-u` is the trap above;
   the runner puts the launch on a virtual display, which bare `xvfb-run` does not guarantee on a
   Wayland desktop (see the last section).
2. **Teardown must run on the failure path.** This is where it actually breaks. A bounded
   `app.close()` race works when the test passes and silently does not when it throws — put the
   teardown in a `finally`/`afterAll` that always runs, SIGKILL the process tree after the bounded
   wait, and reap the child so no zombie survives. `app.close()` can hang indefinitely (the e2e
   helpers document it), so the bounded wait and the kill must both run on the failure path.
3. **Check for survivors before reporting the run.** Zero Electron processes, zero zombies, zero
   stray `Xvfb`. A run that leaves a process is not a finished run.
4. **Delete the `--user-data-dir` temp profile** the run created.

**The trap inside the check itself:** `pgrep -f node_modules/electron/dist/electron` matches *the
command doing the checking*, because that string is in its own argv. It reports processes that do
not exist, which reads as a leak and sends you hunting for nothing. The same happens when the
string sits anywhere in a larger pipeline you are running. Resolve `/proc/<pid>/exe` and compare
the real binary path instead, or at least filter with `ps -eo pid,cmd | grep -F ... | grep -v grep`:

```sh
for p in /proc/[0-9]*; do
  case "$(readlink "$p/exe" 2>/dev/null)" in
    *node_modules/electron/dist/electron*) echo "survivor: $(basename "$p")" ;;
  esac
done
```

## The renderer bundling recipe

webtorrent's `browser` field maps `net`, `bittorrent-dht`, `ut_pex`, `conn-pool`, `crypto`,
`fs`, `http`, `os` and more to `false`, which makes it WebRTC-only — precisely the outcome
`ADR-0001` reason 3 exists to defeat. Beating this needs a specific, non-obvious set of Vite
aliases. This is the complete, verified list (`spike/gate1b/vite.config.js` is the reference
implementation and the superset; `gate1a`'s config lacks the DHT and MSE entries, so do not copy
it as the full list).

| Alias target | Replacement | Why |
|---|---|---|
| `net` | `shim/net.js` (project-specific) | **The load-bearing one.** webtorrent's `torrent.js` refuses all TCP unless `typeof net.connect === 'function'`. Must also export `isIP`/`isIPv4`/`isIPv6` — see "A shim must mirror the whole surface" below. |
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

## The file-protocol fuse is off, and cookie encryption on, in this repository's binaries

On Linux, `npm install` (the `postinstall` hook) and `npm run install:electron` turn `grantFileProtocolExtraPrivileges`
off and `enableCookieEncryption` on in `node_modules/electron/dist/electron`, as `electron-builder.yml` sets them for a
package (`CHECKOUT_FUSES` in `scripts/install-electron.mjs`; a unit test fails when the two disagree). Cookie encryption
is one-way per profile: a binary without the fuse reads none of the cookies an encrypting binary wrote and deletes them,
signing the person out of every site. A run from source has a profile of its own (`~/.config/orivon-source`, ADR-0057),
which the fuse keeps readable when it moves between a checkout and a package.
Every test launch passes `--password-store=basic`, so the cookie key never comes from the desktop's keyring.
With the file-protocol fuse off, a `file:` page's module scripts are blocked (a null origin), a canvas read of a sibling image
throws `SecurityError` and `fetch` of a sibling file rejects, so the shell's own pages load from
`orivon-shell://renderer/...` instead (`src/main/pages/shell-scheme.ts`). After syncing `main`, run
`npm run install:electron` in each checkout: it writes a new file and renames it over its own path, because a
`cp -al` worktree shares the binary's inode with the checkout it came from and an in-place write would flip
that one too (and fail with `ETXTBSY` while it runs). Never `flipFuses` a binary in `node_modules` directly.

## `file://` is a secure context only while the file-protocol fuse is on

Service workers are ordinarily gated to secure contexts (`https:` or `localhost`). **Electron treats a
`file://` origin loaded via `loadFile()` as a secure context** while `grantFileProtocolExtraPrivileges` is on,
and `navigator.serviceWorker.register()` then succeeds with no flag and no workaround (spike gate 3,
`docs/planning/spike-verdict.md`, run with the fuse on). A package and a Linux checkout's binary
have it off (the section above), so nothing here loads its pages from `file:` and the result does not
carry over: a page that needs a service worker is served from a scheme or an origin that is a secure context
by itself.

**What this does not prove:** gate 3 itself is **BLOCKED**, not passed — `register()` succeeding
is confirmed, but the end-to-end media path through the `<video>` element is still unproven,
because Playwright can't attach to that gate's window (see the known-unsolved-issue section
below) and the element itself is explicitly "not yet tested" in `spike-verdict.md`.

## A missing `path` polyfill — when an error names the wrong thing entirely

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

BitTorrent protocol encryption (MSE) runs in a renderer, although it needs Diffie-Hellman, a
synchronous SHA-1 and RC4, none of which WebCrypto usefully provides:

- `bittorrent-protocol/mse.js` already ships a **complete pure-JS RC4 fallback**, selected
  automatically whenever `crypto.createCipheriv('rc4', ...)` throws (which it does, on
  `crypto-browserify`). RC4 is not the blocker: the `nativeRC4` detection line alone suggests it
  is, and the fifteen lines under it are the fallback.
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
- **Never design a reply-carrying protocol over `MessagePortMain` without a timeout.** A reply
  promise with no timeout hangs indefinitely, waiting for a message that was already silently
  dropped.
- **Do not reach for transferables as a throughput optimisation on this path.** They are not
  available. Structured clone (which copies) is not a fallback for a rescue plan — it is the
  *only* mechanism, and it is fast enough on its own: 313–1134 MB/s measured, against a
  1–5 MB/s product requirement.

## A shim must mirror the whole surface a dependency touches, not the obvious methods

`bittorrent-dht`'s RPC layer calls `net.isIP(peer.host)` before every send, to decide whether to
send directly or resolve via DNS first. A `net` shim that implements `connect`, `createServer`
and `Socket` — a complete-looking socket API — but not `isIP` leaves the DHT with its listening
socket bound and **sending nothing, ever**, with no error and no warning.

It is silent because the throw happens inside a `process.nextTick` callback, and the spike's
`globals.js` polyfills `nextTick` with `queueMicrotask`. **Node's real `nextTick` surfaces an
uncaught exception to the process; `queueMicrotask` does not route into the same handlers.** A
polyfill chosen for API-shape compatibility changes error visibility in exactly the wrong
direction for code whose job is partly security-relevant.

**In `orivon-node-shim` (A10), audit every Node timing primitive (`nextTick`, `setImmediate`,
microtask ordering) for this class of behavioural change, not just for call-signature
compatibility.** A shim that type-checks and passes a synthetic test can still be a black hole
for real dependency errors.

## Why webtorrent isn't in the shell `package.json`

`node-datachannel` (`@thaunknown/simple-peer → webrtc-polyfill → node-datachannel`) is a
**hard, non-optional** transitive dependency of webtorrent. Its install script is:

```
prebuild-install -r napi || (npm install --ignore-scripts --production=false && npm run _prebuild)
```

It tries a prebuild and **falls back to compiling with CMake** when no prebuild matches the
platform/ABI — exactly the Rule 8 threat (breaks `npm install` on a machine without a C++
toolchain, i.e. most contributors on Windows/macOS). This is why webtorrent lives in an isolated
`spike/app/` with its own `package.json`, never installed at the shell level. The built renderer bundle contains zero `node-datachannel` references — confirmed
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
identically on `BaseWindow` — confirmed empirically in `src/main/shell/window.ts` (see the next
section for the one real caveat, which is about *when* it fires, not *whether* it exists).

`titleBarStyle`, `titleBarOverlay` and `trafficLightPosition` are **not** in this gap: all three
are declared inside `BaseWindowConstructorOptions` itself (`node_modules/electron/electron.d.ts`
v44.0.0: `titleBarOverlay` at line 4039, `titleBarStyle` at 4043, `trafficLightPosition` at
4049), and `setTitleBarOverlay(...)` is a method on the `BaseWindow` class (line 3569). Only
`ready-to-show` is `BrowserWindow`-only in the types. Check the `.d.ts` before assuming a gap, in
either direction.

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

A `show: false` + `win.once('ready-to-show', () => win.show())` window
(`src/main/shell/window.ts`) can **never appear** under `npm run dev` — no error, no crash, a
completely healthy process tree (main, GPU process, both renderers, per `ps`). It appears every
time under Playwright-launched runs and on the production `loadFile()` path (`npm run smoke`).
The difference: `npm run dev`'s chrome view loads via `chrome.webContents.loadURL(devServerUrl)`
(electron-vite's Vite dev server), not a built file.

**Automated diagnostics cannot see it.** Querying `win.isVisible()`/`isFocused()`/`getBounds()`
through Playwright reports the window as fully correct, because it never exercises the
dev-server load path. What finds it: `console.error` at every step of window creation, and the
human running `npm run dev` pasting the actual output. The trace shows `chrome did-finish-load`
firing normally, then **`ready-to-show` never firing** within several seconds, so `show()` is
never called on an otherwise healthy window.

**Fix: race `ready-to-show` against a short fallback timer** (`src/main/shell/window.ts`'s `showOnce`),
guarded so `show()` never runs twice if the event fires late, after the fallback already ran.
Do not rely on `ready-to-show` alone for a window whose content may come from a dev server —
only for the production `loadFile()` path is it proven prompt and reliable here.

**Two dead ends to skip on the next hard-to-reproduce Electron bug** (commit `04d44bc` has the
full trail): the display's reported dimensions are the user's real main screen, not an unusual
portrait monitor; and forcing `ozone-platform: x11` to make explicit window positioning work
segfaults the GPU process under XWayland on this machine. The least exotic tool is the one that
works: ask the human running the real environment to paste what they actually see, before
trusting any automated proxy for it.

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
turns out to be WM-specific. Linux, Windows and macOS are equal targets and Linux runs on X11 and
Wayland both, so the `setImmediate` deferral below is the fix on the Linux path, not a workaround
for one desktop.

Fix (`src/main/shell/window.ts`'s `'resize'` handler):

```ts
win.on('resize', () => {
  setImmediate(() => { if (!win.isDestroyed()) layoutAll() })
})
```

Ordinary drag-resize is unaffected either way — it already fires `'resize'` repeatedly as the
drag continues, so one tick of latency per frame is not observable. Only a single-shot resize
(`maximize()`, or a programmatic `setBounds`) exposes the staleness.

## Match windows by URL via `app.windows()`, never `app.firstWindow()`

The underlying research is `docs/open-questions.md` C6; this is only the pointer. Once a `BaseWindow` holds
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
`docs/development/testing.md` section "What `npm run smoke` is, and what it is not" — read that; this
is only the pointer:

- **A `waitFor` helper must never be pointed at a condition the pre-action state already
  satisfies.** It returns the instant its predicate holds, so that is a no-op reporting green,
  and it passes while the exact regression it exists to catch is present. Establish an
  observable *transition* first, or settle and read once. A refusal — a navigation that must **not** happen — cannot be polled for
  at all, only waited out.
- **`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`** makes a launch hermetic
  *structurally*, not by assertion. Deliberately a whole-world blackhole rather than a per-host
  rule — a per-host rule only protects the host somebody thought of.

## Reference: files this knowledge came from

- `docs/planning/spike-verdict.md` — the readable summary, start there.
- `docs/planning/spike-results/gate-{0,1a,1b,2,3,4}.json` — raw measured evidence.
- `docs/planning/week-0-spike-plan.md` and `spike-remaining-gates-plan.md` — the spike's
  execution plans, with its state table and traps list.
- `docs/architecture/capability-api.md` section Design rules, section Throughput — where the durable lessons
  (shim completeness, error visibility, transferables) are folded into the actual spec.
- `spike/launch.mjs`, `spike/gate1b/vite.config.js`, `spike/gate1b/shim/*.js` — the reference
  implementations. The `spike/` directory is throwaway; this skill and the docs above are what
  outlive it.
- `src/main/shell/window.ts`'s `showOnce` — the `ready-to-show`-under-dev-server fix, and its
  `'resize'` handler — the `getContentBounds()`/`setImmediate` fix.

## `xvfb-run` is not enough on a Wayland desktop

**The symptom:** an agent runs the e2e suite "headlessly", the log says *using a virtual display*,
and a window opens **on the owner's real screen, in front of what they are typing**, stealing focus.

**The cause.** `xvfb-run` starts an X server and sets `DISPLAY`. It does nothing about
`WAYLAND_DISPLAY`, which a Wayland session leaves in the environment. Electron's ozone layer
auto-detects a backend, finds Wayland available, prefers it, and connects to the **real
compositor**. The virtual display sits unused. Nothing errors, and the reassuring log line is
printed by the wrapper before any of this happens.

**How to tell which backend a running Electron actually chose** — do this rather than trusting a
log line:

    ps -eo cmd | grep -F node_modules/electron/dist/electron | grep -oE 'ozone-platform=[a-z0-9]+'

`wayland` means it is on the real desktop. `x11` under `xvfb-run` means it is genuinely virtual.

**The fix, already in `scripts/run-headless.mjs`:** remove `WAYLAND_DISPLAY` from the child
environment (and downgrade `XDG_SESSION_TYPE`) whenever the virtual-display path is taken, so X11
is the only backend ozone can discover — the one `xvfb-run` just pointed at the virtual display.

**Do NOT "fix" this by passing `--ozone-platform=x11`.** `src/main/index.ts`'s own header warns that
forcing it there crashes the GPU process. Changing what the child can *discover* is safe; changing
what the app *asks for* is not.

### Two false positives that will waste your time

**1. A `dev` session looks exactly like an orphaned test tree.** `pgrep` reporting many Electron
processes with no `Xvfb` running is what a leaked test tree looks like — and also what `npm run dev`
looks like.
Killing it destroys the owner's live work. **The distinguishing signal is the profile path and the
parent**, never the process count:

    ps -eo pid,ppid,cmd | grep -F node_modules/electron/dist/electron | grep -oE 'user-data-dir=[^ ]*'

`--user-data-dir=~/.config/orivon` with a live `electron-vite dev` parent is the **owner's
own session — leave it alone.** A `/tmp/orivon-test-*` profile is a test run and is yours to clean.

**2. `pgrep -f` matches your own shell command**, so the post-run survivor check can report a
leak that does not exist. Use the `/proc/<pid>/exe` recipe in "A launch that leaves anything
behind" before concluding a run left something, or you will "clean up" a run that already tore
down correctly.

## Chrome extensions: the sandbox, service-worker preloads, and `net.fetch`

- **Playwright's `_electron.launch` adds `--no-sandbox` on Linux** unless the launch passes
  `chromiumSandbox: true`, and hides it from `process.argv` (`app.commandLine.hasSwitch` still
  sees it). `launchElectron({ sandbox: true })` in `test/support/launch-electron.mjs` passes it.
- **Electron runs no `service-worker` session preload under `--no-sandbox`.** An extension's
  worker then lacks everything electron-chrome-extensions injects (`tabs` events, `windows`,
  `action`), and real extensions die at start. Extension e2e tests launch sandboxed (A289).
- **Sandboxed, a newly loaded extension's first worker still misses the preload**, every time;
  `src/main/extensions/extension-sw-preload-recovery.ts` checks each worker and reloads once.
- **`net.fetch` on a session that holds an extension declaring `webRequest` or
  `declarativeNetRequest` segfaults the main process** (Electron 44, 10 of 10 runs without an
  embedder `webRequest` listener). Orivon strips both from every extension copy it loads
  (`ADR-0043`).
- **Any embedder `session.webRequest` listener silences extensions' own `webRequest` and
  `declarativeNetRequest`**, and static dNR rules never apply at all.

## Screenshots, hidden views and dead renderers (measured on Electron 44 under xvfb)

What `test/support/qa-evidence.mjs` and `test/support/qa-visual.ts` rely on, each measured here:

- **`webContents.capturePage()` throws `UnknownVizError`** with no GPU. **Playwright's
  `page.screenshot()` works** on every `WebContentsView` (the chrome view and each tab view, at their own
  size) with no GPU switch, and `app.context().tracing` with `screenshots: true` works too. Use
  Playwright's, per view; the window composite is built from the views' bounds
  (`BaseWindow.getAllWindows()[n].contentView.children`).
- **A hidden view (a background tab) cannot paint.** `page.screenshot()` on one waits for its whole
  timeout, and an awaited `requestAnimationFrame` never resolves, so a `page.evaluate` that awaits one
  never returns. Shoot and settle only the views `getVisible()` reports.
- **A failed load splits the identity.** The view's `webContents.getURL()` is the URL that failed;
  Playwright's page for it reports `chrome-error://chromewebdata/`. Pairing views to pages by URL
  alone drops it; pair by size when the URL finds nothing.
- **`webContents.forcefullyCrashRenderer()` hangs the harness.** Kill the renderer's real pid
  instead: `webContents.getOSProcessId()`, then `process.kill(pid, 'SIGKILL')`. Chromium then reports
  `render-process-gone` with `reason: 'killed'`.
- **Watch the main process with `process.on('uncaughtExceptionMonitor')`, never `'uncaughtException'`.**
  Not measured, because it cannot be provoked safely: Electron documents that a plain listener
  suppresses its own error dialog, which would change what a test observes, and that dialog blocks a
  headless run, so no spec provokes an uncaught exception.
- **Playwright's mouse stays where the last click left it**, so the button it clicked keeps its
  hover look in every later screenshot. Park the pointer in empty tab-strip space before a capture.

## A main-process SIGSEGV has no names until the release's symbols are matched to the core

`coredumpctl` and `gdb` show Electron frames as raw offsets in the stripped binary. The symbols are in the release's own
asset, `electron-v<version>-linux-x64-symbols.zip` (GitHub releases of `electron/electron`), as
`electron.breakpad.syms`. Take the offsets of the frames from the core (`gdb -batch -ex bt` on the dump, minus the
mapping's load address), then find the `FUNC` record whose start and size cover each one: a record is
`FUNC [m] <start> <size> <param size> <name>`, all hex, so a short `awk` over the file does it. Frame #0 is the
answer; the first frame in `Run` of a `...Function` class names the extension API that was running. That is how a
store install's crash was found: the native status handler of the Chrome Web Store page's API, reached after an
extension load made the renderer rebuild `chrome.*`. Match the symbols to the exact Electron version in
`node_modules/electron/package.json`; another version's offsets name a different function without any error.
