# `src/preload/`: the privilege boundary

**What lives here.** Eleven preload scripts at eleven privilege levels (`app.ts`, `shell.ts`, `newtab.ts`,
`permissions.ts`, `site-info.ts`, `overlay.ts`, `split-frame.ts`, `internal.ts`, `embed.ts`,
`child-host.ts` and `extension-api.ts`), the
app-tab wiring they share (`manifest-hint.ts`, `expose-shim-globals.ts`, `expose-fetch-route.ts`,
`page-buffer.ts`, `embed-event-relay.ts`, `page-visibility.ts`, `ordinary-tab.ts`), the sign-in form watcher (`form-watch.ts`, with
the decisions it makes in `login-fields.ts`), the app-tab key report (`page-keys.ts`, `find-chord.ts`), and
`orivon-error.ts`, the plain-object error shape [`surface/`](surface/) and [`ports/`](ports/)
share. The narrowest and most security-critical surface in the repository. Tied to Electron,
entirely.

| Folder | Holds |
|---|---|
| [`extension-apis/`](extension-apis/) | The namespaces Orivon adds to `chrome.*`, injected by `extension-api.ts` |
| [`surface/`](surface/) | `window.orivon`'s page surface and its main-world installer |
| [`ports/`](ports/) | The isolated-world per-socket state machines that installer wraps |
| [`routed/`](routed/) | ADR-0017's routed network path: the main-world `fetch`, `XMLHttpRequest`, `EventSource` and `WebSocket` |

**What it depends on.** `electron` (via `require`: these are CommonJS),
[`src/contracts/`](../contracts/) for types, and, from `expose-shim-globals.ts` only,
[`src/shim/globals.ts`](../shim/globals.ts): the one shim file with no `electron` import and no
free identifier, so it can run in a preload and go to `contextBridge.executeInMainWorld`
unchanged (A151). `child-host.ts` imports [`src/shim/worker/host.ts`](../shim/worker/host.ts)
(ADR-0046): the one other shim file this directory reaches into, since the host runs that
logic itself rather than exposing anything to a main world. `extension-api.ts` also imports
[`../../vendor/electron-chrome-extensions/src/preload.js`](../../vendor/electron-chrome-extensions/src/preload.js)
unmodified, so [`vendor/`](../../vendor/) is a dependency of this directory too.

**What it must never import.** [`src/broker/`](../broker/): a preload runs in the renderer
process, where broker logic would fail or, worse, appear to work. Nothing under `src/main/`,
with one exception: [`../main/channels.ts`](../main/channels.ts), a zero-dependency leaf of
string constants, safe in either process and the one neutral home for a channel name shared
across this boundary.

