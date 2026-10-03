# Performance audit: CPU and memory, 2026-10-03

What makes this build heavy on CPU and memory, measured on `main` at `7fa137b1`, and what to change:
now, next, and as standing rules for later work. §Fix plan says which of the changes this audit led
to have landed.

## The 10 GB report: an extension store feeding on itself

The owner's report (interacting with the new-tab page, the browser reached 10 GB and lagged) was not
the new-tab page. The vendored extension library aliased `chrome.storage.managed` to
`chrome.storage.local`, and uBlock Origin copies `managed.get()` into `local` under
`cachedManagedStorage` each time it reads its admin settings. Every start copied the whole local
store, the previous copy included, into itself. Unnoticed for four days of exponential growth, it
reached a single 908 MB value, 4.2 GB on disk, and gigabytes of memory as each start parsed and
rewrote it. `managed` is now an empty, read-only store, as in Chrome with no policy set (PR #83,
UPSTREAM.md patch 63), and the owner's profile was cleared of the value.

## Method

- A static read of the main process, the shell renderer, the preloads and the vendored extension
  libraries.
- A headless probe, [`scripts/perf-probe.mjs`](../../scripts/perf-probe.mjs) (`npm run
  perf:probe`): the ordinary build under xvfb, silent, on a fresh profile, with every host but
  loopback blackholed (the light-client run excepted). It reads each process's CPU from
  `/proc/<pid>/stat` and its memory as PSS from `/proc/<pid>/smaps_rollup`, so pages shared between
  processes are not counted twice. It ran inside this machine's heavy-command cgroup (two cores), so
  the absolute numbers are this machine's; the comparisons are what carry.
- Test pages served on loopback: a static page with a favicon; a "ticker" page that changes its
  title every 500 ms, as a mail or chat tab's unread count does; a page with 300 images.
- CPU is the percent of one core, averaged over 20 s (10 s for the image load).

## Measured baseline

| Scene | Processes | Memory (PSS) | CPU, total | Largest CPU users |
|---|---|---|---|---|
| Fresh window, idle, light client off | 8 | 354 MB | 0.5% | none above 0.2% |
| Fresh window, idle, light client on | 8 | 292-296 MB | 1.9-2.5% | verifier 1.7-1.9% |
| 10 static tabs, idle | 18 | 508 MB | 0.5% | none above 0.2% |
| 10 static tabs and one ticker tab | 19 | 529 MB | 3.8% | toolbar 2.1%, main 1.3% |
| 31 static tabs, ticker tab in the background | 40 | 887 MB | 6.7% | toolbar 2.5%, main 1.7% |
| The same, loading the 300-image page | 41 | 927 MB | 16.7% | main 5.6%, toolbar 3.7%, network 2.4% |

Also measured:

- One ticker tab made the main process write 43 KB per 20 s with 11 tabs open, and 109 KB per 20 s
  with 31. The writes grow with the number of tabs, not with what changed. `history.db-wal` reached
  1.5 MB in about 90 s while `history.db` stayed at 53 KB.
- A CPU profile of the main process through the tab scenes (taken from inside it with
  `node:inspector`) found its JavaScript idle 96% of the time, and one hot spot: `fsyncSync`, under
  the session store's write, at 2.7% of samples with nothing else above 0.3%.
- Each push of tab state to the toolbar carried about 560 bytes per tab (6.8 KB at 11 tabs, 17.4 KB
  at 31) with a 1 KB test icon. Real icons are larger.
- A background tab's page keeps `document.visibilityState === 'visible'`, and its timers keep their
  full rate (10 a second for a 100 ms interval). Only `requestAnimationFrame` stops.
- The verifier process holds 45-69 MB even with the light client off.
- Every tab is a renderer process of its own: 16-20 MB for a trivial page.

## What costs, ranked

### 1. A page that retitles itself rewrites the session, synchronously, twice a second (measured)

The session recorder (`src/main/session-restore/session-recorder.ts`) counted a change of any tab's
title as a change of the session, so a mail or chat tab's unread count rewrote the whole
`session.json` each time, and the store wrote it with `writeFileAtomic`: a synchronous write and two
`fsync`s on the main thread, the thread that routes input, IPC and navigation. History also wrote
down every title change of every page. These two were most of the main process's writes and its only
JavaScript hot spot; a slow disk turns each `fsync` into a visible stall.

### 2. Each tab event costs work in proportion to every tab, three times over (measured)

A title change, a load starting or stopping, an in-page navigation or a new icon in any tab
(`src/main/shell/tab-view.ts`, its `emitState` calls) runs `TabManager.changed()`, which:

