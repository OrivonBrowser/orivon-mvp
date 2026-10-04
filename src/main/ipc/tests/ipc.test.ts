import { describe, expect, it, vi } from 'vitest'
import type { TabManager } from '../../shell/tabs.js'
import type { BookmarkStore } from '../../browsing/bookmarks.js'
import type { SiteInfoController } from '../../permissions/site-info-controller.js'

// ipc.ts had no dedicated suite before queue item 4.4 (the tab/bookmark
// commands are exercised end-to-end by scripts/smoke.mjs instead) -- this
// file covers only the commands this lane and the site-info lane added on
// COMMAND_CHANNEL: the toolbar key's per-tab summary, and opening the
// all-sites and site-info popups. Listing every app and revoking live on
// the all-sites popup's OWN channel instead (permissions-ipc.test.ts); the
// site-info popup's own get/apply/trust/data commands live on ITS own
// channel too (site-info-ipc.test.ts) -- see ShellCommand's own doc on why.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

const { registerShellIpc } = await import('../ipc.js')
type ShellActions = import('../ipc.js').ShellActions
const { COMMAND_CHANNEL } = await import('../../channels.js')

// The handler is registered on the chrome view's own webContents, so the fake
// is that webContents' `ipc`.
const CHROME_URL = 'https://chrome.orivon.example/index.html'
const CHROME_FRAME = { url: CHROME_URL }
const chromeWebContents = {
  mainFrame: CHROME_FRAME,
  ipc: { handle: (channel: string, fn: (event: unknown, command: unknown) => unknown) => { handlers.set(channel, fn) } }
} as unknown as import('electron').WebContents
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


function actions (overrides: Partial<ShellActions> = {}): ShellActions {
  return {
    openPermissions: vi.fn(),
    openSiteInfo: vi.fn(),
    runCommand: vi.fn(),
    openMenu: vi.fn(),
    press: vi.fn(),
    prewarmMenu: vi.fn(),
    act: vi.fn(),
    beginTabDrag: vi.fn(),
    dragTab: vi.fn(),
    dropTab: vi.fn(),
    endTabDrag: vi.fn(),
    tabDragArrived: vi.fn(),
    showTabMenu: vi.fn(),
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
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, siteInfo, actions())

    const result = await dispatch({ type: 'siteSummaryFor', url: 'https://app.example/page' })

    expect(siteInfo.siteSummaryFor).toHaveBeenCalledWith('https://app.example/page')
    expect(result).toEqual({ asked: true, warning: false })
  })

  it('refuses siteSummaryFor from a frame that is not the chrome view\'s own', async () => {
    const siteInfo = fakeSiteInfo()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, siteInfo, actions())

    await dispatch({ type: 'siteSummaryFor', url: 'https://app.example/page' }, OTHER_FRAME)

    expect(siteInfo.siteSummaryFor).not.toHaveBeenCalled()
  })

  // The SAME frame object `chromeWebContents.mainFrame` already is -- object
  // identity alone would pass this -- but with `.url` mutated to something
  // else, the state the chrome view would be in if `lockNavigation`
  // (main/shell/lock-navigation.ts) ever let a navigation through. Checks
  // that the URL comparison is a second, independent layer, not a
  // restatement of the identity check.
  it('refuses siteSummaryFor when the chrome frame itself has navigated to a different URL', async () => {
    const siteInfo = fakeSiteInfo()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, siteInfo, actions())

    CHROME_FRAME.url = 'https://evil.example/'
    try {
      await dispatch({ type: 'siteSummaryFor', url: 'https://app.example/page' })
      expect(siteInfo.siteSummaryFor).not.toHaveBeenCalled()
    } finally {
      CHROME_FRAME.url = CHROME_URL
    }
  })
})

describe('registerShellIpc -- openMenu', () => {
  it('toggles the main menu at the anchor the chrome measured, and only for the chrome view', async () => {
    const openMenu = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ openMenu }))
    const anchor = { x: 1, y: 2, width: 3, height: 4 }

    await dispatch({ type: 'openMenu', anchor }, OTHER_FRAME)
    expect(openMenu).not.toHaveBeenCalled()
    await dispatch({ type: 'openMenu', anchor })

    expect(openMenu).toHaveBeenCalledExactlyOnceWith(anchor)
  })
})

