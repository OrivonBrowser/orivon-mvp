# `src/shim-electron/`: the `electron` module compatibility package

**What lives here.** Electron's `app`, `dialog`, `safeStorage`, `desktopCapturer`, `ipcRenderer`/`ipcMain`,
`BrowserWindow`, `Menu` and `Tray`, rebuilt (or refused by name) on `orivon.*`, so a ported app's
`require('electron')` resolves instead of failing to load. What each API maps to, and which
refuse, is [`compatibility-matrix.md`](../../docs/planning/compatibility-matrix.md) Table 2's
`electron` table; any other top-level name refuses as `'unimplemented'` (`index.ts`).

It is the second of the matrix's adapter families, a sibling of [`src/shim/`](../shim/README.md)
(the Node stdlib family), not part of it. One exception: `src/shim/` imports this package's
`unimplemented.ts` (`refusingProxy`) directly (A135, A160). The reverse must not happen.

**What it depends on.** [`src/contracts/`](../contracts/) (types only) and the `window.orivon`
global the preload installs before app code runs.

**What it must never import.** `electron`: this package *is* its replacement, and must never load
a native Electron binding (Rule 8). `src/broker/`: it runs entirely in the sandbox. `src/shim/`
or `src/preload/`: nothing here needs either; if something does, raise it as a design question.

**Owner stream.** No row in [`parallel-work.md`](../../docs/development/parallel-work.md)'s
ownership map yet. The `electron` alias entry lives in `src/shim/module-map.ts`, owned by `shim`.

## Design notes

**One `ElectronShimError` with a closed `reason` union** (`errors.ts`), not a class per refusal:
every refusal needs the same name, reason and message, and the package's exit criterion is that an
unsupported API throws an error naming why, never a bare `TypeError`. Keep the reasons distinct:
calling an undecided API `'not-built'` tells a porter it is coming when nobody agreed it is, and
calling it `'desktop-shell'` says it is impossible.

**`safeStorage`: `isEncryptionAvailable()` answers `false` on purpose.** The async trio is backed
by `orivon.secrets`
([`ADR-0033`](../../docs/decisions/ADR-0033-an-app-may-hold-an-origin-bound-secret-in-the-os-keyring.md));
the sync trio cannot be (`safe-storage.ts` says why), and `false` is the signal Element Desktop's
and AirGap Vault's documented non-keyring fallbacks check for.

**`desktop-shell.ts` uses three small classes, not a `Proxy`.** Apps call statics
(`Menu.setApplicationMenu`, `BrowserWindow.getAllWindows`) before constructing one, and a few
named entry points read more plainly than `construct`/`get` traps.

**One refusal mechanism, `unimplemented.ts`'s `refusingProxy`**, reused for a whole missing module
(`shell`, `clipboard`, the rest of `index.ts`'s list), for one extra method (`dialog`'s others), and
for the default export (`withUnimplementedFallback`). `src/shim/` reuses it with its own error type.

**Why "total" stops at the default export.** An ES module namespace (`import * as electron`,
`await import('electron')`) cannot be intercepted: a name never declared as an export reads
`undefined`, by spec. Verified with a throwaway script: a `Proxy` exported as a named binding
leaves an undeclared name `undefined`; the same `Proxy` as `default` throws correctly. So
`import electron from 'electron'` refuses every unknown name, while `import { someNewApi }` fails
at bundle time, outside `ElectronShimError`. `index.ts`'s curated list closes this for the names
ported apps use most; naming every real Electron export is not this package's job.

**`file-urls.ts` rewrites `file:///orivon/app/<path>` where a page sets a media or image address.** An Electron
app builds `'file://' + path` for its own files, and Chromium refuses a `file:` URL on an http(s) page before a
request leaves. The rewrite turns that address into `/orivon/app/<path>`, which the app's origin answers from its
files (ADR-0070), through `src` on `<audio>`, `<video>`, `<img>` and `<source>`, `setAttribute('src', ...)` on them
and `new Audio(url)`. It installs when the `electron` shim loads, because only an Electron port builds such
URLs; the Node shim has no use for it. Any other `file:` URL is left alone. Markup an app parses and CSS
`url(file://...)` are not covered: an app that needs them uses the root-absolute path.

**`desktopCapturer` runs Orivon's picker, and serves what the person picked.** `getSources` calls the page's
`getDisplayMedia` (so the picker, the sharing indicators and the stop control are Orivon's, never the app's), keeps
the stream under an id `orivon-shared:<random>` and resolves that one source: the person chose it, so there is no
list to enumerate. The app hands the id back through the legacy
`getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })` call, which the shim
answers from the held stream once, in its promise form or in the callback forms `navigator.webkitGetUserMedia` and
`navigator.getUserMedia` (success and error callbacks, a turn later), so a legacy call never reaches the browser. The
picker captures video only: audio asked beside it is dropped, and a
`getSources` stream carries none. Any other `chromeMediaSource` call (an id nothing holds, `'tab'`, desktop audio
alone) rejects with `NotAllowedError`, because Electron would otherwise hand that legacy request the entire screen
with no picker; every other `getUserMedia` call passes through. A stream the app does not take within 60 seconds is
stopped. A cancelled picker resolves `[]`. An app that calls `getSources` to build its own picker or to refresh
thumbnails reopens Orivon's picker each time, gets `[]` after a refusal until the page has a fresh gesture, and each
source the person picks holds a live capture (the sharing indicator stays on) until the app takes it or 60 seconds pass. `thumbnail` is one frame at `thumbnailSize` (150 by 150 when omitted,
scaled to fit, empty at 0 by 0) with `toDataURL`, `toPNG`, `toJPEG`, `isEmpty` and `getSize`; `display_id` is `''`,
`appIcon` is `null`, and `fetchWindowIcons` has nothing to fetch. The app needs `media.screen` declared, and
`navigator.mediaDevices` (a secure context) to be present.
