import { contextBridge, ipcRenderer } from 'electron'
import { COMMAND_CHANNEL, NATIVE_TAB_DRAG_ARGUMENT, SHELL_EVENT_CHANNEL, STATE_CHANNEL, TAB_DRAG_TYPE } from '../main/channels.js'
import type { ShellCommand } from '../main/ipc/ipc.js'
import type { ShellEvent } from '../main/shell/shell-events.js'
import type { ShellState } from '../main/shell/tabs.js'
import type { SiteSummary } from '../main/permissions/site-info-controller.js'
import type { Web3Score } from '../main/browsing/site-trust.js'
import type { PanelAnchor } from '../main/permissions/permissions-panel.js'
import type { SiteInfoPage } from '../main/permissions/site-info-panel.js'
import type { PressButton } from '../main/shell/press-stamps.js'
import { injectBrowserAction } from '../../vendor/electron-chrome-extensions/src/browser-action.js'

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
  newWindow: () => void
  /** Runs one of main's commands on this window, by id. */
  runCommand: (id: string) => void
  /** One of the shell's own pages, e.g. `'settings'`, optionally at a place inside it. */
  openInternal: (page: string, path?: string) => void
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
  openPermissions: (anchor: PanelAnchor, url?: string) => void
  /** Opens (or closes) the site-info popup; `page` says which icon was clicked. */
  openSiteInfo: (anchor: PanelAnchor, page: SiteInfoPage, url?: string) => void
  /** Opens (or closes) the main menu under the button that opens it. */
  openMenu: (anchor: PanelAnchor) => void
  /** A pointer went down on a toolbar button that opens a popup; main stamps the moment so the click that follows is judged by it. */
  press: (button: PressButton) => void
  /** The menu button was hovered or focused: builds the menu's view ahead of
   * the click that usually follows. Safe to call more than once. */
  prewarmMenu: () => void
  /** A call with arguments that is not a command, run by main's `CHROME_ACTIONS[name]`
   * (src/main/shell/chrome-actions.ts); resolves to what the action returns. A plain command goes through `runCommand`. */
  act: (name: string, payload?: unknown) => Promise<unknown>
  /** Puts a tab at a place in the strip. */
  moveTab: (id: string, index: number) => void
  /** A genuine tab drag has started (past the press threshold, before any tear-out): lets main start
   * capturing the tab's page early, for the floating preview a tear-off shows. */
  beginTabDrag: (id: string) => void
  /** A tab is being dragged: where over the page it is, or nothing while it is over the strip. */
  dragTab: (id: string, x?: number, y?: number) => void
  /** A tab was let go outside the strip: where on the screen, and where in this window. */
  dropTab: (id: string, x: number, y: number, clientX: number, clientY: number) => void
  /** The drag ended without a tear-out: let go inside the strip, or cancelled outright. Releases
   * the capture `beginTabDrag` started, whether or not it was ever shown. */
  endTabDrag: () => void
  /** The data type a dragged tab carries when tabs are dragged by the browser's own drag and drop (a native Wayland
   * session), else null: the strip then drags with the pointer. */
  nativeTabDragType: string | null
  /** The pointer is down on a tab: its page as a data URL for the drag image, null when there is none. */
  prepareTabDrag: (id: string) => Promise<string | null>
  /** The pointer is pulling a tab: every window gets its drop catcher ready. */
  warmDropCatchers: () => void
  /** The pointer is down on a tab (`on`) or let go: the chrome view is taller meanwhile. */
  reachChrome: (on: boolean) => void
  /** The browser started the drag of a tab, which carries only `nonce`. */
  startNativeTabDrag: (id: string, nonce: string) => void
  /** The drag was dropped on this chrome: the place in the strip (null: nothing to do), and whether it was over the
   * chrome below the strip and toolbar. */
  dropNativeTab: (nonce: string, index: number | null, below: boolean) => void
  /** The drag ended in the window it began in, taken or not. */
  endNativeTabDrag: (nonce: string) => void
  /** Escape was seen just after the drag ended. */
  cancelNativeTabDrag: (nonce: string) => void
  /** Asks main for the right-click menu of a tab. */
  showTabMenu: (id: string) => void
  onState: (listener: (state: ShellState) => void) => () => void
  /** Events main sends the chrome (src/main/shell/shell-events.ts): focusing the address bar, drawing or
   * clearing this window's cross-window drop mark, or a payload for one chrome module. */
  onCommand: (listener: (event: ShellEvent) => void) => () => void
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
  newWindow: () => { send({ type: 'runCommand', id: 'window.new' }) },
  runCommand: (id: string) => { send({ type: 'runCommand', id }) },
  openInternal: (page: string, path?: string) => { send(path === undefined ? { type: 'openInternal', page } : { type: 'openInternal', page, path }) },
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
  openPermissions: (anchor: PanelAnchor, url?: string) => {
    send(url === undefined ? { type: 'openPermissions', anchor } : { type: 'openPermissions', url, anchor })
  },
  // Same anchor contract as openPermissions, for the shield or key that opens
  // the per-site popup instead -- `page` says which icon was clicked.
  openSiteInfo: (anchor: PanelAnchor, page: SiteInfoPage, url?: string) => {
    send(url === undefined ? { type: 'openSiteInfo', anchor, page } : { type: 'openSiteInfo', url, anchor, page })
  },

  openMenu: (anchor: PanelAnchor) => { send({ type: 'openMenu', anchor }) },
  press: (button: PressButton) => { send({ type: 'press', button }) },
  prewarmMenu: () => { send({ type: 'prewarmMenu' }) },
  act: async (name: string, payload?: unknown) => await request({ type: 'act', name, payload }),
  moveTab: (id: string, index: number) => { send({ type: 'moveTab', id, index }) },
  beginTabDrag: (id: string) => { send({ type: 'tabDragStart', id }) },
  dragTab: (id: string, x?: number, y?: number) => { send(x === undefined || y === undefined ? { type: 'dragTab', id } : { type: 'dragTab', id, x, y }) },
  dropTab: (id: string, x: number, y: number, clientX: number, clientY: number) => { send({ type: 'dropTab', id, x, y, clientX, clientY }) },
  endTabDrag: () => { send({ type: 'endTabDrag' }) },
  nativeTabDragType: process.argv.includes(NATIVE_TAB_DRAG_ARGUMENT) ? TAB_DRAG_TYPE : null,
  prepareTabDrag: async (id: string) => await request<string | null>({ type: 'prepareTabDrag', id }),
  warmDropCatchers: () => { send({ type: 'warmDropCatchers' }) },
  reachChrome: (on: boolean) => { send({ type: 'reachChrome', on }) },
  startNativeTabDrag: (id: string, nonce: string) => { send({ type: 'startNativeTabDrag', id, nonce }) },
  dropNativeTab: (nonce: string, index: number | null, below: boolean) => { send({ type: 'dropNativeTab', nonce, index, below }) },
  endNativeTabDrag: (nonce: string) => { send({ type: 'endNativeTabDrag', nonce }) },
  cancelNativeTabDrag: (nonce: string) => { send({ type: 'cancelNativeTabDrag', nonce }) },
  showTabMenu: (id: string) => { send({ type: 'tabMenu', id }) },

  /** Subscribes to shell state pushes from main. Returns an unsubscribe
   * function; the listener is a closure, not the raw ipcRenderer, so the
   * page can never register on any channel but this one. */
  onState: (listener: (state: ShellState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ShellState): void => listener(state)
    ipcRenderer.on(STATE_CHANNEL, handler)
    return () => ipcRenderer.removeListener(STATE_CHANNEL, handler)
  },

  /** Commands main asks the chrome to carry out itself: focusing the address
   * bar, or drawing/clearing a cross-window drop mark. Returns the
   * unsubscribe; a closure, like `onState`. */
  onCommand: (listener: (event: ShellEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: ShellEvent): void => listener(event)
    ipcRenderer.on(SHELL_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(SHELL_EVENT_CHANNEL, handler)
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
  // Defines `<browser-action>`/`<browser-action-list>` (ADR-0043) -- only
  // once the gate above has passed, same as orivonShell itself. The
  // element's own `partition` attribute (index.html) says which session's
  // extensions it shows; extension-host.ts's partition.ts resolver is what
  // makes that string reach session.defaultSession.
  injectBrowserAction()
} else {
  // Neither string is a secret in the chrome's own process, and a chrome
  // that silently lost its bridge would otherwise show nothing at all.
  console.error(`[shell preload] orivonShell not exposed: location.href ${location.href} is not --orivon-shell-url ${String(expectedUrl)}`)
}
