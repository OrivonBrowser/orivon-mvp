import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'

// A tab opened beside another in a split, before web pages may load: the new tab does not exist yet, so the split waits
// instead of joining the tab in front (the id `createTab` answers when it defers) to itself.
function fakeContents (): EventEmitter {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
  emitter['loadURL'] = vi.fn(async () => {})
  emitter['isDestroyed'] = vi.fn(() => false)
  emitter['isLoading'] = () => false
  emitter['getURL'] = () => 'http://localhost:5999/newtab/'
  emitter['getTitle'] = () => ''
  emitter['navigationHistory'] = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => -1 }
  emitter['setWindowOpenHandler'] = vi.fn()
  emitter['ipc'] = { on: vi.fn() }
  emitter['close'] = vi.fn()
  emitter['focus'] = vi.fn()
  return emitter
}

vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: false },
  WebContentsView: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this['webContents'] = fakeContents()
    this['setBounds'] = vi.fn()
    this['setVisible'] = vi.fn()
    this['setBackgroundColor'] = vi.fn()
  })
}))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: () => false }))

/** A fresh gate, shut, and a tab manager over it: the gate's state lasts as long as its module. */
async function setup () {
  vi.resetModules()
  const gate = await import('../../startup/web-ready.js')
  const { TabManager } = await import('../tabs.js')
  const contentView = { children: [] as unknown[], addChildView: vi.fn(), removeChildView: vi.fn() }
  const manager = new TabManager(contentView as never, () => ({ x: 0, y: 100, width: 1000, height: 600 }), vi.fn(), 'http://localhost:5999/newtab/', {} as SubsystemContext, { window: { isDestroyed: () => false } as never } as never)
  const openInSplit = (id: string, url: string): void => { (manager as unknown as { viewHost: { openInSplit: (id: string, url: string) => void } }).viewHost.openInSplit(id, url) }
  return { gate, manager, openInSplit }
}

describe('a tab opened in a split before web pages may load', () => {
  it('splits nothing meanwhile, and opens the tab beside the one asked once the gate opens', async () => {
    const { gate, manager, openInSplit } = await setup()
    const a = manager.createTab()
    expect(manager.getState().tabs).toHaveLength(1)

    openInSplit(a, 'https://more.example/')
    expect(manager.getState().tabs).toHaveLength(1)
    expect(manager.getState().tabs[0]?.splitWith).toBeNull()

    gate.openWebContent()
    await vi.waitFor(() => { expect(manager.getState().tabs).toHaveLength(2) })
    const [first, second] = manager.getState().tabs
    expect(first?.id).toBe(a)
    expect(first?.splitWith).toBe(second?.id)
  })

  it('does nothing once the gate opens when the tab it was to split with is gone', async () => {
    const { gate, manager, openInSplit } = await setup()
    const a = manager.createTab()
    manager.createTab()
    openInSplit(a, 'https://more.example/')
    manager.closeTab(a)

    gate.openWebContent()
    await gate.webContentReady()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(manager.getState().tabs).toHaveLength(1)
  })
})
