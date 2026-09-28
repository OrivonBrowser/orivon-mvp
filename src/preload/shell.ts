import { contextBridge, ipcRenderer } from 'electron'
import { COMMAND_CHANNEL, STATE_CHANNEL } from '../main/channels.js'
import type { ShellCommand } from '../main/ipc/ipc.js'
import type { ShellState } from '../main/shell/tabs.js'
import type { SiteSummary } from '../main/permissions/site-info-controller.js'
import type { Web3Score } from '../main/browsing/site-trust.js'
import type { PanelAnchor } from '../main/permissions/permissions-panel.js'
import type { SiteInfoPage } from '../main/permissions/site-info-panel.js'

// Loaded ONLY by the chrome view (src/main/shell/window.ts) -- the tab strip
// and toolbar UI. Privileged: this is the one preload that may issue tab
// commands. Never load this in a tab that shows arbitrary web content.
//
// Closures only, matching preload/app.ts's rule -- no raw ipcRenderer
// handle crosses the bridge, so the chrome page can never listen on a
// channel this file didn't intend it to.
//
// EXPOSURE IS GATED ON `location.href`, the same shape preload/newtab.ts's
// own gate uses and for the same reason: `lockNavigation` (main/shell/
// lock-navigation.ts) refuses the chrome view ever navigating away, but a
// preload is only as safe as the document it is attached to, and this is
// the second, independent check that never trusts the main-side lock
// alone. `--orivon-shell-url=` is passed at `WebContentsView` construction
// (window.ts's own `additionalArguments`), the exact string `chromeUrl`
// there, so this compares against the real load target rather than a
// hardcoded guess that dev/build would diverge from.
const ARG_PREFIX = '--orivon-shell-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(ARG_PREFIX))?.slice(ARG_PREFIX.length)

/** What the chrome view gets as `window.orivonShell`. `src/renderer/main.ts`
 * imports this type, so a command dropped here fails the typecheck there. */
export interface OrivonShell {
  newTab: (url?: string) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  navigate: (id: string, input: string) => void
  back: (id: string) => void
  forward: (id: string) => void
  reload: (id: string) => void
  /** `tabId` lets main read that tab's own captured favicon and keep it with
   * the bookmark -- the chrome view never sends the icon itself. */
  addBookmark: (url: string, title: string, tabId: string) => void
  removeBookmark: (url: string) => void
  openBookmark: (url: string) => void
  /** Whether the site has asked for anything at all, and whether any
   * asked-for row carries a warning. `false`/`false` for an ordinary website. */
  siteSummaryFor: (url: string) => Promise<SiteSummary>
  /** The Web3 Score shield's data, `null` when there is nothing to show. */
  web3ScoreFor: (url: string) => Promise<Web3Score | null>
  /** Opens (or closes) the all-sites popup. `url`, when given, is the tab
   * whose card to scroll to. */
  openSettings: (anchor: PanelAnchor, url?: string) => void
  /** Opens (or closes) the site-info popup; `page` says which icon was clicked. */
  openSiteInfo: (anchor: PanelAnchor, page: SiteInfoPage, url?: string) => void
  onState: (listener: (state: ShellState) => void) => () => void
  platform: string
}

function send (command: ShellCommand): void {
  void ipcRenderer.invoke(COMMAND_CHANNEL, command)
}

/** The permissions commands need the reply `send` above discards --
 * `ipcMain.handle`'s return value, round-tripped back through the same
 * `invoke` call every command here already makes. */
async function request<T> (command: ShellCommand): Promise<T> {
  return await ipcRenderer.invoke(COMMAND_CHANNEL, command) as T
}

// Defining these closures grants nothing; exposing them is the privileged
// step, and only that is gated below.
const api: OrivonShell = {
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
}

if (expectedUrl !== undefined && location.href === expectedUrl) {
  contextBridge.exposeInMainWorld('orivonShell', api)
} else {
  // Neither string is a secret in the chrome's own process, and a chrome
  // that silently lost its bridge would otherwise show nothing at all.
  console.error(`[shell preload] orivonShell not exposed: location.href ${location.href} is not --orivon-shell-url ${String(expectedUrl)}`)
}
