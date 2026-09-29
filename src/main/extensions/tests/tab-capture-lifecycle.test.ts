import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drives the REAL TabCaptureAPI (vendor/.../api/tab-capture.ts, no 'electron'
// value import of its own -- only Electron.WebContents as a TYPE -- so no
// vi.mock('electron', ...) is needed here, unlike
// browser-action-popup-url.test.ts's own sibling suite). Covers items F, G,
// H, I and J of the tabCapture/offscreen security review; item A is covered
// end to end by test/e2e-extensions-offscreen-capture.test.ts, and item B by
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
 * `tab-capture.ts` actually reads. */
class FakeWebContents extends EventEmitter {
  destroyed = false
  audioMuted = false
  constructor (public id: number, private url: string, public session: unknown) { super() }
  getURL (): string { return this.url }
  setURL (url: string): void { this.url = url }
  isDestroyed (): boolean { return this.destroyed }
  setAudioMuted (v: boolean): void { this.audioMuted = v }
  getMediaSourceId (_consumer: unknown): string { return `stream-${String(this.id)}` }
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

describe('TabCaptureAPI (item H): only an http(s) target tab may be captured', () => {
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

describe('TabCaptureAPI (item F): consumption/release tracked per (extension, target tab)', () => {
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
})

describe('TabCaptureAPI (item I): re-checked on the captured tab\'s own navigation', () => {
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

describe('TabCaptureAPI (item J): the tab\'s own listeners are removed on an ordinary release, not leaked', () => {
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

describe('TabCaptureAPI (item G): the actual consumer\'s teardown ends every capture that used it', () => {
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

    consumerA.emit('destroyed')

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
