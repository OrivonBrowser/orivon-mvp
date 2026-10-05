import { describe, expect, it, vi } from 'vitest'
import { createPanelDriver } from '../side-panel-driver.js'
import type { PanelEventInfo, PanelEventName, PanelHostLike, PanelPage, PanelPageEvents } from '../side-panel-driver.js'
import { createSidePanelOptions } from '../side-panel-options.js'
import type { PanelGuest } from '../../side-panel/side-panel-host.js'
import type { ShellWindow } from '../../shell/window-registry.js'

const EXT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

interface FakePage extends PanelPage { url: string, events: PanelPageEvents, navigated: Array<{ url: string, keepFocus: boolean }>, destroyCalls: number, finish: () => void }

/** A panel that behaves as the real one does for a guest: it releases on null, refuses an entry that is not the one showing, and announces a choice. */
function fakeHost (onChoose: (id: string) => void) {
  const state = { open: false, view: 'bookmarks', canShow: true, focused: false, guest: null as PanelGuest | null }
  const release = (): void => {
    const { guest } = state
    if (guest === null) return
    state.guest = null
    if (state.view === guest.id) state.view = 'bookmarks'
    guest.closed?.()
  }
  const host: PanelHostLike = {
    canShow: () => state.canShow,
    isOpen: () => state.open && state.canShow,
    view: () => state.view,
    open: vi.fn((id?: string) => {
      state.open = true
      if (id !== undefined && id !== state.view) { release(); state.view = id; onChoose(id) }
    }),
    close: vi.fn(() => { state.open = false; release(); state.view = state.view.startsWith('ext:') ? 'bookmarks' : state.view }),
    toggle: vi.fn((id?: string) => {
      if (state.open && id === state.view) host.close()
      else host.open(id)
    }),
    setGuest: vi.fn((guest: PanelGuest | null) => {
      if (guest === null) { release(); if (state.view.startsWith('ext:')) state.view = 'bookmarks'; return }
      if (guest.id !== state.view || !state.open) { guest.closed?.(); return }
      release()
      state.guest = guest
    }),
    focusIn: vi.fn(() => { state.focused = true }),
    focusPage: vi.fn(),
    holdsFocus: () => state.focused
  }
  return { host, state }
}

function setup (opts: { manifest?: unknown, reloading?: boolean } = {}) {
  const options = createSidePanelOptions({
    manifestOf: () => opts.manifest ?? { side_panel: { default_path: 'panel.html' } },
    holds: () => true
  })
  const win = { window: { id: 5 } } as unknown as ShellWindow
  const pages: FakePage[] = []
  const fired: Array<{ id: string, name: PanelEventName, info: PanelEventInfo }> = []
  const published: unknown[] = []
  let front: number | undefined = 1
  let driver!: ReturnType<typeof createPanelDriver>
  const { host, state } = fakeHost((id) => { driver.chosen(win, id) })
  driver = createPanelDriver({
    options,
    windows: () => [win],
    hostOf: () => host,
    frontTab: () => front,
    candidates: () => [EXT, OTHER],
    facts: (id) => ({ title: id === EXT ? 'Notes' : 'Other' }),
    publish: (entries) => { published.push(entries) },
    createPage: (_id, _window, url, events) => {
      let finish!: () => void
      let destroyedNow!: () => void
      const ready = new Promise<void>((resolve) => { finish = resolve })
      const destroyed = new Promise<void>((resolve) => { destroyedNow = resolve })
      let alive = true
      const page: FakePage = {
        view: {} as never, url, events, navigated: [], destroyCalls: 0, finish,
        ready, destroyed, alive: () => alive,
        navigate: (to, keepFocus) => { page.navigated.push({ url: to, keepFocus }) },
        destroy: () => { page.destroyCalls += 1; alive = false; destroyedNow() }
      }
      pages.push(page)
      return page
    },
    fire: (id, name, info) => { fired.push({ id, name, info }) },
    reloading: () => opts.reloading === true
  })
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
  return {
    driver, options, host, state, win, pages, fired, published, settle,
    setFront: (tab: number | undefined) => { front = tab },
    /** Opens the panel on the extension and finishes its first load. */
    async openPanel (): Promise<FakePage> {
      host.open(`ext:${EXT}`)
      const page = pages.at(-1) as FakePage
      page.finish()
      await settle()
      return page
    }
  }
}

describe('what the picker lists', () => {
  it('lists an extension that has a panel, once, with its title', () => {
    const s = setup()
    s.driver.republish()
    s.driver.republish()
    expect(s.published).toEqual([[{ id: `ext:${EXT}`, title: 'Notes' }, { id: `ext:${OTHER}`, title: 'Other' }]])
  })

  it('lists an extension whose panel is only on the tab in front, and drops it when that tab goes', () => {
    const s = setup({ manifest: {} })
    s.driver.republish()
    expect(s.published).toEqual([])
    s.options.set(EXT, { tabId: 1, path: 'tab.html' })
    s.driver.optionsChanged(EXT)
    expect(s.published.at(-1)).toEqual([{ id: `ext:${EXT}`, title: 'Notes' }])
    s.driver.tabClosed(1)
    expect(s.published.at(-1)).toEqual([])
  })
})

