# `src/preload/`: the privilege boundary

**What lives here.** Five preload scripts at five different privilege levels (`app.ts`,
`shell.ts`, `newtab.ts` for the new-tab dashboard, `settings.ts` for the all-sites popup, and
`site-info.ts` for the per-site popup), the app-tab wiring they share
(`manifest-hint.ts`, `expose-shim-globals.ts`, `expose-fetch-route.ts`, `page-buffer.ts`), and
`orivon-error.ts`, the plain-object error shape shared by [`surface/`](surface/) and
[`ports/`](ports/). This is the narrowest and most security-critical surface in the repository.

| Folder | Holds |
|---|---|
| (top level) | The five entry points, the app-tab wiring they share, and `orivon-error.ts` |
| [`surface/`](surface/) | `window.orivon`'s page surface: `orivon.ts`, `control-call.ts`, `net.ts`, `web.ts`, and the main-world installer (`main-world-socket.ts`) |
| [`ports/`](ports/) | The isolated-world per-socket state machines `surface/main-world-socket.ts` wraps: `socket-bridge.ts`, `socket.ts`, `datagram.ts`, `server.ts` |
| [`routed/`](routed/) | ADR-0017's routed network path: ten main-world installers for `fetch`, `XMLHttpRequest`, `EventSource` and `WebSocket` |

**What it depends on.** `electron` (via `require`, since these are CommonJS),
[`src/contracts/`](../contracts/) for types, and (from `expose-shim-globals.ts` only, A151)
[`src/shim/globals.ts`](../shim/globals.ts), the one shim file with no `electron` import and no
free identifier of its own, so it is safe to run inside a preload and to hand to
`contextBridge.executeInMainWorld` unchanged.

**What it must never import.** [`src/broker/`](../broker/), because a preload runs in the renderer
process, and importing broker LOGIC there would either fail or, worse, appear to work. **One
documented exception to "never import `src/main/`":** [`../main/channels.ts`](../main/channels.ts)
is a zero-dependency leaf of plain string constants, safe in either process, and the one
neutral place a channel name shared across this trust boundary can live; `shell.ts` and
`newtab.ts` already relied on this before `surface/orivon.ts` did too. Nothing else under
`src/main/` is fair game.

