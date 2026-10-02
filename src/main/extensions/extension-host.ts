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
//      are created after every subsystem runs, so extension-host-impl.ts's
//      callbacks (createTab, createWindow, ...) reject cleanly if an
//      extension somehow calls one before this runs.
import { session } from 'electron'
import type { Session, WebContents } from 'electron'
// Virtual specifiers (electron-chrome-extensions-lib.d.ts's own header says
// why): electron.vite.config.ts's alias resolves each to the real vendor
// file for bundling; tsc uses that .d.ts's ambient declaration instead.
import { ElectronChromeExtensions } from 'orivon:crx-extensions'
import { setSessionPartitionResolver } from 'orivon:crx-extensions-partition'
import { setEventListenerFilter, setMessageSenderIdCheck, setRemoteMessageSenderCheck } from 'orivon:crx-extensions-router'
import { setCookieHostAccessCheck } from 'orivon:crx-extensions-cookies'
import { setTabUrlAccessCheck, setTabHostAccessCheck } from 'orivon:crx-extensions-tabs'
import { setTabCaptureInvocationRecorder } from 'orivon:crx-extensions-browser-action'
import { setTabCaptureAppRefusalCheck, setTabCaptureConsumedCheck, setTabCaptureGrantRecorder, setTabCaptureInvocationCheck } from 'orivon:crx-extensions-tab-capture'
import type { ShellServices } from '../shell/shell-services.js'
import type { SubsystemContext } from '../registry.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { mintTabCaptureGrant, wasTabCaptureGrantConsumed } from '../sessions/tab-capture-grants.js'
import { setTabCaptureMediaAppRefusalCheck } from '../sessions/tab-capture-media.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { EXTENSION_SANDBOX_CSP_FILTER, extensionSandboxCsp } from './extension-sandbox-csp.js'
import { appOrigin } from '../shell/devtools-app-origin.js'
import { eventListenerFilter } from './extension-event-filter.js'
import { closeCurrentPopup, installPopupPolicy } from './extension-popup-policy.js'
import { buildHostImpl, isExtensionActivatingTab, isLoadedExtension, shellInitiated, type ShellBridge } from './extension-host-impl.js'
import { watchPinSetting } from './action-pins-runner.js'
import { watchForMissedServiceWorkerPreload } from './extension-sw-preload-recovery.js'
import { beginDnrReload, endDnrReload } from './extensions-dnr.js'
import { senderMatchesClaimedExtensionId } from './extension-sender-id-check.js'
import { registerSandboxPageQuery } from './extension-sandbox-page-query.js'
import { apiOrHostAccessFor, hostAccessFor } from './extension-host-access.js'
import { clearInvocationsForExtension, hasRecentInvocation } from './extension-tab-invocation.js'
import { recordTabCaptureInvocation } from './extension-tab-capture-invocation.js'

/** The session's extensions emitter takes one `extension-unloaded` listener from each extension subsystem: the
 * vendored library's eight, the invocation ledger, the dNR engine, the bookmarks and manifest APIs, the command
 * keys and the loaded-extensions feed, which is past Node's warning line of ten. Set here, before the first of them
 * attaches, and above the count with room for a subsystem to come, not unlimited: a listener added per extension or
 * per navigation still warns. */
export const EXTENSIONS_LISTENER_ROOM = 32

/** The `<browser-action-list partition="...">` token that resolves to
 * `session.defaultSession`, where every extension runs -- the default
 * session has no name of its own for `session.fromPartition()` to find, so
 * partition.ts's resolver is taught this one extra string. Set on the shell
 * preload too (src/preload/shell.ts), duplicated rather than imported for
 * the same reason APP_TAB_FLAG is (tab-view.ts's own comment). */
export const EXTENSIONS_DEFAULT_PARTITION = 'orivon-extensions-default'

let bridge: ShellBridge | undefined
let hostExtensions: ElectronChromeExtensions | undefined

/** The library's host; undefined until `createExtensionHost` has run. */
export function extensionHost (): ElectronChromeExtensions | undefined {
  return hostExtensions
}

/** The shell's services once the first window exists, undefined before. */
export function shellServices (): ShellServices | undefined {
  return bridge?.services
}

const shellWaiters: Array<(services: ShellServices) => void> = []

