import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const { WebNavigationAPI } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/web-navigation.js'
)

// A tab handed to another window is announced as added again, and must not collect a second set of listeners:
// each set would send every webNavigation event to the extensions once more.
describe('webNavigation watches a tab once however often its tab is added', () => {
  it('attaches one set of listeners across a move to another window and back', () => {
    const store = new EventEmitter()
    new WebNavigationAPI({ router: { apiHandler: () => vi.fn() }, store } as never)
    const tab = new EventEmitter()

    store.emit('tab-added', tab)
    const once = ['did-start-navigation', 'did-frame-navigate', 'did-navigate-in-page', 'dom-ready', 'frame-created'].map((name) => tab.listenerCount(name))
    expect(once.every((count) => count === 1)).toBe(true)

    store.emit('tab-added', tab)
    store.emit('tab-added', tab)

    expect(['did-start-navigation', 'did-frame-navigate', 'did-navigate-in-page', 'dom-ready', 'frame-created'].map((name) => tab.listenerCount(name))).toEqual(once)
  })
})
