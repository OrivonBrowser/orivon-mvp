import { describe, expect, it, vi } from 'vitest'
import type { TabManager } from '../../shell/tabs.js'
import type { BookmarkStore } from '../../browsing/bookmarks.js'
import type { SiteInfoController } from '../../permissions/site-info-controller.js'

// ipc.ts had no dedicated suite before queue item 4.4 (the tab/bookmark
// commands are exercised end-to-end by scripts/smoke.mjs instead) -- this
// file covers only the commands this lane and the site-info lane added on
// COMMAND_CHANNEL: the toolbar key's per-tab summary, and opening the
// all-sites and site-info popups. Listing every app and revoking live on
// the all-sites popup's OWN channel instead (settings-ipc.test.ts); the
// site-info popup's own get/apply/trust/data commands live on ITS own
// channel too (site-info-ipc.test.ts) -- see ShellCommand's own doc on why.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, command: unknown) => unknown) => {
      handlers.set(channel, fn)
    })
  }
}))

const { registerShellIpc } = await import('../ipc.js')
const { COMMAND_CHANNEL } = await import('../../channels.js')

const CHROME_FRAME = {}
const chromeWebContents = { mainFrame: CHROME_FRAME } as unknown as import('electron').WebContents
const OTHER_FRAME = {}

function fakeSiteInfo (overrides: Partial<SiteInfoController> = {}): SiteInfoController {
  return {
    siteSummaryFor: vi.fn(async () => ({ asked: false, warning: false })),
    siteInfoFor: vi.fn(async () => { throw new Error('not stubbed') }),
    siteTrustFor: vi.fn(async () => null),
    storageDeclarationFor: vi.fn(async () => null),
    turnOn: vi.fn(async () => 'not-registered' as const),
    turnOff: vi.fn(async () => {}),
    revokePickedPath: vi.fn(async () => {}),
    ...overrides
  }
}

function dispatch (command: unknown, senderFrame: unknown = CHROME_FRAME): unknown {
  const fn = handlers.get(COMMAND_CHANNEL)
  if (fn === undefined) throw new Error('registerShellIpc did not register a handler')
  return fn({ senderFrame }, command)
}