/** Runs `run` with the shell's services: now when they exist, else once the first window attaches. */
export function whenShellServices (run: (services: ShellServices) => void): void {
  if (bridge !== undefined) run(bridge.services)
  else shellWaiters.push(run)
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
  const sessionExtensions = session.defaultSession.extensions
  sessionExtensions.setMaxListeners(Math.max(sessionExtensions.getMaxListeners(), EXTENSIONS_LISTENER_ROOM))
  setSessionPartitionResolver((partition) =>
    partition === EXTENSIONS_DEFAULT_PARTITION ? session.defaultSession : session.fromPartition(partition))
  setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
  setEventListenerFilter(eventListenerFilter)
  setCookieHostAccessCheck((manifest, url, extensionId) => hostAccessFor(extensionId, manifest, url))
  setTabUrlAccessCheck((manifest, url, extensionId, tabId) => apiOrHostAccessFor(extensionId, manifest, 'tabs', url, tabId))
  setTabHostAccessCheck((manifest, url, extensionId, tabId) => hostAccessFor(extensionId, manifest, url, tabId))
  setTabCaptureInvocationRecorder(recordTabCaptureInvocation)
  setTabCaptureInvocationCheck(hasRecentInvocation)
  setTabCaptureGrantRecorder((extensionId, targetTabId) => { mintTabCaptureGrant(extensionId, targetTabId, Date.now()) })
  setTabCaptureConsumedCheck(wasTabCaptureGrantConsumed)
  // Orivon patch (UPSTREAM.md patch 33): the activeTab-style
  // invocation ledger (extension-tab-invocation.ts) otherwise survives a
  // disable/uninstall/crash -- the same 'extension-unloaded' signal
  // offscreen.ts's own listener and tab-capture.ts's own listener already
  // key their own teardown off.
  const invocationSessionExtensions = session.defaultSession.extensions || session.defaultSession
  invocationSessionExtensions.addListener('extension-unloaded', (_event, extension) => {
    clearInvocationsForExtension(extension.id)
  })
  // Orivon patch (UPSTREAM.md patch 37): the vendored preload's own
  // synchronous query, before it ever calls injectExtensionAPIs() --
  // extension-sandbox-page-query.ts's own doc.
  registerSandboxPageQuery()
  // Orivon patch (UPSTREAM.md patch 40): the real A302 fix -- gives a
  // manifest sandbox.pages document Chrome's own CSP `sandbox`, so it
  // actually gets an opaque origin, rather than only withholding chrome.*
  // (patch 37) from a page that still runs at the extension's own origin.
  webRequestOwnerFor(session.defaultSession).onHeadersReceived(
    RUN_LAST,
    EXTENSION_SANDBOX_CSP_FILTER,
    (url) => url.startsWith('chrome-extension://'),
    extensionSandboxCsp()
  )

  hostExtensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: session.defaultSession,
    preloadPath,
    ...buildHostImpl(() => bridge)
  })

  // extension-sw-preload-recovery.ts must not import extensions-dnr.ts
  // itself (its own header says why -- a preload script imports from that
  // file too), so this call site is what supplies the dNR-specific reload
  // marking: extensions-dnr.ts's own 'extension-unloaded' handler would
  // otherwise drop session rules, badge mode and its webRequest
  // registration for a worker recovering from a missed preload, which is
  // not a real unload.
  watchForMissedServiceWorkerPreload(session.defaultSession, (id, phase) => {
    if (phase === 'start') beginDnrReload(id)
    else endDnrReload(id)
  })

  installPopupPolicy(hostExtensions, { services: () => bridge?.services, isLoaded: isLoadedExtension })

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
  for (const run of shellWaiters.splice(0)) run(services)
  watchPinSetting(services)

  setRemoteMessageSenderCheck((event) => event.type === 'frame' && isFromChromeView(event.sender))
  // ADR-0044 moved a granted, network-served app's tab into this SAME
  // default session tabCapture's own tab store tracks -- the same
  // predicate shell-services.ts's own DevTools prompt uses for the
  // identical "is this tab an app I granted, not an ordinary site" question.
  const tabCaptureAppRefusal = (tab: WebContents): boolean => {
    const origin = appOrigin(originFromUrl, tab)
    return origin !== null && ctx.broker?.app.hasGrantsSync(origin) === true
  }
  setTabCaptureAppRefusalCheck(tabCaptureAppRefusal)
  // The same predicate, registered a second time for permission-gate.ts's
  // own re-check inside the 'media' REQUEST handler -- setTabCaptureMediaAppRefusalCheck's
  // own doc says why a single registration point (this file's own
  // `setTabCaptureAppRefusalCheck`, read only by the vendored tab-capture.ts)
  // is not enough on its own.
  setTabCaptureMediaAppRefusalCheck(tabCaptureAppRefusal)

  services.tabLifecycle.subscribe({
    tabCreated: (wc, win) => {
      // wc is freshly created here, in every case -- safe to read .session.
      if (win === undefined || wc.session !== session.defaultSession) return
      trackedTabs.add(wc)
      hostExtensions?.addTab(wc, win)
    },
    tabActivated: (wc) => {
      // Chrome closes an open browserAction popup the moment the PERSON
      // switches tabs -- 'browser-action-popup-created' wires the same
      // close for the active tab's own navigation; this is the other half.
      // Never for a switch the popup's own extension just made through
      // chrome.tabs.create/update (isExtensionActivatingTab's own doc):
      // test/e2e-extensions-toolbar.test.ts deliberately keeps the popup
      // open and interactive across its own chrome.tabs.create() call.
      if (!isExtensionActivatingTab()) closeCurrentPopup()
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
      // The library takes a tab it is handed to be the one in front. A view replaced behind the person's back (a tab
      // put to sleep) must not pull the window to it, and the library's own idea of the front tab goes back.
      notifyShell(newWc, (t) => hostExtensions?.addTab(t, win))
      const front = bridge?.services.windows.findTab(newWc)?.window.tabs.activeWebContents()
      if (front !== undefined && front !== newWc && trackedTabs.has(front)) notifyShell(front, (t) => hostExtensions?.selectTab(t))
    }
  })

  ElectronChromeExtensions.handleCRXProtocol(shellSession)
}
