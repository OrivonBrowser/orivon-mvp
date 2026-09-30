import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'
import type { TabSignal } from '../tab-signals.js'

// The per-tab hooks a feature plugs in, driven through a real TabManager so
// the wiring points (a new view, a parked view coming back, every state push,
// a tab leaving) are the ones a feature relies on.
interface FakeContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: () => boolean
  getURL: () => string
  getTitle: () => string
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean, getActiveIndex: () => number, length: () => number, getEntryAtIndex: () => { url: string }, removeEntryAtIndex: () => boolean }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
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
  emitter.getURL = () => ''
  emitter.getTitle = () => ''
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getActiveIndex: () => 0, length: () => 0, getEntryAtIndex: () => ({ url: '' }), removeEntryAtIndex: () => false }
  emitter.setWindowOpenHandler = vi.fn()
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
const { TabLifecycle } = await import('../tab-lifecycle.js')
const { TAB_SIGNALS, applyTabSignals, signalState, wireTabSignals } = await import('../tab-signals.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
const APP_CTX = { broker: { app: { isRegisteredSync: (origin: string) => origin === 'https://app.example' }, dropOrigin: async () => {} } } as unknown as SubsystemContext

function newManager (shell?: Record<string, unknown>, ctx: SubsystemContext = {} as SubsystemContext): InstanceType<typeof TabManager> {
  return new TabManager(fakeContentView as never, () => ({ x: 0, y: 0, width: 800, height: 600 }), vi.fn(), 'http://localhost:5999/newtab/', ctx, shell as never)
}

/** Installs `signal` for one test; TAB_SIGNALS is the registry a feature adds a line to. */
function install (signal: TabSignal): void { (TAB_SIGNALS as TabSignal[]).push(signal) }

beforeEach(() => { createdViews.length = 0 })
afterEach(() => { (TAB_SIGNALS as TabSignal[]).length = 0 })

describe('the tab signal registry', () => {
  it('lists each feature once, by a name of its own', () => {
    const names = TAB_SIGNALS.map((signal) => signal.name)
    expect(names.every((name) => name !== '')).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it('runs every wire, then every apply, and gives each the same context', () => {
    const calls: string[] = []
    const record = { view: { webContents: {} } } as never
    const a: TabSignal = { name: 'a', wire: () => { calls.push('a.wire') }, apply: () => { calls.push('a.apply') } }
    const b: TabSignal = { name: 'b', wire: () => { calls.push('b.wire') }, apply: () => { calls.push('b.apply') } }

    wireTabSignals('t1', record, [a, b])

    expect(calls).toEqual(['a.wire', 'b.wire', 'a.apply', 'b.apply'])
  })

  it('tells a signal its view stopped being the tab\'s once the record shows another', () => {
    const first = { webContents: {} }
    const record = { view: first } as never as { view: unknown }
    let shown: (() => boolean) | undefined
    wireTabSignals('t1', record as never, [{ name: 'a', wire: (tab) => { shown = tab.shown } }])

    expect(shown?.()).toBe(true)
    record.view = { webContents: {} }
    expect(shown?.()).toBe(false)
  })

  it('applies without wiring when asked to only apply', () => {
    const wire = vi.fn()
    const apply = vi.fn()

    applyTabSignals('t1', { view: { webContents: {} } } as never, [{ name: 'a', wire, apply }])

    expect(wire).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('merges what every signal adds to the state, later signals winning a shared key', () => {
    const merged = signalState({} as never, undefined, [
      { name: 'a', state: () => ({ muted: true, audible: true }) },
      { name: 'b' },
      { name: 'c', state: () => ({ audible: false }) }
    ])

    expect(merged).toEqual({ muted: true, audible: false })
  })
})

describe('TabManager and the tab signals', () => {
  it('wires a signal once per webContents and applies it again when a parked view returns', () => {
    const wire = vi.fn()
    const apply = vi.fn()
    install({ name: 'probe', wire, apply })
    const manager = newManager(undefined, APP_CTX)

    const id = manager.createTab('https://app.example/')
    manager.navigate(id, 'https://news.example/')
    expect(wire).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(2)

    manager.navigate(id, 'https://app.example/')

    expect(createdViews).toHaveLength(2)
    expect(wire).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(3)
  })

  it('lets a signal reach the tab through the record it is given', () => {
    let seen: { id: string, sameRecord: boolean } | undefined
    const manager = newManager()
    install({ name: 'probe', wire: (tab) => { seen = { id: tab.id, sameRecord: tab.record.view === tab.view } } })

    const id = manager.createTab('https://a.example/')

    expect(seen).toEqual({ id, sameRecord: true })
    expect(manager.record(id)?.view).toBe(createdViews[0])
  })

  it('pushes the pre-declared fields at rest, and what a signal adds on top', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/')
    expect(manager.getState().tabs[0]).toMatchObject({ id, pinned: false, muted: false, audible: false, crashed: null })

    install({ name: 'audio', state: (record) => ({ muted: record.muted === true, audible: true }) })
    const record = manager.record(id)
    if (record !== undefined) record.muted = true

    expect(manager.getState().tabs[0]).toMatchObject({ muted: true, audible: true })
  })

  it('answers record(), ids() and changed() for a feature that keeps state on the record', () => {
    const manager = newManager()
    const seen = vi.fn()
    manager.onStateChange(seen)
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    seen.mockClear()

    manager.moveTab(b, 0)
    expect(manager.ids()).toEqual([b, a])
    expect(manager.record('nope')).toBeUndefined()

    seen.mockClear()
    manager.changed()
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('gives view-level code the shell\'s services and a way to run a command on the window', () => {
    const services = { settings: {} }
    const runCommand = vi.fn()
    const manager = newManager({ window: {}, htmlFullscreenChanged: vi.fn(), services, runCommand })
    const id = manager.createTab('https://a.example/')

    const host = manager.record(id)?.host
    host?.runCommand('tab.new')

    expect(host?.services).toBe(services)
    expect(runCommand).toHaveBeenCalledWith('tab.new')
  })

  it('has no services and runs nothing when the window gives none', () => {
    const manager = newManager()
    const host = manager.record(manager.createTab('https://a.example/'))?.host

    expect(host?.services).toBeUndefined()
    expect(() => { host?.runCommand('tab.new') }).not.toThrow()
  })
})

describe('the tabClosing lifecycle event', () => {
  function watched (): { manager: InstanceType<typeof TabManager>, closing: ReturnType<typeof vi.fn>, order: string[] } {
    const lifecycle = new TabLifecycle()
    const order: string[] = []
    const closing = vi.fn(() => { order.push('closing') })
    lifecycle.subscribe({ tabClosing: closing, tabClosed: () => { order.push('closed') } })
    const manager = newManager({ window: { id: 'win' }, htmlFullscreenChanged: vi.fn(), tabLifecycle: lifecycle })
    return { manager, closing, order }
  }

  it('says closed, with the tab\'s place and record, ahead of tabClosed and while the tab is still held', () => {
    const { manager, closing, order } = watched()
    manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const record = manager.record(b)
    let held = false
    closing.mockImplementation(() => { held = manager.record(b) !== undefined })

    manager.closeTab(b)

    expect(closing).toHaveBeenCalledWith({ id: b, index: 1, record, reason: 'closed', window: { id: 'win' } })
    expect(held).toBe(true)
    expect(order.indexOf('closing')).toBeLessThan(order.indexOf('closed'))
  })

  it('says moved for a tab handed to another window alive', () => {
    const { manager, closing } = watched()
    const id = manager.createTab('https://a.example/')

    manager.takeTab(id)

    expect(closing).toHaveBeenCalledWith(expect.objectContaining({ id, reason: 'moved' }))
  })

  it('says gone for a page whose webContents was destroyed under the tab', () => {
    const { manager, closing } = watched()
    const id = manager.createTab('https://a.example/')

    createdViews[0]?.webContents.emit('destroyed')

    expect(closing).toHaveBeenCalledWith(expect.objectContaining({ id, reason: 'gone' }))
  })

  it('says window-closing for every tab when the window goes', () => {
    const { manager, closing } = watched()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')

    manager.dispose()

    expect(closing.mock.calls.map(([info]) => (info as { id: string, reason: string }))).toEqual([
      expect.objectContaining({ id: a, reason: 'window-closing' }),
      expect.objectContaining({ id: b, reason: 'window-closing' })
    ])
  })
})
