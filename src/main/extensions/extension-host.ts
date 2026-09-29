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
import { app, session } from 'electron'
import type { BaseWindow, Session, WebContents } from 'electron'
// Virtual specifiers (electron-chrome-extensions-lib.d.ts's own header says
// why): electron.vite.config.ts's alias resolves each to the real vendor
// file for bundling; tsc uses that .d.ts's ambient declaration instead.
import { ElectronChromeExtensions } from 'orivon:crx-extensions'
import { setSessionPartitionResolver } from 'orivon:crx-extensions-partition'
import { setEventListenerFilter, setMessageSenderIdCheck, setRemoteMessageSenderCheck } from 'orivon:crx-extensions-router'
import { setCookieHostAccessCheck } from 'orivon:crx-extensions-cookies'
import { setTabUrlAccessCheck, setTabHostAccessCheck } from 'orivon:crx-extensions-tabs'
import { createShellWindow } from '../shell/window.js'
import type { ShellServices } from '../shell/shell-services.js'
import type { SubsystemContext } from '../registry.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { applyOrivonTabDetails } from './extension-tab-details.js'
import { watchForMissedServiceWorkerPreload } from './extension-sw-preload-recovery.js'
import { senderMatchesClaimedExtensionId } from './extension-sender-id-check.js'
import { hasApiOrHostAccess, hasApiPermission, hasHostAccess } from './extension-host-access.js'

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

/** `session.defaultSession.extensions.getExtension` answers `null` for an id
 * it does not hold (Electron's own contract), never `undefined` -- checked
 * against both, so a URL policy check bound to this never trivially passes. */
function isLoadedExtension (id: string): boolean {
  return session.defaultSession.extensions.getExtension(id) != null
}

/** The four chrome.tabs fields Chrome itself only returns to an extension
 * holding `tabs` or a matching host permission -- the same set
 * vendor/.../src/browser/api/tabs.ts's own `filterTabDetails` strips for a
 * direct call, applied here to whatever shape a broadcast tabs.* event
 * argument carries (a full `chrome.tabs.Tab`, or `tabs.onUpdated`'s own
 * `changeInfo`, which may carry a subset of the same names). */
function stripSensitiveTabFields (value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const copy = { ...(value as Record<string, unknown>) }
  delete copy.url
  delete copy.pendingUrl
  delete copy.title
  delete copy.favIconUrl
  return copy
}

/** A URL standing in for a broadcast `cookies.onChanged` event's own
 * cookie, for the same host-permission check `api/cookies.ts`'s own
 * `cookieUrl` applies to a direct `cookies.getAll` result -- duplicated
 * here in miniature rather than imported, since this file sits one layer
 * above that module (router.ts's per-listener filter, not a handler). */
function cookieChangeUrl (cookie: { domain?: unknown, path?: unknown, secure?: unknown }): string | undefined {
  if (typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') return undefined
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  return `${cookie.secure === true ? 'https' : 'http'}://${domain}${cookie.path}`
}

/**
 * Installed with setEventListenerFilter (router.ts's own doc): per
 * listener, decides whether a broadcast event reaches `extensionId` at all,
 * and whether it carries every field or a stripped copy --
 * cookies.onChanged needs BOTH the `cookies` permission and host access to
 * the cookie's own URL (api/cookies.ts's UPSTREAM.md entry: the same rule
 * its own handlers apply); tabs.onCreated/onUpdated strip the four
 * sensitive fields (stripSensitiveTabFields above) unless the listener
 * holds `tabs` OR host access to the tab's URL (Chrome's own either/or
 * rule, `hasApiOrHostAccess`'s own doc); every other tabs.* event and every
 * webNavigation.* event either carries no such field (tabs.onActivated/
 * onRemoved) or requires the `webNavigation` permission outright.
 */
function eventListenerFilter (extensionId: string, eventName: string, args: readonly unknown[]): readonly unknown[] | undefined {
  const manifest = session.defaultSession.extensions.getExtension(extensionId)?.manifest

  if (eventName === 'cookies.onChanged') {
    const changeInfo = args[0] as { cookie?: { domain?: unknown, path?: unknown, secure?: unknown } } | undefined
    const url = changeInfo?.cookie === undefined ? undefined : cookieChangeUrl(changeInfo.cookie)
    if (!hasApiPermission(manifest, 'cookies') || !hasHostAccess(manifest, url)) return undefined
    return args
  }

  if (eventName === 'tabs.onCreated') {
    const details = args[0] as { url?: string } | undefined
    if (hasApiOrHostAccess(manifest, 'tabs', details?.url)) return args
    return [stripSensitiveTabFields(details)]
  }

  if (eventName === 'tabs.onUpdated') {
    const [tabId, changeInfo, tab] = args as [unknown, unknown, { url?: string } | undefined]
    if (hasApiOrHostAccess(manifest, 'tabs', tab?.url)) return args
    return [tabId, stripSensitiveTabFields(changeInfo), stripSensitiveTabFields(tab)]
  }

  if (eventName === 'windows.onCreated' || eventName === 'windows.onBoundsChanged') {
    const details = args[0] as { tabs?: Array<{ url?: string }> } | undefined
    if (details?.tabs === undefined) return args
    const tabs = details.tabs.map((tab) =>
      hasApiOrHostAccess(manifest, 'tabs', tab?.url) ? tab : stripSensitiveTabFields(tab)
    )
    return [{ ...details, tabs }]
  }

  if (eventName.startsWith('webNavigation.')) {
    return hasApiPermission(manifest, 'webNavigation') ? args : undefined
  }

  return args
}

function windowFor (windowId: number | undefined): BaseWindow | undefined {
  if (bridge === undefined) return undefined
  if (windowId !== undefined) return bridge.services.windows.all().find((w) => w.window.id === windowId)?.window
  return bridge.services.windows.focused()?.window
}

/** Routes `window.open()`/`target=_blank` out of an extension popup or
 * MV2 background page through the same URL policy and `openTrusted`
 * chrome.tabs.create uses (createTab's own impl above), instead of letting
 * Electron's own default -- a raw, unpoliced BrowserWindow -- through.
 * Always denies the native window Electron would otherwise open: whatever
 * this opens, it opens itself, as a tracked tab. */
function setupWindowOpenPolicy (contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (bridge !== undefined) {
      const win = windowFor(undefined)
      const target = extensionOpenedUrl(url, isLoadedExtension)
      const shellWindow = win === undefined ? undefined : bridge.services.windows.all().find((w) => w.window === win)
      if (shellWindow !== undefined && target !== undefined) shellWindow.tabs.openTrusted(target)
    }
    return { action: 'deny' }
  })
}

