import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the REAL TabCaptureAPI (vendor/.../api/tab-capture.ts, no 'electron'
// value import of its own -- only Electron.WebContents as a TYPE -- so no
// vi.mock('electron', ...) is needed here, unlike
// browser-action-popup-url.test.ts's own sibling suite). Covers consumption
// and release tracked per (extension, target tab), capture-end teardown
// keyed on the real consumer, the http(s)-only target check, its re-check on
// the captured tab's own navigation, and listener cleanup on an ordinary
// release; the 'media' carve-out itself is covered end to end by
// test/e2e-extensions-offscreen-capture.test.ts, and a forged invocation by
// browser-action-tab-capture-invocation.test.ts.
const {
  TabCaptureAPI,
  setTabCaptureInvocationCheck,
  setTabCaptureAppRefusalCheck,
  setTabCaptureGrantRecorder,
  setTabCaptureConsumedCheck,
} = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/tab-capture.js')

/** A minimal stand-in for `Electron.WebContents`: real EventEmitter
 * semantics (so a test can `.emit('destroyed')`/`.emit('did-navigate')` the
 * same way Electron itself would fire them), the handful of methods/fields
 * `tab-capture.ts` actually reads -- INCLUDING the real gotcha that catches
 * production code out: reading almost any property or calling almost any
 * method on a destroyed `WebContents` throws "Object has been destroyed"
 * (electron.d.ts's own documented behavior); `isDestroyed()` itself is the
 * one exception. `.id` is a getter, not a plain field, specifically so a
 * test can catch code that reads `tab.id` from INSIDE a `'destroyed'`
 * listener, where the real object already throws. `destroy()` sets the
 * flag before emitting, the same order Electron's own destruction does. */
class FakeWebContents extends EventEmitter {
  private destroyedFlag = false
  audioMuted = false
  constructor (private readonly _id: number, private url: string, public session: unknown) { super() }
  private assertLive (): void {
    if (this.destroyedFlag) throw new Error('Object has been destroyed')
  }
  get id (): number { this.assertLive(); return this._id }
  getURL (): string { this.assertLive(); return this.url }
  setURL (url: string): void { this.url = url }
  isDestroyed (): boolean { return this.destroyedFlag }
  setAudioMuted (v: boolean): void { this.assertLive(); this.audioMuted = v }
  getMediaSourceId (_consumer: unknown): string { this.assertLive(); return `stream-${String(this._id)}` }
  /** Simulates a real tab close: flips `isDestroyed()` true, THEN fires
   * 'destroyed' -- any listener that reads `.id`/`.getURL()`/etc. on `this`
   * (rather than a value captured before this call) throws exactly the way
   * production code did before the fix this test exists to catch. */
  destroy (): void { this.destroyedFlag = true; this.emit('destroyed') }
}

const EXT_A = 'ext-a'
const EXT_B = 'ext-b'

/** A fresh session-identity object per test, built BEFORE any
 * `FakeWebContents` -- every one of them must carry this exact object as
 * its own `.session`, since `getMediaStreamId`'s own session check compares
 * object identity, and `ctx.session` resolves to it too. */
function fakeSession (): { session: any, extensionUnloaded: (id: string) => void } {
  let onExtensionUnloaded: ((event: unknown, extension: { id: string }) => void) | undefined
  const session = {
    extensions: {
      addListener: (name: string, cb: typeof onExtensionUnloaded) => {
        if (name === 'extension-unloaded') onExtensionUnloaded = cb
      },
    },
  }
  return { session, extensionUnloaded: (id: string) => onExtensionUnloaded?.({}, { id }) }
}

function fakeCtx (session: unknown, tabs: Map<number, FakeWebContents>): any {
  return {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session,
    store: {
      getTabById: (id: number) => tabs.get(id),
      getActiveTabOfCurrentWindow: () => undefined,
    },
  }
}

function fakeOffscreen (consumer: FakeWebContents): any {
  return { getDocumentWebContents: () => consumer }
}

const HTTP_URL = 'http://example.test/'

beforeEach(() => {
  vi.useFakeTimers()
  setTabCaptureInvocationCheck(() => true)
  setTabCaptureAppRefusalCheck(() => false)
  setTabCaptureGrantRecorder(() => {})
  setTabCaptureConsumedCheck(() => true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TabCaptureAPI: only an http(s) target tab may be captured', () => {
  it('refuses a chrome-extension:// target outright', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, 'chrome-extension://other-ext/popup.html', session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await expect(
      (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 }),
    ).rejects.toThrow(/only an http\(s\) tab/)
  })

  it('allows an ordinary http(s) target', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await expect(
      (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 }),
    ).resolves.toBe('stream-1')
  })
})