describe('registerShellIpc -- press', () => {
  it('tells the window which toolbar button went down, for the chrome view only', async () => {
    const press = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ press }))

    await dispatch({ type: 'press', button: 'menu' }, OTHER_FRAME)
    expect(press).not.toHaveBeenCalled()
    await dispatch({ type: 'press', button: 'menu' })
    await dispatch({ type: 'press', button: 'web3' })

    expect(press).toHaveBeenNthCalledWith(1, 'menu')
    expect(press).toHaveBeenNthCalledWith(2, 'web3')
  })

  it('ignores a button that is not one of the toolbar\'s', async () => {
    const press = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ press }))

    for (const button of [undefined, null, 7, '', 'extensions', '__proto__', { id: 'menu' }]) await dispatch({ type: 'press', button } as never)

    expect(press).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- openPermissions', () => {
  it('toggles the all-sites popup, passing the tune icon\'s anchor and the tab url when given', async () => {
    const openPermissions = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ openPermissions }))

    // The anchor is the chrome view's measurement of its own tune icon --
    // main has no way to derive it, so it always rides the command.
    const anchor = { x: 900, y: 44, width: 32, height: 32 }
    await dispatch({ type: 'openPermissions', anchor })
    await dispatch({ type: 'openPermissions', url: 'https://app.example/some/page', anchor })

    expect(openPermissions).toHaveBeenNthCalledWith(1, anchor, undefined)
    expect(openPermissions).toHaveBeenNthCalledWith(2, anchor, 'https://app.example/some/page')
  })

  it('refuses openPermissions from a frame that is not the chrome view\'s own', async () => {
    const openPermissions = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ openPermissions }))

    await dispatch({ type: 'openPermissions', anchor: { x: 900, y: 44, width: 32, height: 32 } }, OTHER_FRAME)

    expect(openPermissions).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- openSiteInfo', () => {
  it('toggles the site-info popup, passing the icon\'s anchor, the requested page and the tab url when given', async () => {
    const openSiteInfo = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ openSiteInfo }))

    const anchor = { x: 40, y: 44, width: 28, height: 28 }
    await dispatch({ type: 'openSiteInfo', anchor, page: 'web3' })
    await dispatch({ type: 'openSiteInfo', url: 'https://app.example/some/page', anchor, page: 'main' })

    expect(openSiteInfo).toHaveBeenNthCalledWith(1, anchor, 'web3', undefined)
    expect(openSiteInfo).toHaveBeenNthCalledWith(2, anchor, 'main', 'https://app.example/some/page')
  })

  it('refuses openSiteInfo from a frame that is not the chrome view\'s own', async () => {
    const openSiteInfo = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ openSiteInfo }))

    await dispatch({ type: 'openSiteInfo', anchor: { x: 40, y: 44, width: 28, height: 28 }, page: 'main' }, OTHER_FRAME)

    expect(openSiteInfo).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- starring a page keeps its icon', () => {
  const ICON = 'data:image/png;base64,iVBORw0KGgo='

  it('stores the icon MAIN already captured for that tab, not one sent by the renderer', () => {
    const add = vi.fn()
    const tabs = { faviconFor: vi.fn(() => ICON) } as unknown as TabManager
    registerShellIpc(chromeWebContents, CHROME_URL, tabs, { add } as unknown as BookmarkStore, fakeSiteInfo(), actions())

    void dispatch({ type: 'addBookmark', url: 'https://a.example/', title: 'A', tabId: 'tab-7' })

    expect(tabs.faviconFor).toHaveBeenCalledWith('tab-7')
    expect(add).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'A', favicon: ICON })
  })

  it('saves the bookmark with no icon when that tab has not got one yet', () => {
    const add = vi.fn()
    const tabs = { faviconFor: vi.fn(() => null) } as unknown as TabManager
    registerShellIpc(chromeWebContents, CHROME_URL, tabs, { add } as unknown as BookmarkStore, fakeSiteInfo(), actions())

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
        levelOverride: 4, judged: { status: 'off' }, judgedShown: false, displayedLevel: 4, deliveryOverride: undefined, displayedDelivery: 1
      } as never))
    })
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, siteInfo, actions())

    const result = await dispatch({ type: 'web3ScoreFor', url: 'https://app.example/page' })

    expect(siteInfo.siteTrustFor).toHaveBeenCalledWith('https://app.example/page')
    expect(result).toEqual({ level: 4, overridden: true, judgedBy: undefined, pending: false, delivery: 1, deliveryOverridden: false, localDev: false })
  })

  it('is null when siteTrustFor has nothing to report', async () => {
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions())

    const result = await dispatch({ type: 'web3ScoreFor', url: 'https://app.example/page' })

    expect(result).toBeNull()
  })

  it('refuses web3ScoreFor from a frame that is not the chrome view\'s own', async () => {
    const siteInfo = fakeSiteInfo()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, siteInfo, actions())

    await dispatch({ type: 'web3ScoreFor', url: 'https://app.example/page' }, OTHER_FRAME)

    expect(siteInfo.siteTrustFor).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- runCommand', () => {
  it('runs a command the shell has, and only for the chrome view', async () => {
    const runCommand = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ runCommand }))

    await dispatch({ type: 'runCommand', id: 'window.new' }, OTHER_FRAME)
    expect(runCommand).not.toHaveBeenCalled()
    await dispatch({ type: 'runCommand', id: 'window.new' })

    expect(runCommand).toHaveBeenCalledExactlyOnceWith('window.new')
  })

  it('ignores a command that does not exist', async () => {
    const runCommand = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ runCommand }))

    await dispatch({ type: 'runCommand', id: 'nope' })
    await dispatch({ type: 'runCommand', id: 7 })

    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- moving tabs', () => {
  it('moves a tab in the strip, and refuses what is not an id and a number', async () => {
    const moveTab = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, { moveTab } as unknown as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions())

    await dispatch({ type: 'moveTab', id: 'tab-1', index: 2 })
    await dispatch({ type: 'moveTab', id: 7, index: 2 })
    await dispatch({ type: 'moveTab', id: 'tab-1', index: Number.NaN })
    await dispatch({ type: 'moveTab', id: 'tab-1', index: 1 }, OTHER_FRAME)

    expect(moveTab.mock.calls).toEqual([['tab-1', 2]])
  })

  it('passes on a tab let go outside the strip, and the tab menu request', async () => {
    const dropTab = vi.fn()
    const showTabMenu = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ dropTab, showTabMenu }))

    await dispatch({ type: 'dropTab', id: 'tab-1', x: 100, y: 200, clientX: 10, clientY: 20 })
    await dispatch({ type: 'dropTab', id: 'tab-1', x: 'left', y: 200, clientX: 10, clientY: 20 })
    await dispatch({ type: 'dropTab', id: 'tab-1', x: 100, y: 200 })
    await dispatch({ type: 'dropTab', id: 'tab-1', x: 100, y: 200, clientX: 10, clientY: 20 }, OTHER_FRAME)
    await dispatch({ type: 'tabMenu', id: 'tab-3' })
    await dispatch({ type: 'tabMenu', id: 3 })
    await dispatch({ type: 'tabMenu', id: 'tab-3' }, OTHER_FRAME)

    expect(dropTab.mock.calls).toEqual([['tab-1', { x: 100, y: 200 }, { x: 10, y: 20 }]])
    expect(showTabMenu.mock.calls).toEqual([['tab-3']])
  })
})

