import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'

// Pin, mute and the bulk closes, driven through a real TabManager over fake views: what matters is the strip's
// order, and which page each call reaches.
interface FakeContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: () => boolean
  getURL: () => string
  getTitle: () => string
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean, getAllEntries: () => Array<{ url: string, title: string, pageState?: string }>, getActiveIndex: () => number, restore: ReturnType<typeof vi.fn> }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  setAudioMuted: ReturnType<typeof vi.fn>
  isCurrentlyAudible: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
interface RecordedView { webContents: FakeContents, setBounds: ReturnType<typeof vi.fn>, setBackgroundColor: ReturnType<typeof vi.fn> }
const createdViews: RecordedView[] = []

function makeFakeWebContents (): FakeContents {
  const emitter = new EventEmitter() as FakeContents
  let destroyed = false
  emitter.loadURL = vi.fn(async () => {})
  emitter.isDestroyed = vi.fn(() => destroyed)
  emitter.isLoading = () => false
  emitter.getURL = () => 'https://a.example/'
  emitter.getTitle = () => ''
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [{ url: 'https://a.example/', title: '' }], getActiveIndex: () => 0, restore: vi.fn(async () => {}) }
  emitter.setWindowOpenHandler = vi.fn()
  emitter.setAudioMuted = vi.fn()
  emitter.isCurrentlyAudible = vi.fn(() => false)
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView) {
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    this.setBackgroundColor = vi.fn()
    createdViews.push(this)
  })
}))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: (origin: string) => origin === 'https://app.example' }))

const { TabManager } = await import('../tabs.js')
const { setPinned } = await import('../tab-pin.js')
const { closeOthers, closeToRight, duplicateTab, newTabToRight, othersToClose, rightToClose, tabMenuFlags, toggleMute, togglePin } = await import('../tab-commands.js')

beforeEach(() => { createdViews.length = 0 })

const APP_CTX = { broker: { app: { isRegisteredSync: (origin: string) => origin === 'https://app.example' }, dropOrigin: async () => {} } } as unknown as SubsystemContext

function newManager (ctx: SubsystemContext = {} as SubsystemContext): InstanceType<typeof TabManager> {
  return new TabManager({ addChildView: vi.fn(), removeChildView: vi.fn() } as never, () => ({ x: 0, y: 0, width: 800, height: 600 }), vi.fn(), 'http://localhost:5999/newtab/', ctx)
}

/** A strip of `n` tabs, ids in strip order. */
function strip (manager: InstanceType<typeof TabManager>, n: number): string[] {
  return Array.from({ length: n }, (_, at) => manager.createTab(`https://site${String(at)}.example/`))
}

const order = (manager: InstanceType<typeof TabManager>): readonly string[] => manager.ids()

describe('pinning', () => {
  it('moves a tab to the end of the pinned run, and back to the start of the rest when unpinned', () => {
    const manager = newManager()
    const [a, b, c, d] = strip(manager, 4) as [string, string, string, string]

    expect(setPinned(manager, c, true)).toBe(true)
    expect(order(manager)).toEqual([c, a, b, d])
    expect(setPinned(manager, d, true)).toBe(true)
    expect(order(manager)).toEqual([c, d, a, b])
    expect(setPinned(manager, c, false)).toBe(true)
    expect(order(manager)).toEqual([d, c, a, b])
    expect(manager.record(c)?.pinned).toBe(false)
  })

  it('keeps the tab in front in front, and reports the change', () => {
    const manager = newManager()
    const [, , c] = strip(manager, 3) as [string, string, string]
    const seen = vi.fn()
    manager.onStateChange(seen)

    setPinned(manager, c, true)

    expect(manager.getState().activeTabId).toBe(c)
    expect(manager.getState().tabs.map((tab) => tab.pinned)).toEqual([true, false, false])
    expect(seen).toHaveBeenCalled()
  })

  it('does nothing for a tab that is already so, or that is gone', () => {
    const manager = newManager()
    const [a] = strip(manager, 2) as [string, string]
    expect(setPinned(manager, a, false)).toBe(false)
    expect(setPinned(manager, 'nope', true)).toBe(false)
  })

  it('refuses a tab that is in a split, and keeps a pinned tab out of one', () => {
    const manager = newManager()
    const [a, b, c] = strip(manager, 3) as [string, string, string]
    manager.splits.split(a, b, 'right')

    expect(setPinned(manager, a, true)).toBe(false)
    expect(manager.record(a)?.pinned).toBe(false)

    setPinned(manager, c, true)
    expect(manager.splits.split(c, a, 'right')).toBe(false)
    expect(manager.splits.groups.partnerOf(c)).toBeNull()
  })

  it('does not choose a pinned tab as the partner of a split toggle', () => {
    const manager = newManager()
    const [a, b, c] = strip(manager, 3) as [string, string, string]
    setPinned(manager, a, true)
    manager.activateTab(b)

    manager.splits.toggle(b)

    expect(manager.splits.groups.partnerOf(b)).toBe(c)
    expect(manager.splits.groups.partnerOf(a)).toBeNull()
  })
})

