import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Page signals (title, loading, address inside the page, icon) reach the strip's listeners as one trailing push,
// driven through a real TabManager over fake views.
const createdViews: Array<{ webContents: EventEmitter }> = []

function makeFakeWebContents (): EventEmitter {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
  emitter.loadURL = vi.fn(async () => {})
  emitter.isDestroyed = vi.fn(() => false)
  emitter.isLoading = () => false
  emitter.isCrashed = () => true
  emitter.getUserAgent = () => ''
  emitter.setUserAgent = vi.fn()
  emitter.getURL = () => 'https://a.example/'
  emitter.getTitle = () => 'A'
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [{ url: 'https://a.example/', title: '' }], getActiveIndex: () => 0, restore: vi.fn(async () => {}) }
  emitter.setWindowOpenHandler = vi.fn()
  emitter.ipc = { on: vi.fn() }
  emitter.setAudioMuted = vi.fn()
  emitter.isCurrentlyAudible = vi.fn(() => false)
  emitter.focus = vi.fn()
  emitter.stop = vi.fn()
  emitter.reload = vi.fn()
  emitter.close = vi.fn(() => { emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: { webContents: EventEmitter }) {
    this.webContents = makeFakeWebContents()
    Object.assign(this, { setBounds: vi.fn(), setBackgroundColor: vi.fn() })
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

function newManager (): InstanceType<typeof TabManager> {
  return new TabManager({ children: [], addChildView: vi.fn(), removeChildView: vi.fn() } as never, () => ({ x: 0, y: 0, width: 800, height: 600 }), vi.fn(), 'http://localhost:5999/newtab/', {} as never)
}

beforeEach(() => { createdViews.length = 0; vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('page signals and the state push', () => {
  it('turns a burst of signals from several tabs into one push after a short wait', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')
    const seen = vi.fn()
    manager.onStateChange(seen)
    const [first, second] = createdViews.map((view) => view.webContents) as [EventEmitter, EventEmitter]

    first.emit('did-start-loading')
    first.emit('page-title-updated', {}, 'A')
    second.emit('page-title-updated', {}, 'B')
    first.emit('did-navigate-in-page', {}, 'https://a.example/#x')
    first.emit('did-stop-loading')
    expect(seen).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(seen).toHaveBeenCalledTimes(1)

    first.emit('page-title-updated', {}, 'A2')
    vi.advanceTimersByTime(100)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('leaves changed() synchronous, and lets it stand in for a push already waiting', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const seen = vi.fn()
    manager.onStateChange(seen)

    createdViews[0]?.webContents.emit('page-title-updated', {}, 'A')
    manager.changed()
    expect(seen).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(100)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('pushes nothing for a signal that was waiting when the manager was disposed', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const seen = vi.fn()
    manager.onStateChange(seen)

    createdViews[0]?.webContents.emit('page-title-updated', {}, 'A')
    manager.dispose()
    // Every timer, not only the push's: the panes keep a layout check of their own, which pushes nothing.
    vi.runAllTimers()

    expect(seen).not.toHaveBeenCalled()
  })
})
