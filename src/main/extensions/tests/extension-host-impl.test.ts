import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellBridge } from '../extension-host-impl.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 }
const DISPLAY = { id: 1, bounds: SCREEN, workArea: SCREEN }
vi.mock('electron', () => ({ screen: { getPrimaryDisplay: () => DISPLAY, getAllDisplays: () => [DISPLAY] }, session: { defaultSession: { extensions: { getExtension: vi.fn((id: string) => id === 'abcdefghijklmnopabcdefghijklmnop' ? {} : null) } } } }))
vi.mock('../../shell/window.js', () => ({ createShellWindow: vi.fn() }))
vi.mock('../../shell/window-frame.js', () => ({ MIN_WINDOW_WIDTH: 500, MIN_WINDOW_HEIGHT: 400, defaultWindowSize: () => ({ width: 1280, height: 800 }) }))

const { buildHostImpl, extensionJustActivatedTab, EXTENSION_FOCUS_HANDOVER_MS } = await import('../extension-host-impl.js')
const { isExtensionOpened } = await import('../extension-opened-pages.js')
const { createShellWindow } = await import('../../shell/window.js')

function bridgeWith (record: Record<string, unknown>): ShellBridge {
  const tabs = { faviconFor: () => null, record: () => record }
  return { services: { windows: { findTab: () => ({ window: { tabs }, tabId: 't1' }) } } } as unknown as ShellBridge
}

describe('buildHostImpl: assignTabDetails', () => {
  it('reports a sleeping tab as discarded, with the address and title it will wake to', () => {
    const host = buildHostImpl(() => bridgeWith({ pinned: false, sleeping: { url: 'https://a.example/', title: 'A', favicon: null } }))
    const details = { pinned: false, url: 'about:blank', title: '' }
    host.assignTabDetails?.(details as never, {} as WebContents)
    expect(details).toMatchObject({ discarded: true, url: 'https://a.example/', title: 'A' })
  })

  it('leaves an awake tab as the library built it', () => {
    const host = buildHostImpl(() => bridgeWith({ pinned: true }))
    const details: Record<string, unknown> = { pinned: false, url: 'https://b.example/', title: 'B' }
    host.assignTabDetails?.(details as never, {} as WebContents)
    expect(details).toEqual({ pinned: true, url: 'https://b.example/', title: 'B' })
  })
})

describe('buildHostImpl: pages the extension opens count as its own', () => {
  const pageWith = (): WebContents => ({ on: vi.fn(), loadURL: vi.fn(async () => undefined) }) as unknown as WebContents

  it('marks a tab chrome.tabs.create opens on an extension page, and not one it opens on the web', async () => {
    const extensionTab = pageWith()
    const webTab = pageWith()
    const openTrusted = vi.fn((target?: string): [string, WebContents] => ['t', target?.startsWith('https:') === true ? webTab : extensionTab])
    const win = { id: 1, isDestroyed: () => false, isFocused: () => true }
    const bridge = { services: { windows: { focused: () => ({ window: win }), all: () => [{ window: win, tabs: { openTrusted } }] } } } as unknown as ShellBridge
    const host = buildHostImpl(() => bridge)

    await host.createTab?.({ url: `chrome-extension://${ID}/welcome.html` } as never)
    await host.createTab?.({ url: 'https://example.com/' } as never)

    expect(isExtensionOpened(extensionTab, ID)).toBe(true)
    expect(webTab.on).not.toHaveBeenCalled()
  })

  it('marks a tab chrome.tabs.update sends to an extension page', async () => {
    const tab = pageWith()
    const host = buildHostImpl(() => undefined)

    await host.navigateTab?.(tab, `chrome-extension://${ID}/options.html`)

    expect(isExtensionOpened(tab, ID)).toBe(true)
    expect(tab.loadURL).toHaveBeenCalledWith(`chrome-extension://${ID}/options.html`)
  })
})

describe('buildHostImpl: windowOf', () => {
  it('names the window whose chrome view is the page asked about', () => {
    const chromeA = {}
    const chromeB = {}
    const winA = { id: 1 }
    const winB = { id: 2 }
    const bridge = { services: { windows: { all: () => [{ window: winA, chrome: { webContents: chromeA } }, { window: winB, chrome: { webContents: chromeB } }] } } } as unknown as ShellBridge
    const host = buildHostImpl(() => bridge)
    expect(host.windowOf?.(chromeB as WebContents)).toBe(winB)
    expect(host.windowOf?.({} as WebContents)).toBeUndefined()
  })
})

