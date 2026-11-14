# Driving Electron with Playwright's `_electron`

## Match windows by URL through `app.windows()`

The shell is one `BaseWindow` holding several `WebContentsView`s, and view-add order is an implementation detail, so
`app.firstWindow()` may return any of them. `scripts/smoke.mjs` has the pattern in use:

```js
const win = app.windows().find((w) => w.url().endsWith('index.html'))
if (win === undefined) throw new Error('chrome view not found in app.windows()')
```

The research behind it is `docs/decisions/resolved-questions.md` C6, and `docs/development/testing.md` section
"Playwright's `_electron` driver and this shell" has the rest, including that a driven page's visibility is forced to
`'visible'`.

## Playwright could not attach to gate 3's window (closed, not pursued)

Gate 3 (video playback) is **blocked**, not failed, on this. The app itself is fine, confirmed by a direct,
non-Playwright launch, where `dom-ready` and `did-finish-load` both fire immediately and the page behaves exactly as
gates 0/1a/1b/4 do. But launched through Playwright's `_electron.launch()` + `firstWindow()`, the call times out after
30 seconds, even though `DEBUG=pw:electron,pw:browser` shows Playwright's own CDP session to the main process
connecting cleanly: the browser-level DevTools WebSocket connects, but **no target-created event for the window is
ever logged.**

Ruled out (full trail: `docs/planning/spike-results/gate-3.json`): a new `protocol.registerSchemesAsPrivileged()`
call, the real `mse.js` vs. a stub, a stray Electron process holding a single-instance lock, system resource
starvation, and a silent preload crash. The direct launch loading normally places the fault in the
Playwright/Electron integration, not in the app. **Not tested:** the `<video>` element itself (the one thing unique to
that gate's DOM), and whether a raw CDP client can see the window that Playwright's target auto-attach misses.

Gates 0, 1a, 1b and 4 all attach fine through the identical `launchElectron()` path, and the shell's e2e suite attaches
cleanly. **If you hit an unexplained `firstWindow()` timeout on a new gate or test, check this first** rather than
re-deriving the ruled-out hypotheses from scratch.

## Two smoke-test traps

The complete write-up is `docs/development/testing.md` section "What `npm run smoke` is, and what it is not":

- **A `waitFor` helper must never be pointed at a condition the pre-action state already satisfies.** It returns the
  instant its predicate holds, so that is a no-op reporting green, and it passes while the exact regression it exists
  to catch is present. Establish an observable *transition* first, or settle and read once. A refusal (a navigation
  that must **not** happen) cannot be polled for at all, only waited out.
- **`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`** makes a launch hermetic *structurally*, not by
  assertion. Deliberately a whole-world blackhole rather than a per-host rule: a per-host rule only protects the host
  somebody thought of.

## Screenshots, hidden views and dead renderers (measured on Electron 44 under xvfb)

What `test/support/qa-evidence.mjs` and `test/support/qa-visual.ts` rely on, each measured here:

- **`webContents.capturePage()` throws `UnknownVizError`** with no GPU. **Playwright's `page.screenshot()` works** on
  every `WebContentsView` (the chrome view and each tab view, at their own size) with no GPU switch, and
  `app.context().tracing` with `screenshots: true` works too. Use Playwright's, per view; the window composite is
  built from the views' bounds (`BaseWindow.getAllWindows()[n].contentView.children`).
- **A hidden view (a background tab) cannot paint.** `page.screenshot()` on one waits for its whole timeout, and an
  awaited `requestAnimationFrame` never resolves, so a `page.evaluate` that awaits one never returns. Shoot and settle
  only the views `getVisible()` reports.
- **A failed load splits the identity.** The view's `webContents.getURL()` is the URL that failed; Playwright's page
  for it reports `chrome-error://chromewebdata/`. Pairing views to pages by URL alone drops it; pair by size when the
  URL finds nothing.
- **`webContents.forcefullyCrashRenderer()` hangs the harness.** Kill the renderer's real pid instead:
  `webContents.getOSProcessId()`, then `process.kill(pid, 'SIGKILL')`. Chromium then reports `render-process-gone`
  with `reason: 'killed'`.
- **Watch the main process with `process.on('uncaughtExceptionMonitor')`, never `'uncaughtException'`.** Not measured,
  because it cannot be provoked safely: Electron documents that a plain listener suppresses its own error dialog,
  which would change what a test observes, and that dialog blocks a headless run, so no spec provokes an uncaught
  exception.
- **Playwright's mouse stays where the last click left it**, so the button it clicked keeps its hover look in every
  later screenshot. Park the pointer in empty tab-strip space before a capture.
