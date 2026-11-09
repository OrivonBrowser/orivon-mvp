import { beforeEach, describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 76: a toolbar click, or chrome.action.openPopup(), acts on what is in front of the
// window it belongs to. Over a page no extension instance tracks (an Orivon page, a tab of a session no
// extension is in) the popup opens in that window with no tab; nothing is dispatched to the extension in its
// place and no invocation is recorded. Over another instance's tab nothing opens.
vi.mock('electron', () => ({ Menu: class {}, MenuItem: class {}, nativeImage: {} }))
const created: any[] = []
vi.mock('../../../../vendor/electron-chrome-extensions/src/browser/popup.js', () => ({
  PopupView: class {
    extensionId: string
    constructor (public opts: any) { this.extensionId = opts.extensionId; created.push(opts) }
    isDestroyed () { return false }
    destroy () {}
    get webContents () { return { id: 7, isDestroyed: () => false } }
  },
  setPopupHost: vi.fn()
}))

const { BrowserActionAPI, setActionClickInterceptor, setOpenPopupAnchor, setTabCaptureInvocationRecorder } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js'
)

const A = 'a'.repeat(32)
const ANCHOR = { x: 1, y: 2, width: 3, height: 4 }
const NO_TAB = -1

interface Front { active: any, frontTracked: boolean }

/** A library instance with one window. `front.active` is the tab of the instance in front there; `front.frontTracked` is the host's answer. */
function build (options: { popup?: string, active?: 'tab' | 'other', frontTracked?: boolean } = {}): { api: any, ctx: any, win: any, tab: any, other: any, front: Front, chromeView: any } {
  const win: any = { id: 1, isDestroyed: () => false, getSize: () => [800, 600] }
  const tab: any = { id: 10 }
  const other: any = { id: 11 }
  const chromeView = {}
  const front: Front = { active: options.active === undefined ? undefined : { tab, other }[options.active], frontTracked: options.frontTracked ?? false }
  const ctx: any = {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn(), getExtension: () => undefined } },
    emit: vi.fn(),
    store: {
      on: vi.fn(),
      impl: { windowOf: (wc: unknown) => (wc === chromeView ? win : undefined), frontTracked: () => front.frontTracked },
      getTabById: (id: number) => [tab, other].find((candidate) => candidate.id === id),
      getActiveTabFromWindow: () => front.active,
      getActiveTabOfCurrentWindow: () => undefined,
      getCurrentWindow: () => win,
      getWindowById: () => win,
      tabToWindow: new Map([[tab, win], [other, win]]),
      tabDetailsCache: new Map([[10, { id: 10 }], [11, { id: 11 }]])
    }
  }
  const api: any = new BrowserActionAPI(ctx)
  if (options.popup !== undefined) api.getAction(A).popup = options.popup
  return { api, ctx, win, tab, other, front, chromeView }
}

const click = (api: any, chromeView: unknown, tabId = NO_TAB): void => {
  api.activate({ type: 'frame', sender: chromeView, extension: undefined }, { eventType: 'click', extensionId: A, tabId, anchorRect: ANCHOR })
}

let recorder: ReturnType<typeof vi.fn<(extensionId: string, tab: unknown) => void>>
let interceptor: ReturnType<typeof vi.fn<(extensionId: string, tab: unknown, window: unknown) => boolean>>

beforeEach(() => {
  created.length = 0
  recorder = vi.fn()
  interceptor = vi.fn(() => false)
  setTabCaptureInvocationRecorder(recorder as never)
  setActionClickInterceptor(interceptor as never)
  setOpenPopupAnchor(undefined)
})

