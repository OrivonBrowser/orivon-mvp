import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellBridge } from '../extension-host-impl.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

vi.mock('electron', () => ({ session: { defaultSession: { extensions: { getExtension: vi.fn((id: string) => id === 'abcdefghijklmnopabcdefghijklmnop' ? {} : null) } } } }))
vi.mock('../../shell/window.js', () => ({ createShellWindow: vi.fn() }))

const { buildHostImpl } = await import('../extension-host-impl.js')
const { isExtensionOpened } = await import('../extension-opened-pages.js')

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
    const win = { id: 1 }
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

describe('buildHostImpl: side panel pages', () => {
  function panelPage (url: string): WebContents {
    return { id: 9, once: vi.fn(), isDestroyed: () => false, getURL: () => url } as unknown as WebContents
  }

  it('names the window a side panel page belongs to', async () => {
    const { registerSidePanelPage } = await import('../side-panel-pages.js')
    const page = panelPage(`chrome-extension://${'f'.repeat(32)}/panel.html`)
    const win = { id: 4 }
    registerSidePanelPage(page, win as never)
    const host = buildHostImpl(() => ({ services: { windows: { all: () => [] } } }) as unknown as ShellBridge)
    expect(host.windowOf?.(page)).toBe(win)
  })

  it('lists the extension\'s side panel pages as SIDE_PANEL contexts, and no other extension\'s', async () => {
    const { registerSidePanelPage } = await import('../side-panel-pages.js')
    const mine = panelPage(`chrome-extension://${ID}/panel.html`)
    const other = panelPage('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/panel.html')
    registerSidePanelPage(mine, { id: 6 } as never)
    registerSidePanelPage(other, { id: 7 } as never)
    const host = buildHostImpl(() => undefined)
    expect(host.extensionContexts?.(ID)).toEqual([{ contextType: 'SIDE_PANEL', contents: mine, windowId: 6 }])
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