describe('TabCaptureAPI: consumption/release tracked per (extension, target tab)', () => {
  it("tab A's own unconsumed-release timer never releases tab B, minted by the same extension", async () => {
    const { session } = fakeSession()
    const tabA = new FakeWebContents(1, HTTP_URL, session)
    const tabB = new FakeWebContents(2, HTTP_URL, session)
    const consumer = new FakeWebContents(3, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tabA], [2, tabB]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    // Tab A's grant is never consumed; tab B's is.
    setTabCaptureConsumedCheck((_extensionId: string, targetTabId: number) => targetTabId === 2)

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 2 })
    expect(tabA.audioMuted).toBe(true)
    expect(tabB.audioMuted).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(tabA.audioMuted).toBe(false) // released: never consumed
    expect(tabB.audioMuted).toBe(true) // untouched: consumed, still capturing
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(EXT_A, 'tabCapture.onStatusChanged', { tabId: 1, status: 'stopped', fullscreen: false })
    expect(ctx.router.sendEvent).not.toHaveBeenCalledWith(EXT_A, 'tabCapture.onStatusChanged', { tabId: 2, status: 'stopped', fullscreen: false })
  })

  it('refuses a second getMediaStreamId for a tab the SAME extension is already capturing, matching Chrome\'s own refusal', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })

    await expect(
      (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 }),
    ).rejects.toThrow(/Cannot capture a tab with an active stream/)
  })

  it('a refused re-mint schedules no second safety-net timer: the FIRST mint\'s own 10s check runs exactly once', async () => {
    // The bug this test exists to catch: before the refusal above existed,
    // a second getMediaStreamId call for an (extension, tab) pair with an
    // active stream reset tab-capture-grants.ts's own `consumed` bit back
    // to false and scheduled a SECOND, independent 10s safety-net timer --
    // which could then end the FIRST, still-running capture out from under
    // it (unmuting the tab, firing 'stopped') even though the extension's
    // own real getUserMedia('tab') call had already redeemed the first
    // grant. Refusing the re-mint outright means `getMediaStreamId` never
    // reaches `scheduleUnconsumedRelease` a second time at all -- checked
    // here directly, by counting how many times the consumed-check for
    // this exact (extension, tab) pair is consulted once the FIRST mint's
    // own 10-second window elapses: exactly once, never twice.
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))
    const consumedCheck = vi.fn(() => true)
    setTabCaptureConsumedCheck(consumedCheck)

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 }).catch(() => {})

    await vi.advanceTimersByTimeAsync(10_000)

    expect(consumedCheck).toHaveBeenCalledTimes(1)
    expect(consumedCheck).toHaveBeenCalledWith(EXT_A, 1)
  })
})

describe('TabCaptureAPI: re-checked on the captured tab\'s own navigation', () => {
  it('ends the capture once the app-refusal check newly refuses, after navigation', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    expect(tab.audioMuted).toBe(true)

    // The tab navigates to what is now a granted app's own origin.
    setTabCaptureAppRefusalCheck(() => true)
    tab.emit('did-navigate')

    expect(tab.audioMuted).toBe(false)
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(EXT_A, 'tabCapture.onStatusChanged', { tabId: 1, status: 'stopped', fullscreen: false })
  })

  it('ends the capture once the tab navigates to a non-http(s) URL', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    tab.setURL('chrome-extension://someone-else/page.html')
    tab.emit('did-navigate')

    expect(tab.audioMuted).toBe(false)
  })

  it('a same-origin navigation (still allowed) never ends the capture', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    tab.setURL('http://example.test/other-page')
    tab.emit('did-navigate')

    expect(tab.audioMuted).toBe(true)
  })
})

describe('TabCaptureAPI: the tab\'s own listeners are removed on an ordinary release, not leaked', () => {
  it('removes both the destroyed and did-navigate listeners once every capturer has released the tab', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    setTabCaptureConsumedCheck(() => false) // released by the safety net below
    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    expect(tab.listenerCount('destroyed')).toBe(1)
    expect(tab.listenerCount('did-navigate')).toBe(1)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(tab.audioMuted).toBe(false)
    expect(tab.listenerCount('destroyed')).toBe(0)
    expect(tab.listenerCount('did-navigate')).toBe(0)
  })

  it('capturing the same tab again afterward attaches exactly one fresh pair, never stacking on the old one', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    setTabCaptureConsumedCheck(() => false)
    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(tab.listenerCount('destroyed')).toBe(0)

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    expect(tab.listenerCount('destroyed')).toBe(1)
    expect(tab.listenerCount('did-navigate')).toBe(1)
  })
})

