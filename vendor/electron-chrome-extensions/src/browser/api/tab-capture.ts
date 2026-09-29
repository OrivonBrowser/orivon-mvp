// Orivon patch (UPSTREAM.md, patch 33): chrome.tabCapture is absent from
// Electron; only `webContents.getMediaSourceId(requestWebContents)` exists
// as the underlying primitive (electron.d.ts: "restricted to the web
// contents that it is registered to... valid for 10 seconds"). Only
// `getMediaStreamId` (plus the cheap `getCapturedTabs`/`onStatusChanged`
// pair) is implemented -- `capture()` itself is a getUserMedia call Chrome
// makes on the extension's OWN behalf and has no real users among MV3
// extensions using tabCapture through an offscreen document, which always
// call `getMediaStreamId` and do their own `getUserMedia` instead.
//
// `targetTabId` resolves through `ctx.store.getTabById`/
// `getActiveTabOfCurrentWindow` ONLY -- the same store `extension-host.ts`'s
// `tabLifecycle.subscribe` populates ONLY for `wc.session ===
// session.defaultSession` (its own `tabCreated` doc). An `orivon://` page or
// another extension's page were never added, so a non-default session is
// already unreachable here; the explicit session check below is
// belt-and-suspenders documentation of that fact, not new work. A granted
// app's own tab is a SEPARATE refusal: ADR-0044 moved a granted, network-
// served app into this SAME default session, so it passes the session
// check -- `setTabCaptureAppRefusalCheck` (extension-host.ts) is the actual
// gate for it, the same `broker.app.hasGrantsSync` predicate
// shell-services.ts's own DevTools prompt uses for the identical question.
import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'
import type { OffscreenAPI } from './offscreen'

/** Chrome's own error text (developer.chrome.com/docs/extensions/reference/
 * api/tabCapture): an extension may capture a tab only after being invoked
 * on it. Real Chrome ties this to the `activeTab` permission; Orivon's own
 * ledger (this file's own `setTabCaptureInvocationCheck`) tracks the same
 * thing for a toolbar click regardless of which permission grants it, since
 * `tabCapture` itself carries the same "must be invoked" rule as
 * `activeTab` in Chrome's own docs. */
const NOT_INVOKED_MESSAGE =
  'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'

type InvocationCheck = (extensionId: string, tabId: number) => boolean
let gInvocationCheck: InvocationCheck | undefined
export function setTabCaptureInvocationCheck (check: InvocationCheck): void {
  gInvocationCheck = check
}

/** True when `tab` must be refused outright -- a granted app's own tab
 * (this file's own header). Unset, every tab the store tracks is eligible,
 * which is correct for a session with no granted apps in it at all (a unit
 * test's fake store, for instance). */
type AppRefusalCheck = (tab: Electron.WebContents) => boolean
let gAppRefusalCheck: AppRefusalCheck | undefined
export function setTabCaptureAppRefusalCheck (check: AppRefusalCheck): void {
  gAppRefusalCheck = check
}

/** Called once per successful `getMediaStreamId`, so `permission-gate.ts`'s
 * `'media'` carve-out (`tab-capture-grants.ts`) knows this extension is
 * mid-capture. Set once, before the first call (extension-host.ts). */
type GrantRecorder = (extensionId: string) => void
let gGrantRecorder: GrantRecorder | undefined
export function setTabCaptureGrantRecorder (recorder: GrantRecorder): void {
  gGrantRecorder = recorder
}

/** True once `permission-gate.ts` has actually allowed a `'media'` request
 * for this extension -- `tab-capture-grants.ts`'s own
 * `wasTabCaptureGrantConsumed`, wired from `extension-host.ts`. This is
 * `observeOffscreenTeardown`'s real "did a getUserMedia('tab') call for
 * this grant ever actually happen" signal -- see its own doc for why a
 * media-playback event cannot answer that question. */
type ConsumedCheck = (extensionId: string) => boolean
let gConsumedCheck: ConsumedCheck | undefined
export function setTabCaptureConsumedCheck (check: ConsumedCheck): void {
  gConsumedCheck = check
}

interface CapturedTabRecord {
  previousMuted: boolean
  capturedBy: Set<string>
}