describe('a toolbar click over a page no instance tracks', () => {
  it('opens the popup in the window of the toolbar that was clicked, with no tab', () => {
    const { api, win, chromeView } = build({ popup: 'popup.html' })
    click(api, chromeView)
    expect(created).toHaveLength(1)
    expect(created[0].parent).toBe(win)
    expect(created[0].url).toBe(`chrome-extension://${A}/popup.html`)
    expect(created[0].anchorRect).toEqual(ANCHOR)
  })

  it('reports that popup to getContexts with tab -1', () => {
    const { api, chromeView } = build({ popup: 'popup.html' })
    click(api, chromeView)
    expect(api.getOpenPopup()?.tabId).toBe(-1)
  })

  it('uses the action\'s popup, since no per-tab popup can apply', () => {
    const { api, chromeView } = build({ popup: 'popup.html' })
    api.getAction(A).tabs[10] = { popup: 'other.html' }
    click(api, chromeView)
    expect(created[0].url).toBe(`chrome-extension://${A}/popup.html`)
  })

  it('records no invocation: there is no tab to be invoked on', () => {
    const { api, chromeView } = build({ popup: 'popup.html' })
    click(api, chromeView)
    expect(recorder).not.toHaveBeenCalled()
  })

  it('offers the click to the interceptor with the window and no tab; true ends it there', () => {
    const { api, win, chromeView } = build({ popup: 'popup.html' })
    interceptor.mockReturnValueOnce(true)
    click(api, chromeView)
    expect(interceptor).toHaveBeenCalledWith(A, undefined, win)
    expect(created).toHaveLength(0)
  })

  it('dispatches onClicked to nobody when the action has no popup, and does not throw', () => {
    const { api, ctx, chromeView } = build()
    expect(() => { click(api, chromeView) }).not.toThrow()
    expect(ctx.router.sendEvent).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it('ignores the tab id the toolbar still holds: that tab is behind the page in front, not under the click', () => {
    const { api, tab, chromeView } = build({ popup: 'popup.html' })
    click(api, chromeView, tab.id)
    expect(recorder).not.toHaveBeenCalled()
    expect(interceptor).toHaveBeenCalledWith(A, undefined, expect.anything())
    expect(api.getOpenPopup()?.tabId).toBe(-1)
  })
})

describe('a toolbar click over a tab of another instance', () => {
  it('opens nothing, and says there is no tab to act on', () => {
    const { api, chromeView } = build({ popup: 'popup.html', frontTracked: true })
    expect(() => { click(api, chromeView) }).toThrow('Unable to get active tab')
    expect(created).toHaveLength(0)
    expect(recorder).not.toHaveBeenCalled()
    expect(interceptor).not.toHaveBeenCalled()
  })
})

describe('a toolbar click over a tab of the instance', () => {
  it('acts on the tab in front of the window, records it, and offers it to the interceptor with the window', () => {
    const { api, win, tab, chromeView } = build({ popup: 'popup.html', active: 'tab' })
    click(api, chromeView, tab.id)
    expect(recorder).toHaveBeenCalledWith(A, tab)
    expect(interceptor).toHaveBeenCalledWith(A, tab, win)
    expect(created[0].parent).toBe(win)
    expect(api.getOpenPopup()?.tabId).toBe(10)
  })

  it('acts on the tab now in front, not on the one the toolbar named when it was last drawn', () => {
    const { api, other, chromeView } = build({ popup: 'popup.html', active: 'other' })
    click(api, chromeView, 10)
    expect(api.getOpenPopup()?.tabId).toBe(other.id)
    expect(recorder).toHaveBeenCalledWith(A, other)
  })

  it('dispatches onClicked with the tab in front when the action has no popup', () => {
    const { api, ctx, tab, chromeView } = build({ active: 'tab' })
    click(api, chromeView, tab.id)
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(A, 'browserAction.onClicked', { id: 10 })
  })
})

describe('a click that names no window (a menu or key click without one)', () => {
  it('reads the tab id it names', () => {
    const { api, tab } = build({ popup: 'popup.html' })
    api.activateClick({ eventType: 'click', extensionId: A, tabId: tab.id, anchorRect: ANCHOR }, true)
    expect(recorder).toHaveBeenCalledWith(A, tab)
    expect(api.getOpenPopup()?.tabId).toBe(10)
  })

  it('refuses a tab id nothing tracks, and an absent one when the last window has none', () => {
    const { api } = build({ popup: 'popup.html' })
    expect(() => { api.activateClick({ eventType: 'click', extensionId: A, tabId: 99, anchorRect: ANCHOR }, true) }).toThrow('Unable to get active tab')
    expect(() => { api.activateClick({ eventType: 'click', extensionId: A, tabId: NO_TAB, anchorRect: ANCHOR }, true) }).toThrow('Unable to get active tab')
  })

  it('treats a toolbar whose window is gone as naming none', () => {
    const { api, win, chromeView } = build({ popup: 'popup.html' })
    win.isDestroyed = () => true
    expect(() => { click(api, chromeView) }).toThrow('Unable to get active tab')
  })
})

describe('activateFromMain', () => {
  it('acts on what is in front of the window: no tab over a page no instance tracks', () => {
    const { api, win } = build({ popup: 'popup.html' })
    api.activateFromMain(A, win, ANCHOR)
    expect(created).toHaveLength(1)
    expect(created[0].parent).toBe(win)
    expect(api.getOpenPopup()?.tabId).toBe(-1)
    expect(recorder).not.toHaveBeenCalled()
  })

  it('acts on the tab in front, recorded as an invocation', () => {
    const { api, win, tab } = build({ popup: 'popup.html', active: 'tab' })
    api.activateFromMain(A, win, ANCHOR)
    expect(api.getOpenPopup()?.tabId).toBe(tab.id)
    expect(recorder).toHaveBeenCalledWith(A, tab)
  })

  it('does nothing for a window that is gone', () => {
    const { api, win } = build({ popup: 'popup.html' })
    win.isDestroyed = () => true
    api.activateFromMain(A, win, ANCHOR)
    expect(created).toHaveLength(0)
  })

  it('opens nothing over a tab of another instance', () => {
    const { api, win } = build({ popup: 'popup.html', frontTracked: true })
    expect(() => { api.activateFromMain(A, win, ANCHOR) }).toThrow('Unable to get active tab')
    expect(created).toHaveLength(0)
  })
})

describe('chrome.action.openPopup', () => {
  const event = { type: 'frame', sender: {}, extension: { id: A } }

  it('over a page no instance tracks opens the popup in the current window with no tab, anchored where the embedder says', async () => {
    const { api, win } = build({ popup: 'popup.html' })
    const rect = { x: 700, y: 36, width: 28, height: 28 }
    setOpenPopupAnchor(async () => rect)
    await api.openPopup(event, undefined)
    expect(created).toHaveLength(1)
    expect(created[0].parent).toBe(win)
    expect(created[0].anchorRect).toEqual(rect)
    expect(recorder).not.toHaveBeenCalled()
    expect(api.getOpenPopup()?.tabId).toBe(-1)
  })

  it('over a tab of the instance opens the popup for that tab, still not counted as a click', async () => {
    const { api } = build({ popup: 'popup.html', active: 'tab' })
    await api.openPopup(event, undefined)
    expect(api.getOpenPopup()?.tabId).toBe(10)
    expect(recorder).not.toHaveBeenCalled()
    expect(interceptor).not.toHaveBeenCalled()
  })

  it('opens nothing over a tab of another instance', async () => {
    const { api } = build({ popup: 'popup.html', frontTracked: true })
    await api.openPopup(event, undefined)
    expect(created).toHaveLength(0)
  })

  it('opens nothing when another instance\'s tab came to the front while the anchor was measured', async () => {
    const { api, front } = build({ popup: 'popup.html' })
    setOpenPopupAnchor(async () => { front.frontTracked = true; return undefined })
    await api.openPopup(event, undefined)
    expect(created).toHaveLength(0)
  })

  it('opens for the tab that is in front after the anchor was measured, not the one before', async () => {
    const { api, front, other } = build({ popup: 'popup.html', active: 'tab' })
    setOpenPopupAnchor(async () => { front.active = other; return ANCHOR })
    await api.openPopup(event, undefined)
    expect(api.getOpenPopup()?.tabId).toBe(11)
  })

  it('opens with no tab when the front became a page no instance tracks while the anchor was measured', async () => {
    const { api, front } = build({ popup: 'popup.html', active: 'tab' })
    setOpenPopupAnchor(async () => { front.active = undefined; return ANCHOR })
    await api.openPopup(event, undefined)
    expect(api.getOpenPopup()?.tabId).toBe(-1)
  })

  it('opens nothing and dispatches nothing when the action has no popup', async () => {
    const { api, ctx } = build()
    await api.openPopup(event, undefined)
    expect(created).toHaveLength(0)
    expect(ctx.router.sendEvent).not.toHaveBeenCalled()
  })
})
