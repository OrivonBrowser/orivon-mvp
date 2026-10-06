import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real ExtensionStore and TabsAPI over fake windows and tabs: which window a
// chrome.tabs call means, which tab is active in each window, and the events a tab's
// coming and going announce (UPSTREAM.md patch 65).
const popupParents = new Map<unknown, unknown>()
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (wc: unknown) => (popupParents.has(wc) ? { getParentWindow: () => popupParents.get(wc) } : null),
    getAllWindows: () => []
  },
  BaseWindow: { getAllWindows: () => [] },
  webContents: { fromId: () => ({}) },
  nativeImage: {}
}))

const { ExtensionStore } = await import('../../../../vendor/electron-chrome-extensions/src/browser/store.js')
const { TabsAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/tabs.js')
const { WindowsAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/windows.js')

let nextId = 1
function fakeWindow (): any {
  return { id: nextId++, isDestroyed: () => false, getSize: () => [800, 600], on: vi.fn(), once: vi.fn() }
}

function fakeTab (): any {
  const handlers = new Map<string, Array<() => void>>()
  const tab: any = {
    id: nextId++,
    isDestroyed: () => false,
    isCurrentlyAudible: () => false,
    audioMuted: false,
    isLoading: () => false,
    getTitle: () => 'T',
    getURL: () => 'https://a.example/',
    getType: () => 'window',
    favicon: undefined,
    on: (name: string, fn: () => void) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    once: (name: string, fn: () => void) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
    off: vi.fn(),
    destroy: () => { for (const fn of handlers.get('destroyed') ?? []) fn() }
  }
  return tab
}

function setup (impl: Record<string, unknown> = {}): { store: any, tabs: any, call: (name: string, event: unknown, ...args: unknown[]) => any, events: Array<[string, ...unknown[]]> } {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const events: Array<[string, ...unknown[]]> = []
  const router = {
    apiHandler: () => (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) },
    broadcastEvent: (name: string, ...args: unknown[]) => { events.push([name, ...args]) }
  }
  const store = new ExtensionStore(impl as never)
  const tabs = new TabsAPI({ router, store, session: {} } as never)
  return { store, tabs, events, call: (name, event, ...args) => handlers.get(name)?.(event, ...args) }
}

const extensionEvent = (sender: unknown = {}): any => ({ type: 'frame', sender, extension: { id: 'x', manifest: {} } })

beforeEach(() => { popupParents.clear() })

describe('chrome.tabs.query with a window filter', () => {
  function twoWindows (): { a: any, b: any, tabA: any, tabB: any, ctl: ReturnType<typeof setup> } {
    const ctl = setup()
    const a = fakeWindow()
    const b = fakeWindow()
    const tabA = fakeTab()
    const tabB = fakeTab()
    ctl.store.addTab(tabA, a)
    ctl.store.addTab(tabB, b)
    return { a, b, tabA, tabB, ctl }
  }

  it('answers the window a popup hangs under for currentWindow, not the last focused one', () => {
    const { a, b, tabA, tabB, ctl } = twoWindows()
    ctl.store.lastFocusedWindowId = a.id
    const popup = {}
    popupParents.set(popup, b)
    const result = ctl.call('tabs.query', extensionEvent(popup), { active: true, currentWindow: true })
    expect(result.map((t: any) => t.id)).toEqual([tabB.id])
    expect(tabA.id).not.toBe(tabB.id)
  })

  it('answers the window of the tab the call comes from', () => {
    const { b, tabA, ctl } = twoWindows()
    ctl.store.lastFocusedWindowId = b.id
    const result = ctl.call('tabs.query', extensionEvent(tabA), { currentWindow: true })
    expect(result.map((t: any) => t.id)).toEqual([tabA.id])
  })

  it('falls back to the last focused window for a caller with no window of its own', () => {
    const { b, tabB, ctl } = twoWindows()
    ctl.store.lastFocusedWindowId = b.id
    const result = ctl.call('tabs.query', extensionEvent(), { currentWindow: true })
    expect(result.map((t: any) => t.id)).toEqual([tabB.id])
  })

  it('keeps the tabs outside the window for currentWindow false', () => {
    const { b, tabA, ctl } = twoWindows()
    ctl.store.lastFocusedWindowId = b.id
    const result = ctl.call('tabs.query', extensionEvent(), { currentWindow: false })
    expect(result.map((t: any) => t.id)).toEqual([tabA.id])
  })

  it('answers the last focused window for lastFocusedWindow', () => {
    const { a, tabA, ctl } = twoWindows()
    ctl.store.lastFocusedWindowId = a.id
    const result = ctl.call('tabs.query', extensionEvent(), { lastFocusedWindow: true })
    expect(result.map((t: any) => t.id)).toEqual([tabA.id])
  })
})

describe('the window of a side panel page (UPSTREAM.md patch 70)', () => {
  function withPanel (): { a: any, b: any, tabA: any, tabB: any, panel: object, ctl: ReturnType<typeof setup>, current: () => any } {
    const panel = {}
    const owners = new Map<unknown, unknown>()
    const ctl = setup({ windowOf: (wc: unknown) => owners.get(wc) })
    const a = fakeWindow()
    const b = fakeWindow()
    const tabA = fakeTab()
    const tabB = fakeTab()
    ctl.store.addTab(tabA, a)
    ctl.store.addTab(tabB, b)
    ctl.store.lastFocusedWindowId = a.id
    owners.set(panel, b)
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const router = { apiHandler: () => (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) } }
    const session = { isPersistent: () => true }
    new WindowsAPI({ router, store: ctl.store, session } as never)
    for (const window of [a, b]) Object.assign(window, { isFocused: () => false, getPosition: () => [0, 0], isMaximized: () => false, isMinimized: () => false, isFullScreen: () => false, isAlwaysOnTop: () => false })
    return { a, b, tabA, tabB, panel, ctl, current: () => handlers.get('windows.getCurrent')?.(extensionEvent(panel), {}) }
  }

  it('is the window chrome.tabs.query means by currentWindow, not the last focused one', () => {
    const { tabB, panel, ctl } = withPanel()
    const result = ctl.call('tabs.query', extensionEvent(panel), { active: true, currentWindow: true })
    expect(result.map((t: any) => t.id)).toEqual([tabB.id])
  })

  it('is the window chrome.windows.getCurrent answers', () => {
    const { b, current } = withPanel()
    expect(current().id).toBe(b.id)
  })

  it('leaves a caller the host knows no window for on the last focused window', () => {
    const { a, ctl } = withPanel()
    const result = ctl.call('tabs.query', extensionEvent({}), { active: true, currentWindow: true })
    expect(result).toHaveLength(1)
    expect(ctl.store.lastFocusedWindowId).toBe(a.id)
  })
})

