import { describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 65: each toolbar shows, and a click acts on, the active tab of
// its own window, found through the host's `windowOf`.
vi.mock('electron', () => ({ Menu: class {}, MenuItem: class {}, nativeImage: {} }))

const { BrowserActionAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/browser-action.js')

const A = 'a'.repeat(32)
const ANCHOR = { x: 1, y: 2, width: 3, height: 4 }

function twoWindows (): { api: any, ctx: any, chromeA: any, chromeB: any, tabA: any, tabB: any } {
  const winA = { id: 1 }
  const winB = { id: 2 }
  const tabA = { id: 10 }
  const tabB = { id: 20 }
  const chromeA = {}
  const chromeB = {}
  const active = new Map<unknown, unknown>([[winA, tabA], [winB, tabB]])
  const tabs = new Map<number, unknown>([[10, tabA], [20, tabB]])
  const ctx: any = {
    router: { apiHandler: () => vi.fn(), sendEvent: vi.fn() },
    session: { extensions: { on: vi.fn(), getExtension: () => undefined } },
    store: {
      on: vi.fn(),
      impl: { windowOf: (wc: unknown) => (wc === chromeA ? winA : wc === chromeB ? winB : undefined) },
      getTabById: (id: number) => tabs.get(id),
      getActiveTabFromWindow: (win: unknown) => active.get(win),
      getActiveTabOfCurrentWindow: () => tabB,
      tabToWindow: new Map(),
      tabDetailsCache: new Map([[10, { id: 10 }], [20, { id: 20 }]])
    }
  }
  const api: any = new BrowserActionAPI(ctx)
  api.getAction(A).title = 'Alpha'
  return { api, ctx, chromeA, chromeB, tabA, tabB }
}

describe('the toolbar of each window', () => {
  it('reports the active tab of the window asking, whichever window was last focused', () => {
    const { api, chromeA, chromeB } = twoWindows()
    expect(api.getState({ type: 'frame', sender: chromeA }).activeTabId).toBe(10)
    expect(api.getState({ type: 'frame', sender: chromeB }).activeTabId).toBe(20)
  })

  it('reports the last focused window\'s tab to a caller the host does not know', () => {
    const { api } = twoWindows()
    expect(api.getState({ type: 'frame', sender: {} }).activeTabId).toBe(20)
  })

  it('acts, with no tab named, on the active tab of the toolbar that was clicked', () => {
    const { api, ctx, chromeA } = twoWindows()
    api.activate({ type: 'frame', sender: chromeA, extension: undefined }, { eventType: 'click', extensionId: A, tabId: -1, anchorRect: ANCHOR })
    expect(ctx.router.sendEvent).toHaveBeenCalledWith(A, 'browserAction.onClicked', { id: 10 })
  })
})