describe('registerShellIpc -- siteSummaryFor', () => {
  it('forwards the tab URL to siteInfo.siteSummaryFor()', async () => {
    const siteInfo = fakeSiteInfo({ siteSummaryFor: vi.fn(async () => ({ asked: true, warning: false })) })
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, siteInfo, vi.fn(), vi.fn())

    const result = await dispatch({ type: 'siteSummaryFor', url: 'https://app.example/page' })

    expect(siteInfo.siteSummaryFor).toHaveBeenCalledWith('https://app.example/page')
    expect(result).toEqual({ asked: true, warning: false })
  })

  it('refuses siteSummaryFor from a frame that is not the chrome view\'s own', async () => {
    const siteInfo = fakeSiteInfo()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, siteInfo, vi.fn(), vi.fn())

    await dispatch({ type: 'siteSummaryFor', url: 'https://app.example/page' }, OTHER_FRAME)

    expect(siteInfo.siteSummaryFor).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- openSettings', () => {
  it('toggles the all-sites popup, passing the tune icon\'s anchor and the tab url when given', async () => {
    const openSettings = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), openSettings, vi.fn())

    // The anchor is the chrome view's measurement of its own tune icon --
    // main has no way to derive it, so it always rides the command.
    const anchor = { x: 900, y: 44, width: 32, height: 32 }
    await dispatch({ type: 'openSettings', anchor })
    await dispatch({ type: 'openSettings', url: 'https://app.example/some/page', anchor })

    expect(openSettings).toHaveBeenNthCalledWith(1, anchor, undefined)
    expect(openSettings).toHaveBeenNthCalledWith(2, anchor, 'https://app.example/some/page')
  })

  it('refuses openSettings from a frame that is not the chrome view\'s own', async () => {
    const openSettings = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), openSettings, vi.fn())

    await dispatch({ type: 'openSettings', anchor: { x: 900, y: 44, width: 32, height: 32 } }, OTHER_FRAME)

    expect(openSettings).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- openSiteInfo', () => {
  it('toggles the site-info popup, passing the icon\'s anchor, the requested page and the tab url when given', async () => {
    const openSiteInfo = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), vi.fn(), openSiteInfo)

    const anchor = { x: 40, y: 44, width: 28, height: 28 }
    await dispatch({ type: 'openSiteInfo', anchor, page: 'web3' })
    await dispatch({ type: 'openSiteInfo', url: 'https://app.example/some/page', anchor, page: 'main' })

    expect(openSiteInfo).toHaveBeenNthCalledWith(1, anchor, 'web3', undefined)
    expect(openSiteInfo).toHaveBeenNthCalledWith(2, anchor, 'main', 'https://app.example/some/page')
  })

  it('refuses openSiteInfo from a frame that is not the chrome view\'s own', async () => {
    const openSiteInfo = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), vi.fn(), openSiteInfo)

    await dispatch({ type: 'openSiteInfo', anchor: { x: 40, y: 44, width: 28, height: 28 }, page: 'main' }, OTHER_FRAME)

    expect(openSiteInfo).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- starring a page keeps its icon', () => {
  const ICON = 'data:image/png;base64,iVBORw0KGgo='

  it('stores the icon MAIN already captured for that tab, not one sent by the renderer', () => {
    const add = vi.fn()
    const tabs = { faviconFor: vi.fn(() => ICON) } as unknown as TabManager
    registerShellIpc(chromeWebContents, tabs, { add } as unknown as BookmarkStore, fakeSiteInfo(), vi.fn(), vi.fn())

    void dispatch({ type: 'addBookmark', url: 'https://a.example/', title: 'A', tabId: 'tab-7' })

    expect(tabs.faviconFor).toHaveBeenCalledWith('tab-7')
    expect(add).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'A', favicon: ICON })
  })

  it('saves the bookmark with no icon when that tab has not got one yet', () => {
    const add = vi.fn()
    const tabs = { faviconFor: vi.fn(() => null) } as unknown as TabManager
    registerShellIpc(chromeWebContents, tabs, { add } as unknown as BookmarkStore, fakeSiteInfo(), vi.fn(), vi.fn())

    void dispatch({ type: 'addBookmark', url: 'https://a.example/', title: 'A', tabId: 'tab-7' })

    expect(add).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'A', favicon: null })
  })
})

describe('registerShellIpc -- web3ScoreFor', () => {
  it('forwards the tab URL to siteInfo.siteTrustFor and maps the result through web3Score', async () => {
    const siteInfo = fakeSiteInfo({
      siteTrustFor: vi.fn(async () => ({
        connection: 'secure', ddoc: { status: 'not-checked' }, pin: undefined, name: undefined,
        level: { level: 1, because: 'x', assessable: undefined },
        delivery: { level: 1, evidence: {} as never },
        levelOverride: 4, displayedLevel: 4, deliveryOverride: undefined, displayedDelivery: 1
      } as never))
    })
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, siteInfo, vi.fn(), vi.fn())

    const result = await dispatch({ type: 'web3ScoreFor', url: 'https://app.example/page' })

    expect(siteInfo.siteTrustFor).toHaveBeenCalledWith('https://app.example/page')
    expect(result).toEqual({ level: 4, overridden: true, delivery: 1, deliveryOverridden: false })
  })

  it('is null when siteTrustFor has nothing to report', async () => {
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), vi.fn(), vi.fn())

    const result = await dispatch({ type: 'web3ScoreFor', url: 'https://app.example/page' })

    expect(result).toBeNull()
  })

  it('refuses web3ScoreFor from a frame that is not the chrome view\'s own', async () => {
    const siteInfo = fakeSiteInfo()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, siteInfo, vi.fn(), vi.fn())

    await dispatch({ type: 'web3ScoreFor', url: 'https://app.example/page' }, OTHER_FRAME)

    expect(siteInfo.siteTrustFor).not.toHaveBeenCalled()
  })
})