1. rebuilds every tab's state, several native calls per tab (`tab-state.ts`);
2. in `pushState()` (`window-state.ts`), for every tab with an icon: decodes and re-encodes its data
   URL and scans every bookmark (`fillMissingFavicon`), and queues a history write that sanitizes
   the icon again, rewrites its row and runs a `COUNT(*)`/`ORDER BY` trim under `secure_delete`
   (`history-favicons.ts`);
3. sends the whole state, every icon included, to the toolbar, which removes and recreates every tab
   element and group chip (`src/renderer/chrome/tab-strip.ts`), then forces a layout.

The toolbar renderer was the largest CPU user in every scene with tabs. Thirty tabs with three mail
or chat tabs ticking once a second do all of this three times a second, all day.

### 3. Background tabs are never hidden to the page (measured)

Electron 44 does not mark a `WebContentsView` hidden when it leaves its window. Detaching it, as
`pane-host.ts` does, stops animation frames, but the page still reads as visible. Chromium then
applies none of its background-tab throttling (timers woken once a second, then far less after five
minutes), and web apps that back off when `document.hidden` is true never do.

Tried and failed:

- `view.setVisible(false)` on the detached view: no change.
- Keeping the view attached with `setVisible(false)`: worse. Animation frames resume at 60 a second,
  5% CPU for one animated page.
- Parking the view in a `BaseWindow` that is never shown: no change.
- `Page.setWebLifecycleState({ state: 'frozen' })` over the DevTools protocol: it answers, and freezes
  nothing, since Chromium freezes only hidden pages.

Measured under xvfb. A real desktop was not tested, since nothing a test runs may appear on screen.

### 4. The Ethereum light client runs for everyone, all the time (measured)

The verifier host starts after the first page loads (`verifier-subsystem.ts`, `startAfterFirstPage`)
and starts Helios at once (`src/protocols/verifier-host/protocols.ts`, `startEns`). Helios follows
the chain, and the host reads its head every minute. With no `.eth` page open that is 1.7-1.9% CPU
without pause and about 70 MB: roughly 80% of an idle browser's CPU. With the light client off, the
host process still holds 45-69 MB.

### 5. Every web request makes three main-process round trips at default settings (static)

The privacy controls (`install-privacy-net.ts`) register `onBeforeSendHeaders` and
`onHeadersReceived` for every http, https and WebSocket request, and the content settings
(`install-content-settings.ts`) register `onBeforeRequest` for every image, whatever the settings
say. Each handler returns the request unchanged while its setting is off, and every one is off by
default. The owner's union filter (`web-request-owner.ts`, `unionFilter`) then widens
`onBeforeRequest` to every resource type, because the verifier's `.eth` filter names none. Each
round trip holds the request until JavaScript on the main thread answers. The profile above puts these
handlers' own JavaScript far below the session write: removing them is right, but it is not where the
main process's time went. The declarativeNetRequest bridge (`dnr-webrequest.ts`) already registers
only while an extension needs it: that is the pattern.

### 6. Five overlay renderers stay resident (static)

Each window builds its toolbar view at once and its overlays on first use. Of 32 overlays, 25 are
destroyed on close. The five marked `keep: 'warm'` (address-bar dropdown, menu, find, side panel,
toast) live as long as their window, each a renderer process of its own.

### 7. Preloads parsed in every page and frame (static)

- Every ordinary tab loads `out/preload/app.js`, 244 KB unminified: the routed fetch, the sockets,
  the shim globals and an inlined `buffer` package, all gated on `--orivon-app-tab` and so dead code
  in a website's tab, plus `installOrivon`, evaluated into each page's main world.
- The two vendored extension libraries register session-wide `frame` preloads (41 KB and 11 KB) on
  the default session, so every frame of every site, ad iframes included, loads both before they
  bail out, and every site's service worker loads the extension one.
- Preload bundles are unminified: electron-vite's default for main and preload builds.

### 8. Memory saver is the only lever on RAM, and it acts late (static)

A tab sleeps after 2 hours idle (`performance.sleepAfter`), never when it is a new-tab or internal
page, and nothing reacts to memory pressure.

### 9. Smaller items

- `src/loader/reach/guard.ts`: each open third-party reach stream re-checks its grant every 200 ms.
- `src/preload/form-watch.ts`: while password saving is on, a subtree `MutationObserver` on every
  http(s) page. Throttled to 500 ms, it still forces a layout per password field.
- `src/main/omnibox`: local history matching runs synchronously on the main thread on every
  keystroke. Cheap at today's history sizes.
- The offscreen child and web-context hosts run with `backgroundThrottling: false`. They exist only
  while an app uses them.
