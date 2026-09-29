// Wires electron-chrome-extensions (ADR-0043) into the shell. Two calls, in
// order:
//
//   1. createExtensionHost(preloadPath), from extensionsSubsystem.afterReady,
//      BEFORE the first loadExtension() -- the library's own
//      'extension-loaded' listener (vendor/.../src/browser/index.ts) must
//      already be attached to session.defaultSession to see every extension,
//      including the first one this process loads.
//   2. attachExtensionShell(ctx, services, shellSession), from
//      src/main/index.ts, once ShellServices exist -- the shell's windows
//      are created after every subsystem runs, so the impl callbacks below
//      (createTab, createWindow, ...) reject cleanly if an extension somehow
//      calls one before this runs.
import { session } from 'electron'
import type { BaseWindow, Session, WebContents } from 'electron'
// Virtual specifiers (electron-chrome-extensions-lib.d.ts's own header says
// why): electron.vite.config.ts's alias resolves each to the real vendor
// file for bundling; tsc uses that .d.ts's ambient declaration instead.
import { ElectronChromeExtensions } from 'orivon:crx-extensions'
import { setSessionPartitionResolver } from 'orivon:crx-extensions-partition'
import { setRemoteMessageSenderCheck } from 'orivon:crx-extensions-router'
import { createShellWindow } from '../shell/window.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { SubsystemContext } from '../registry.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { applyOrivonTabDetails } from './extension-tab-details.js'

/** The `<browser-action-list partition="...">` token that resolves to
 * `session.defaultSession`, where every extension runs -- the default
 * session has no name of its own for `session.fromPartition()` to find, so
 * partition.ts's resolver is taught this one extra string. Set on the shell
 * preload too (src/preload/shell.ts), duplicated rather than imported for
 * the same reason APP_TAB_FLAG is (tab-view.ts's own comment). */
export const EXTENSIONS_DEFAULT_PARTITION = 'orivon-extensions-default'

interface ShellBridge { ctx: SubsystemContext, services: ShellServices }

let bridge: ShellBridge | undefined
let hostExtensions: ElectronChromeExtensions | undefined

function isLoadedExtension (id: string): boolean {
  return session.defaultSession.extensions.getExtension(id) !== undefined
}

function windowFor (windowId: number | undefined): BaseWindow | undefined {
  if (bridge === undefined) return undefined
  if (windowId !== undefined) return bridge.services.windows.all().find((w) => w.window.id === windowId)?.window
  return bridge.services.windows.focused()?.window
}

/** Constructs the library, once, before any extension loads. */
export function createExtensionHost (preloadPath: string): ElectronChromeExtensions {
  setSessionPartitionResolver((partition) =>
    partition === EXTENSIONS_DEFAULT_PARTITION ? session.defaultSession : session.fromPartition(partition))

  hostExtensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: session.defaultSession,
    preloadPath,

    createTab: async (details) => {
      if (bridge === undefined) throw new Error('extensions: no shell attached yet')
      const win = windowFor(details.windowId)
      if (win === undefined) throw new Error('extensions: no window to open a tab in')
      const shellWindow = bridge.services.windows.all().find((w) => w.window === win)
      if (shellWindow === undefined) throw new Error('extensions: window has no tabs')
      if (details.url !== undefined && extensionOpenedUrl(details.url, isLoadedExtension) === undefined) {
        throw new Error(`extensions: refused to open ${details.url}`)
      }
      const opened = shellWindow.tabs.openTrusted(details.url)
      if (opened === undefined) throw new Error('extensions: tab capacity reached')
      return [opened[1], win]
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
      const found = bridge?.services.windows.findTab(wc)
      if (found != null) found.window.tabs.activateTab(found.tabId)
    },

    removeTab: (wc) => {
      if (shellInitiated.has(wc)) return
      const found = bridge?.services.windows.findTab(wc)
      if (found != null) found.window.tabs.closeTab(found.tabId)
    },

    assignTabDetails: (details, wc) => {
      const found = bridge?.services.windows.findTab(wc)
      applyOrivonTabDetails(details, found == null ? null : found.window.tabs.faviconFor(found.tabId))
    },

    createWindow: async (details) => {
      if (bridge === undefined) throw new Error('extensions: no shell attached yet')
      const raw = details.url === undefined ? [] : Array.isArray(details.url) ? details.url : [details.url]
      const urls = raw
        .map((u) => extensionOpenedUrl(u, isLoadedExtension))
        .filter((u): u is string => u !== undefined)
      return createShellWindow(bridge.ctx, bridge.services, {
        first: (tabs) => { if (urls.length === 0) tabs.createTab(); else for (const u of urls) tabs.openTrusted(u) }
      })
    },

    removeWindow: (win) => { if (!win.isDestroyed()) win.close() },

    navigateTab: async (wc, url) => {
      const target = extensionOpenedUrl(url, isLoadedExtension)
      if (target !== undefined) await wc.loadURL(target)
    }
  })

  return hostExtensions
}

