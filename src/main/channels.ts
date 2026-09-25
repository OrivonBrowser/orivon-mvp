// IPC channel names shared across a preload/main trust boundary -- previously
// the same two literals typed three times under different constant names,
// which a rename on either side could silently desynchronise
// (code-guidelines.md Rule 3).
//
// CONTROL_CHANNEL below is broker's, added on the same terms: src/preload/
// README.md forbids preload/app.ts importing anything under src/broker/, so
// the channel name it shares with src/broker/transport/ipc.ts has nowhere
// else neutral to live.

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
 * ../broker/transport/ipc.ts and ../broker/transport/port-pump.ts. */
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
 * ./ipc/settings-ipc.ts. */
export const SETTINGS_COMMAND_CHANNEL = 'orivon-settings:command'

/** Ordinary tab -> main: reports a `<link rel="orivon-manifest">` hint's
 * href, seen at most once per navigation (src/preload/manifest-hint.ts).
 * One-way, fire-and-forget, like PORT_CHANNEL -- main derives the origin
 * from event.senderFrame itself (../broker/policy/origin.ts), never from
 * this payload, and decides independently whether to install anything
 * (src/main/manifest-hint.ts, src/main/app-install.ts). */
export const MANIFEST_HINT_CHANNEL = 'orivon-loader:manifest-hint'

/** The site-info popup's own WebContentsView -> main: the current site's
 * capability switches, its Web3 Score evidence, and its Cookies and site
 * data page (`./ipc/site-info-ipc.ts`). A separate channel from
 * SETTINGS_COMMAND_CHANNEL -- two independent popup views, each its own
 * webContents identity, opened at different toolbar icons and never both
 * at once (`./permissions/popover-view.ts`). */
export const SITE_INFO_COMMAND_CHANNEL = 'orivon-site-info:command'

/**
 * Main to the settings panel only: the light client's state, sent whenever
 * it changes while the panel is open, so the page never polls for it.
 */
export const LIGHT_CLIENT_STATUS_CHANNEL = 'orivon-settings:light-client'
