// IPC channel names shared across a preload/main trust boundary -- previously
// the same two literals typed three times under different constant names,
// which a rename on either side could silently desynchronise
// (code-guidelines.md Rule 3).
//
// CONTROL_CHANNEL below is broker's, added on the same terms: src/preload/
// README.md forbids preload/app.ts importing anything under src/broker/, so
// the channel name it shares with src/broker/transport/ipc.ts has nowhere
// else neutral to live.

/** Main -> chrome view: a command for the chrome itself to carry out, such as focusing the address bar. */
export const SHELL_EVENT_CHANNEL = 'orivon-shell:event'

/** Chrome view -> main: tab commands (newTab, closeTab, navigate, ...). See ./ipc.ts. */
export const COMMAND_CHANNEL = 'orivon-shell:command'

/** Main -> chrome view: pushed tab state. See ./window.ts. */
export const STATE_CHANNEL = 'orivon-shell:state'

/** New-tab dashboard -> main: fetch bookmarks, or navigate the calling
 * tab. A separate channel from COMMAND_CHANNEL on purpose -- more than
 * one dashboard tab can exist at once, so its sender check (per call,
 * against the frame's own URL) is a different shape than the chrome
 * view's single-webContents identity check. See ./newtab-ipc.ts. */
export const NEWTAB_COMMAND_CHANNEL = 'orivon-newtab:command'

// APPEND POINT: one const per channel, newest last.

/** Ordinary tab -> broker: orivon.app.manifest/grants and orivon.fs.readFile/
 * writeFile. See ../broker/transport/ipc.ts. */
export const CONTROL_CHANNEL = 'orivon:control'

/** Broker -> ordinary tab, one-way: delivers a socket's dedicated
 * MessageChannelMain port via WebFrameMain.postMessage, tagged with the
 * handle id CONTROL_CHANNEL's net.connect response also carries. Never a
 * request/reply pair like CONTROL_CHANNEL -- the port itself is the payload
 * that cannot travel over ipcMain.handle/ipcRenderer.invoke. See
 * ../broker/transport/ipc.ts and ../broker/transport/relay/port-pump.ts. */
export const PORT_CHANNEL = 'orivon:port'

/** Ordinary tab -> broker: orivon.fs.readFileSync (ADR-0016), over
 * ipcRenderer.sendSync/ipcMain.on's event.returnValue -- never
 * ipcMain.handle/ipcRenderer.invoke's Promise, so this stays a separate
 * channel from CONTROL_CHANNEL rather than a method name on it (mixing the
 * two reply mechanisms on one channel would make a handler's own code the
 * only thing distinguishing which shape a given message expects). See
 * ../broker/transport/sync-fs.ts. */
export const SYNC_CONTROL_CHANNEL = 'orivon:control-sync'

/** The all-sites permissions popup's own WebContentsView -> main:
 * list/revoke (queue item 4.4). A separate channel from COMMAND_CHANNEL:
 * this is its own popup view, not the chrome view, so its sender check is
 * against ITS OWN webContents identity, never chrome's. See
 * ./ipc/permissions-ipc.ts. */
export const PERMISSIONS_COMMAND_CHANNEL = 'orivon-permissions:command'

/** Ordinary tab -> main: reports a `<link rel="orivon-manifest">` hint's
 * href, seen at most once per navigation (src/preload/manifest-hint.ts).
 * One-way, fire-and-forget, like PORT_CHANNEL -- main derives the origin
 * from event.senderFrame itself (../broker/policy/origin.ts), never from
 * this payload, and decides independently whether to install anything
 * (src/main/manifest-hint.ts, src/main/app-install.ts). */
export const MANIFEST_HINT_CHANNEL = 'orivon-loader:manifest-hint'

/** Ordinary tab -> main: what the page's login forms report (src/preload/form-watch.ts): that the page is
 * there, which fields it has, which one was focused, and a submitted credential. One-way. Main derives the
 * origin from `event.senderFrame`, never from the payload, and answers only the top frame of a tab. */
export const FORM_WATCH_CHANNEL = 'orivon-forms:watch'

/** A registered app's tab -> main: a browser key the app left unhandled, as `{ command }` (src/preload/page-keys.ts).
 * One-way. Main accepts only a listed command, only from the top frame of the tab in front, and runs it on that tab's window
 * (src/main/shortcuts/page-key-ipc.ts). */
export const PAGE_KEY_CHANNEL = 'orivon-shortcuts:page-key'

/** Main -> an ordinary tab's top frame: whether the watcher may act, and the account a person chose in
 * Orivon's own chooser. A page cannot send on it; the watcher writes the values into its own fields. */
export const FORM_FILL_CHANNEL = 'orivon-forms:fill'

/** The site-info popup's own WebContentsView -> main: the current site's
 * capability switches, its Web3 Score evidence, and its Cookies and site
 * data page (`./ipc/site-info-ipc.ts`). A separate channel from
 * PERMISSIONS_COMMAND_CHANNEL -- two independent popup views, each its own
 * webContents identity, opened at different toolbar icons and never both
 * at once (`./permissions/popover-view.ts`). */
export const SITE_INFO_COMMAND_CHANNEL = 'orivon-site-info:command'

/**
 * Main to the settings panel only: the light client's state, sent whenever
 * it changes while the panel is open, so the page never polls for it.
 */
export const LIGHT_CLIENT_STATUS_CHANNEL = 'orivon-permissions:light-client'

/**
 * A page an app shows inside itself -> main (ADR-0039): the shell's own
 * preload in that page asks for the script its app set with
 * `orivon.web.setEmbedScript`, over `ipcRenderer.sendSync`, so the script
 * runs before the page's own code. Main answers from the guest's own
 * identity (`event.sender`, a webview guest, and the app tab that hosts
 * it), never from anything in the payload. See `src/main/embed/`.
 */
