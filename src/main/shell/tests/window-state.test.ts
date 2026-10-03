import { describe, expect, it, vi } from 'vitest'
import { SHELL_EVENT_CHANNEL, STATE_CHANNEL } from '../../channels.js'
import { createWindowState } from '../window-state.js'
import type { TabsSnapshot } from '../tab-types.js'

interface FakeTab { id: string, url: string, displayUrl: string, favicon: string | null }

function setup (): {
  push: (tabs: FakeTab[], active: string | null) => void
  send: ReturnType<typeof vi.fn>
  overlays: { tabSwitched: ReturnType<typeof vi.fn>, navigated: ReturnType<typeof vi.fn>, restack: ReturnType<typeof vi.fn>, relayout: ReturnType<typeof vi.fn> }
  changeBookmarks: (height: number) => void
  tabLayout: ReturnType<typeof vi.fn>
  closeSiteInfo: ReturnType<typeof vi.fn>
  fillMissingFavicon: ReturnType<typeof vi.fn>
  barItems: (items: unknown[]) => void
  setFavicon: ReturnType<typeof vi.fn>
  tabsChanged: ReturnType<typeof vi.fn>
  stop: () => void
  unsubscribed: ReturnType<typeof vi.fn>
} {
  let snapshot: TabsSnapshot = { tabs: [], activeTabId: null }
  let notify: () => void = () => {}
  const unsubscribed = vi.fn()
  const send = vi.fn()
  const overlays = { tabSwitched: vi.fn(), navigated: vi.fn(), restack: vi.fn(), relayout: vi.fn() }
  const closeSiteInfo = vi.fn()
  const fillMissingFavicon = vi.fn()
  let bar: unknown[] = []
  const setFavicon = vi.fn()
  const tabsChanged = vi.fn()
  const tabLayout = vi.fn()
  const tabs = { getState: () => snapshot, onStateChange: (cb: () => void) => { notify = cb }, layout: tabLayout }
  const subscribe = () => unsubscribed
  let chromeHeight = 76
  let bookmarksChanged: () => void = () => {}
  const services = {
    bookmarks: { fillMissingFavicon, has: () => false, children: () => bar, onChange: (cb: () => void) => { bookmarksChanged = cb; return unsubscribed }, load: async () => {} },
    history: { setFavicon },
    zoom: { onChange: subscribe, percentFor: () => 100, defaultPercent: () => 100 },
    profiles: { onChange: subscribe, look: () => ({ name: 'p', color: '#000', isPrivate: false, shown: false }) },
    settings: { onChange: subscribe }
  }
  const state = createWindowState({
    win: { isDestroyed: () => false } as never,
    chrome: { webContents: { isDestroyed: () => false, send } } as never,
    tabs: tabs as never,
    services: services as never,
    context: { window: { chrome: { webContents: { isDestroyed: () => false, send } } }, services } as never,
    fullscreen: { tabsChanged } as never,
    layout: { chromeHeight: () => chromeHeight, layoutChrome: vi.fn(), tabBounds: () => ({ x: 0, y: 76, width: 1, height: 1 }) },
    bookmarksBarShown: () => false,
    overlays: overlays as never,
    closeSiteInfo
  })
  return {
    push: (list, active) => { snapshot = { tabs: list as never, activeTabId: active }; notify() },
    changeBookmarks: (height) => { chromeHeight = height; bookmarksChanged() },
    barItems: (items) => { bar = items }, tabLayout, send, overlays, closeSiteInfo, fillMissingFavicon, setFavicon, tabsChanged, stop: state.stop, unsubscribed
  }
}

const tab = (id: string, url: string, favicon: string | null = null): FakeTab => ({ id, url, displayUrl: url, favicon })

