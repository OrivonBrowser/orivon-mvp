import { describe, expect, it, vi, beforeEach } from 'vitest'

// Drives the REAL BrowserActionAPI.activate/activateClick/openPopup (private,
// reached the same way browser-action-popup-url.test.ts reaches getPopupUrl:
// `(api as any)`), proving both forgery routes into a tabCapture invocation
// are refused:
//  - a LOCAL crx-msg call to browserAction.activate (event.extension
//    defined -- router.ts's own onRouterMessage resolves it from the
//    caller's VERIFIED extension id) must be refused outright, whatever
//    `details.extensionId`/`details.tabId` claim.
//  - chrome.action.openPopup() (no gesture, no toolbar click) must still
//    open the popup/dispatch onClicked, but must NEVER record a tabCapture
//    invocation.
// Only a REMOTE call (event.extension undefined -- router.ts's own
// onRemoteMessage ALWAYS passes extensionId: undefined, and
// setRemoteMessageSenderCheck's own isFromChromeView gate is what makes
// that path trustworthy) may record one.
vi.mock('electron', () => ({
  Menu: class {},
  MenuItem: class {},
  nativeImage: {}
}))

const { BrowserActionAPI, setTabCaptureInvocationRecorder } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js'
)

const OWN_ID = 'a'.repeat(32)
const OTHER_ID = 'b'.repeat(32)

function fakeTab (id: number): any {
  return { id }
}

function fakeCtx (tab: any): any {
  return {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn() } },
    store: {
      on: vi.fn(),
      getTabById: (id: number) => (id === tab.id ? tab : undefined),
      getActiveTabOfCurrentWindow: () => tab,
      tabToWindow: new Map(),
      tabDetailsCache: new Map()
    }
  }
}

let recorder: ReturnType<typeof vi.fn<(extensionId: string, tab: unknown) => void>>

beforeEach(() => {
  recorder = vi.fn()
  setTabCaptureInvocationRecorder(recorder)
})

describe('BrowserActionAPI: tabCapture invocation only ever recorded for a real toolbar click', () => {
  it('a REMOTE click (event.extension undefined -- the real chrome-view path) records an invocation', () => {
    const tab = fakeTab(1)
    const api = new BrowserActionAPI(fakeCtx(tab))

    ;(api as any).activate(
      { type: 'frame', sender: {}, extension: undefined },
      { eventType: 'click', extensionId: OWN_ID, tabId: tab.id, anchorRect: { x: 0, y: 0, width: 0, height: 0 } },
    )

    expect(recorder).toHaveBeenCalledWith(OWN_ID, tab)
  })

  it('a LOCAL crx-msg call (event.extension defined) is refused outright, never reaching activateClick at all', () => {
    const tab = fakeTab(1)
    const api = new BrowserActionAPI(fakeCtx(tab))

    expect(() => {
      ;(api as any).activate(
        { type: 'frame', sender: {}, extension: { id: OWN_ID } },
        { eventType: 'click', extensionId: OWN_ID, tabId: tab.id, anchorRect: { x: 0, y: 0, width: 0, height: 0 } },
      )
    }).toThrow(/directly, not through a real toolbar click/)

    expect(recorder).not.toHaveBeenCalled()
  })

  it('a LOCAL call carrying a FORGED, different extensionId/tabId is refused the same way -- the forgery this item exists for', () => {
    const tab = fakeTab(1)
    const otherTab = fakeTab(99)
    const ctx = fakeCtx(tab)
    ctx.store.getTabById = (id: number) => (id === tab.id ? tab : id === otherTab.id ? otherTab : undefined)
    const api = new BrowserActionAPI(ctx)

    expect(() => {
      ;(api as any).activate(
        // A page belonging to OWN_ID (the only id `event.extension` could
        // ever legitimately name for a local call) claiming to act for
        // OTHER_ID, on a tab it was never invoked on.
        { type: 'frame', sender: {}, extension: { id: OWN_ID } },
        { eventType: 'click', extensionId: OTHER_ID, tabId: otherTab.id, anchorRect: { x: 0, y: 0, width: 0, height: 0 } },
      )
    }).toThrow(/directly, not through a real toolbar click/)

    expect(recorder).not.toHaveBeenCalled()
  })

  it('chrome.action.openPopup() opens/dispatches like a click, but never records an invocation (no gesture)', () => {
    const tab = fakeTab(1)
    const ctx = fakeCtx(tab)
    ctx.store.getWindowById = () => undefined
    ctx.store.getCurrentWindow = () => ({ isDestroyed: () => false, getSize: () => [800, 600] })
    ctx.store.getActiveTabFromWindow = () => tab
    const api = new BrowserActionAPI(ctx)

    ;(api as any).openPopup({ extension: { id: OWN_ID } })

    expect(recorder).not.toHaveBeenCalled()
    // The real, user-visible half of chrome.action.openPopup() still runs:
    // either a popup opened, or (no popup configured, this fixture's own
    // case) onClicked was dispatched -- either way `activateClick` itself
    // ran to completion rather than being refused.
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(OWN_ID, 'browserAction.onClicked', undefined)
  })
})