**Owner stream.** `broker` for `app.ts`, `orivon-error.ts`, `surface/`, `ports/` and `routed/`;
`shell` for `shell.ts` and `newtab.ts`.

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | every ordinary tab | `./page-dialogs.ts`'s `prompt` wrapper; `./ordinary-tab.ts`'s `exposeOrdinaryTabSurface()` only from the top frame (`./frame.ts`'s `inMainFrame()`): `window.orivon` and what depends on it -- none of that on a `chrome-extension:` page, which still gets the `prompt` wrapper |
| `shell.ts` | only the chrome view, and only at the URL `--orivon-shell-url` names | Tab commands, typed by its `OrivonShell` |
| `permissions.ts` | only the all-sites popup (`src/main/permissions/permissions-panel.ts`), and only at its expected URL | `orivonPermissions`: list and revoke grants, list and reset notification answers; `src/main/ipc/permissions-ipc.ts` re-verifies the sender on every call |
| `overlay.ts` | only an overlay view (`src/main/overlays/overlay-view.ts`), and only at the exact URL main built for it | `orivonOverlay`: which overlay this is, `ready`, `request`, `size`, `close` and `onEvent`; `src/main/overlays/overlay-ipc.ts` re-verifies the sender on every call, and the host runs only the handler of the overlay the view was built for |
| `split-frame.ts` | only the view behind a split (`src/main/shell/split-frame.ts`) | `orivonSplit`: what to draw, and drag the divider to a place or reset it |
| `internal.ts` | only a tab the shell opened as one of its own pages (`src/main/pages/`: Settings, History, ...) | `orivonInternal`: one `request(domain, command)` and one `onEvent`, after checking the document's scheme and host against the page the shell named; `src/main/pages/internal-ipc.ts` decides on every call what the page may reach |
| `site-info.ts` | only the per-site popup (`src/main/permissions/site-info-panel.ts`) | `orivonSiteInfo`: this site's info, switches, picked paths and browser data |
| `embed.ts` | only a page an app shows inside itself (`src/main/embed/embed-host.ts` sets it on every `<webview>` guest; ADR-0039) | Nothing on `window`: runs the script set with `orivon.web.setEmbedScript` before the page's own code, handing it `orivonEmbed`; also installs `./page-dialogs.ts`'s wrapper, so the shown page's `prompt` is asked in the app's tab |
| `child-host.ts` | only the hidden child host (`src/main/children/child-host.ts`; ADR-0046), and only at its own `/.well-known/orivon/child-host` document | Nothing on `window`: builds `orivon` in this isolated world alone and runs `src/shim/worker/host.ts`'s relay over the ports main connects |
| `page-dialogs.ts` | every tab preload (`app.ts`, `newtab.ts`, `internal.ts`), and the embed guest's top frame | Nothing new on `window`: a `Proxy` over the page's own `prompt` (Electron's renderer throws for it, and the dialog event main listens to is never raised for it; `alert` and `confirm` are answered from that event, `src/main/shell/page-dialogs.ts`) that blocks on `PAGE_DIALOG_CHANNEL` until main has the person's answer, so the page keeps its synchronous contract and `toString` and the property's descriptor are the platform's. A reply that is not a string reads as Cancel, and so does a call Chromium would have ignored: the page being left, read from `window.event` through the getter taken before page scripts run (a page can replace the property), or a top-level document with an opaque origin. It registers no listener on the window |
| `frame.ts` | every tab preload | `inMainFrame()`: a tab's preload runs in its top frame only (`nodeIntegrationInSubFrames` is off), and what it exposes asks here first, so a setting that ran it in a subframe would not hand that frame `window.orivon`. A preload that cannot tell which frame it is in counts as a subframe |
| `newtab.ts` | only a fresh tab (`src/main/shell/tabs.ts`'s `createTab()` with no `url`) | Read-only bookmarks and navigate-this-tab; otherwise the same `exposeOrdinaryTabSurface()` as `app.ts` |
| `embed-event-relay.ts` | `./ordinary-tab.ts`, so every ordinary tab | Nothing on `window`: turns the shell's notice that a page shown in a `<webview>` asked for a window or started a download (`EMBED_EVENT_CHANNEL`, ADR-0047) into a bubbling `orivon-popup` or `orivon-download` event on the element, dispatched in the main world so the page can read `detail`; idle until main sends, and a page cannot send on that channel |
| `page-visibility.ts` | `./ordinary-tab.ts`, so every ordinary tab, top frame only; never an extension's own page | Nothing new on `window`: replaces the page's `Document.prototype` getters for `visibilityState`, `hidden`, `webkitVisibilityState` and `webkitHidden`, installed in the main world before the page's scripts, so a tab out of sight reads hidden and sees one `visibilitychange` per change, as in Chrome. The state is a closure; the shell's message (`TAB_VISIBILITY_CHANNEL`) reaches it through a per-document event name no page script is told. A page that tampers with it only fools itself |
| `form-watch.ts`, `login-fields.ts` | `./ordinary-tab.ts`, so every ordinary tab, top frame only | Nothing on `window`: reports a page's password fields, the box a person focused and a submitted sign-in over `FORM_WATCH_CHANNEL`, and writes the account a person chose in Orivon's chooser into the page's own fields when main says so on `FORM_FILL_CHANNEL`; inert until main's config turns it on, and a page can neither ask it for a value nor trigger a fill |
| `page-keys.ts`, `find-chord.ts` | `./ordinary-tab.ts`, top frame of an app tab only | Nothing on `window`: when a `Ctrl+F` (`Cmd+F` on macOS) reaches the end of the page's own handlers without `preventDefault`, sends `{ command: 'find.open' }` over `PAGE_KEY_CHANNEL`; `src/main/shortcuts/page-key-ipc.ts` accepts it only from the top frame of the tab in front, on a registered app's tab, at five a second |
| `expose-fetch-route.ts`, `expose-shim-globals.ts`, `expose-child-host-connect.ts` | `./ordinary-tab.ts`, shared by `app.ts` and `newtab.ts`'s fallback | On an app tab only: the routed network path, `process`/`global`/`setImmediate`/`clearImmediate`/`Buffer`, and (ADR-0046) a registered-symbol bridge (`start`/`send`/`kill` closures, never the raw port -- T17) letting the page reach its app's child host with no new global; each closure applies `window.orivon`'s own page-caller check (ADR-0045), so an extension's script in the page cannot start, message or kill the app's children |
| `extension-api.ts` | registered as both a `'frame'` and a `'service-worker'` preload on the default session (`src/main/extensions/extension-host.ts`'s `createExtensionHost`, wired from `extensions-subsystem.ts`); injects `chrome.*` only on a `chrome-extension:` page or a `chrome-extension:`-scoped service worker (its URL read from the worker's main world: a worker's preload realm has no `location`), nothing elsewhere | `chrome.*` (`vendor/electron-chrome-extensions`'s `injectExtensionAPIs`), plus a health check that reloads a worker whose first `chrome.*` injection missed (`extension-sw-preload-recovery.ts`, A289) |
| `vendor/electron-chrome-web-store/src/renderer/chrome-web-store.preload.ts` (not under this directory) | registered as a `'frame'` preload on the default session (`src/main/extensions/store-runner.ts`'s `startWebStore`); runs only on the top frame at exactly `https://chromewebstore.google.com` | `chrome.webstorePrivate`, and the `chrome.runtime`/`chrome.management` extras the store page's own script expects |

`shell.ts`, `permissions.ts`, `site-info.ts`, `overlay.ts`, `split-frame.ts` and `newtab.ts` each check
`location.href` against the URL main passed them (`--orivon-shell-url` and its siblings) before exposing
anything. The chrome view, the popups and the split view are also locked to that document
(`src/main/shell/lock-navigation.ts`); a fresh tab is not, since it navigates. Main re-verifies the sender on
every call: `ipc.ts`'s `isFromChrome` by frame identity and URL, `newtab-ipc.ts` by URL, `permissions-ipc.ts`,
`overlay-ipc.ts` and `site-info-ipc.ts` by identity and URL (A269), and site-info fixes the origin itself.

## The rule that governs this directory

**The raw `MessagePortMain` never crosses into the main world.** [`ports/`](ports/) holds it in
the isolated world behind plain closures, and `surface/main-world-socket.ts` builds the page's
streams over those closures. The threat and the measurement: [`ports/README.md`](ports/README.md).

## Design notes

**Whether a tab is an app tab is fixed when its view is built.** `src/main/shell/tab-view.ts`'s
`appTabArgsFor` asks `Broker.app.isRegisteredSync` once, at `WebContentsView` construction, and
passes `--orivon-app-tab` in `additionalArguments`; `expose-fetch-route.ts` and
`expose-shim-globals.ts` read it synchronously off `process.argv`. `window.orivon` reaches every
ordinary tab, so routing whenever `orivon.net` exists would break every cross-origin `fetch()` on
the open web, and awaiting `orivon.app.manifest()` in the main world would race the page's first
script. The known, permanent limitation: an origin registered after its tab's view was built
keeps the old answer until a navigation swaps in a fresh view, so an app installed during its
own first visit gets routing and shimmed globals from its next navigation.

**A method the broker cannot serve is left off `window.orivon`, never wired to fail:** a method
that always threw `'invalid'` would be worse than a method that is not there.
[`surface/README.md`](surface/README.md) names what this leaves off today.

**Every global installed on an app's window keeps the platform's own property descriptor,
`orivon` excepted:**
[ADR-0021](../../docs/decisions/ADR-0021-page-globals-carry-the-platform-descriptor.md).
`npm run check:page-globals` fails the build on a locked one.

**Why `Buffer` reaches the page inlined into [`page-buffer.ts`](page-buffer.ts)'s installer.**
`executeInMainWorld` serialises a function alone, so the installer cannot import `buffer`;
`electron.vite.config.ts`'s `pageBufferPackage` writes the package (resolved from
[`../shim/polyfills/buffer.ts`](../shim/polyfills/buffer.ts)) into its body at build time.
Measured in a headless Electron 44 tab under five page CSPs (none; the served bundle's own;
`script-src 'self' 'unsafe-inline'`; nonce-only; nonce plus Trusted Types), this defines `Buffer`
before the page's first inline `<head>` script, and the page can still assign over, shadow and
delete it. Two other routes were measured and rejected:

- **The `Function` constructor in the main world** fails silently without `'unsafe-eval'`, which
  an app tab can lack: developer mode appends Orivon's policy to the dev server's own, so the
  stricter applies.
- **`webFrame.executeJavaScript`** passed all five, but that it runs before the page's scripts is
  observed behaviour of a promise-returning call, not a contract. `executeInMainWorld` is
  synchronous by contract, and a failure throws where it can be logged.

**The routed path's shared slot, its numbers and its divergences from a browser** (which
ADR-0017 requires be written down) are in [`routed/README.md`](routed/README.md)'s Design notes.

**[`child-host.ts`](child-host.ts) is the one preload whose build needs
`wrapSandboxedPreloadBody`** (`electron.vite.config.ts`, applied to the child host's preload, the one that bundles shim code; every other preload's output is left as built). It
alone pulls in `../shim/child-process/child.ts`, whose `stream` import brings in a bundled
`readable-stream`, whose own `require('buffer')`/`require('util')` resolve through
`shimNodeSpecifiers` to the shim's polyfills -- landing a real, unwrapped top-level `Buffer`
declaration in the bundle, which collides with Electron's own sandboxed preload environment
(measured: it binds `Buffer` as one of the function parameters the preload's own body runs
inside). `wrapSandboxedPreloadBody`'s own doc comment has the fix.

**[`child-host.ts`](child-host.ts) patches `process.nextTick` before ever calling into `host.js`.**
Electron's sandboxed preload gives a real, but partial, `process` (measured: `versions`,
`platform`, `env`; no `nextTick`), unlike a page or a Worker, where this repository's own shim
installs a complete one. ES imports are hoisted, so `host.js`'s own module graph has already
evaluated by the time this file's patch line runs -- harmless here, since nothing in that graph
calls `process.nextTick` at module-evaluation time, only later, deep inside `readable-stream`'s
`Readable`/`Writable` internals, reached once a spawnSync's own stdout/stderr piping or close
path actually runs. The patch only has to land before THAT, which every line below the import
already satisfies. Unpatched, that call throws `TypeError: process.nextTick is not a function`,
wire-carried back to spawnSync's own caller as an unexplained spawn failure.

**[`page-visibility.ts`](page-visibility.ts) answers for the tab's top frame only.** A view taken off its
window is never told by Electron that it is hidden, so the shell sends the answer
([`tab-visibility.ts`](../main/shell/tab-visibility.ts)) and this file makes the page's own visibility
properties follow it; why the browser reports a background tab this way is in the
[decision log](../../docs/decisions/decision-log.md). Known limit: a subframe keeps the browser's own answer
(`visible`), because a tab's preload does not run in subframes, so an embedded player or widget that backs off
on `document.hidden` still runs at full rate in a background tab. The state is also unset until the first message
after a document loads, so a page's first scripts in a background tab can read `visible` for an instant.
