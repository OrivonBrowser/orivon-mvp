# `src/preload/`: the privilege boundary

**What lives here.** Six preload scripts at six privilege levels, the app-tab wiring they share
(`manifest-hint.ts`, `expose-shim-globals.ts`, `expose-fetch-route.ts`, `page-buffer.ts`), and
`orivon-error.ts`, the plain-object error shape [`surface/`](surface/) and [`ports/`](ports/)
share. The narrowest and most security-critical surface in the repository. Tied to Electron,
entirely.

| Folder | Holds |
|---|---|
| [`surface/`](surface/) | `window.orivon`'s page surface and its main-world installer |
| [`ports/`](ports/) | The isolated-world per-socket state machines that installer wraps |
| [`routed/`](routed/) | ADR-0017's routed network path: the main-world `fetch`, `XMLHttpRequest`, `EventSource` and `WebSocket` |

**What it depends on.** `electron` (via `require`: these are CommonJS),
[`src/contracts/`](../contracts/) for types, and, from `expose-shim-globals.ts` only,
[`src/shim/globals.ts`](../shim/globals.ts): the one shim file with no `electron` import and no
free identifier, so it can run in a preload and go to `contextBridge.executeInMainWorld`
unchanged (A151).

**What it must never import.** [`src/broker/`](../broker/): a preload runs in the renderer
process, where broker logic would fail or, worse, appear to work. Nothing under `src/main/`,
with one exception: [`../main/channels.ts`](../main/channels.ts), a zero-dependency leaf of
string constants, safe in either process and the one neutral home for a channel name shared
across this boundary.

**Owner stream.** `broker` for `app.ts`, `orivon-error.ts`, `surface/`, `ports/` and `routed/`;
`shell` for `shell.ts` and `newtab.ts`.

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | every ordinary tab | `window.orivon`, from `surface/orivon.ts`'s `exposeOrivon()` |
| `shell.ts` | only the chrome view | Tab commands |
| `settings.ts` | only the all-sites popup (`src/main/permissions/permissions-panel.ts`) | `orivonSettings`: list and revoke grants, list and reset notification answers |
| `site-info.ts` | only the per-site popup (`src/main/permissions/site-info-panel.ts`) | `orivonSiteInfo`: this site's info, switches, picked paths and browser data |
| `embed.ts` | only a page an app shows inside itself (`src/main/embed/embed-host.ts` sets it on every `<webview>` guest; ADR-0039) | Nothing on `window`: runs the script set with `orivon.web.setEmbedScript` before the page's own code, handing it `orivonEmbed` |
| `newtab.ts` | only a fresh tab (`src/main/shell/tabs.ts`'s `createTab()` with no `url`) | Read-only bookmarks and navigate-this-tab; otherwise the same `exposeOrivon()` as `app.ts` |
| `expose-fetch-route.ts`, `expose-shim-globals.ts` | `app.ts` and `newtab.ts`'s fallback | On an app tab only: the routed network path, and `process`, `global`, `setImmediate`, `clearImmediate` and `Buffer` |

`settings.ts`, `site-info.ts` and `newtab.ts` load into navigable views, so each checks
`location.href` against its expected URL before exposing anything; `src/main/ipc/settings-ipc.ts`
and `site-info-ipc.ts` re-verify the sender on every call, and site-info fixes the origin itself.

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