describe('extensionJustActivatedTab', () => {
  const popupOf = (extensionId: string, parent: object): { extensionId: string, parent: never } => ({ extensionId, parent: parent as never })

  async function activateAs (extensionId: string | undefined, win: object): Promise<void> {
    const tabs = { openTrusted: () => ['t', { on: vi.fn(), loadURL: vi.fn(async () => undefined) }] }
    const bridge = { services: { windows: { focused: () => ({ window: win }), all: () => [{ window: win, tabs }] } } } as unknown as ShellBridge
    await buildHostImpl(() => bridge, () => extensionId).createTab?.({ url: `chrome-extension://${ID}/welcome.html` } as never)
  }

  it('holds for the focus handover after chrome.tabs.create, and not past it', async () => {
    const win = { id: 1, isDestroyed: () => false, isFocused: () => true }
    await activateAs('ext-a', win)
    const now = Date.now()
    expect(extensionJustActivatedTab(popupOf('ext-a', win), now)).toBe(true)
    expect(extensionJustActivatedTab(popupOf('ext-a', win), now + EXTENSION_FOCUS_HANDOVER_MS + 50)).toBe(false)
  })

  it('does not hold for a popup whose extension is not the one that activated the tab', async () => {
    const win = { id: 1, isDestroyed: () => false, isFocused: () => true }
    await activateAs('ext-b', win)
    expect(extensionJustActivatedTab(popupOf('ext-a', win))).toBe(false)
  })

  it('does not hold for a popup in another window than the one the tab was activated in', async () => {
    await activateAs('ext-a', { id: 1, isDestroyed: () => false, isFocused: () => true })
    expect(extensionJustActivatedTab(popupOf('ext-a', { id: 2 }))).toBe(false)
  })

  it('does not hold when the library did not say who asked', async () => {
    const win = { id: 1, isDestroyed: () => false, isFocused: () => true }
    await activateAs(undefined, win)
    expect(extensionJustActivatedTab(popupOf('ext-a', win))).toBe(false)
  })
})

describe('buildHostImpl: side panel pages', () => {
  function panelPage (url: string): WebContents {
    return { id: 9, once: vi.fn(), isDestroyed: () => false, getURL: () => url } as unknown as WebContents
  }

  it('names the window a side panel page belongs to', async () => {
    const { registerSidePanelPage } = await import('../side-panel-pages.js')
    const page = panelPage(`chrome-extension://${'f'.repeat(32)}/panel.html`)
    const win = { id: 4, isDestroyed: () => false }
    registerSidePanelPage(page, win as never)
    const host = buildHostImpl(() => ({ services: { windows: { all: () => [] } } }) as unknown as ShellBridge)
    expect(host.windowOf?.(page)).toBe(win)
  })

  it('lists the extension\'s side panel pages as SIDE_PANEL contexts, and no other extension\'s', async () => {
    const { registerSidePanelPage } = await import('../side-panel-pages.js')
    const mine = panelPage(`chrome-extension://${ID}/panel.html`)
    const other = panelPage('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/panel.html')
    registerSidePanelPage(mine, { id: 6, isDestroyed: () => false } as never)
    registerSidePanelPage(other, { id: 7, isDestroyed: () => false } as never)
    const host = buildHostImpl(() => undefined)
    expect(host.extensionContexts?.(ID)).toEqual([{ contextType: 'SIDE_PANEL', contents: mine, windowId: 6 }])
  })

  it('leaves out a side panel page whose window is gone, instead of throwing', async () => {
    const { registerSidePanelPage } = await import('../side-panel-pages.js')
    const orphan = panelPage(`chrome-extension://${ID}/orphan.html`)
    registerSidePanelPage(orphan, { get id (): number { throw new Error('Object has been destroyed') }, isDestroyed: () => true } as never)
    const host = buildHostImpl(() => undefined)
    expect(host.extensionContexts?.(ID)?.some((context) => context.contents === orphan)).toBe(false)
  })

  it('counts a click on one of the extension\'s context-menu items as input on it', async () => {
    const { sidePanelGestures } = await import('../side-panel-gesture.js')
    sidePanelGestures.clear(ID)
    const host = buildHostImpl(() => undefined)
    expect(sidePanelGestures.available(ID)).toBe(false)
    host.menuItemClicked?.(ID, {} as WebContents)
    expect(sidePanelGestures.available(ID)).toBe(true)
    sidePanelGestures.clear(ID)
  })
})

