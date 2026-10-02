import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { SubsystemContext } from '../../registry.js'

// A tab whose view is swapped for one of the same session keeps its back and
// forward list; a swap across partitions starts a new one. The swap itself is
// driven the way the real one happens: Chromium's `did-navigate` on the old
// view, for an origin that has just become an app.
interface FakeHistory {
  entries: Array<{ url: string, title: string }>
  active: number
  restore: ReturnType<typeof vi.fn>
  getAllEntries: () => Array<{ url: string, title: string, pageState?: string }>
  getActiveIndex: () => number
  canGoBack: () => boolean
  canGoForward: () => boolean
  length: () => number
  getEntryAtIndex: (index: number) => { url: string }
  removeEntryAtIndex: (index: number) => boolean
}

interface FakeWebContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  getTitle: ReturnType<typeof vi.fn>
  navigationHistory: FakeHistory
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

interface RecordedView {
  options: { webPreferences?: Record<string, unknown> }
  webContents: FakeWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}
const createdViews: RecordedView[] = []

function makeFakeWebContents (): FakeWebContents {
  const emitter = new EventEmitter() as FakeWebContents
  let destroyed = false
  const history: FakeHistory = {
    entries: [],
    active: -1,
    restore: vi.fn(async () => {}),
    getAllEntries: () => history.entries.map((entry) => ({ ...entry, pageState: 'form values and a POST body' })),
    getActiveIndex: () => history.active,
    canGoBack: () => history.active > 0,
    canGoForward: () => false,
    length: () => history.entries.length,
    getEntryAtIndex: (index) => ({ url: history.entries[index]?.url ?? '' }),
    removeEntryAtIndex: () => false
  }
  emitter.navigationHistory = history
  emitter.loadURL = vi.fn(async () => {})
  emitter.stop = vi.fn()
  emitter.reload = vi.fn()
  emitter.isDestroyed = vi.fn(() => destroyed)
  emitter.isLoading = vi.fn(() => false)
  emitter.getURL = vi.fn(() => '')
  emitter.getTitle = vi.fn(() => '')
  emitter.setWindowOpenHandler = vi.fn()
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView, options: RecordedView['options']) {
    this.options = options
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    this.setBackgroundColor = vi.fn()
    createdViews.push(this)
  })
}))

const { served } = vi.hoisted(() => ({ served: new Set<string>() }))
vi.mock('../../../loader/electron/serve.js', () => ({
  isOriginServedFromCacheSync: (origin: string) => served.has(origin)
}))