describe('createWindowState', () => {
  it('sends the tabs with whether the page is bookmarked, the bar, the zoom chip and the profile look', () => {
    const { push, send } = setup()

    push([tab('a', 'https://a.example/')], 'a')

    expect(send).toHaveBeenCalledWith(STATE_CHANNEL, expect.objectContaining({
      activeTabId: 'a', bookmarked: false, bookmarksBar: false, zoomPercent: null, profile: expect.objectContaining({ name: 'p' })
    }))
  })

  it('tells the overlays when the active tab changes, and only then', () => {
    const { push, overlays } = setup()

    push([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], 'a')
    overlays.tabSwitched.mockClear()
    push([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], 'a')
    expect(overlays.tabSwitched).not.toHaveBeenCalled()

    push([tab('a', 'https://a.example/'), tab('b', 'https://b.example/')], 'b')
    expect(overlays.tabSwitched).toHaveBeenCalledTimes(1)
    expect(overlays.navigated).not.toHaveBeenCalled()
  })

  it('tells the overlays about a same-tab navigation, not a fragment change, and restacks after every push', () => {
    const { push, overlays } = setup()
    push([tab('a', 'https://a.example/one')], 'a')
    overlays.navigated.mockClear()

    push([tab('a', 'https://a.example/one#part')], 'a')
    expect(overlays.navigated).not.toHaveBeenCalled()
    push([tab('a', 'https://a.example/two')], 'a')
    expect(overlays.navigated).toHaveBeenCalledTimes(1)
    expect(overlays.restack).toHaveBeenCalledTimes(3)
  })

  it('repositions the overlays when the bookmarks bar changes the chrome height, and only then', () => {
    const { changeBookmarks, overlays, tabLayout } = setup()

    changeBookmarks(76)
    expect(overlays.relayout).not.toHaveBeenCalled()

    changeBookmarks(104)
    expect(tabLayout).toHaveBeenCalledTimes(1)
    expect(overlays.relayout).toHaveBeenCalledTimes(1)

    changeBookmarks(104)
    expect(overlays.relayout).toHaveBeenCalledTimes(1)
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

  it('sends the bar\'s items to the chrome when the bookmarks change, and not with every state push', () => {
    const { push, changeBookmarks, barItems, send } = setup()
    const items = [{ id: 'x', kind: 'folder', title: 'F' }]
    const barEvents = (): unknown[] => send.mock.calls.filter(([channel]) => channel === SHELL_EVENT_CHANNEL).map(([, event]) => event)

    push([tab('a', 'https://a.example/')], 'a')
    expect(barEvents()).toEqual([])

    barItems(items)
    changeBookmarks(76)
    expect(barEvents()).toEqual([{ type: 'module', module: 'bookmarks-bar', payload: items }])
  })

  it('sends the items again when a late favicon was filled into a saved page', () => {
    const { push, fillMissingFavicon, send } = setup()
    fillMissingFavicon.mockReturnValue(true)

    push([tab('a', 'https://a.example/', 'data:icon')], 'a')

    expect(send.mock.calls.filter(([channel]) => channel === SHELL_EVENT_CHANNEL)).toHaveLength(1)
  })

  it('keeps a tab\'s icon under the host of a page history could hold, and no other', () => {
    const { push, setFavicon } = setup()

    push([tab('a', 'https://A.example:8080/x', 'data:icon'), tab('b', 'orivon://settings/', 'data:other'), tab('c', 'https://c.example/')], 'a')

    expect(setFavicon).toHaveBeenCalledExactlyOnceWith('a.example:8080', 'data:icon')
  })

  it('does no icon work for a push that leaves a tab\'s icon as it was', () => {
    const { push, fillMissingFavicon, setFavicon } = setup()
    const tabs = [tab('a', 'https://a.example/', 'data:icon'), tab('b', 'https://b.example/', 'data:other')]

    for (let n = 0; n < 20; n += 1) push(tabs, 'a')

    expect(fillMissingFavicon).toHaveBeenCalledTimes(2)
    expect(setFavicon).toHaveBeenCalledTimes(2)
  })

  it('offers the icon of a tab that changed it, or that moved to another page', () => {
    const { push, fillMissingFavicon, setFavicon } = setup()
    push([tab('a', 'https://a.example/', 'data:icon')], 'a')

    push([tab('a', 'https://a.example/', 'data:new')], 'a')
    expect(setFavicon).toHaveBeenLastCalledWith('a.example', 'data:new')

    push([tab('a', 'https://a.example/other', 'data:new')], 'a')
    expect(fillMissingFavicon).toHaveBeenLastCalledWith('https://a.example/other', 'data:new')
    expect(fillMissingFavicon).toHaveBeenCalledTimes(3)
  })

  it('offers an icon again to the bookmarks once they change, without telling the history', () => {
    const { push, changeBookmarks, fillMissingFavicon, setFavicon } = setup()
    push([tab('a', 'https://a.example/', 'data:icon')], 'a')
    fillMissingFavicon.mockClear()
    setFavicon.mockClear()

    changeBookmarks(76)
    expect(fillMissingFavicon).toHaveBeenCalledExactlyOnceWith('https://a.example/', 'data:icon')
    expect(setFavicon).not.toHaveBeenCalled()

    push([tab('a', 'https://a.example/', 'data:icon')], 'a')
    expect(fillMissingFavicon).toHaveBeenCalledTimes(1)
  })

  it('forgets a closed tab, so its id shown again is offered afresh', () => {
    const { push, setFavicon } = setup()
    push([tab('a', 'https://a.example/', 'data:icon')], 'a')
    push([tab('b', 'https://b.example/')], 'b')
    setFavicon.mockClear()

    push([tab('a', 'https://a.example/', 'data:icon'), tab('b', 'https://b.example/')], 'a')

    expect(setFavicon).toHaveBeenCalledExactlyOnceWith('a.example', 'data:icon')
  })

  it('ends every subscription it made when stopped', () => {
    const { stop, unsubscribed } = setup()

    stop()

    // The bookmarks, zoom, profile and settings listeners, and the settings listeners of the address bar and home state parts.
    expect(unsubscribed).toHaveBeenCalledTimes(6)
  })
})