describe('TabCaptureAPI: closing the captured tab (probable crash)', () => {
  // A real WebContents throws "Object has been destroyed" for almost any
  // property read once destroyed -- the FakeWebContents class above
  // reproduces exactly that. Closing a captured tab fires 'destroyed' while
  // it is already in that state; if the handler chain reads `tab.id` (or
  // any other property) from the SAME object instead of a value captured
  // earlier, that read throws INSIDE the event emission, which Node
  // reports as an uncaught exception -- in the real app,
  // index.ts's exitOnUncaught handler then quits the whole process.
  it('closing the captured tab never throws', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })

    expect(() => { tab.destroy() }).not.toThrow()
  })

  it('closing the captured tab still releases the capture and tells the extension it stopped', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    tab.destroy()

    expect(ctx.router.sendEvent).toHaveBeenCalledWith(EXT_A, 'tabCapture.onStatusChanged', { tabId: 1, status: 'stopped', fullscreen: false })
  })

  it('closing a tab captured by two extensions releases both, never throwing, through the ONE shared TabCaptureAPI instance real production uses', async () => {
    // ElectronChromeExtensions constructs exactly one TabCaptureAPI per
    // session (browser/index.ts), shared by every extension in it -- unlike
    // this file's other tests, which each construct their own instance for
    // isolation, this one matches that real shape deliberately: both
    // extensions' captures live in the SAME `capturedTabs`/`capturedBy`
    // record for this tab, which is exactly the scenario `releaseCapture`'s
    // own "only unmute once every capturer has released it" logic exists
    // for.
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    await (api as any).getMediaStreamId({ extension: { id: EXT_B } }, { targetTabId: 1 })

    expect(() => { tab.destroy() }).not.toThrow()
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(EXT_A, 'tabCapture.onStatusChanged', { tabId: 1, status: 'stopped', fullscreen: false })
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(EXT_B, 'tabCapture.onStatusChanged', { tabId: 1, status: 'stopped', fullscreen: false })
  })
})

describe('TabCaptureAPI: the actual consumer\'s teardown ends every capture that used it', () => {
  it('a consumer\'s own "destroyed" event ends every capture using it, and only those', async () => {
    const { session } = fakeSession()
    const tabA = new FakeWebContents(1, HTTP_URL, session)
    const tabB = new FakeWebContents(2, HTTP_URL, session)
    const consumerA = new FakeWebContents(3, 'chrome-extension://ext-a/offscreen.html', session)
    const consumerAlsoA = new FakeWebContents(3, 'chrome-extension://ext-a/offscreen.html', session)
    // `consumerTabId` lets a capture pick a consumer other than the
    // extension's own offscreen document -- exercised here so the two
    // captures genuinely use two DIFFERENT consumer objects.
    const otherConsumer = new FakeWebContents(4, HTTP_URL, session)
    const tabs = new Map([[1, tabA], [2, tabB], [4, otherConsumer]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumerA))
    void consumerAlsoA

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 2, consumerTabId: 4 })
    expect(tabA.audioMuted).toBe(true)
    expect(tabB.audioMuted).toBe(true)

    consumerA.destroy()

    expect(tabA.audioMuted).toBe(false)
    expect(tabB.audioMuted).toBe(true)
  })

  it('a consumer\'s own "render-process-gone" ends every capture using it, the same as "destroyed"', async () => {
    const { session } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    consumer.emit('render-process-gone')

    expect(tab.audioMuted).toBe(false)
  })

  it('"extension-unloaded" ends every capture the extension holds, regardless of consumer state', async () => {
    const { session, extensionUnloaded } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))
    void api

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    expect(tab.audioMuted).toBe(true)

    extensionUnloaded(EXT_A)

    expect(tab.audioMuted).toBe(false)
  })

  it('"extension-unloaded" for a DIFFERENT extension never releases another extension\'s capture', async () => {
    const { session, extensionUnloaded } = fakeSession()
    const tab = new FakeWebContents(1, HTTP_URL, session)
    const consumer = new FakeWebContents(2, 'chrome-extension://ext-a/offscreen.html', session)
    const tabs = new Map([[1, tab]])
    const ctx = fakeCtx(session, tabs)
    const api = new TabCaptureAPI(ctx, fakeOffscreen(consumer))
    void api

    await (api as any).getMediaStreamId({ extension: { id: EXT_A } }, { targetTabId: 1 })
    extensionUnloaded(EXT_B)

    expect(tab.audioMuted).toBe(true)
  })
})
