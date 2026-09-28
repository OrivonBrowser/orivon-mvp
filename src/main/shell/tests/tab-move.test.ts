import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'
import type { ShellWindow } from '../window-registry.js'

// Two windows' tab managers over fake views. What matters is which manager
// answers for a tab after it has moved: its views' handlers were attached once,
// when the tab was made, and must follow it.
interface FakeContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: () => boolean
  getURL: () => string
  getTitle: () => string
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}
interface RecordedView { webContents: FakeContents, setBounds: ReturnType<typeof vi.fn> }
const createdViews: RecordedView[] = []

function makeFakeWebContents (): FakeContents {
  const emitter = new EventEmitter() as FakeContents
  let destroyed = false
  emitter.loadURL = vi.fn(async () => {})
  emitter.isDestroyed = vi.fn(() => destroyed)
  emitter.isLoading = () => false
  emitter.getURL = () => 'https://a.example/'
  emitter.getTitle = () => ''
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  emitter.setWindowOpenHandler = vi.fn()
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView) {
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')
const { dropTab, moveToNewWindow, moveToWindow } = await import('../tab-move.js')

beforeEach(() => { createdViews.length = 0 })

interface Side { manager: InstanceType<typeof TabManager>, contentView: { addChildView: ReturnType<typeof vi.fn>, removeChildView: ReturnType<typeof vi.fn> }, onEmpty: ReturnType<typeof vi.fn>, entry: ShellWindow, close: ReturnType<typeof vi.fn>, holdsScreen: { on: boolean } }

function side (): Side {
  const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
  const onEmpty = vi.fn()
  const manager = new TabManager(contentView as never, () => ({ x: 0, y: 0, width: 800, height: 600 }), onEmpty, 'http://localhost:5999/newtab/', {} as SubsystemContext)
  const close = vi.fn()
  const holdsScreen = { on: false }
  const entry = { window: { isDestroyed: () => false, close, focus: vi.fn() }, tabs: manager, shortcutsSuspended: () => holdsScreen.on } as unknown as ShellWindow
  return { manager, contentView, onEmpty, entry, close, holdsScreen }
}

const ids = (manager: InstanceType<typeof TabManager>): string[] => manager.getState().tabs.map((tab) => tab.id)

describe('a tab moved to another window', () => {
  it('is shown there, in the same view, and no longer here', () => {
    const from = side()
    const to = side()
    const [a, b] = [from.manager.createTab('https://a.example/'), from.manager.createTab('https://b.example/')]
    const view = createdViews[1] as RecordedView

    expect(moveToWindow(from.entry, b, to.entry)).toBe(true)

    expect(ids(from.manager)).toEqual([a])
    expect(ids(to.manager)).toEqual([b])
    expect(from.manager.getState().activeTabId).toBe(a)
    expect(to.manager.getState().activeTabId).toBe(b)
    expect(from.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(to.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 800, height: 600 })
    expect(view.webContents.close).not.toHaveBeenCalled()
    expect(from.close).not.toHaveBeenCalled()
  })

  it('is answered for by the window that shows it now: closing its page removes it there, and not here', () => {
    const from = side()
    const to = side()
    from.manager.createTab('https://a.example/')
    const moved = from.manager.createTab('https://b.example/')
    const view = createdViews[1] as RecordedView
    moveToWindow(from.entry, moved, to.entry)
    to.manager.createTab('https://c.example/')

    view.webContents.emit('destroyed')

    expect(ids(to.manager)).toHaveLength(1)
    expect(ids(to.manager)).not.toContain(moved)
    expect(ids(from.manager)).toHaveLength(1)
  })

  it('closes the window it left when that was its last tab, and does not treat that as a tab being closed', () => {
    const from = side()
    const to = side()
    const only = from.manager.createTab('https://a.example/')

    expect(moveToWindow(from.entry, only, to.entry)).toBe(true)

    expect(from.close).toHaveBeenCalledTimes(1)
    expect(from.onEmpty).not.toHaveBeenCalled()
    expect(ids(to.manager)).toEqual([only])
  })

  it('goes where it is put in the strip', () => {
    const from = side()
    const to = side()
    const t1 = to.manager.createTab('https://1.example/')
    const t2 = to.manager.createTab('https://2.example/')
    from.manager.createTab('https://x.example/')
    const moved = from.manager.createTab('https://y.example/')

    moveToWindow(from.entry, moved, to.entry, 1)

    expect(ids(to.manager)).toEqual([t1, moved, t2])
  })

  it('stays put when the other window has no room, the window holds the screen, or it is asked to go where it is', () => {
    const from = side()
    const to = side()
    from.manager.createTab('https://a.example/')
    const tab = from.manager.createTab('https://b.example/')

    expect(moveToWindow(from.entry, tab, from.entry)).toBe(false)
    from.holdsScreen.on = true
    expect(moveToWindow(from.entry, tab, to.entry)).toBe(false)
    from.holdsScreen.on = false
    to.manager.dispose()
    expect(moveToWindow(from.entry, tab, to.entry)).toBe(false)
    expect(moveToWindow(from.entry, 'tab-that-is-not-here', side().entry)).toBe(false)
    expect(ids(from.manager)).toHaveLength(2)
  })
})

describe('a tab moved to a new window', () => {
  it('opens a window that takes the tab as its first', () => {
    const from = side()
    from.manager.createTab('https://a.example/')
    const tab = from.manager.createTab('https://b.example/')
    const fresh = side()
    const openWindow = vi.fn((options: { first?: (tabs: InstanceType<typeof TabManager>) => void }) => { options.first?.(fresh.manager) })

    expect(moveToNewWindow(from.entry, tab, openWindow, { x: 5, y: 6 })).toBe(true)

    expect(openWindow).toHaveBeenCalledWith(expect.objectContaining({ place: { x: 5, y: 6 } }))
    expect(ids(fresh.manager)).toEqual([tab])
    expect(ids(from.manager)).toHaveLength(1)
  })

  it('opens on a new tab when the tab has gone by the time the window is ready', () => {
    const from = side()
    from.manager.createTab('https://a.example/')
    const tab = from.manager.createTab('https://b.example/')
    const fresh = side()
    const openWindow = vi.fn((options: { first?: (tabs: InstanceType<typeof TabManager>) => void }) => {
      from.manager.closeTab(tab)
      options.first?.(fresh.manager)
    })

    moveToNewWindow(from.entry, tab, openWindow)

    expect(ids(fresh.manager)).toHaveLength(1)
    expect(ids(fresh.manager)).not.toContain(tab)
  })

  it('does nothing for a window\'s only tab, or while a page holds the screen', () => {
    const only = side()
    const tab = only.manager.createTab('https://a.example/')
    const openWindow = vi.fn()
    expect(moveToNewWindow(only.entry, tab, openWindow)).toBe(false)

    const busy = side()
    busy.manager.createTab('https://a.example/')
    const second = busy.manager.createTab('https://b.example/')
    busy.holdsScreen.on = true
    expect(moveToNewWindow(busy.entry, second, openWindow)).toBe(false)
    expect(openWindow).not.toHaveBeenCalled()
  })
})

describe('reordering a window\'s tabs', () => {
  it('puts a tab where it is dropped and tells the window', () => {
    const { manager } = side()
    const [a, b, c] = [manager.createTab('https://a.example/'), manager.createTab('https://b.example/'), manager.createTab('https://c.example/')]
    const heard = vi.fn()
    manager.onStateChange(heard)

    manager.moveTab(a, 2)

    expect(ids(manager)).toEqual([b, c, a])
    expect(heard).toHaveBeenCalledTimes(1)
    manager.moveTab(a, 2)
    expect(heard).toHaveBeenCalledTimes(1)
  })
})

describe('a tab let go where windows overlap', () => {
  it('goes to the newest window whose strip is under the pointer', () => {
    const bounds = { x: 100, y: 100, width: 800, height: 600 }
    const [from, older, newer] = [side(), side(), side()]
    for (const each of [from, older, newer]) (each.entry.window as unknown as { getBounds: () => typeof bounds }).getBounds = () => bounds
    from.manager.createTab('https://a.example/')
    const moved = from.manager.createTab('https://b.example/')

    dropTab(from.entry, moved, { x: 300, y: 110 }, [older.entry, newer.entry, from.entry], vi.fn(), 80)

    expect(ids(newer.manager)).toEqual([moved])
    expect(ids(older.manager)).toEqual([])
  })
})