describe('buildHostImpl: windows an extension opens and changes', () => {
  const bridge = { ctx: {}, services: {} } as unknown as ShellBridge

  /** The window `createWindow` makes for `details`, handed the way createShellWindow hands it to `created`. */
  async function create (details: Record<string, unknown>) {
    const win = { id: 11, isDestroyed: () => false }
    vi.mocked(createShellWindow).mockImplementationOnce(((_ctx: unknown, _services: unknown, options: { created?: (w: unknown) => void }) => {
      options.created?.(win)
      return win
    }) as never)
    const host = buildHostImpl(() => bridge)
    await host.createWindow?.(details as never)
    return { host, win, options: vi.mocked(createShellWindow).mock.calls.at(-1)?.[2] as { place?: object, inactive?: boolean } }
  }

  it('reports a window created as a popup as one before its first tab exists, and any other as normal', async () => {
    const popup = await create({ type: 'popup', width: 400, height: 620, left: 100, top: 50 })
    expect(popup.host.windowType?.(popup.win as never)).toBe('popup')
    const plain = await create({})
    expect(plain.host.windowType?.(plain.win as never)).toBe('normal')
    expect(plain.host.windowType?.({} as never)).toBe('normal')
  })

  it('opens at the size and place asked, held inside the display and above the smallest window', async () => {
    expect((await create({ type: 'popup', width: 400, height: 620, left: 100, top: 50 })).options.place).toEqual({ x: 100, y: 50, width: 500, height: 620 })
    expect((await create({ width: 9999, height: 9999, left: 5000, top: 5000 })).options.place).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('reports the deprecated panel type as a popup', async () => {
    const panel = await create({ type: 'panel' })
    expect(panel.host.windowType?.(panel.win as never)).toBe('popup')
  })

  it('holds a corner inside the display using the size the window will get', async () => {
    expect((await create({ left: 1800, top: 900 })).options.place).toEqual({ x: 640, y: 280, width: 1280, height: 800 })
  })

  it('opens a tab in the last focused ordinary window, not in an extension popup', async () => {
    const popup = await create({ type: 'popup' })
    Object.assign(popup.win, { isFocused: () => true })
    const ordinary = { id: 1, isDestroyed: () => false, isFocused: () => false }
    const openTrusted = vi.fn((): [string, WebContents] => ['t', { on: vi.fn(), loadURL: vi.fn(async () => undefined) } as unknown as WebContents])
    const entries = [{ window: ordinary, tabs: { openTrusted } }, { window: popup.win, tabs: { openTrusted: vi.fn() } }]
    const bridge2 = { services: { windows: { all: () => entries, focused: () => entries[1] } } } as unknown as ShellBridge
    const opened = await buildHostImpl(() => bridge2).createTab?.({ url: `chrome-extension://${ID}/welcome.html` } as never)
    expect(opened?.[1]).toBe(ordinary)
    expect(openTrusted).toHaveBeenCalled()
  })

  it('opens behind the others for focused: false, and in front otherwise', async () => {
    expect((await create({ focused: false })).options.inactive).toBe(true)
    expect((await create({})).options.inactive).toBeUndefined()
  })

  describe('windows.update', () => {
    function win (over: Record<string, unknown> = {}) {
      const bounds = { x: 200, y: 100, width: 700, height: 800 }
      return {
        isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false, isMinimized: () => false,
        getBounds: () => ({ ...bounds }), setBounds: vi.fn(), show: vi.fn(), focus: vi.fn(), restore: vi.fn(), flashFrame: vi.fn(), setFullScreen: vi.fn(), ...over
      }
    }
    const host = buildHostImpl(() => undefined)

    it('moves and resizes inside the display, and leaves the rest of the bounds', () => {
      const w = win()
      host.updateWindow?.(w as never, { left: 5000, width: 300 })
      expect(w.setBounds).toHaveBeenCalledWith({ x: 1420, y: 100, width: 500, height: 800 })
    })

    it('leaves the bounds alone when the call names none, whatever the window spans', () => {
      const tall = win({ getBounds: () => ({ x: -200, y: 0, width: 2400, height: 1400 }) })
      host.updateWindow?.(tall as never, { focused: true, drawAttention: true })
      expect(tall.setBounds).not.toHaveBeenCalled()
    })

    it('restores a maximized, fullscreen or minimized window before it applies bounds', () => {
      const big = win({ isMaximized: () => true })
      host.updateWindow?.(big as never, { left: 0 })
      expect(big.restore).toHaveBeenCalled()
      expect(big.setBounds).toHaveBeenCalledWith({ x: 0, y: 100, width: 700, height: 800 })
      const full = win({ isFullScreen: () => true })
      host.updateWindow?.(full as never, { top: 0 })
      expect(full.setFullScreen).toHaveBeenCalledWith(false)
      expect(full.setBounds).toHaveBeenCalled()
    })

    it('shows and focuses for focused: true, and does nothing about focus otherwise', () => {
      const w = win({ isMinimized: () => true })
      host.updateWindow?.(w as never, { focused: true })
      expect(w.restore).toHaveBeenCalled()
      expect(w.show).toHaveBeenCalled()
      expect(w.focus).toHaveBeenCalled()
      const other = win()
      host.updateWindow?.(other as never, { focused: false })
      expect(other.focus).not.toHaveBeenCalled()
    })

    it('flashes the frame for drawAttention', () => {
      const w = win()
      host.updateWindow?.(w as never, { drawAttention: true })
      expect(w.flashFrame).toHaveBeenCalledWith(true)
    })

    it('ignores a window that is gone', () => {
      const w = win({ isDestroyed: () => true })
      host.updateWindow?.(w as never, { focused: true, left: 3 })
      expect(w.show).not.toHaveBeenCalled()
    })
  })
})
