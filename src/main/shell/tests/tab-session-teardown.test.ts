import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'

// Session teardown (handle-contracts.md's own "Session teardown is not
// revocation" section): the broker forgets what it knows about an origin --
// closes its handles, drops its revoked-grant tombstones -- once the LAST
// live tab document of that origin goes, whether by a normal close, a
// navigation away from it, or the tab dying unexpectedly. Never before: two
// tabs of one origin share the broker's per-origin state, so the first
// tab's close must not take the second tab's handles.
//
// Split out with its own small harness rather than added to tabs.test.ts
// (near Rule 2's budget), matching tab-dispose.test.ts's own precedent.

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
}
const createdViews: RecordedView[] = []

function makeFakeWebContents (): FakeContents {
  const emitter = new EventEmitter() as FakeContents
  let destroyed = false
  emitter.loadURL = vi.fn(async () => {})
  emitter.isDestroyed = vi.fn(() => destroyed)
  emitter.isLoading = () => false
  emitter.getURL = () => ''
  emitter.getTitle = () => ''
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  emitter.setWindowOpenHandler = vi.fn()
  emitter.ipc = { on: vi.fn() }
  // Electron can fire 'destroyed' synchronously from close() -- the same
  // fixture tab-dispose.test.ts and tabs.test.ts already use.
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView) {
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    this.setVisible = vi.fn()
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }

/** Neither `hasGrantsSync` nor `isRegisteredSync` matters here: origin
 * liveness is tracked independently of which session a tab is in, so both
 * are fixed to `false` and only `dropOrigin` is asserted on. */
function managerWithBroker (): { manager: InstanceType<typeof TabManager>, dropOrigin: ReturnType<typeof vi.fn> } {
  const dropOrigin = vi.fn(async () => {})
  const ctx = {
    broker: { app: { hasGrantsSync: () => false, isRegisteredSync: () => false }, dropOrigin }
  } as unknown as SubsystemContext
  const manager = new TabManager(fakeContentView as never, () => ({ x: 0, y: 0, width: 800, height: 600 }), vi.fn(), 'http://localhost:5999/newtab/', ctx)
  return { manager, dropOrigin }
}

beforeEach(() => {
  createdViews.length = 0
  fakeContentView.addChildView.mockClear()
  fakeContentView.removeChildView.mockClear()
})

describe('TabManager -- session teardown drops an origin once its last live tab goes', () => {
  it('drops the origin when its only tab closes', () => {
    const { manager, dropOrigin } = managerWithBroker()
    const id = manager.createTab('https://drop-a.example/')
    createdViews[0]!.webContents.emit('did-navigate', {}, 'https://drop-a.example/')

    manager.closeTab(id)

    expect(dropOrigin).toHaveBeenCalledWith('https://drop-a.example')
  })

  it('does not drop the origin while a second tab of it is still open', () => {
    const { manager, dropOrigin } = managerWithBroker()
    const first = manager.createTab('https://drop-b.example/')
    createdViews[0]!.webContents.emit('did-navigate', {}, 'https://drop-b.example/')
    manager.createTab('https://drop-b.example/')
    createdViews[1]!.webContents.emit('did-navigate', {}, 'https://drop-b.example/')

    manager.closeTab(first)

    expect(dropOrigin).not.toHaveBeenCalled()
  })

  it('drops it once BOTH tabs of it are closed, exactly once', () => {
    const { manager, dropOrigin } = managerWithBroker()
    const first = manager.createTab('https://drop-c.example/')
    createdViews[0]!.webContents.emit('did-navigate', {}, 'https://drop-c.example/')
    const second = manager.createTab('https://drop-c.example/')
    createdViews[1]!.webContents.emit('did-navigate', {}, 'https://drop-c.example/')

    manager.closeTab(first)
    manager.closeTab(second)

    expect(dropOrigin).toHaveBeenCalledExactlyOnceWith('https://drop-c.example')
  })

  it('drops the OLD origin, never the new one, when a tab navigates away and was its only tab', () => {
    const { manager, dropOrigin } = managerWithBroker()
    manager.createTab('https://drop-d.example/')
    createdViews[0]!.webContents.emit('did-navigate', {}, 'https://drop-d.example/')

    createdViews[0]!.webContents.emit('did-navigate', {}, 'https://drop-e.example/')

    expect(dropOrigin).toHaveBeenCalledExactlyOnceWith('https://drop-d.example')
  })

  it('drops the origin of a tab that dies unexpectedly, without a normal close', () => {
    const { manager, dropOrigin } = managerWithBroker()
    manager.createTab('https://drop-f.example/')
    createdViews[0]!.webContents.emit('did-navigate', {}, 'https://drop-f.example/')

    createdViews[0]!.webContents.emit('destroyed')

    expect(dropOrigin).toHaveBeenCalledWith('https://drop-f.example')
  })
})