describe('registerShellIpc -- dragging a tab over the page', () => {
  it('reports where it is, and that it is back in the strip when there is no place', async () => {
    const dragTab = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ dragTab }))

    await dispatch({ type: 'dragTab', id: 'tab-1', x: 300, y: 400 })
    await dispatch({ type: 'dragTab', id: 'tab-1' })
    await dispatch({ type: 'dragTab', id: 'tab-1', x: 'far', y: 400 })
    await dispatch({ type: 'dragTab', id: 4, x: 1, y: 2 })
    await dispatch({ type: 'dragTab', id: 'tab-1', x: 1, y: 2 }, OTHER_FRAME)

    expect(dragTab.mock.calls).toEqual([['tab-1', { x: 300, y: 400 }], ['tab-1', null], ['tab-1', null]])
  })

  it('releases the drag once it ends, from any frame that names itself the chrome view', async () => {
    const endTabDrag = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ endTabDrag }))

    await dispatch({ type: 'endTabDrag' })
    await dispatch({ type: 'endTabDrag' }, OTHER_FRAME)

    expect(endTabDrag).toHaveBeenCalledOnce()
  })

  it('takes the place the pointer first appeared over the chrome, only as two finite numbers from the chrome view', async () => {
    const tabDragArrived = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ tabDragArrived }))

    await dispatch({ type: 'tabDragArrived', x: 150, y: 20 })
    await dispatch({ type: 'tabDragArrived', x: 'left', y: 20 })
    await dispatch({ type: 'tabDragArrived', x: Number.NaN, y: 20 })
    await dispatch({ type: 'tabDragArrived', x: 150 })
    await dispatch({ type: 'tabDragArrived', x: 150, y: 20 }, OTHER_FRAME)

    expect(tabDragArrived.mock.calls).toEqual([[{ x: 150, y: 20 }]])
  })
})

describe('registerShellIpc -- act', () => {
  it('hands the name and payload to the actions and returns what they answer', async () => {
    const act = vi.fn(() => 'answer')
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ act }))

    expect(await dispatch({ type: 'act', name: 'overlay.close', payload: { name: 'menu' } })).toBe('answer')

    expect(act).toHaveBeenCalledWith('overlay.close', { name: 'menu' })
  })

  it('refuses a sender that is not the chrome view', async () => {
    const act = vi.fn()
    registerShellIpc(chromeWebContents, CHROME_URL, {} as TabManager, {} as BookmarkStore, fakeSiteInfo(), actions({ act }))

    await dispatch({ type: 'act', name: 'overlay.close', payload: { name: 'menu' } }, OTHER_FRAME)

    expect(act).not.toHaveBeenCalled()
  })
})
