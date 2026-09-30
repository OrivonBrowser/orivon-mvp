// Wires the upgrade tracker to real tabs: a failed load of an upgraded address
// puts the warning sheet over that tab. Tied to Electron through the events of
// the WebContents it is given; the decisions are in ./https-fallback.ts.
import type { WebContents } from 'electron'
import { HTTPS_WARNING_OVERLAY } from './https-warning-overlay.js'
import type { FailedUpgrade, HttpsState } from './https-state.js'
import type { UpgradeTracker } from './https-fallback.js'
import type { requestSlot as requestSlotFn } from '../overlays/tab-slots.js'
import type { WindowRegistry } from '../shell/window-registry.js'

export interface FallbackDeps {
  readonly tracker: UpgradeTracker
  readonly state: HttpsState
  readonly windows: Pick<WindowRegistry, 'findTab'>
  readonly requestSlot: typeof requestSlotFn
}

export interface FallbackSheets {
  /** Puts the sheet for `failed` over the tab holding `contents`; false when `contents` is not a tab. */
  show: (contents: WebContents | undefined, failed: FailedUpgrade) => boolean
  /** Follows one WebContents: its failed loads, its committed pages and its end. */
  watch: (contents: WebContents) => void
}

export function createFallbackSheets (deps: FallbackDeps): FallbackSheets {
  /** One sheet per tab: a newer failure replaces the one waiting. */
  const asks = new Map<string, { cancel: () => void }>()

  function show (contents: WebContents | undefined, failed: FailedUpgrade): boolean {
    if (contents === undefined || contents.isDestroyed()) return false
    const found = deps.windows.findTab(contents)
    if (found === null) return false
    const { window, tabId } = found
    asks.get(tabId)?.cancel()
    deps.state.failed.set(tabId, failed)
    // `closed` may run before `requestSlot` returns (a full queue), so it cannot refer to the ask itself.
    const mine = { cancel: () => {} }
    const ask = deps.requestSlot({
      window,
      tabId,
      slot: 'center',
      overlay: HTTPS_WARNING_OVERLAY,
      payload: { tabId },
      closed: () => {
        if (asks.get(tabId) === mine) asks.delete(tabId)
        if (deps.state.failed.get(tabId) === failed) deps.state.failed.clear(tabId)
      }
    })
    mine.cancel = ask.cancel
    asks.set(tabId, mine)
    return true
  }

  /** The sheet ends when the tab starts loading something else; the failed page's own error page is not that. */
  function endSheet (contents: WebContents): void {
    const found = deps.windows.findTab(contents)
    if (found !== null) asks.get(found.tabId)?.cancel()
  }

  const watched = new WeakSet<WebContents>()

  function watch (contents: WebContents): void {
    if (watched.has(contents)) return
    watched.add(contents)
    const id = contents.id
    contents.on('did-fail-load', (_event, errorCode, _description, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      const upgrade = deps.tracker.failed(id, validatedUrl, errorCode)
      if (upgrade === null) return
      try {
        show(contents, { from: upgrade.from, host: new URL(upgrade.from).hostname })
      } catch (error) {
        console.error('[privacy] could not show the secure-connection warning:', error)
      }
    })
    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument && !event.url.startsWith('chrome-error:')) endSheet(contents)
    })
    contents.on('did-navigate', (_event, url) => { deps.tracker.navigated(id, url) })
    contents.once('destroyed', () => { deps.tracker.forget(id) })
  }

  return { show, watch }
}
