import { describe, expect, it, vi } from 'vitest'

// chrome.action.openPopup() has no click to read an anchor from: the embedder names where the
// action's icon is (UPSTREAM.md patch 69), and the popup opens there; with no answer it falls back
// to the window's top-right corner.
vi.mock('electron', () => ({ Menu: class {}, MenuItem: class {}, nativeImage: {} }))
const created: any[] = []
vi.mock('../../../../vendor/electron-chrome-extensions/src/browser/popup.js', () => ({
  PopupView: class { constructor (public opts: unknown) { created.push(opts) } isDestroyed () { return false } destroy () {} },
  setPopupHost: vi.fn()
}))

const { BrowserActionAPI, setOpenPopupAnchor } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js')

const A = 'a'.repeat(32)

function build (): { api: any, win: any } {
  const win: any = { id: 1, isDestroyed: () => false, getSize: () => [800, 600] }
  const tab: any = { id: 10 }
  const ctx: any = {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn(), getExtension: () => ({ id: A, manifest: { action: { default_popup: 'popup.html' } } }) } },
    emit: vi.fn(),
    store: {
      on: vi.fn(), impl: {}, getCurrentWindow: () => win, getWindowById: () => win,
      getActiveTabFromWindow: () => tab, getTabById: () => tab,
      tabToWindow: new Map([[tab, win]]), tabDetailsCache: new Map()
    }
  }
  const api: any = new BrowserActionAPI(ctx)
  api.getAction(A).popup = 'popup.html'
  return { api, win }
}

const event = { type: 'frame', sender: {}, extension: { id: A } }

describe('chrome.action.openPopup', () => {
  it('opens the popup at the anchor the embedder names for the window', async () => {
    const { api, win } = build()
    const rect = { x: 700, y: 36, width: 28, height: 28 }
    const lookup = vi.fn(async () => rect)
    setOpenPopupAnchor(lookup)
    created.length = 0
    await api.openPopup(event, undefined)
    expect(lookup).toHaveBeenCalledWith(A, win)
    expect(created[0].anchorRect).toEqual(rect)
  })

  it('falls back to the window\'s top-right corner when the embedder has no answer', async () => {
    const { api } = build()
    setOpenPopupAnchor(async () => undefined)
    created.length = 0
    await api.openPopup(event, undefined)
    expect(created[0].anchorRect).toEqual({ x: 800 - 64, y: 0, width: 64, height: 64 })
  })

  it('falls back when the lookup throws', async () => {
    const { api } = build()
    setOpenPopupAnchor(async () => { throw new Error('chrome page reloading') })
    created.length = 0
    await api.openPopup(event, undefined)
    expect(created[0].anchorRect).toEqual({ x: 800 - 64, y: 0, width: 64, height: 64 })
  })
})