**Owner stream.** `app.ts`, `orivon-error.ts`, everything under `surface/`, `ports/` and
`routed/` belong to `broker` (build step 2); `shell.ts` and `newtab.ts` belong to `shell` (build
step 1, done).

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | **every ordinary tab** | `surface/orivon.ts`'s `exposeOrivon()`: `orivon.version`, `orivon.app.manifest`/`grants`, `orivon.fs.readFile`/`writeFile`/`readFileSync` (the last one ADR-0016's synchronous exception; see `surface/orivon.ts`'s own `fsReadFileSync`), `orivon.id.publicKey`/`sign`, `orivon.net.connect` (a real `TcpSocket`) and `orivon.net.udpBind` (a real `UdpSocket`), both built in the main world by `surface/main-world-socket.ts` |
| `shell.ts` | **only** the chrome view | Tab commands |
| `settings.ts` | **only** the all-sites popup's own view (`src/main/permissions/permissions-panel.ts`) | `orivonSettings`: list each app's grants and revoke one, and list each site's notification answer and reset one, after checking `location.href` against its expected URL; `src/main/ipc/settings-ipc.ts` re-verifies the sender on every call |
| `site-info.ts` | **only** the site-info popup's own view (`src/main/permissions/site-info-panel.ts`) | `orivonSiteInfo`: this site's info/trust/data, apply a staged set of switches, revoke a picked path, clear browser data, reload, open the all-sites popup — same `location.href` check as `settings.ts`; `src/main/ipc/site-info-ipc.ts` re-verifies the sender and fixes the origin, never trusting one from the page |
| `newtab.ts` | **only** a genuinely fresh tab (`src/main/shell/tabs.ts`'s `createTab()`, no `url` argument) | Read-only bookmark access, navigate-this-tab-only, but only after checking `location.href` against its own expected URL first, since (unlike the chrome view) a dashboard tab is ordinary and navigable; falls back to the SAME `exposeOrivon()` `app.ts` uses otherwise, not a second copy |
| `routed/fetch.ts`, `routed/xhr.ts`, `routed/eventsource.ts`, `routed/websocket.ts` (the routed network path) | `app.ts` and `newtab.ts`'s fallback branch, via `expose-fetch-route.ts`'s `exposeFetchRoute()` | ADR-0017: `window.fetch`, `XMLHttpRequest`, `EventSource` and `WebSocket` reach a registered app's GRANTED cross-origin hosts through `orivon.net`, when the tab's `--orivon-app-tab` flag says so (`src/main/shell/tab-view.ts`'s `appTabArgsFor`). Every other request -- same-origin, another scheme, or to a host the app was not granted -- takes the page's native API, CORS and CSP and all. A plain website keeps all four native, untouched |
| `expose-shim-globals.ts` | `app.ts` and `newtab.ts`'s fallback branch, via `exposeShimGlobals()` | A151: installs `src/shim/globals.ts`'s `process`/`global`/`setImmediate`/`clearImmediate`, passing no reporter so an uncaught callback error reaches the page's own `reportError`, and `page-buffer.ts`'s `Buffer`, into the main world, gated on the SAME `--orivon-app-tab` flag `expose-fetch-route.ts` reads; an ordinary tab never receives shimmed Node globals just because it loaded before this preload ran |

**Preload builds are isolated per entry (`electron.vite.config.ts`'s `isolatedEntries: true`).**
When two preloads share a local import (`shell.ts` and `newtab.ts` both import `./channels.js`),
Rollup's default multi-entry build extracts it into a shared chunk that a sandboxed preload's
restricted `require()` cannot load, so `contextBridge.exposeInMainWorld` never runs and the whole
chrome UI goes silently inert with no visible error. `isolatedEntries` keeps
each preload a single, fully self-contained bundle.

## The rule that governs this directory

**The raw `MessagePortMain` never crosses into the main world.** [`ports/`](ports/) holds it in
the isolated world and exposes only plain closures over it, and [`surface/`](surface/)'s
`main-world-socket.ts` builds the page's real streams over exactly those closures, the port
itself never crossing. See [`ports/README.md`](ports/README.md) for the full rule, the
measurement behind it, and why it is a security rule rather than a throughput optimisation left
for later.

## Design notes

**Why the page surface, the ports and the routed network path are each their own folder.** See
[`surface/README.md`](surface/README.md), [`ports/README.md`](ports/README.md) and
[`routed/README.md`](routed/README.md) for what belongs to each and why it is shaped the way it
is; this file covers only what is common to the whole directory.

**Every global this directory installs on an app's window carries the platform's own property
descriptor -- `orivon` excepted.** ADR-0021 states the rule and the evidence for it; the short
version is that a locked global cannot be shadowed in strict mode, so a bundle that ponyfills one
dies while its module graph is still evaluating, naming no cause. So the routed `fetch` is
installed `writable`, `configurable` and `enumerable` (an operation's descriptor), the routed
`XMLHttpRequest`, `EventSource` and `WebSocket` `writable` and `configurable` but not `enumerable`
(an interface object's), [`../shim/globals.ts`](../shim/globals.ts)'s `process`, `global`,
`setImmediate` and `clearImmediate` are plain assignments, and [`page-buffer.ts`](page-buffer.ts)'s `Buffer` is
`writable` and `configurable` but not `enumerable`, as Node defines its own.
`npm run check:page-globals` fails the build on a locked one, and reads an omitted `writable` as
the lock it actually is.

**Why `Buffer` reaches the page inlined into [`page-buffer.ts`](page-buffer.ts)'s installer.**
`contextBridge.executeInMainWorld` serialises a function alone, so the installer cannot import
the `buffer` package. `electron.vite.config.ts`'s `pageBufferPackage` plugin bundles the package
(resolved from [`../shim/node-buffer.ts`](../shim/node-buffer.ts), so the one the shim wraps) and
writes it into the installer's body at build time, and fails the build if the placeholder it
replaces is not there exactly once. Measured in a headless Electron 44 tab against five page CSPs (none; the served
bundle's own; `script-src 'self' 'unsafe-inline'`; nonce-only; nonce plus Trusted Types), this
defines `Buffer` before the page's first inline `<head>` script under all five, and the page can
still assign over, shadow and delete it. Two other routes were measured beside it:

- **Evaluating the package source with the `Function` constructor in the main world** fails,
  silently, under every policy without `'unsafe-eval'`. An app tab can carry one: developer mode
  appends Orivon's policy to the dev server's own rather than replacing it, so the stricter of
  the two applies.
- **`webFrame.executeJavaScript`** passed all five too, but that it runs before the page's own
  scripts is observed behaviour of a call that returns a promise, not a documented property.
  `executeInMainWorld` runs synchronously by contract, and a failure throws where it can be
  logged.

The bundler drops a nested `'use strict'`, so the package runs sloppy in the page, as
`installGlobals` does; `tests/page-buffer.test.ts` and `test/e2e-page-buffer.test.ts` both run
it that way. [`../shim/node-buffer.ts`](../shim/node-buffer.ts) adopts this global when it finds
it, which is what keeps `require('buffer').Buffer` and `Buffer` one class.