export class TabCaptureAPI {
  private capturedTabs = new Map<Electron.WebContents, CapturedTabRecord>()
  private extensionCaptures = new Map<string, Set<Electron.WebContents>>()
  /** Extensions whose offscreen document already has the teardown/safety
   * listeners below attached -- idempotent the same way `api/tabs.ts`'s
   * `observeTab` is (UPSTREAM.md patch 29's own doc): the offscreen document
   * is recreated at most once in its lifetime, but never twice for the
   * same still-open instance. */
  private observedOffscreen = new Set<string>()

  constructor (
    private ctx: ExtensionContext,
    private offscreen: OffscreenAPI,
  ) {
    const handle = this.ctx.router.apiHandler()
    handle('tabCapture.getMediaStreamId', this.getMediaStreamId.bind(this), { permission: 'tabCapture' })
    handle('tabCapture.getCapturedTabs', this.getCapturedTabs.bind(this), { permission: 'tabCapture' })
  }

  private async getMediaStreamId (
    event: ExtensionEvent,
    options: chrome.tabCapture.GetMediaStreamOptions = {},
  ): Promise<string> {
    const extensionId = event.extension.id

    const targetTab =
      options.targetTabId !== undefined
        ? this.ctx.store.getTabById(options.targetTabId)
        : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!targetTab) {
      throw new Error(`tabCapture.getMediaStreamId: no tab with id ${String(options.targetTabId)}`)
    }
    if (targetTab.session !== this.ctx.session) {
      throw new Error('tabCapture.getMediaStreamId: refused -- the target tab is not in this extension\'s session.')
    }
    if (gAppRefusalCheck?.(targetTab) === true) {
      throw new Error('tabCapture.getMediaStreamId: refused -- the target tab belongs to a granted app.')
    }

    if (gInvocationCheck?.(extensionId, targetTab.id) !== true) {
      throw new Error(NOT_INVOKED_MESSAGE)
    }

    const consumer =
      options.consumerTabId !== undefined
        ? this.ctx.store.getTabById(options.consumerTabId)
        : this.offscreen.getDocumentWebContents(extensionId)
    if (!consumer) {
      throw new Error(
        'tabCapture.getMediaStreamId: no consumer -- chrome.offscreen.createDocument() must resolve first ' +
          '(or pass consumerTabId), the same way real Chrome requires a consumer for this call.',
      )
    }