export const EMBED_SCRIPT_CHANNEL = 'orivon-embed:page-script'

/**
 * An internal page (Settings, History, ...) -> main: `{ domain, command }`.
 * One channel for all of them; which domains a page may reach is decided per
 * call in `./pages/internal-ipc.ts`, never by the page.
 */
export const INTERNAL_COMMAND_CHANNEL = 'orivon-internal:command'

/** An overlay's own WebContentsView -> main: `{ type: 'ready' | 'request' | 'size' | 'close' }`. See ./overlays/overlay-ipc.ts. */
export const OVERLAY_COMMAND_CHANNEL = 'orivon-overlay:command'

/** Main -> an overlay's own view: `{ type: 'show', payload }` on a warm view's every later show, and `{ type: 'event', event }` from `overlays.send`. */
export const OVERLAY_EVENT_CHANNEL = 'orivon-overlay:event'

/** The split backdrop's own view -> main: the divider being dragged or reset. See ./shell/split-frame.ts. */
export const SPLIT_FRAME_CHANNEL = 'orivon-split:command'

/** Main -> the split backdrop: what to draw. */
export const SPLIT_STATE_CHANNEL = 'orivon-split:state'

/** Main -> an internal page: `{ topic, payload }`, for changes made elsewhere while the page is open. */
export const INTERNAL_EVENT_CHANNEL = 'orivon-internal:event'

/** Main -> an extension service worker, once it first reaches 'running':
 * asks whether the library's own chrome.tabs/chrome.windows/chrome.action
 * actually arrived (extension-sw-preload-recovery.ts's own header). The
 * worker's own preload (src/preload/extension-sw-verify.ts) answers on
 * EXTENSION_SW_HEALTH_REPLY_CHANNEL below -- both names live here, rather
 * than in main/extensions/, so the preload script can name them without
 * importing anything under src/main/ but this file (src/preload/README.md's
 * own rule). */
export const EXTENSION_SW_HEALTH_CHECK_CHANNEL = 'orivon-extension-sw-health-check'

/** Extension service worker -> main: the boolean answer to the check above. */
export const EXTENSION_SW_HEALTH_REPLY_CHANNEL = 'orivon-extension-sw-health-reply'

/**
 * An app tab -> main: ask for a connection to this app's child host
 * (ADR-0046), fire-and-forget like MANIFEST_HINT_CHANNEL above -- main
 * derives the origin from `event.senderFrame` itself, refuses a tab that is
 * not a registered app, and delivers the port on
 * `CHILD_HOST_PORT_CHANNEL` below rather than as this call's own reply,
 * since a `MessagePortMain` cannot cross as an `ipcRenderer.invoke` result.
 * See `src/main/children/`.
 */
export const CHILD_HOST_CONNECT_CHANNEL = 'orivon-children:connect'

/** Main -> the requesting app tab, one-way: delivers the page's own end of
 * the `MessageChannelMain` a child-host connection uses, via
 * `WebFrameMain.postMessage` -- `PORT_CHANNEL`'s own pattern, a separate
 * channel since this one carries no handle id to tag the delivery with. */
export const CHILD_HOST_PORT_CHANNEL = 'orivon-children:page-port'

/** Main -> the hidden child host itself (never a page): delivers one page's
 * own end of the per-page `MessageChannelMain` (`src/main/children/
 * child-host.ts`'s `postPagePort`), over `WebFrameMain.postMessage` on the
 * host's own `mainFrame` -- the host's preload (`src/preload/child-host.ts`)
 * is the only listener. */
export const CHILD_HOST_PAGE_CHANNEL = 'orivon-children:host-page'

/** The hidden child host's own preload -> main, fire-and-forget, once its
 * `orivon` and its `ChildHost` relay both exist: `child-host.ts`'s `build()`
 * waits for this (bounded) before ever handing a page a port, so a preload
 * that threw partway through (the sandboxed-bundling faults `src/preload/
 * README.md` measures) is caught and its host closed, never left running
 * with no `orivon:child-host:page` listener at all (W2). */
export const CHILD_HOST_READY_CHANNEL = 'orivon-children:host-ready'

/** A `chrome-extension://` frame's own preload (the vendored library's
 * `preload.ts`) -> main, synchronous (`ipcRenderer.sendSync`/
 * `event.returnValue`): is THIS frame one of its own extension's manifest
 * `sandbox.pages`? Real Chrome gives such a page no `chrome.*` at all
 * (extensions put untrusted code there precisely because it cannot reach
 * extension APIs); this is what the preload asks, before deciding whether
 * to inject any, so a sandboxed page's own document_start script never
 * sees one even briefly. Main derives the answer entirely from
 * `event.senderFrame`'s own URL (never a payload) --
 * `src/main/extensions/extension-host.ts`. The literal string is
 * duplicated in `vendor/electron-chrome-extensions/src/preload.ts` rather
 * than imported: `vendor/` may not depend on anything under `src/`
 * (`src/main/extensions/README.md`'s own boundary), the same reason that
 * file's `extension-host.ts` duplicates `EXTENSIONS_DEFAULT_PARTITION`
 * instead of importing it. */
export const EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL = 'orivon-extensions:sandbox-page-query'

/** Main -> an app's page: a shown page asked for a window or started a download (ADR-0047). The page's preload turns it into an event on the `<webview>` element. */
export const EMBED_EVENT_CHANNEL = 'orivon-embed:event'

/** A page's `alert`, `confirm` or `prompt`, from the wrapper a tab's preload puts over them: a synchronous send from any frame of the tab, answered by main once the person has. */
export const PAGE_DIALOG_CHANNEL = 'orivon-page-dialog'
