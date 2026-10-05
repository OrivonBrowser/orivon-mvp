import { describe, expect, it, vi } from 'vitest'

// An extension popup is a view inside its window, so Electron knows no window for its page: the
// library records the window a popup was opened over (UPSTREAM.md patch 68), and `currentWindow`
// from the popup's page must mean that one, not whichever window was focused last.
const parents = new Map<unknown, unknown>()
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  BaseWindow: { getAllWindows: () => [] },
  webContents: { fromId: () => ({}) },
  nativeImage: {}
}))
vi.mock('../../../../vendor/electron-chrome-extensions/src/browser/popup.js', () => ({
  popupParentOf: (contents: unknown) => parents.get(contents)
}))

const { ExtensionStore } = await import('../../../../vendor/electron-chrome-extensions/src/browser/store.js')
const { TabsAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/tabs.js')

let nextId = 1
const fakeWindow = (): any => ({ id: nextId++, isDestroyed: () => false, getSize: () => [800, 600], on: vi.fn(), once: vi.fn() })
const fakeTab = (): any => ({
  id: nextId++, isDestroyed: () => false, isCurrentlyAudible: () => false, audioMuted: false, isLoading: () => false,
  getTitle: () => 'T', getURL: () => 'https://a.example/', getType: () => 'window', favicon: undefined,
  on: vi.fn(), once: vi.fn(), off: vi.fn()
})

function setup (): { store: any, query: (event: unknown) => any } {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const router = {
    apiHandler: () => (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) },
    broadcastEvent: () => {}
  }
  const store = new ExtensionStore({} as never)
  new TabsAPI({ router, store, session: {} } as never)
  return { store, query: (event) => handlers.get('tabs.query')?.(event, { active: true, currentWindow: true }) }
}

describe('chrome.tabs.query({ currentWindow: true }) from a popup page', () => {
  it('answers the window the popup was opened over, not the last focused one', () => {
    const { store, query } = setup()
    const a = fakeWindow()
    const b = fakeWindow()
    const tabA = fakeTab()
    const tabB = fakeTab()
    store.addTab(tabA, a)
    store.addTab(tabB, b)
    store.lastFocusedWindowId = a.id
    const popupPage = {}
    parents.set(popupPage, b)
    const result = query({ type: 'frame', sender: popupPage, extension: { id: 'x', manifest: {} } })
    expect(result.map((tab: any) => tab.id)).toEqual([tabB.id])
  })

  it('answers the last focused window for a page that is no popup', () => {
    const { store, query } = setup()
    const a = fakeWindow()
    const b = fakeWindow()
    const tabA = fakeTab()
    store.addTab(tabA, a)
    store.addTab(fakeTab(), b)
    store.lastFocusedWindowId = a.id
    const result = query({ type: 'frame', sender: {}, extension: { id: 'x', manifest: {} } })
    expect(result.map((tab: any) => tab.id)).toEqual([tabA.id])
  })
})
