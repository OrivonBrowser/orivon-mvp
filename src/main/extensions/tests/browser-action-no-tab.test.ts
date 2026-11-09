import { beforeEach, describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 76: a toolbar click, or chrome.action.openPopup(), over a page no tab of the instance
// stands for (an Orivon page, a tab of another session) opens the popup in the window of the toolbar that
// was clicked, with no tab. Nothing is dispatched to the extension in its place, and no invocation is recorded.
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

function build (options: { popup?: string, active?: any } = {}): { api: any, ctx: any, win: any, tab: any } {
  const win: any = { id: 1, isDestroyed: () => false, getSize: () => [800, 600] }
  const tab: any = { id: 10 }
  const chromeView = {}
  const ctx: any = {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn(), getExtension: () => undefined } },
    emit: vi.fn(),
    store: {
      on: vi.fn(),
      impl: { windowOf: (wc: unknown) => (wc === chromeView ? win : undefined) },
      getTabById: (id: number) => (id === tab.id ? tab : undefined),
      getActiveTabFromWindow: () => options.active,
      getActiveTabOfCurrentWindow: () => undefined,
      getCurrentWindow: () => win,
      getWindowById: () => win,
      tabToWindow: new Map([[tab, win]]),
      tabDetailsCache: new Map([[10, { id: 10 }]])
    }
  }
  const api: any = new BrowserActionAPI(ctx)
  if (options.popup !== undefined) api.getAction(A).popup = options.popup
  return { api, ctx, win, tab: Object.assign(tab, { chromeView }) }
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

describe('a toolbar click with no tab in front', () => {
  it('opens the popup in the window of the toolbar that was clicked, with no tab', () => {
    const { api, win, tab } = build({ popup: 'popup.html' })
    click(api, tab.chromeView)
    expect(created).toHaveLength(1)
    expect(created[0].parent).toBe(win)
    expect(created[0].url).toBe(`chrome-extension://${A}/popup.html`)
    expect(created[0].anchorRect).toEqual(ANCHOR)
  })

  it('reports that popup to getContexts with tab -1', () => {
    const { api, tab } = build({ popup: 'popup.html' })
    click(api, tab.chromeView)
    expect(api.getOpenPopup()?.tabId).toBe(-1)
  })

  it('uses the action\'s popup, since no per-tab popup can apply', () => {
    const { api, tab } = build({ popup: 'popup.html' })
    api.getAction(A).tabs[10] = { popup: 'other.html' }
    click(api, tab.chromeView)
    expect(created[0].url).toBe(`chrome-extension://${A}/popup.html`)
  })

  it('records no invocation: there is no tab to be invoked on', () => {
    const { api, tab } = build({ popup: 'popup.html' })
    click(api, tab.chromeView)
    expect(recorder).not.toHaveBeenCalled()
  })

  it('offers the click to the interceptor with the window and no tab; true ends it there', () => {
    const { api, win, tab } = build({ popup: 'popup.html' })
    interceptor.mockReturnValueOnce(true)
    click(api, tab.chromeView)
    expect(interceptor).toHaveBeenCalledWith(A, undefined, win)
    expect(created).toHaveLength(0)
  })

  it('dispatches onClicked to nobody when the action has no popup, and does not throw', () => {
    const { api, ctx, tab } = build()
    expect(() => { click(api, tab.chromeView) }).not.toThrow()
    expect(ctx.router.sendEvent).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it('still refuses when there is no tab and no window to anchor in', () => {
    const { api } = build({ popup: 'popup.html' })
    expect(() => { api.activateClick({ eventType: 'click', extensionId: A, tabId: NO_TAB, anchorRect: ANCHOR }, true) }).toThrow('Unable to get active tab')
  })

  it('still refuses a tab id nothing tracks when it names no window either (a menu or key click)', () => {
    const { api } = build({ popup: 'popup.html' })
    expect(() => { api.activateClick({ eventType: 'click', extensionId: A, tabId: 99, anchorRect: ANCHOR }, true) }).toThrow('Unable to get active tab')
  })

  it('refuses a toolbar whose window is gone', () => {
    const { api, win, tab } = build({ popup: 'popup.html' })
    win.isDestroyed = () => true
    expect(() => { click(api, tab.chromeView) }).toThrow('Unable to get active tab')
  })
})

describe('a toolbar click with a tab in front', () => {
  it('is unchanged: the tab is recorded and offered to the interceptor with its window, and the popup opens for it', () => {
    const { api, win, tab } = build({ popup: 'popup.html', active: undefined })
    click(api, tab.chromeView, tab.id)
    expect(recorder).toHaveBeenCalledWith(A, tab)
    expect(interceptor).toHaveBeenCalledWith(A, tab, win)
    expect(created[0].parent).toBe(win)
    expect(api.getOpenPopup()?.tabId).toBe(10)
  })

  it('dispatches onClicked with the tab when the action has no popup', () => {
    const { api, ctx, tab } = build()
    click(api, tab.chromeView, tab.id)
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(A, 'browserAction.onClicked', { id: 10 })
  })
})

describe('chrome.action.openPopup with no tab in front', () => {
  const event = { type: 'frame', sender: {}, extension: { id: A } }

  it('opens the popup in the current window, anchored where the embedder says', async () => {
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

  it('opens nothing and dispatches nothing when the action has no popup', async () => {
    const { api, ctx } = build()
    await api.openPopup(event, undefined)
    expect(created).toHaveLength(0)
    expect(ctx.router.sendEvent).not.toHaveBeenCalled()
  })
})
