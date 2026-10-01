import { afterEach, describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patches 50 and 51: the toolbar action's right-click menu is built by Orivon, and every action
// is listed whether or not it is pinned, with its badge. Against the real BrowserActionAPI.
const popups: Array<{ items: unknown, at: unknown }> = []
vi.mock('electron', () => ({
  Menu: class {
    static buildFromTemplate (items: unknown): { popup: (at: unknown) => void } { return { popup: (at) => { popups.push({ items, at }) } } }
    append (): void {}
    popup (at: unknown): void { popups.push({ items: 'library menu', at }) }
  },
  MenuItem: class {},
  nativeImage: {}
}))

const { BrowserActionAPI, setActionMenuBuilder, setActionVisibilityCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js'
)

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

function ctxWith (): any {
  const extension = { id: A, name: 'Alpha', manifest: { manifest_version: 3, name: 'Alpha', version: '1', action: {} } }
  return {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn(), getExtension: (id: string) => (id === A ? extension : null) } },
    store: { on: vi.fn(), buildMenuItems: () => [{ own: true }], createTab: vi.fn(), getActiveTabOfCurrentWindow: () => ({ id: 1 }), tabToWindow: new Map(), tabDetailsCache: new Map() }
  }
}

afterEach(() => {
  setActionMenuBuilder(undefined)
  setActionVisibilityCheck(undefined as never)
  popups.length = 0
})

describe('setActionMenuBuilder (UPSTREAM.md patch 50)', () => {
  it('pops up what the builder returns, given the extension and its own menu items', () => {
    const api = new BrowserActionAPI(ctxWith()) as any
    const builder = vi.fn(() => [{ label: 'Mine' }])
    setActionMenuBuilder(builder)
    api.activateContextMenu({ extensionId: A, anchorRect: { x: 10.7, y: 20, width: 30, height: 5 } })
    expect(builder).toHaveBeenCalledWith(A, [{ own: true }])
    expect(popups).toEqual([{ items: [{ label: 'Mine' }], at: { x: 10, y: 25 } }])
  })

  it('keeps the library\'s own menu while no builder is set', () => {
    const api = new BrowserActionAPI(ctxWith()) as any
    api.activateContextMenu({ extensionId: A, anchorRect: { x: 1, y: 2, width: 3, height: 4 } })
    expect(popups).toEqual([{ items: 'library menu', at: { x: 1, y: 6 } }])
  })
})

describe('listAllActions (UPSTREAM.md patch 51)', () => {
  function withActions (api: any): void {
    const a = api.getAction(A)
    a.title = 'Alpha'
    a.popup = 'popup.html'
    a.text = '7'
    api.getAction(B).title = 'Beta'
    api.getAction(B).tabs[5] = { text: 'tab', title: 'Beta here', popup: 'p.html' }
  }

  it('lists every action with its title, popup and badge, hidden by the toolbar or not', () => {
    const api = new BrowserActionAPI(ctxWith()) as any
    withActions(api)
    setActionVisibilityCheck((id: string) => id === A)
    expect(api.listActions().map((entry: { id: string }) => entry.id)).toEqual([A])
    expect(api.listAllActions()).toEqual([
      { id: A, title: 'Alpha', hasPopup: true, badge: '7' },
      { id: B, title: 'Beta', hasPopup: false, badge: '' }
    ])
  })

  it('reports what is set for one tab when asked for it, the action\'s own otherwise', () => {
    const api = new BrowserActionAPI(ctxWith()) as any
    withActions(api)
    expect(api.listAllActions(5)).toEqual([
      { id: A, title: 'Alpha', hasPopup: true, badge: '7' },
      { id: B, title: 'Beta here', hasPopup: true, badge: 'tab' }
    ])
    expect(api.listAllActions(6)[1]).toEqual({ id: B, title: 'Beta', hasPopup: false, badge: '' })
  })
})