/** Constructs the library, once, before any extension loads. `preloadPath`
 * is `extensions-subsystem.ts`'s bundle of `vendor/.../src/preload.ts` PLUS
 * Orivon's own service-worker-preload health check
 * (src/preload/extension-api.ts, extension-sw-preload-recovery.ts's own
 * header says why the check rides inside this one preload rather than a
 * second registration). docs/open-questions.md A289 has the open question
 * this exists for: under `--no-sandbox`, NOTHING registered as a
 * 'service-worker'-type session preload ever runs for a worker, reproduced
 * 100%. Sandboxed, it does run, but a freshly loaded extension's first
 * worker still races its registration and misses every time (measured:
 * 20/20 cold starts of a fixture extension, 4/4 of four real ones) --
 * watchForMissedServiceWorkerPreload's one-time reload recovers every miss
 * (0 failures after reload, same measurements), for either cause. */
export function createExtensionHost (preloadPath: string): ElectronChromeExtensions {
  setSessionPartitionResolver((partition) =>
    partition === EXTENSIONS_DEFAULT_PARTITION ? session.defaultSession : session.fromPartition(partition))
  setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
  setEventListenerFilter(eventListenerFilter)
  setCookieHostAccessCheck(hasHostAccess)
  setTabUrlAccessCheck((manifest, url) => hasApiOrHostAccess(manifest, 'tabs', url))
  setTabHostAccessCheck(hasHostAccess)

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
      const target = details.url === undefined ? undefined : extensionOpenedUrl(details.url, isLoadedExtension)
      if (details.url !== undefined && target === undefined) {
        throw new Error(`extensions: refused to open ${details.url}`)
      }
      const opened = shellWindow.tabs.openTrusted(target)
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

  watchForMissedServiceWorkerPreload(session.defaultSession)

  // Orivon patch: an extension popup's own page, and an MV2 background
  // page (Electron's own native support creates these -- never this
  // library), otherwise get no window-open policy of any kind: Electron's
  // default for window.open()/target=_blank is a raw, unpoliced
  // BrowserWindow. 'browser-action-popup-created' fires synchronously right
  // after the popup's own BrowserWindow is constructed (browser-action.ts's
  // own activateClick), before its page has had a chance to load and call
  // window.open() itself.
  hostExtensions.on('browser-action-popup-created', (popup) => {
    const wc = popup.browserWindow?.webContents
    if (wc !== undefined) setupWindowOpenPolicy(wc)
  })
  app.on('web-contents-created', (_event, contents) => {
    if (contents.session === session.defaultSession && contents.getType() === 'backgroundPage') {
      setupWindowOpenPolicy(contents)
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
 * tab whose webContents already finished being destroyed throws -- true of
 * an unexpected teardown (a crash: src/main/shell/tabs.ts's own 'destroyed'
 * handler runs forgetTab() well after destruction), even though an ordinary
 * close (closeTab(), or dispose() when the window itself closes) routes
 * through forgetTab() -- which calls tabClosed() -- while the webContents
 * is still live, well before it is actually destroyed. A `Set`, not a
 * `WeakSet`: `.delete()` on tabClosed/viewReplaced must be reachable
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
      if (trackedTabs.has(wc)) {
        notifyShell(wc, (t) => hostExtensions?.selectTab(t))
        return
      }
      // The shell activated a tab this library never learned about (an
      // `orivon:` page, or a granted app in its own partition) -- tell it
      // there is no active tab in that tab's window, rather than leaving it
      // pointed at whatever tracked tab was active before (extension-host.ts's
      // own `trackedTabs` doc; ExtensionStore.clearActiveTab's own doc).
      const found = bridge?.services.windows.findTab(wc)
      if (found != null) hostExtensions?.clearActiveTab(found.window.window)
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
