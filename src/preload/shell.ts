import { contextBridge, ipcRenderer } from 'electron'
import { COMMAND_CHANNEL, STATE_CHANNEL } from '../main/channels.js'
import type { ShellCommand } from '../main/ipc/ipc.js'
import type { ShellState } from '../main/shell/tabs.js'
import type { SiteSummary } from '../main/permissions/site-info-controller.js'
import type { Web3Score } from '../main/browsing/site-trust.js'
import type { PanelAnchor } from '../main/permissions/permissions-panel.js'
import type { SiteInfoPage } from '../main/permissions/site-info-panel.js'

// Loaded ONLY by the chrome view (src/main/window.ts) -- the tab strip and
// toolbar UI. Privileged: this is the one preload that may issue tab
// commands. Never load this in a tab that shows arbitrary web content.
//
// Closures only, matching preload/app.ts's rule -- no raw ipcRenderer
// handle crosses the bridge, so the chrome page can never listen on a
// channel this file didn't intend it to.

function send (command: ShellCommand): void {
  void ipcRenderer.invoke(COMMAND_CHANNEL, command)
}

/** The permissions commands need the reply `send` above discards --
 * `ipcMain.handle`'s return value, round-tripped back through the same
 * `invoke` call every command here already makes. */
async function request<T> (command: ShellCommand): Promise<T> {
  return await ipcRenderer.invoke(COMMAND_CHANNEL, command) as T
}

contextBridge.exposeInMainWorld('orivonShell', {
  newTab: (url?: string) => { send(url === undefined ? { type: 'newTab' } : { type: 'newTab', url }) },
  closeTab: (id: string) => { send({ type: 'closeTab', id }) },
  activateTab: (id: string) => { send({ type: 'activateTab', id }) },
  navigate: (id: string, input: string) => { send({ type: 'navigate', id, input }) },
  back: (id: string) => { send({ type: 'back', id }) },
  forward: (id: string) => { send({ type: 'forward', id }) },
  reload: (id: string) => { send({ type: 'reload', id }) },
  addBookmark: (url: string, title: string, tabId: string) => { send({ type: 'addBookmark', url, title, tabId }) },
  removeBookmark: (url: string) => { send({ type: 'removeBookmark', url }) },
  openBookmark: (url: string) => { send({ type: 'openBookmark', url }) },

  // The toolbar key's own at-a-glance state (a round trip, via `request`
  // above -- see ShellCommand's own doc on 'siteSummaryFor' for why
  // listing/revoking, and the full per-capability list, are NOT here), and
  // opening the all-sites and site-info popups (fire-and-forget, like
  // every other command above).
  siteSummaryFor: async (url: string) => await request<SiteSummary>({ type: 'siteSummaryFor', url }),
  // The address-bar shield's own displayed Website and Delivery level --
  // same round-trip shape as siteSummaryFor above, deliberately a separate
  // command (see ShellCommand's own doc on 'web3ScoreFor') rather than
  // folded into the permissions payload, which answers a different question
  // (what can this app do, not how trustless its delivery is).
  web3ScoreFor: async (url: string) => await request<Web3Score | null>({ type: 'web3ScoreFor', url }),
  // `anchor` is the tune icon's own rect, read by the chrome view -- main
  // has no way to know where the toolbar put that button. Passed through
  // verbatim; permissions-panel.ts clamps it to the window rather than
  // trusting it as a bounds.
  openSettings: (anchor: PanelAnchor, url?: string) => {
    send(url === undefined ? { type: 'openSettings', anchor } : { type: 'openSettings', url, anchor })
  },
  // Same anchor contract as openSettings, for the shield or key that opens
  // the per-site popup instead -- `page` says which icon was clicked.
  openSiteInfo: (anchor: PanelAnchor, page: SiteInfoPage, url?: string) => {
    send(url === undefined ? { type: 'openSiteInfo', anchor, page } : { type: 'openSiteInfo', url, anchor, page })
  },

  /** Subscribes to shell state pushes from main. Returns an unsubscribe
   * function; the listener is a closure, not the raw ipcRenderer, so the
   * page can never register on any channel but this one. */
  onState: (listener: (state: ShellState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ShellState): void => listener(state)
    ipcRenderer.on(STATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler)
  },

  /** A read-only value, not a command -- lets the chrome view reserve
   * space for Electron's native window buttons without a round trip.
   * Available even under sandbox: true (Electron's own process.md,
   * "Sandbox" section). Needed because env(titlebar-area-*) and navigator.windowControlsOverlay
   * both report empty/false for this shell's BaseWindow + WebContentsView
   * composition -- confirmed empirically, open-questions.md A34. */
  platform: process.platform
})