const { TabManager } = await import('../tabs.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
const fakeBounds = { x: 0, y: 0, width: 800, height: 600 }

function managerWith (registered: Set<string>): InstanceType<typeof TabManager> {
  const known = (origin: string): boolean => registered.has(origin)
  const ctx = { broker: { dropOrigin: async () => {}, app: { isRegisteredSync: known, hasGrantsSync: (origin: string) => served.has(origin) && known(origin) } } } as unknown as SubsystemContext
  return new TabManager(fakeContentView as never, () => fakeBounds, vi.fn(), 'http://localhost:5999/newtab/', ctx)
}

beforeEach(() => {
  createdViews.length = 0
  served.clear()
})

const APP = 'http://127.0.0.1:8874'

describe('a swap within one session carries the back and forward list', () => {
  it('a page newly registered as an app, with no partition of its own, keeps its history in the rebuilt view', () => {
    const registered = new Set<string>()
    const manager = managerWith(registered)
    manager.createTab(`${APP}/`)
    const oldView = createdViews[0] as RecordedView
    oldView.webContents.navigationHistory.entries = [{ url: 'https://start.example/', title: 'Start' }, { url: `${APP}/`, title: 'App' }]
    oldView.webContents.navigationHistory.active = 1

    registered.add(APP)
    oldView.webContents.emit('did-navigate', {}, `${APP}/`)

    expect(createdViews).toHaveLength(2)
    const newView = createdViews[1] as RecordedView
    expect(newView.webContents.navigationHistory.restore).toHaveBeenCalledExactlyOnceWith({
      entries: [{ url: 'https://start.example/', title: 'Start' }, { url: `${APP}/`, title: 'App' }],
      index: 1
    })
    expect(newView.webContents.reload).toHaveBeenCalledOnce()
    expect(newView.webContents.loadURL).not.toHaveBeenCalled()
  })

  it('carries only addresses and titles, never an entry\'s saved page state', () => {
    const registered = new Set<string>()
    const manager = managerWith(registered)
    manager.createTab(`${APP}/`)
    const oldView = createdViews[0] as RecordedView
    oldView.webContents.navigationHistory.entries = [{ url: 'https://start.example/', title: 'Start' }, { url: `${APP}/`, title: 'App' }]
    oldView.webContents.navigationHistory.active = 1

    registered.add(APP)
    oldView.webContents.emit('did-navigate', {}, `${APP}/`)

    const restored = (createdViews[1] as RecordedView).webContents.navigationHistory.restore.mock.calls[0]?.[0] as { entries: object[] }
    for (const entry of restored.entries) expect(entry).not.toHaveProperty('pageState')
  })

  it('a tab with a single page loads the address as before', () => {
    const registered = new Set<string>()
    const manager = managerWith(registered)
    manager.createTab(`${APP}/`)
    const oldView = createdViews[0] as RecordedView
    oldView.webContents.navigationHistory.entries = [{ url: `${APP}/`, title: 'App' }]
    oldView.webContents.navigationHistory.active = 0

    registered.add(APP)
    oldView.webContents.emit('did-navigate', {}, `${APP}/`)

    const newView = createdViews[1] as RecordedView
    expect(newView.webContents.loadURL).toHaveBeenCalledWith(`${APP}/`)
    expect(newView.webContents.navigationHistory.restore).not.toHaveBeenCalled()
  })
})

describe('a swap made before the address has committed', () => {
  it('keeps the pages behind the one being left, and loads the address after them', () => {
    const registered = new Set<string>([APP])
    const manager = managerWith(registered)
    const id = manager.createTab(`${APP}/`)
    const oldView = createdViews[0] as RecordedView
    oldView.webContents.navigationHistory.entries = [{ url: 'https://before.example/', title: 'Before' }, { url: `${APP}/`, title: 'App' }]
    oldView.webContents.navigationHistory.active = 1

    manager.navigate(id, 'https://plain.example/')

    const newView = createdViews[1] as RecordedView
    expect(newView.webContents.navigationHistory.restore).toHaveBeenCalledExactlyOnceWith({
      entries: [{ url: 'https://before.example/', title: 'Before' }, { url: `${APP}/`, title: 'App' }],
      index: 1
    })
    expect(newView.webContents.loadURL).toHaveBeenCalledWith('https://plain.example/')
    expect(newView.webContents.reload).not.toHaveBeenCalled()
  })

  it('drops the pages ahead of the one being left, as any new address does', () => {
    const registered = new Set<string>([APP])
    const manager = managerWith(registered)
    const id = manager.createTab(`${APP}/`)
    const oldView = createdViews[0] as RecordedView
    oldView.webContents.navigationHistory.entries = [{ url: `${APP}/`, title: 'App' }, { url: `${APP}/two`, title: 'Two' }]
    oldView.webContents.navigationHistory.active = 0

    manager.navigate(id, 'https://plain.example/')

    const restored = (createdViews[1] as RecordedView).webContents.navigationHistory.restore.mock.calls[0]?.[0] as { entries: object[], index: number }
    expect(restored.entries).toEqual([{ url: `${APP}/`, title: 'App' }])
    expect(restored.index).toBe(0)
  })

  it('a tab with no committed page yet just loads the address', () => {
    const registered = new Set<string>([APP])
    const manager = managerWith(registered)
    const id = manager.createTab(`${APP}/`)

    manager.navigate(id, 'https://plain.example/')

    const newView = createdViews[1] as RecordedView
    expect(newView.webContents.loadURL).toHaveBeenCalledWith('https://plain.example/')
    expect(newView.webContents.navigationHistory.restore).not.toHaveBeenCalled()
  })
})

describe('a swap across partitions starts a new list', () => {
  it('entering an app that has a partition of its own loads its address in a view with no history', () => {
    const registered = new Set<string>([APP])
    served.add(APP)
    const manager = managerWith(registered)
    manager.createTab('https://start.example/')
    const oldView = createdViews[0] as RecordedView
    oldView.webContents.navigationHistory.entries = [{ url: 'https://before.example/', title: 'Before' }, { url: `${APP}/`, title: 'App' }]
    oldView.webContents.navigationHistory.active = 1

    oldView.webContents.emit('did-navigate', {}, `${APP}/`)

    const newView = createdViews[1] as RecordedView
    expect(newView.webContents.loadURL).toHaveBeenCalledWith(`${APP}/`)
    expect(newView.webContents.navigationHistory.restore).not.toHaveBeenCalled()
  })
})
