# `BaseWindow`, `WebContentsView` and window timing

## `ready-to-show` is typed on `BrowserWindow` only, but fires identically on `BaseWindow`

Symptom: TypeScript's own types, and context7's docs, show `ready-to-show` only on `BrowserWindow`'s typed event
union. Nothing in either source suggests it exists on `BaseWindow` at all.

Cause: a **typing/documentation gap, not a runtime one**. `ready-to-show` fires identically on `BaseWindow`, confirmed
empirically in `src/main/shell/window-frame.ts` (`showWhenReady`). The one real caveat is about *when* it fires, not
*whether* it exists (next section).

`titleBarStyle`, `titleBarOverlay` and `trafficLightPosition` are **not** in this gap: all three are declared inside
`BaseWindowConstructorOptions` itself, and `setTitleBarOverlay(...)` is a method on the `BaseWindow` class. Only
`ready-to-show` is `BrowserWindow`-only in the types. Line numbers move with the Electron version, so check the
installed file:

    grep -n -E "ready-to-show|titleBarStyle\?|titleBarOverlay\?|trafficLightPosition\?|setTitleBarOverlay\(|^  (class|interface) (BaseWindow|BrowserWindow)" node_modules/electron/electron.d.ts

**Fix: when context7, or the `.d.ts` itself, is silent about `BaseWindow` for something documented only on
`BrowserWindow`, treat the silence as "unconfirmed", not "no".** Verify empirically (a throwaway probe app is enough,
or a direct grep of `electron.d.ts`) before assuming either way. Subscribing to `ready-to-show` needs a narrow cast
past the typed event union: cast the method, not the whole object, so a genuine `BaseWindow`/`BrowserWindow` mismatch
would still be caught by the type-checker:

```ts
;(win as unknown as { once: (event: 'ready-to-show', cb: () => void) => void })
  .once('ready-to-show', showOnce)
```

## `ready-to-show` does not fire reliably when loading from a dev server

A `show: false` window shown on `ready-to-show` can **never appear** under `npm run dev`: no error, no crash, a
completely healthy process tree (main, GPU process, both renderers, per `ps`). It appears every time under
Playwright-launched runs and on the production `loadFile()` path (`npm run smoke`). The difference: `npm run dev`'s
chrome view loads via `chrome.webContents.loadURL(devServerUrl)` (electron-vite's Vite dev server), not a built file.

**Automated diagnostics cannot see it.** Querying `win.isVisible()`/`isFocused()`/`getBounds()` through Playwright
reports the window as fully correct, because it never exercises the dev-server load path. What finds it:
`console.error` at every step of window creation, and the human running `npm run dev` pasting the actual output. The
trace shows `chrome did-finish-load` firing normally, then **`ready-to-show` never firing** within several seconds, so
`show()` is never called on an otherwise healthy window.

**Fix: race `ready-to-show` against a short fallback timer**: `showOnce` and its `setTimeout(showOnce, 1000)` in
`src/main/shell/window-frame.ts`, guarded so `show()` never runs twice if the event fires late, after the fallback
already ran. Do not rely on `ready-to-show` alone for a window whose content may come from a dev server; only for the
production `loadFile()` path is it proven prompt and reliable here.

**Two dead ends to skip on the next hard-to-reproduce Electron bug:** the display's reported dimensions are the user's
real main screen, not an unusual portrait monitor; and forcing `ozone-platform: x11` to make explicit window
positioning work segfaults the GPU process under XWayland on this machine. The least exotic tool is the one that
works: ask the human running the real environment to paste what they actually see, before trusting any automated
proxy for it.

## `getContentBounds()` read inside a `'resize'` handler can return stale, pre-resize bounds

Symptom: laying out child `WebContentsView`s from `win.getContentBounds()` inside a `'resize'` listener works fine for
an ordinary drag-resize, but a **`maximize()`-triggered** resize leaves the chrome and tab views at their pre-maximize
width: no error, no crash, a visibly wrong layout the moment the window is maximized.

Cause: measured here, on this X11 window manager; whether the staleness is specific to this window manager or general
to Electron/Chromium's resize dispatch was not isolated. In `electron.d.ts` (on the `BaseWindow` class), `'resize'`
fires immediately on `maximize()`, but a *synchronous* read of `win.getContentBounds()` inside that same handler
returns the bounds from **before** the resize. `queueMicrotask` does not fix it: it observes the same stale value.
Deferring to the next **macrotask** (`setImmediate`) sees the settled bounds, though the window manager can still
report a new size in steps after that.

Electron's `'resized'` event, which exists to sidestep this class of bug, is declared `@platform darwin,win32` in the
`.d.ts`: **it does not exist on Linux at all, on any window manager**, so it was never an option here. Linux, Windows
and macOS are equal targets and Linux runs on X11 and Wayland both, so the deferral below is the fix on the Linux
path, not a workaround for one desktop.

Fix: `relayoutOnSizeChange` (`src/main/shell/window-size-settle.ts`, called from `src/main/shell/window.ts`). On
`resize`, `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen` and `restore` it lays out on
`setImmediate`, then reads the size again at 60, 250 and 800 ms and lays out again whenever the size has moved since
the last layout. Ordinary drag-resize is unaffected either way: it already fires `'resize'` repeatedly as the drag
continues, so one tick of latency per frame is not observable. Only a single-shot resize (`maximize()`, or a
programmatic `setBounds`) exposes the staleness.