describe('the strip with pinned tabs in it', () => {
  it('holds a tab moved by a command to its own run', () => {
    const manager = newManager()
    const [a, b, c, d] = strip(manager, 4) as [string, string, string, string]
    setPinned(manager, a, true)
    setPinned(manager, b, true)

    manager.moveTab(d, 0)
    expect(order(manager)).toEqual([a, b, d, c])
    manager.moveTab(a, 3)
    expect(order(manager)).toEqual([b, a, d, c])
  })

  it('moves a joined pair as one, never into the pinned run', () => {
    const manager = newManager()
    const [a, b, c, d] = strip(manager, 4) as [string, string, string, string]
    setPinned(manager, a, true)
    manager.splits.split(c, d, 'right')

    manager.moveTab(c, 0)

    expect(order(manager)).toEqual([a, c, d, b])
  })

  it('puts a pinned tab that arrives from another window among the pinned tabs, and the others after them', () => {
    const from = newManager()
    const to = newManager()
    const [x, y] = strip(from, 2) as [string, string]
    const [p, q, r] = strip(to, 3) as [string, string, string]
    setPinned(to, p, true)
    setPinned(from, x, true)

    const pinnedRecord = from.takeTab(x)
    to.giveTab(x, pinnedRecord as never, 3)
    expect(order(to)).toEqual([p, x, q, r])

    const plain = from.takeTab(y)
    to.giveTab(y, plain as never, 0)
    expect(order(to)).toEqual([p, x, y, q, r])
  })
})

describe('closing tabs in bulk', () => {
  const state = (specs: Array<[id: string, pinned: boolean, splitWith?: string]>): { tabs: Array<{ id: string, pinned: boolean, splitWith: string | null }> } => ({ tabs: specs.map(([id, isPinned, splitWith]) => ({ id, pinned: isPinned, splitWith: splitWith ?? null })) })

  it('leaves the pinned tabs alone, and the tab itself', () => {
    const tabs = state([['a', true], ['b', false], ['c', false], ['d', true], ['e', false]])
    expect(othersToClose(tabs, 'c')).toEqual(['b', 'e'])
    expect(rightToClose(tabs, 'b')).toEqual(['c', 'e'])
    expect(rightToClose(tabs, 'e')).toEqual([])
    expect(rightToClose(tabs, 'gone')).toEqual([])
  })

  it('counts the right of a joined pair from the far side of the pair', () => {
    const tabs = state([['a', false], ['b', false, 'c'], ['c', false, 'b'], ['d', false]])
    expect(rightToClose(tabs, 'b')).toEqual(['d'])
    expect(rightToClose(tabs, 'c')).toEqual(['d'])
  })

  it('closes them in a real strip and lands on the tab it was asked about', () => {
    const manager = newManager()
    const [a, b, c, d] = strip(manager, 4) as [string, string, string, string]
    setPinned(manager, a, true)
    manager.activateTab(d)

    closeOthers(manager, b)

    expect(order(manager)).toEqual([a, b])
    expect(manager.getState().activeTabId).toBe(b)
    expect(manager.record(c)).toBeUndefined()
  })

  it('closes what is right of a tab, and nothing when nothing is', () => {
    const manager = newManager()
    const [a, b, c, d] = strip(manager, 4) as [string, string, string, string]
    manager.activateTab(a)

    closeToRight(manager, b)
    expect(order(manager)).toEqual([a, b])
    expect(manager.getState().activeTabId).toBe(a)
    closeToRight(manager, b)
    expect(order(manager)).toEqual([a, b])
    expect([c, d].every((id) => manager.record(id) === undefined)).toBe(true)
  })
})

