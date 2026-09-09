# FreeTube port reconnaissance

**Queue item 0.1.** Read-only. Findings only -- no decision is taken here.
Read against **FreeTube 0.25.3** (shallow clone of `FreeTubeApp/FreeTube`, 2026-09-09), against
Electron 43. Line numbers are that revision's.

**Why it was the first task.** The owner accepted "Orivon terminates TLS" on the condition that
an app like FreeTube would actually reach the network through the compatibility layer. It does
not. It reaches the network a different way, and that changes what has to be built.

---

## The one-line answer

**FreeTube's renderer imports zero Node builtins and zero `electron` APIs.** It is a pure browser
application: Vue, `fetch`, and a narrow bridge its own preload exposes as `window.ftElectron`.

So the Node compatibility layer does nothing for FreeTube. **Every one of its network calls is the
browser's own `fetch` -- 32 call sites, no `axios`, no `XMLHttpRequest`, no Node `http`/`https`.**
The decision to route `fetch` through the capability is therefore not an optimisation for this
class of app; it is the whole difference between working and not working at all.

## What the renderer does

| Fact | Evidence |
|---|---|
| No Node builtins imported anywhere under `src/renderer/` | grep for 21 builtins, zero hits |
| No `electron` import anywhere under `src/renderer/` | zero files |
| 32 `fetch(` call sites | `helpers/api/invidious.js`, `helpers/sponsorblock.js`, `store/modules/*`, `helpers/player/SabrSchemePlugin.js` |
| The YouTube client library is *handed* a fetch function rather than owning one | `src/renderer/helpers/api/local.js:104`, `:562`, `:587` |
| Everything privileged goes over one bridge | `src/preload/main.js:4` -- `contextBridge.exposeInMainWorld('ftElectron', api)`; the API is `src/preload/interface.js`, 338 lines, ~41 functions |

**This is already the shape Orivon wants**: a web frontend over a narrow privileged bridge. That
is the good news in this document.

## The requirement nobody had written down

FreeTube's renderer `fetch` calls only work because **its main process rewrites the request
headers on the way out**:

- `src/main/index.js:589` -- `onBeforeSendHeaders`, which at `:596`, `:624` and `:627` sets
  `Origin: https://www.youtube.com`, and at `:606` deletes `Origin` entirely.
- `src/main/index.js:655` -- `onHeadersReceived`, stripping tracking cookies from responses.

`Origin`, `Referer`, `User-Agent` and `Cookie` are headers a page is **forbidden** to set on its
own `fetch`; that is why this lives in main. In Orivon an app cannot touch the browser's request
pipeline -- it is the browser's, not the app's.

**Consequence:** routed `fetch` that cannot carry app-chosen forbidden headers leaves FreeTube
broken *even with CORS solved*, because the far end rejects the requests. This is a shape
requirement on the routing decision, and it is where the security question sits.

## What the main-process half needs, and why most of it is not portable

`src/main/index.js` imports `app, BrowserWindow, dialog, Menu, ipcMain, powerSaveBlocker, screen,
session, shell, nativeTheme, net, protocol, clipboard, Tray`, plus `child_process`, `fs`'s
`existsSync`, `fs/promises`, `zlib`'s `brotliDecompress` and `util`'s `promisify`.

Under `ADR-0005` there is no app backend: all app code is renderer JavaScript. So a port does not
*port* this file -- Orivon already is the window manager. What a port must do is re-express the
**25 handlers** the renderer depends on (`ipcMain.handle`/`on`, 43 `ipcRenderer` call sites, 173
channel constants in `src/constants.js`). That list is bounded and enumerable, which makes the
porting cost estimable rather than open-ended:

| Group | Handlers | What Orivon needs |
|---|---|---|
| Storage and caches | 7 `DB_*` (history, playlists, profiles, search, settings, subscriptions) + `PLAYER_CACHE_GET/SET` | `orivon.fs` **or** IndexedDB. Its datastore (`@seald-io/nedb`) is pure JS and file-backed, so over `fs` it also needs `existsSync` -- the synchronous read the owner already decided to support |
| Window and playback UX | fullscreen, picture-in-picture, zoom factor, power-save blocker, system locale | **Web platform APIs, no capability at all** -- `requestFullscreen`, `requestPictureInPicture`, Screen Wake Lock, `navigator.language`. The pleasant surprise of this audit |
| Downloads | `CHOOSE_DEFAULT_FOLDER`, `WRITE_TO_DEFAULT_FOLDER` | The folder picker -- **gated on the user-facing prompt work of build step 4**, same as everything else a person consents to |
| Token generation | `GENERATE_PO_TOKEN` | Evaluates YouTube's bot-guard script; needs a place to run untrusted script plus real HTTP. Unassessed |
| Excluded | `OPEN_IN_EXTERNAL_PLAYER` (`child_process`), `ENABLE/DISABLE_PROXY` | `subprocess` is excluded by decision; proxy configuration is shell-level, not app-level. **Documented feature losses in a port, not blockers** |
| Shell control | new window, relaunch, hardware-acceleration and cache toggles, window title | Refusals or shell features. An app asking the browser to relaunch itself is not a capability |

## Two corrections this forces on the queue

1. **The polyfill list is short.** `compatibility-matrix.md` Table 3 names `Buffer`, `stream`,
   `events`, `path`, `os`, `crypto`. This app's backend half also needs **`zlib`** (brotli) and
   **`util`**. The list should be treated as a floor discovered empirically from a named target
   app's dependency tree, not as a closed set.
2. **FreeTube does not verify the Node shim.** Its renderer uses none of it. It verifies routed
   `fetch`, storage and the web-API mappings. Something Node-shaped -- `webtorrent`, the flagship
   -- is what proves `net`/`dgram`/`fs`. The two exercise disjoint halves of the platform, and a
   queue that verifies only one is only half-verified.

## Verdict

**Routing `fetch` is confirmed necessary, and confirmed insufficient on its own.** It needs
app-chosen request headers, including ones a browser normally forbids. With that, FreeTube's
entire network layer runs unmodified; without it, none of it does.

The remaining port cost is 25 enumerable handlers, of which roughly a third need no Orivon
capability at all because the web platform already answers them.
