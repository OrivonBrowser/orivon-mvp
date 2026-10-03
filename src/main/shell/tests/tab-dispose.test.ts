import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'

// A window that is closing destroys itself first and its views' webContents
// after. The tab manager must not ask that window for anything in between.
interface FakeContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: () => boolean
  getURL: () => string
  getTitle: () => string
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  ipc: { on: ReturnType<typeof vi.fn> }
  close: ReturnType<typeof vi.fn>
}

interface RecordedView {
  webContents: FakeContents
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
}
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
  emitter.ipc = { on: vi.fn() }
  // Electron can fire 'destroyed' synchronously from close().
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView) {
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    this.setVisible = vi.fn()
    this.setBackgroundColor = vi.fn()
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }

function managerOverAWindow (): { manager: InstanceType<typeof TabManager>, windowDestroyed: () => void, getBounds: ReturnType<typeof vi.fn>, onEmpty: ReturnType<typeof vi.fn>, devtoolsCloseFor: ReturnType<typeof vi.fn> } {
  let destroyed = false
  const getBounds = vi.fn(() => {
    if (destroyed) throw new TypeError('Object has been destroyed')
    return { x: 0, y: 0, width: 800, height: 600 }
  })
  const onEmpty = vi.fn()
  const devtoolsCloseFor = vi.fn()
  const shell = { window: {} as never, htmlFullscreenChanged: vi.fn(), devtools: { allowed: vi.fn(), inspect: vi.fn(), closeFor: devtoolsCloseFor } }
  const manager = new TabManager(fakeContentView as never, getBounds, onEmpty, 'http://localhost:5999/newtab/', {} as SubsystemContext, shell)
  return { manager, windowDestroyed: () => { destroyed = true }, getBounds, onEmpty, devtoolsCloseFor }
}

beforeEach(() => {
  createdViews.length = 0
  fakeContentView.addChildView.mockClear()
  fakeContentView.removeChildView.mockClear()
})

describe('TabManager.dispose -- a closing window (A259)', () => {
  it('closes every tab\'s view, the background ones included: only the active view is a child of the window', () => {
    const { manager } = managerOverAWindow()
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')
    manager.createTab('https://c.example/')

    manager.dispose()

    for (const view of createdViews) expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('never asks a destroyed window for its bounds while its tabs are destroyed after it', () => {
    const { manager, windowDestroyed, getBounds, onEmpty } = managerOverAWindow()
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')
    getBounds.mockClear()

    windowDestroyed()

    expect(() => { manager.dispose() }).not.toThrow()
    expect(getBounds).not.toHaveBeenCalled()
    expect(onEmpty).not.toHaveBeenCalled()
  })

  it('a tab that dies on its own after dispose does not bring a fallback tab up', () => {
    const { manager, getBounds } = managerOverAWindow()
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')
    manager.dispose()
    getBounds.mockClear()

    createdViews[1]?.webContents.emit('destroyed')

    expect(getBounds).not.toHaveBeenCalled()
    expect(fakeContentView.addChildView).toHaveBeenCalledTimes(2)
  })

  it('reports itself disposed from the moment dispose starts', () => {
    const { manager } = managerOverAWindow()
    manager.createTab('https://a.example/')
    expect(manager.isDisposed()).toBe(false)
    manager.dispose()
    expect(manager.isDisposed()).toBe(true)
  })

  it('stops pushing state to its listeners', () => {
    const { manager } = managerOverAWindow()
    manager.createTab('https://a.example/')
    const listener = vi.fn()
    manager.onStateChange(listener)

    manager.dispose()

    expect(listener).not.toHaveBeenCalled()
    manager.layout()
    expect(listener).not.toHaveBeenCalled()
  })

  it('takes no new tab once the window is closing', () => {
    const { manager } = managerOverAWindow()
    manager.dispose()

    manager.createTab('https://late.example/')

    expect(createdViews).toHaveLength(0)
  })

  it('can be called twice', () => {
    const { manager } = managerOverAWindow()
    manager.createTab('https://a.example/')

    manager.dispose()
    manager.dispose()

    expect(createdViews[0]?.webContents.close).toHaveBeenCalledTimes(1)
  })

  // DevToolsService tracks every WebContents it opened tools on until closeFor()
  // runs; skipping it here leaks a destroyed WebContents for the rest of the
  // process's life.
  it('closes DevTools for every tab\'s view', () => {
    const { manager, devtoolsCloseFor } = managerOverAWindow()
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')

    manager.dispose()

    for (const view of createdViews) expect(devtoolsCloseFor).toHaveBeenCalledWith(view.webContents)
  })

  // Every other mutator that matters after teardown checks disposed itself;
  // takeTab/giveTab did not, relying entirely on tab-move.ts's own hasRoom()
  // check on the TARGET window rather than enforcing their own invariant.
  it('takeTab refuses on a disposed manager, even if a record is still tracked', () => {
    const { manager } = managerOverAWindow()
    const id = manager.createTab('https://a.example/')
    // dispose()'s own close() would otherwise fire 'destroyed' and drop the
    // record via forgetTab() before takeTab() runs, masking whether ITS OWN
    // guard is what refuses -- overriding close() keeps the record tracked.
    createdViews[0]!.webContents.close = vi.fn()

    manager.dispose()

    expect(manager.takeTab(id)).toBeNull()
  })

  it('giveTab refuses on a disposed manager', () => {
    const { manager } = managerOverAWindow()
    manager.dispose()

    expect(() => { manager.giveTab('x', {} as never) }).not.toThrow()
    expect(manager.getState().tabs).toHaveLength(0)
  })
})