describe('opening a tab beside another', () => {
  it('duplicates the address into a foreground tab directly to the right of its source', () => {
    const manager = newManager()
    const [a, b, c] = strip(manager, 3) as [string, string, string]

    duplicateTab(manager, a)

    const [, copy] = order(manager) as [string, string]
    expect(order(manager)).toEqual([a, copy, b, c])
    expect(manager.getState().activeTabId).toBe(copy)
    expect(manager.record(copy)?.pinned).toBe(false)
    expect(createdViews.at(-1)?.webContents.loadURL).toHaveBeenCalledWith('https://a.example/', undefined)
  })

  it('gives the copy the pages behind the original, leaving out what a page saved of its form', () => {
    const manager = newManager()
    const [a] = strip(manager, 1) as [string]
    const original = createdViews.at(-1)?.webContents as FakeContents
    original.navigationHistory.getAllEntries = () => [{ url: 'https://a.example/1', title: 'One', pageState: 'secret' }, { url: 'https://a.example/2', title: 'Two', pageState: 'more' }]
    original.navigationHistory.getActiveIndex = () => 1

    duplicateTab(manager, a)

    const copy = createdViews.at(-1)?.webContents as FakeContents
    expect(copy.navigationHistory.restore).toHaveBeenCalledWith({ entries: [{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }], index: 1 })
  })

  it('has no history to give a copy of a tab that has only its one page', () => {
    const manager = newManager()
    const [a] = strip(manager, 1) as [string]
    duplicateTab(manager, a)
    expect((createdViews.at(-1)?.webContents as FakeContents).navigationHistory.restore).not.toHaveBeenCalled()
  })

  it('opens beside the far edge of a joined pair', () => {
    const manager = newManager()
    const [a, b, c] = strip(manager, 3) as [string, string, string]
    manager.splits.split(a, b, 'right')

    newTabToRight(manager, a)

    const ids = order(manager)
    expect(ids.slice(0, 2)).toEqual([a, b])
    expect(ids.indexOf(c)).toBe(3)
  })

  it('opens beside a pinned tab at the start of the tabs that are not', () => {
    const manager = newManager()
    const [a, b, c] = strip(manager, 3) as [string, string, string]
    setPinned(manager, a, true)
    setPinned(manager, b, true)

    duplicateTab(manager, a)

    const [, , copy] = order(manager) as [string, string, string]
    expect(order(manager)).toEqual([a, b, copy, c])
    expect(manager.record(copy)?.pinned).toBe(false)
  })

  it('makes no tab at all when the window is full', () => {
    const manager = newManager()
    const ids = strip(manager, 1)
    vi.spyOn(manager, 'hasRoom').mockReturnValue(false)
    newTabToRight(manager, ids[0] ?? '')
    expect(order(manager)).toEqual(ids)
  })
})

describe('the tab menu\'s reading of the strip', () => {
  const tab = (over: Record<string, unknown> = {}) => ({ id: 'a', pinned: false, muted: false, splitWith: null, isNewTab: false, isInternal: false, ...over })

  it('offers a copy only of a page with an address of its own', () => {
    expect(tabMenuFlags({ tabs: [tab()] } as never, 'a')?.canDuplicate).toBe(true)
    expect(tabMenuFlags({ tabs: [tab({ isNewTab: true })] } as never, 'a')?.canDuplicate).toBe(false)
    expect(tabMenuFlags({ tabs: [tab({ isInternal: true })] } as never, 'a')?.canDuplicate).toBe(false)
  })

  it('does not pin a tab in a split, and closes nothing beside a lone or all-pinned strip', () => {
    const flags = tabMenuFlags({ tabs: [tab({ splitWith: 'b' }), tab({ id: 'b', splitWith: 'a' })] } as never, 'a')
    expect(flags).toMatchObject({ canPin: false, othersClosable: true, rightClosable: false })
    expect(tabMenuFlags({ tabs: [tab(), tab({ id: 'b', pinned: true })] } as never, 'a')).toMatchObject({ othersClosable: false, rightClosable: false })
    expect(tabMenuFlags({ tabs: [] }, 'a')).toBeUndefined()
  })
})

describe('muting', () => {
  it('switches the page off and back on, and says so in the tab\'s state', () => {
    const manager = newManager()
    const [a] = strip(manager, 1) as [string]
    const page = createdViews.at(-1)?.webContents

    toggleMute(manager, a)
    expect(page?.setAudioMuted).toHaveBeenLastCalledWith(true)
    expect(manager.getState().tabs[0]?.muted).toBe(true)
    toggleMute(manager, a)
    expect(page?.setAudioMuted).toHaveBeenLastCalledWith(false)
    expect(manager.getState().tabs[0]?.muted).toBe(false)
  })

  it('carries the mute to the view a cross-origin navigation puts in the tab\'s place', () => {
    const manager = newManager(APP_CTX)
    const id = manager.createTab('https://app.example/')
    toggleMute(manager, id)
    const views = createdViews.length

    manager.navigate(id, 'https://news.example/')

    expect(createdViews.length).toBe(views + 1)
    expect(createdViews.at(-1)?.webContents.setAudioMuted).toHaveBeenLastCalledWith(true)
    expect(manager.getState().tabs[0]?.muted).toBe(true)
  })

  it('reports a page that starts or stops making sound, only while its view is the tab\'s', () => {
    const manager = newManager(APP_CTX)
    const id = manager.createTab('https://app.example/')
    const first = createdViews.at(-1)?.webContents as FakeContents
    const seen = vi.fn()
    manager.onStateChange(seen)

    first.isCurrentlyAudible.mockReturnValue(true)
    first.emit('audio-state-changed', { audible: true })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(manager.getState().tabs[0]?.audible).toBe(true)

    manager.navigate(id, 'https://news.example/')
    seen.mockClear()
    first.emit('audio-state-changed', { audible: false })
    expect(seen).not.toHaveBeenCalled()
  })

  it('pins and unpins through the command\'s own toggle', () => {
    const manager = newManager()
    const [a] = strip(manager, 1) as [string]
    togglePin(manager, a)
    expect(manager.record(a)?.pinned).toBe(true)
    togglePin(manager, a)
    expect(manager.record(a)?.pinned).toBe(false)
  })
})
