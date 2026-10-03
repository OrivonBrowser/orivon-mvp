// The shell callbacks the vendored library calls to act on Orivon's tabs and
// windows (createTab, selectTab, removeTab, assignTabDetails, createWindow,
// removeWindow, navigateTab). Every URL an extension hands over goes through
// extension-url-policy.ts first. The shell is reached through a getter: the
// library is constructed before the first window exists, and a callback made
// before then must reject cleanly.
import { session } from 'electron'
import type { BaseWindow, WebContents } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import { createShellWindow } from '../shell/window.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { SubsystemContext } from '../registry.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { applyOrivonTabDetails } from './extension-tab-details.js'
import { markExtensionOpened, openExtensionTab } from './extension-opened-pages.js'

export interface ShellBridge { ctx: SubsystemContext, services: ShellServices }

/** What the library takes besides its license, session and preload path. */
export type HostImpl = Omit<ConstructorParameters<typeof ElectronChromeExtensions>[0], 'license' | 'session' | 'preloadPath'>

/** Held for exactly the duration of a shell-initiated selectTab/removeTab
 * call (extension-host.ts's `notifyShell`) -- what the selectTab/removeTab
 * callbacks below check to skip acting on their own shell's own
 * notification. */
export const shellInitiated = new Set<WebContents>()

/** True for the duration of a `chrome.tabs.create`/`chrome.tabs.update({active:true})`
 * call's own `activateTab` -- extension-host.ts's `tabActivated` reads this to skip
 * closing an open popup: a tab switch the EXTENSION itself just made (querying tabs,
 * then opening one from its own popup, per test/e2e-extensions-toolbar.test.ts) must not
 * close the very popup that asked for it, unlike a tab switch the PERSON makes by
 * clicking the tab strip. `createTab` and `selectTab` below are the only two ways an
 * extension can activate a tab, and neither recurses into the other. */
let tabActivationFromExtension = false

export function isExtensionActivatingTab (): boolean {
  return tabActivationFromExtension
}

/** `session.defaultSession.extensions.getExtension` answers `null` for an id
 * it does not hold (Electron's own contract), never `undefined` -- checked
 * against both, so a URL policy check bound to this never trivially passes. */
export function isLoadedExtension (id: string): boolean {
  return session.defaultSession.extensions.getExtension(id) != null
}

function windowFor (bridge: ShellBridge, windowId: number | undefined): BaseWindow | undefined {
  if (windowId !== undefined) return bridge.services.windows.all().find((w) => w.window.id === windowId)?.window
  return bridge.services.windows.focused()?.window
}

export function buildHostImpl (getBridge: () => ShellBridge | undefined): HostImpl {
  return {
  createTab: async (details) => {
    const bridge = getBridge()
    if (bridge === undefined) throw new Error('extensions: no shell attached yet')
    const win = windowFor(bridge, details.windowId)
    if (win === undefined) throw new Error('extensions: no window to open a tab in')
    const shellWindow = bridge.services.windows.all().find((w) => w.window === win)
    if (shellWindow === undefined) throw new Error('extensions: window has no tabs')
    const target = details.url === undefined ? undefined : extensionOpenedUrl(details.url, isLoadedExtension)
    if (details.url !== undefined && target === undefined) {
      throw new Error(`extensions: refused to open ${details.url}`)
    }
    tabActivationFromExtension = true
    try {
      const opened = openExtensionTab(shellWindow.tabs, target)
      if (opened === undefined) throw new Error('extensions: tab capacity reached')
      return [opened[1], win]
    } finally {
      tabActivationFromExtension = false
    }
  },

  // The library calls selectTab/removeTab for an extension-initiated
  // change (chrome.tabs.update({active:true})/chrome.tabs.remove()) AND
  // for the shell's own ElectronChromeExtensions.selectTab()/removeTab()
  // calls below (attachExtensionShell's tabActivated/tabClosed) -- the
  // shellInitiated guard there is what tells the two apart, so a tab the
  // shell itself just activated or closed is never re-activated/re-closed
  // here, recursively, before the shell's own call has returned.
  selectTab: (wc) => {
    if (shellInitiated.has(wc)) return
    const found = getBridge()?.services.windows.findTab(wc)
    if (found == null) return
    tabActivationFromExtension = true
    try {
      found.window.tabs.activateTab(found.tabId)
    } finally {
      tabActivationFromExtension = false
    }
  },

  removeTab: (wc) => {
    if (shellInitiated.has(wc)) return
    const found = getBridge()?.services.windows.findTab(wc)
    if (found != null) found.window.tabs.closeTab(found.tabId)
  },

  assignTabDetails: (details, wc) => {
    const found = getBridge()?.services.windows.findTab(wc)
    applyOrivonTabDetails(details, found == null ? null : found.window.tabs.faviconFor(found.tabId), found != null && found.window.tabs.record(found.tabId)?.pinned === true, found?.window.tabs.record(found.tabId)?.sleeping)
  },

  createWindow: async (details) => {
    const bridge = getBridge()
    if (bridge === undefined) throw new Error('extensions: no shell attached yet')
    const raw = details.url === undefined ? [] : Array.isArray(details.url) ? details.url : [details.url]
    const urls = raw
      .map((u) => extensionOpenedUrl(u, isLoadedExtension))
      .filter((u): u is string => u !== undefined)
    return createShellWindow(bridge.ctx, bridge.services, {
      first: (tabs) => { if (urls.length === 0) tabs.createTab(); else for (const u of urls) openExtensionTab(tabs, u) }
    })
  },

  removeWindow: (win) => { if (!win.isDestroyed()) win.close() },

  windowOf: (wc) => getBridge()?.services.windows.all().find((w) => w.chrome.webContents === wc)?.window,

  navigateTab: async (wc, url) => {
    const target = extensionOpenedUrl(url, isLoadedExtension)
    if (target === undefined) return
    markExtensionOpened(wc, target)
    await wc.loadURL(target)
  }
  }
}
