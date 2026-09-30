import { describe, expect, it, vi } from 'vitest'
import { STATE_CHANNEL } from '../../channels.js'
import { createWindowState } from '../window-state.js'
import type { TabsSnapshot } from '../tab-types.js'

interface FakeTab { id: string, url: string, favicon: string | null }

function setup (): {
  push: (tabs: FakeTab[], active: string | null) => void
  send: ReturnType<typeof vi.fn>
  closePanels: ReturnType<typeof vi.fn>
  closeSiteInfo: ReturnType<typeof vi.fn>
  fillMissingFavicon: ReturnType<typeof vi.fn>
  tabsChanged: ReturnType<typeof vi.fn>
  stop: () => void
  unsubscribed: ReturnType<typeof vi.fn>
} {
  let snapshot: TabsSnapshot = { tabs: [], activeTabId: null }
  let notify: () => void = () => {}
  const unsubscribed = vi.fn()
  const send = vi.fn()
  const closePanels = vi.fn()
  const closeSiteInfo = vi.fn()
  const fillMissingFavicon = vi.fn()
  const tabsChanged = vi.fn()
  const tabs = { getState: () => snapshot, onStateChange: (cb: () => void) => { notify = cb }, layout: vi.fn() }
  const subscribe = () => unsubscribed
  const services = {
    bookmarks: { fillMissingFavicon, getAll: () => [], onChange: subscribe, load: async () => {} },
    zoom: { onChange: subscribe, percentFor: () => 100, defaultPercent: () => 100 },
    profiles: { onChange: subscribe, look: () => ({ name: 'p', color: '#000', isPrivate: false, shown: false }) },
    settings: { onChange: subscribe }
  }
  const state = createWindowState({
    win: { isDestroyed: () => false } as never,
    chrome: { webContents: { isDestroyed: () => false, send } } as never,
    tabs: tabs as never,
    services: services as never,
    context: { window: {}, services } as never,
    fullscreen: { tabsChanged } as never,
    layout: { chromeHeight: () => 76, layoutChrome: vi.fn(), tabBounds: () => ({ x: 0, y: 76, width: 1, height: 1 }) },
    bookmarksBarShown: () => false,
    closePanels,
    closeSiteInfo
  })
  return {
    push: (list, active) => { snapshot = { tabs: list as never, activeTabId: active }; notify() },
    send, closePanels, closeSiteInfo, fillMissingFavicon, tabsChanged, stop: state.stop, unsubscribed
  }
}

const tab = (id: string, url: string, favicon: string | null = null): FakeTab => ({ id, url, favicon })

describe('createWindowState', () => {
  it('sends the tabs with the bookmarks, the bar, the zoom chip and the profile look', () => {
    const { push, send } = setup()

    push([tab('a', 'https://a.example/')], 'a')

    expect(send).toHaveBeenCalledWith(STATE_CHANNEL, expect.objectContaining({
      activeTabId: 'a', bookmarks: [], bookmarksBar: false, zoomPercent: null, profile: expect.objectContaining({ name: 'p' })
    }))
  })

  it('dismisses the toolbar popovers when the active tab changes, and only then', () => {
    const { push, closePanels } = setup()

    push([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], 'a')
    closePanels.mockClear()
    push([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], 'a')
    expect(closePanels).not.toHaveBeenCalled()

    push([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], 'b')
    expect(closePanels).toHaveBeenCalledTimes(1)
  })

  it('closes the site-info popover when the same tab moves to another origin, not for a path or fragment', () => {
    const { push, closeSiteInfo } = setup()
    push([tab('a', 'https://a.example/one')], 'a')
    closeSiteInfo.mockClear()

    push([tab('a', 'https://a.example/two#part')], 'a')
    expect(closeSiteInfo).not.toHaveBeenCalled()

    push([tab('a', 'https://b.example/')], 'a')
    expect(closeSiteInfo).toHaveBeenCalledTimes(1)
  })

  it('hands a late favicon to the bookmark for that page, and tells the fullscreen state which tabs exist', () => {
    const { push, fillMissingFavicon, tabsChanged } = setup()

    push([tab('a', 'https://a.example/', 'data:icon')], 'a')

    expect(fillMissingFavicon).toHaveBeenCalledWith('https://a.example/', 'data:icon')
    expect(tabsChanged).toHaveBeenCalledWith('a', expect.any(Function))
  })

  it('ends every subscription it made when stopped', () => {
    const { stop, unsubscribed } = setup()

    stop()

    expect(unsubscribed).toHaveBeenCalledTimes(4)
  })
})
