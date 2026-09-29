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

/**
 * (item H) A capturable target is an ordinary web page, never a
 * `chrome-extension://` page. MEASURED: `ctx.store` (this file's own header)
 * tracks every `wc.session === session.defaultSession` tab, and ADR-0044
 * put a granted app's own `chrome-extension://`-hosted... no -- put a
 * granted app's tab in that SAME session, which is what
 * `setTabCaptureAppRefusalCheck` exists to refuse; a DIFFERENT extension's
 * own page (its popup opened as a tab, its options page, another
 * extension's offscreen document) is ALSO tracked there and is NOT a
 * granted app, so `gAppRefusalCheck` alone lets it through --
 * `devtools-app-origin.ts`'s own `appOrigin` returns null for a
 * `chrome-extension://` page, and `hasGrantsSync(null)` is never true.
 * DECIDED: refuse every non-`http(s)` target outright, the caller's OWN
 * `chrome-extension://<self>/` pages included, rather than carving out an
 * exception for them -- real Chrome's own tabCapture is documented and used
 * against ordinary tabs; no fixture or real extension in this repo captures
 * its own page, and refusing it outright is the one rule that needs no
 * "whose page is this, really" identity check of its own.
 */
function isHttpOrHttpsUrl (url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

type InvocationCheck = (extensionId: string, tabId: number) => boolean
let gInvocationCheck: InvocationCheck | undefined
export function setTabCaptureInvocationCheck (check: InvocationCheck): void {
  gInvocationCheck = check
}

/** True when `tab` must be refused outright -- a granted app's own tab
 * (this file's own header). Unset, every tab the store tracks is eligible,
 * which is correct for a session with no granted apps in it at all (a unit
 * test's fake store, for instance). Consulted twice per capture (item I):
 * once here at mint time, and again on the captured tab's own
 * `did-navigate` (`recheckCaptureStillAllowed`) -- a tab minted while
 * ungranted can navigate to a granted app's origin mid-capture, and a mint
 * check alone would never notice. */
type AppRefusalCheck = (tab: Electron.WebContents) => boolean
let gAppRefusalCheck: AppRefusalCheck | undefined
export function setTabCaptureAppRefusalCheck (check: AppRefusalCheck): void {
  gAppRefusalCheck = check
}

/** Called once per successful `getMediaStreamId`, so `permission-gate.ts`'s
 * `'media'` carve-out (`tab-capture-grants.ts`) knows this extension is
 * mid-capture FOR THIS EXACT TAB (item F: the ledger is keyed by
 * (extensionId, targetTabId), never extension alone). Set once, before the
 * first call (extension-host.ts). */
type GrantRecorder = (extensionId: string, targetTabId: number) => void
let gGrantRecorder: GrantRecorder | undefined
export function setTabCaptureGrantRecorder (recorder: GrantRecorder): void {
  gGrantRecorder = recorder
}

/** True once `permission-gate.ts` has actually allowed a `'media'` request
 * for this exact (extensionId, targetTabId) pair -- `tab-capture-grants.ts`'s
 * own `wasTabCaptureGrantConsumed`, wired from `extension-host.ts`. This is
 * `scheduleUnconsumedRelease`'s real "did a getUserMedia('tab') call for
 * THIS tab's grant ever actually happen" signal -- see its own doc for why
 * a media-playback event cannot answer that question, and item F's own doc
 * for why this is per-tab, not per-extension: an extension capturing two
 * tabs at once must have each tab's own still-unredeemed mint judged (and
 * released) independently of the other's. */
type ConsumedCheck = (extensionId: string, targetTabId: number) => boolean
let gConsumedCheck: ConsumedCheck | undefined
export function setTabCaptureConsumedCheck (check: ConsumedCheck): void {
  gConsumedCheck = check
}

interface CapturedTabRecord {
  previousMuted: boolean
  capturedBy: Set<string>
  /** (item J) Stored so `releaseCapture` can remove it: the original code
   * attached this with `tab.once(...)` but never removed it if the capture
   * ended WITHOUT the tab dying (the ordinary case) -- a tab captured,
   * released, and captured again leaked one more armed 'destroyed' listener
   * on it every cycle, forever, since `once` only self-removes when the
   * event it is waiting for actually fires. */
  onDestroyed: () => void
  /** (item I) The captured tab's own re-check on navigation; same removal
   * requirement as `onDestroyed`, and the same reason: this is `.on`, not
   * `.once`, so it never self-removes at all. */
  onNavigate: () => void
}

/** (item G) One entry per live capture, keyed by (extensionId, targetTabId)
 * -- exists only so `observeConsumerTeardown` can find every capture that
 * shares a given CONSUMER webContents (the offscreen document, or the
 * `consumerTabId` tab) when that consumer dies, without having to search
 * `extensionCaptures` for tabs and guess which consumer each one used. */
interface CaptureRecord {
  consumer: Electron.WebContents
}

function captureKey (extensionId: string, targetTabId: number): string {
  return `${extensionId}\u0000${String(targetTabId)}`
}

export class TabCaptureAPI {
  private capturedTabs = new Map<Electron.WebContents, CapturedTabRecord>()
  private extensionCaptures = new Map<string, Set<Electron.WebContents>>()
  private captureRecords = new Map<string, CaptureRecord>()
  /** Consumers whose teardown (`'destroyed'`/`'render-process-gone'`) is
   * already being watched -- idempotent the same way `api/tabs.ts`'s
   * `observeTab` is (UPSTREAM.md patch 29's own doc): a consumer that hosts
   * several captures (one offscreen document capturing two tabs) gets
   * exactly one pair of listeners, not one pair per capture. */
  private observedConsumers = new Set<Electron.WebContents>()

  constructor (
    private ctx: ExtensionContext,
    private offscreen: OffscreenAPI,
  ) {
    const handle = this.ctx.router.apiHandler()
    handle('tabCapture.getMediaStreamId', this.getMediaStreamId.bind(this), { permission: 'tabCapture' })
    handle('tabCapture.getCapturedTabs', this.getCapturedTabs.bind(this), { permission: 'tabCapture' })

    // (item G) "release on extension-unloaded regardless": this fires for
    // disable, uninstall AND a crashed extension alike, whether the
    // consumer was an offscreen document (whose own destruction already
    // cascades here through observeConsumerTeardown) or a `consumerTabId`
    // tab (which has no such cascade of its own) -- this listener is the
    // one path that covers both, directly, rather than depending on the
    // consumer also happening to die.
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    sessionExtensions.addListener('extension-unloaded', (_event: unknown, extension: { id: string }) => {
      this.releaseExtensionCaptures(extension.id)
    })
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
    if (!isHttpOrHttpsUrl(targetTab.getURL())) {
      throw new Error('tabCapture.getMediaStreamId: refused -- only an http(s) tab may be captured.')
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
    gGrantRecorder?.(extensionId, targetTab.id)
    this.beginCapture(extensionId, targetTab, consumer)
    this.scheduleUnconsumedRelease(extensionId, targetTab)
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
   * however long it goes on to run.
   *
   * (item F) Releases ONLY `targetTab`'s own capture, never every tab this
   * extension holds: an extension minting a grant for tab A and, separately,
   * a still-live grant for tab B, must have A's own unconsumed timer leave
   * B alone. The old code called `releaseExtensionCaptures(extensionId)`
   * here, which released every tab at once -- exactly the bug. */
  private scheduleUnconsumedRelease (extensionId: string, targetTab: Electron.WebContents): void {
    setTimeout(() => {
      if (gConsumedCheck?.(extensionId, targetTab.id) !== true) this.endCapture(extensionId, targetTab)
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
  private beginCapture (extensionId: string, tab: Electron.WebContents, consumer: Electron.WebContents): void {
    let record = this.capturedTabs.get(tab)
    if (!record) {
      const onDestroyed = (): void => { this.releaseAllCapturesOfTab(tab) }
      const onNavigate = (): void => { this.recheckCaptureStillAllowed(tab) }
      record = { previousMuted: tab.audioMuted, capturedBy: new Set(), onDestroyed, onNavigate }
      this.capturedTabs.set(tab, record)
      tab.setAudioMuted(true)
      tab.once('destroyed', onDestroyed)
      // `did-navigate` fires only for a main-frame navigation (Electron's
      // own docs), which is exactly item I's own scope -- an iframe inside
      // the captured page navigating elsewhere is not the tab "becoming a
      // different page" the granted-app/http(s) refusal cares about.
      tab.on('did-navigate', onNavigate)
    }
    const isNewCapture = !record.capturedBy.has(extensionId)
    record.capturedBy.add(extensionId)

    let extTabs = this.extensionCaptures.get(extensionId)
    if (!extTabs) { extTabs = new Set(); this.extensionCaptures.set(extensionId, extTabs) }
    extTabs.add(tab)

    this.captureRecords.set(captureKey(extensionId, tab.id), { consumer })
    this.observeConsumerTeardown(consumer)

    if (isNewCapture) {
      this.ctx.router.sendEvent(extensionId, 'tabCapture.onStatusChanged', {
        tabId: tab.id, status: 'active', fullscreen: false,
      })
    }
  }

  /** (item I) Re-run at the captured tab's own `did-navigate`: a tab that
   * was an ordinary page at mint time can navigate to a granted app's
   * origin, or (defensively) to a non-http(s) URL, without ever closing --
   * `getMediaStreamId`'s own checks only ever ran once, at mint. Ends every
   * extension's capture of this tab the moment either check newly refuses,
   * the same way a real tab-close would. */
  private recheckCaptureStillAllowed (tab: Electron.WebContents): void {
    if (tab.isDestroyed()) return
    const refused = gAppRefusalCheck?.(tab) === true || !isHttpOrHttpsUrl(tab.getURL())
    if (!refused) return
    const record = this.capturedTabs.get(tab)
    if (!record) return
    for (const extensionId of Array.from(record.capturedBy)) this.endCapture(extensionId, tab)
  }

  /** (item G) Watches the actual CONSUMER of a capture -- the offscreen
   * document by default, or the `consumerTabId` tab when the extension
   * named one explicitly -- rather than assuming it is always the offscreen
   * document (the old code's `observeOffscreenTeardown` did). Both
   * `'destroyed'` and `'render-process-gone'` end every capture that used
   * this exact consumer: a renderer crash leaves the consumer's webContents
   * alive but unable to ever receive the stream again, the same practical
   * effect as it closing.
   *
   * DECIDED, and deliberately NOT built: a periodic `isCurrentlyAudible()`
   * poll on the consumer, to catch "the extension stopped the track but
   * kept the document open" without either of the above firing. Measured/
   * reasoned against it: a consumer that only records the captured stream
   * (`MediaRecorder`, never routed to `ctx.destination`) is legitimately
   * NEVER audible for the consumer's own webContents, for the capture's
   * entire real duration -- polling would release a live, correctly-running
   * capture within the same window meant to catch a stopped one, and
   * `chrome.tabCapture`'s own real-world use is at least as often
   * record-only as it is play-back. `media-paused`/`audio-state-changed`
   * are `HTMLMediaElement` events and never fire for a `MediaStreamTrack`
   * piped through Web Audio at all (Volume Master's own shape), so neither
   * candidate in the brief is a safe, general signal. The two events this
   * method actually watches, plus `extension-unloaded` (constructor) and
   * the tab's own `did-navigate`/`destroyed` handlers, are the ones this
   * library can act on without guessing at the extension's own intent. */
  private observeConsumerTeardown (consumer: Electron.WebContents): void {
    if (this.observedConsumers.has(consumer)) return
    this.observedConsumers.add(consumer)

    const onConsumerGone = (): void => {
      this.observedConsumers.delete(consumer)
      for (const [key, record] of Array.from(this.captureRecords)) {
        if (record.consumer !== consumer) continue
        this.captureRecords.delete(key)
        const separator = key.indexOf('\u0000')
        const extensionId = key.slice(0, separator)
        const targetTabId = Number(key.slice(separator + 1))
        const tab = this.ctx.store.getTabById(targetTabId)
        if (tab) this.endCapture(extensionId, tab)
      }
    }
    consumer.once('destroyed', onConsumerGone)
    consumer.once('render-process-gone', onConsumerGone)
  }

  private releaseExtensionCaptures (extensionId: string): void {
    const tabs = this.extensionCaptures.get(extensionId)
    if (!tabs) return
    this.extensionCaptures.delete(extensionId)
    for (const tab of Array.from(tabs)) this.endCapture(extensionId, tab)
  }

  private releaseAllCapturesOfTab (tab: Electron.WebContents): void {
    const record = this.capturedTabs.get(tab)
    if (!record) return
    for (const extensionId of Array.from(record.capturedBy)) this.endCapture(extensionId, tab)
  }

  /** The single choke point for ending one (extensionId, tab) capture:
   * drops its `captureRecords` entry, unmutes/removes listeners once no
   * extension captures this tab any more (`releaseCapture`), and tells the
   * extension the capture stopped -- used by every release path (the
   * unconsumed-safety-net timer, a tab's own navigation/destruction, a
   * consumer's destruction/crash, and `extension-unloaded`) so all of them
   * agree on what "ended" means. */
  private endCapture (extensionId: string, tab: Electron.WebContents): void {
    this.captureRecords.delete(captureKey(extensionId, tab.id))
    this.releaseCapture(extensionId, tab)
    if (!tab.isDestroyed()) {
      this.ctx.router.sendEvent(extensionId, 'tabCapture.onStatusChanged', { tabId: tab.id, status: 'stopped', fullscreen: false })
    }
  }

  private releaseCapture (extensionId: string, tab: Electron.WebContents): void {
    const record = this.capturedTabs.get(tab)
    if (!record) return
    record.capturedBy.delete(extensionId)
    this.extensionCaptures.get(extensionId)?.delete(tab)
    if (record.capturedBy.size === 0) {
      this.capturedTabs.delete(tab)
      // (item J) Removed here, not just left to `once` to self-clean: a tab
      // released without dying (the ordinary case) never fires 'destroyed'
      // at all, and `did-navigate` is `.on`, which never self-removes.
      if (!tab.isDestroyed()) {
        tab.removeListener('destroyed', record.onDestroyed)
        tab.removeListener('did-navigate', record.onNavigate)
        tab.setAudioMuted(record.previousMuted)
      }
    }
  }
}

/** Electron's own `getMediaSourceId` validity window (electron.d.ts), reused
 * as the safety net's own bound -- see `scheduleUnconsumedRelease`'s doc. */
const TAB_CAPTURE_SAFETY_NET_MS = 10_000