describe('which tab is active in each window', () => {
  it('leaves the active tab of another window active when a tab is activated', () => {
    const { store, tabs, call } = setup()
    const a = fakeWindow()
    const b = fakeWindow()
    const tabA = fakeTab()
    const tabB = fakeTab()
    const tabB2 = fakeTab()
    store.addTab(tabA, a)
    store.addTab(tabB, b)
    store.addTab(tabB2, b)
    tabs.onActivated(tabB2.id)
    const active = call('tabs.query', extensionEvent(), { active: true }).map((t: any) => t.id)
    expect(active.sort()).toEqual([tabA.id, tabB2.id].sort())
  })

  it('keeps the front tab when another opens behind it, and says nothing of the new one', () => {
    const { store, events } = setup()
    const win = fakeWindow()
    const front = fakeTab()
    const behind = fakeTab()
    store.addTab(front, win)
    events.length = 0
    store.addTab(behind, win)
    expect(store.getActiveTabFromWindow(win)).toBe(front)
    expect(events.filter((e) => e[0] === 'tabs.onActivated')).toEqual([])
  })

  it('announces the first tab of a window as activated', () => {
    const { store, events } = setup()
    const win = fakeWindow()
    const first = fakeTab()
    store.addTab(first, win)
    expect(events.filter((e) => e[0] === 'tabs.onActivated')).toEqual([['tabs.onActivated', { tabId: first.id, windowId: win.id }]])
  })

  it('hands the front place to a view that replaces the front tab, and to a page that comes back', () => {
    const { store, events } = setup()
    const win = fakeWindow()
    const app = fakeTab()
    const site = fakeTab()
    store.addTab(app, win)
    store.removeTab(app)
    store.addTab(site, win)
    expect(store.getActiveTabFromWindow(win)).toBe(site)
    store.removeTab(site)
    store.addTab(app, win)
    expect(store.getActiveTabFromWindow(win)).toBe(app)
    expect(events.filter((e) => e[0] === 'tabs.onActivated').at(-1)).toEqual(['tabs.onActivated', { tabId: app.id, windowId: win.id }])
  })
})

describe('chrome.tabs.remove', () => {
  it('announces the removal once, with the window the tab was in', () => {
    const { store, call, events } = setup({ removeTab: (tab: any) => { tab.destroy() } })
    const win = fakeWindow()
    const tab = fakeTab()
    store.addTab(tab, win)
    call('tabs.remove', extensionEvent(), tab.id)
    const removed = events.filter((e) => e[0] === 'tabs.onRemoved')
    expect(removed).toEqual([['tabs.onRemoved', tab.id, { windowId: win.id, isWindowClosing: false }]])
  })
})

describe('a tab handed to another window', () => {
  it('keeps its window id current and says it was detached and attached', () => {
    const { store, call, events } = setup()
    const a = fakeWindow()
    const b = fakeWindow()
    const tab = fakeTab()
    const other = fakeTab()
    store.addTab(tab, a)
    store.addTab(other, b)
    events.length = 0
    store.moveTab(tab, b)
    expect(call('tabs.get', extensionEvent(), tab.id).windowId).toBe(b.id)
    expect(call('tabs.query', extensionEvent(), { windowId: b.id }).map((t: any) => t.id).sort()).toEqual([tab.id, other.id].sort())
    expect(events.filter((e) => e[0] === 'tabs.onDetached' || e[0] === 'tabs.onAttached')).toEqual([
      ['tabs.onDetached', tab.id, { oldWindowId: a.id, oldPosition: 0 }],
      ['tabs.onAttached', tab.id, { newWindowId: b.id, newPosition: 0 }]
    ])
  })

  it('does not drop what an extension set for the tab', () => {
    const { store } = setup()
    const removed = vi.fn()
    store.on('tab-removed', removed)
    const a = fakeWindow()
    const b = fakeWindow()
    const tab = fakeTab()
    store.addTab(tab, a)
    store.moveTab(tab, b)
    expect(removed).not.toHaveBeenCalled()
  })
})