/** Only a chrome view's own top frame may address another session's tabs
 * and windows APIs over crx-msg-remote (the `<browser-action-list>` channel)
 * -- the same identity+URL shape `isFromChrome` checks (ipc.ts's own doc).
 * `chromeUrls` is rebuilt on every check rather than cached once: a second
 * window's chrome view is a different webContents at the same
 * `--orivon-shell-url`, and there is no single "the" chrome view. */
function isFromChromeView (sender: WebContents): boolean {
  if (bridge === undefined) return false
  return bridge.services.windows.all().some((w) => w.chrome.webContents === sender)
}

/** Every WebContents this host has told the library about -- membership
 * only, never a property read on the object itself. Reading `.session` on a
 * tab whose webContents already finished being destroyed throws (measured:
 * a window closing with tabs still open runs tabClosed from the 'destroyed'
 * event, well after destruction -- TabManager.dispose() closes every tab's
 * view but does not itself forget them, so the record, and this webContents,
 * are still what forgetTab() sees once 'destroyed' fires later). A `Set`,
 * not a `WeakSet`: `.delete()` on tabClosed/viewReplaced must be reachable
 * without a second read of the (possibly destroyed) key.
 */
const trackedTabs = new Set<WebContents>()

/** Held for exactly the duration of a shell-initiated selectTab/removeTab
 * call below -- what the selectTab/removeTab impl callbacks above check to
 * skip acting on their own shell's own notification (their own doc says
 * why). */
const shellInitiated = new Set<WebContents>()

function notifyShell (wc: WebContents, run: (wc: WebContents) => void): void {
  shellInitiated.add(wc)
  try {
    run(wc)
  } finally {
    shellInitiated.delete(wc)
  }
}

/** Wires every window's tab lifecycle into the library's own tab store, and
 * makes the toolbar's crx: icons load in the chrome session. */
export function attachExtensionShell (ctx: SubsystemContext, services: ShellServices, shellSession: Session): void {
  bridge = { ctx, services }

  setRemoteMessageSenderCheck((event) => event.type === 'frame' && isFromChromeView(event.sender))

  services.tabLifecycle.subscribe({
    tabCreated: (wc, win) => {
      // wc is freshly created here, in every case -- safe to read .session.
      if (win === undefined || wc.session !== session.defaultSession) return
      trackedTabs.add(wc)
      hostExtensions?.addTab(wc, win)
    },
    tabActivated: (wc) => {
      if (trackedTabs.has(wc)) notifyShell(wc, (t) => hostExtensions?.selectTab(t))
    },
    tabClosed: (wc) => {
      if (!trackedTabs.has(wc)) return
      trackedTabs.delete(wc)
      // ElectronChromeExtensions.removeTab() itself reads wc.session to
      // validate its argument, which throws once wc is destroyed -- the
      // case trackedTabs exists to route around, not this call.
      if (!wc.isDestroyed()) notifyShell(wc, (t) => hostExtensions?.removeTab(t))
    },
    viewReplaced: (oldWc, newWc, win) => {
      if (trackedTabs.has(oldWc)) {
        trackedTabs.delete(oldWc)
        if (!oldWc.isDestroyed()) notifyShell(oldWc, (t) => hostExtensions?.removeTab(t))
      }
      if (win === undefined || newWc.session !== session.defaultSession) return
      trackedTabs.add(newWc)
      hostExtensions?.addTab(newWc, win)
    }
  })

  ElectronChromeExtensions.handleCRXProtocol(shellSession)
}