    const streamId = targetTab.getMediaSourceId(consumer)
    gGrantRecorder?.(extensionId)
    this.beginCapture(extensionId, targetTab)
    this.scheduleUnconsumedRelease(extensionId)
    return streamId
  }

  /** The one safety net this file still keeps a timer for: a minted id
   * whose getUserMedia('tab') call never actually happened (a bug in the
   * extension's own offscreen page, or a denied prompt) would otherwise
   * leave the tab muted forever, with no tab-close or offscreen-close event
   * ever coming to release it. `gConsumedCheck` (`tab-capture-grants.ts`'s
   * `wasTabCaptureGrantConsumed`, set from `permission-gate.ts`'s own
   * allow path) is the real signal a capture actually started -- checked
   * once, at exactly the id's own validity window
   * (`tab-capture-grants.ts`'s `TAB_CAPTURE_GRANT_MS`), never on any other
   * schedule. A CONSUMED capture is never released on a timer again,
   * however long it goes on to run. */
  private scheduleUnconsumedRelease (extensionId: string): void {
    setTimeout(() => {
      if (gConsumedCheck?.(extensionId) !== true) this.releaseExtensionCaptures(extensionId)
    }, TAB_CAPTURE_SAFETY_NET_MS)
  }

  private async getCapturedTabs (event: ExtensionEvent): Promise<chrome.tabCapture.CaptureInfo[]> {
    const tabs = this.extensionCaptures.get(event.extension.id)
    if (!tabs) return []
    return Array.from(tabs)
      .filter((wc) => !wc.isDestroyed())
      .map((wc) => ({ tabId: wc.id, status: 'active', fullscreen: false }))
  }

  /** Mutes the tab's own local playback -- Electron duplicates what a
   * captured tab plays instead of diverting it the way Chrome does
   * (measured: `tabWc.isCurrentlyAudible()` stays true, and the consumer
   * receives the same signal, after `getUserMedia('tab')`; muting the
   * source does NOT also silence what the consumer receives, measured the
   * same way). One extension capturing a tab twice, or two different
   * extensions capturing the same tab, share one `previousMuted` and are
   * only actually unmuted once every capturer has released it. */
  private beginCapture (extensionId: string, tab: Electron.WebContents): void {
    let record = this.capturedTabs.get(tab)
    if (!record) {
      record = { previousMuted: tab.audioMuted, capturedBy: new Set() }
      this.capturedTabs.set(tab, record)
      tab.setAudioMuted(true)
      tab.once('destroyed', () => { this.releaseAllCapturesOfTab(tab) })
    }
    const isNewCapture = !record.capturedBy.has(extensionId)
    record.capturedBy.add(extensionId)

    let extTabs = this.extensionCaptures.get(extensionId)
    if (!extTabs) { extTabs = new Set(); this.extensionCaptures.set(extensionId, extTabs) }
    extTabs.add(tab)

    if (isNewCapture) {
      this.ctx.router.sendEvent(extensionId, 'tabCapture.onStatusChanged', {
        tabId: tab.id, status: 'active', fullscreen: false,
      })
    }
    this.observeOffscreenTeardown(extensionId)
  }

  /** The offscreen document is this extension's only capture consumer
   * (`getMediaStreamId`'s own doc), so its destruction -- `closeDocument()`,
   * disable, uninstall, or a crash (`offscreen.ts`'s own
   * 'extension-unloaded' listener) -- is a real signal every capture this
   * extension holds has ended, the "the media stream ... closed by the
   * extension" half of Chrome's own tabCapture doc; a closed tab is the
   * other half, handled per-tab in `beginCapture`'s own `'destroyed'`
   * listener.
   *
   * MEASURED, and deliberately not used as a signal here:
   * `WebContents`'s own `'media-started-playing'` DOES fire for an
   * `AudioContext` graph routed to `ctx.destination` in this Electron
   * version (confirmed directly against this fixture's own offscreen
   * page) -- the opposite of what was assumed when this safety net was
   * first written. It is still the wrong signal to build on: nothing
   * documents that behaviour, a future Chromium could change it either
   * way, and it says nothing about the ONE case this file actually needs
   * a signal for -- a minted id that never got consumed at all, which
   * never fires ANY media event, playing or not. `scheduleUnconsumedRelease`
   * (called once per `getMediaStreamId`, not here) is the real replacement:
   * it asks `tab-capture-grants.ts` whether a genuine `getUserMedia('tab')`
   * call ever actually redeemed the id, the one fact a media-playback
   * event was only ever a proxy for. */
  private observeOffscreenTeardown (extensionId: string): void {
    if (this.observedOffscreen.has(extensionId)) return
    const offscreenContents = this.offscreen.getDocumentWebContents(extensionId)
    if (!offscreenContents) return
    this.observedOffscreen.add(extensionId)

    offscreenContents.once('destroyed', () => {
      this.observedOffscreen.delete(extensionId)
      this.releaseExtensionCaptures(extensionId)
    })
  }

  private releaseExtensionCaptures (extensionId: string): void {
    const tabs = this.extensionCaptures.get(extensionId)
    if (!tabs) return
    this.extensionCaptures.delete(extensionId)
    for (const tab of tabs) {
      this.releaseCapture(extensionId, tab)
      if (!tab.isDestroyed()) {
        this.ctx.router.sendEvent(extensionId, 'tabCapture.onStatusChanged', { tabId: tab.id, status: 'stopped', fullscreen: false })
      }
    }
  }

  private releaseAllCapturesOfTab (tab: Electron.WebContents): void {
    const record = this.capturedTabs.get(tab)
    if (!record) return
    for (const extensionId of Array.from(record.capturedBy)) this.releaseCapture(extensionId, tab)
  }

  private releaseCapture (extensionId: string, tab: Electron.WebContents): void {
    const record = this.capturedTabs.get(tab)
    if (!record) return
    record.capturedBy.delete(extensionId)
    this.extensionCaptures.get(extensionId)?.delete(tab)
    if (record.capturedBy.size === 0) {
      this.capturedTabs.delete(tab)
      if (!tab.isDestroyed()) tab.setAudioMuted(record.previousMuted)
    }
  }
}

/** Electron's own `getMediaSourceId` validity window (electron.d.ts), reused
 * as the safety net's own bound -- see `observeOffscreenTeardown`'s doc. */
const TAB_CAPTURE_SAFETY_NET_MS = 10_000