- Developer mode only (`npm run dev`): `--disable-http-cache` turns the HTTP cache off for the whole
  browser (`dev-switches.ts`), and every shell surface loads unbundled from the Vite server. Judge
  performance on `npm start`, never on `npm run dev`.

### Checked and fine

Inactive tabs are detached, so their animation frames stop. History is a file-backed SQLite database
in WAL mode, not a whole-file rewrite. The toolbar and overlays run no polling loop and no endless
animation. The task manager page stops polling while hidden. Download progress is throttled. A child
host closes with its app's last document.

## Fix plan

### Now: no product trade-off

| # | Change | Effect sought |
|---|---|---|
| F1 | An icon is filled into bookmarks and written to history only when a tab's icon changed; an identical icon is not rewritten; the favicon trim runs once per write batch | Main-process writes near zero while pages only retitle |
| F2 | Page signals schedule one trailing state push (about 32 ms) | A load's burst of signals is one push |
| F3 | The toolbar updates tab elements in place, keyed by tab id | Toolbar CPU per push no longer rebuilds every tab |
| F4 | Privacy and content-settings handlers registered only while a setting needs them | No main-process round trip per request at default settings |
| F5 | `scripts/perf-probe.mjs` and `npm run perf:probe` | This measurement, repeatable |
| F6 | The session file is written off the main thread (`writeFileAtomicAsync`), and a change of titles alone waits for the next other change or 30 s | No synchronous flush per title change |
| F7 | History keeps the first five title changes of each page reached, as Chrome does | No history write per title change |

### Next: decided by the owner

| # | Change | Decision |
|---|---|---|
| N1 | The verifier host and its light client start when a `.eth` name is typed or opened, and stop after about 10 min with no `.eth` tab or request; 2 min after launch they run once when the newest checkpoint is over 7 days old. Measured: no verifier process at idle (was 1.7-1.9% CPU and about 70 MB, always) | d-0422 |
| N2 | A tab out of view, or in a minimized or hidden window, reports `document.hidden` and fires `visibilitychange`, as Chrome does: the shell computes the state and the page's preload answers the getters in the main world. Subframes keep the browser's own answer | d-0423 |
| N3 | Memory saver: 30 min by default; while available memory is low, up to three eligible tabs a minute sleep early, least recently used first. The new-tab and internal pages stay awake for now (see §Later) | d-0424 |
| N4 | The menu, find, side panel and toast overlays close after about 60 s hidden; the address-bar dropdown stays warm | d-0425 |

### Measured after the "now" changes

Same probe, same machine, ordinary build:

| Scene | Before | After |
|---|---|---|
| 11 tabs, one retitling twice a second: main-process writes per 20 s | 43 KB | 7 KB |
| The same, main-process CPU | 1.3% | 0.7% |
| The same, toolbar CPU | 2.1% | 1.0% |
| 31 tabs, one retitling: main-process writes per 20 s | 109 KB | 10 KB |
| The same, main-process CPU | 1.7% | 0.8% |
| The same, toolbar CPU | 2.5% | 0.8% |

The toolbar's numbers come from a run with every "now" change in; the main process's, from a run
with F1, F2, F4, F6 and F7.

### Later: open

- Split the ordinary-tab preload from the app-tab one, and minify preloads.
- Register the extension libraries' session-wide preloads only once an extension is installed. This
  is a vendored patch, and the web-store preload must still reach the store's own page.
- Send icons to the toolbar only when they change. This changes the shell state's shape.
- Revoke reach streams on a grant event instead of polling every 200 ms.
- Narrow developer mode's cache switch to the verifier's own origins.
- Let the new-tab page and the shell's own pages sleep (allowed by d-0424): waking one needs its
  own preload, session and guards rebuilt, where a website's tab only reloads its history.
- A `.eth` download that outlives its tab could be cut when the verifier host stops for being idle,
  since one long request counts as one use.
- Measure an extension that holds `webRequest` (uBlock Origin, now possible through the extension
  bridge): each request it watches crosses the main process and its background page, which no scene
  above covers.

## Rules for later work

Kept in [`code-guidelines.md`](../development/code-guidelines.md) §Rules:

1. Work done per event is proportional to what changed, never to the number of tabs, windows or
   bookmarks.
2. Nothing is written that has not changed.
3. A feature the person has not used costs nothing: no process, timer or webRequest handler before
   first use, and it stops when idle.
4. A view out of sight is detached, never hidden with `setVisible(false)`.
5. A change to a hot path (a tab event, a network request, a frame) runs `npm run perf:probe`
   before and after, and the PR carries both numbers.
