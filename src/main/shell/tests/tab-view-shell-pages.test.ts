import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { SubsystemContext } from '../../registry.js'

// A real EventEmitter stands in for the webContents, so the handlers wireView attaches are the ones tested.
interface FakeView {
  webContents: EventEmitter & Record<string, unknown>
  setBackgroundColor: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
}
const createdViews: FakeView[] = []

function fakeWebContents (): FakeView['webContents'] {
  const emitter = new EventEmitter() as FakeView['webContents']
  emitter['loadURL'] = vi.fn(async () => {})
  emitter['isDestroyed'] = vi.fn(() => false)
  emitter['isLoading'] = vi.fn(() => false)
  emitter['getURL'] = vi.fn(() => '')
  emitter['getTitle'] = vi.fn(() => '')
  emitter['navigationHistory'] = { getActiveIndex: () => -1, length: () => 0, canGoBack: () => false, canGoForward: () => false }
  emitter['setWindowOpenHandler'] = vi.fn()
  emitter['ipc'] = { on: vi.fn() }
  emitter['close'] = vi.fn()
  return emitter
}

vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: false },
  WebContentsView: vi.fn().mockImplementation(function (this: FakeView) {
    this.webContents = fakeWebContents()
    this.setBackgroundColor = vi.fn()
    this.setVisible = vi.fn()
    this.setBounds = vi.fn()
    createdViews.push(this)
  })
}))
vi.mock('../../browsing/favicon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../browsing/favicon.js')>()
  return { ...actual, fetchFaviconDataUrlCached: vi.fn().mockResolvedValue(null) }
})

const { TabManager } = await import('../tabs.js')

const SHELL_PAGE = 'orivon-shell://renderer/newtab/index.html'
const DASHBOARD_URL = SHELL_PAGE

function newManager (): InstanceType<typeof TabManager> {
  const contentView = { children: [] as unknown[], addChildView: vi.fn(), removeChildView: vi.fn() }
  return new TabManager(contentView as never, () => ({ x: 0, y: 0, width: 800, height: 600 }), vi.fn(), DASHBOARD_URL, {} as SubsystemContext)
}

beforeEach(() => { createdViews.length = 0 })

describe('a dashboard tab that navigates to a page of its own opaque origin', () => {
  it('stops being the dashboard on about:blank and on a data: page, and resets the view colour', () => {
    const manager = newManager()
    const id = manager.createTab()
    const view = createdViews[0] as FakeView
    view.setBackgroundColor.mockClear()

    view.webContents.emit('did-navigate', {}, 'about:blank')

    expect(manager.record(id)?.isDashboardTab).toBe(false)
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#FFFFFF')

    const other = manager.createTab()
    ;(createdViews[1] as FakeView).webContents.emit('did-navigate', {}, 'data:text/html,x')
    expect(manager.record(other)?.isDashboardTab).toBe(false)
  })

  it('stays the dashboard when only its query or hash changes', () => {
    const manager = newManager()
    const id = manager.createTab()
    const view = createdViews[0] as FakeView

    view.webContents.emit('did-navigate', {}, `${DASHBOARD_URL}?q=1#top`)

    expect(manager.record(id)?.isDashboardTab).toBe(true)
  })
})

describe('a tab asked to go to the shell\'s own scheme', () => {
  const emit = (view: FakeView, name: string, url: string): ReturnType<typeof vi.fn> => {
    const preventDefault = vi.fn()
    view.webContents.emit(name, { url, preventDefault })
    return preventDefault
  }

  it('refuses a navigation and a redirect to it, and lets the web through', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const view = createdViews[0] as FakeView

    for (const name of ['will-frame-navigate', 'will-redirect']) {
      expect(emit(view, name, SHELL_PAGE), name).toHaveBeenCalled()
      expect(emit(view, name, 'orivon-shell://renderer/index.html?x=1'), name).toHaveBeenCalled()
      expect(emit(view, name, 'https://b.example/'), name).not.toHaveBeenCalled()
    }
  })
})