describe('opening the panel', () => {
  it('shows the page once its first load ended, tells the extension, and takes the keyboard', async () => {
    const s = setup()
    s.driver.republish()
    s.host.open(`ext:${EXT}`)
    expect(s.pages).toHaveLength(1)
    expect(s.pages[0]?.url).toBe(`chrome-extension://${EXT}/panel.html`)
    expect(s.host.setGuest).not.toHaveBeenCalled()
    s.pages[0]?.finish()
    await s.settle()
    expect(s.host.setGuest).toHaveBeenCalledOnce()
    expect(s.fired).toEqual([{ id: EXT, name: 'onOpened', info: { windowId: 5, path: 'panel.html' } }])
    expect(s.host.focusIn).toHaveBeenCalledOnce()
  })

  it('answers a choice with nothing to show by clearing the guest slot', () => {
    const s = setup({ manifest: {} })
    s.driver.chosen(s.win, `ext:${EXT}`)
    expect(s.pages).toHaveLength(0)
    expect(s.host.setGuest).toHaveBeenCalledWith(null)
  })

  it('closes a page again, without announcing it, when the panel closed while it loaded', async () => {
    const s = setup()
    s.driver.republish()
    s.host.open(`ext:${EXT}`)
    s.host.close()
    s.pages[0]?.finish()
    await s.settle()
    expect(s.pages[0]?.destroyCalls).toBeGreaterThan(0)
    expect(s.fired).toEqual([])
  })

  it('reports the tab when the extension set a panel for that tab', async () => {
    const s = setup()
    s.options.set(EXT, { tabId: 1, path: 'tab.html' })
    s.driver.republish()
    await s.openPanel()
    expect(s.fired[0]?.info).toEqual({ windowId: 5, tabId: 1, path: 'tab.html' })
  })

  it('tells the extension when the panel closes, and destroys the page', async () => {
    const s = setup()
    s.driver.republish()
    const page = await s.openPanel()
    s.host.close()
    expect(s.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed'])
    expect(page.destroyCalls).toBeGreaterThan(0)
  })

  it('closes the panel when the page destroys itself, as a page closing itself closes a panel', async () => {
    const s = setup()
    s.driver.republish()
    const page = await s.openPanel()
    page.events.destroyed()
    expect(s.host.close).toHaveBeenCalled()
    expect(s.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed'])
  })

  it('releases the guest when the page\'s renderer dies', async () => {
    const s = setup()
    s.driver.republish()
    const page = await s.openPanel()
    page.events.gone()
    expect(s.host.setGuest).toHaveBeenLastCalledWith(null)
    expect(s.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed'])
  })
})

describe('the tab in front', () => {
  it('navigates the page when the new tab has another panel, keeping the keyboard where it was', async () => {
    const s = setup()
    s.options.set(EXT, { tabId: 2, path: 'two.html' })
    s.driver.republish()
    const page = await s.openPanel()
    s.state.focused = false
    s.setFront(2)
    s.driver.sync(s.win)
    expect(page.navigated).toEqual([{ url: `chrome-extension://${EXT}/two.html`, keepFocus: false }])
    s.setFront(2)
    s.driver.sync(s.win)
    expect(page.navigated).toHaveLength(1)
  })

  it('releases the guest on a tab with the panel disabled, and shows it again, quietly, when an enabled tab returns', async () => {
    const s = setup()
    s.options.set(EXT, { tabId: 2, enabled: false })
    s.driver.republish()
    await s.openPanel()
    vi.mocked(s.host.focusIn).mockClear()
    s.setFront(2)
    s.driver.sync(s.win)
    expect(s.host.setGuest).toHaveBeenLastCalledWith(null)
    expect(s.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed'])
    expect(s.host.isOpen()).toBe(true)

    s.setFront(1)
    s.driver.sync(s.win)
    expect(s.host.open).toHaveBeenLastCalledWith(`ext:${EXT}`)
    expect(s.pages).toHaveLength(2)
    s.pages[1]?.finish()
    await s.settle()
    expect(s.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed', 'onOpened'])
    expect(s.host.focusIn).not.toHaveBeenCalled()
  })

  it('does not bring the panel back after the person closed it or chose another view', async () => {
    for (const away of ['close', 'choose'] as const) {
      const s = setup()
      s.options.set(EXT, { tabId: 2, enabled: false })
      s.driver.republish()
      await s.openPanel()
      s.setFront(2)
      s.driver.sync(s.win)
      if (away === 'close') s.host.close()
      else s.state.view = 'history'
      s.setFront(1)
      s.driver.sync(s.win)
      expect(s.pages).toHaveLength(1)
    }
  })

  it('opens for a background tab when that tab comes forward, and not for a later one', async () => {
    const s = setup({ manifest: {} })
    s.options.set(EXT, { tabId: 2, path: 'two.html' })
    s.driver.republish()
    await s.driver.open({ extensionId: EXT, window: s.win, tabId: 2 })
    expect(s.host.open).not.toHaveBeenCalled()
    s.setFront(2)
    s.driver.sync(s.win)
    expect(s.host.open).toHaveBeenCalledWith(`ext:${EXT}`)

    const t = setup({ manifest: {} })
    t.options.set(EXT, { tabId: 2, path: 'two.html' })
    t.driver.republish()
    await t.driver.open({ extensionId: EXT, window: t.win, tabId: 2 })
    t.setFront(3)
    t.driver.sync(t.win)
    t.setFront(2)
    t.driver.sync(t.win)
    expect(t.host.open).not.toHaveBeenCalled()
  })
})

describe('open and close from the API', () => {
  it('rejects when the window cannot show a panel, so the extension keeps its popup', async () => {
    const s = setup()
    s.state.canShow = false
    await expect(s.driver.open({ extensionId: EXT, window: s.win, tabId: undefined })).rejects.toThrow(/cannot be shown/)
  })

  it('rejects when the extension has no panel for the tab', async () => {
    const s = setup({ manifest: {} })
    await expect(s.driver.open({ extensionId: EXT, window: s.win, tabId: undefined })).rejects.toThrow('No active side panel for windowId: 5.')
  })

  it('opens the extension\'s panel, and closes it when asked', async () => {
    const s = setup()
    await s.driver.open({ extensionId: EXT, window: s.win, tabId: undefined })
    expect(s.host.open).toHaveBeenCalledWith(`ext:${EXT}`)
    s.pages[0]?.finish()
    await s.settle()
    await s.driver.close({ extensionId: EXT, window: s.win, tabId: undefined })
    expect(s.host.close).toHaveBeenCalled()
    await s.driver.close({ extensionId: OTHER, window: s.win, tabId: undefined })
    expect(vi.mocked(s.host.close)).toHaveBeenCalledTimes(1)
  })
})

describe('the toolbar button and the extension\'s key', () => {
  it('leaves the click alone unless the extension asked for the panel', () => {
    const s = setup()
    expect(s.driver.actionClick(EXT, s.win, 1)).toBe(false)
    expect(s.host.toggle).not.toHaveBeenCalled()
  })

  it('leaves the click alone in a window with no room, and for a tab with no panel', () => {
    const s = setup()
    s.options.setOpenOnActionClick(EXT, true)
    s.state.canShow = false
    expect(s.driver.actionClick(EXT, s.win, 1)).toBe(false)
    s.state.canShow = true
    s.options.set(EXT, { tabId: 1, enabled: false })
    expect(s.driver.actionClick(EXT, s.win, 1)).toBe(false)
  })

  it('opens the panel on a click, and a second click closes it, both taken', async () => {
    const s = setup()
    s.options.setOpenOnActionClick(EXT, true)
    expect(s.driver.actionClick(EXT, s.win, 1)).toBe(true)
    s.pages[0]?.finish()
    await s.settle()
    expect(s.host.isOpen()).toBe(true)
    expect(s.driver.actionClick(EXT, s.win, 1)).toBe(true)
    expect(s.host.isOpen()).toBe(false)
    expect(s.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed'])
  })

  it('opens from the key whether or not the extension asked for the panel on a click, and passes the key on when there is no panel', () => {
    const s = setup()
    expect(s.driver.openFromKey(EXT, s.win, 1)).toBe(true)
    expect(s.host.open).toHaveBeenCalledWith(`ext:${EXT}`)
    s.options.set(EXT, { enabled: false })
    expect(s.driver.openFromKey(EXT, s.win, 1)).toBe(false)
  })
})

describe('an extension that goes away', () => {
  it('releases its panel at once when it is unloaded', async () => {
    const s = setup()
    s.driver.republish()
    const page = await s.openPanel()
    s.driver.extensionUnloaded(EXT)
    expect(s.host.isOpen()).toBe(true)
    expect(page.destroyCalls).toBeGreaterThan(0)
    expect(s.state.view).toBe('bookmarks')
  })

  it('keeps its panel through a reload Orivon makes', async () => {
    const s = setup({ reloading: true })
    s.driver.republish()
    const page = await s.openPanel()
    s.driver.extensionUnloaded(EXT)
    expect(page.destroyCalls).toBe(0)
    expect(s.state.view).toBe(`ext:${EXT}`)
  })

  it('closes every page of the extension and settles once they are gone', async () => {
    const s = setup()
    s.driver.republish()
    s.host.open(`ext:${EXT}`)
    const loading = s.pages[0] as FakePage
    await s.driver.closeAll(EXT)
    expect(loading.destroyCalls).toBeGreaterThan(0)

    const t = setup()
    t.driver.republish()
    const shown = await t.openPanel()
    await t.driver.closeAll(EXT)
    expect(shown.destroyCalls).toBeGreaterThan(0)
    expect(t.fired.map((entry) => entry.name)).toEqual(['onOpened', 'onClosed'])
  })
})
