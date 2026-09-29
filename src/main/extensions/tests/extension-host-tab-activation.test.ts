import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseWindow, WebContents } from 'electron'
import type { ShellServices } from '../../shell/shell-services.js'
import type { SubsystemContext } from '../../registry.js'

// Same mocking shape as extension-host.test.ts's own header: every module
// extension-host.ts imports at module scope is mocked, and the mocked
// 'orivon:crx-extensions' class exposes spies for every method
// attachExtensionShell's own tabLifecycle callbacks call, so this suite can
// drive those callbacks directly and assert what the (fake) library was
// told, without a real ElectronChromeExtensions or a real BrowserWindow.

let capturedOptions: any
let lastInstance: any

const getExtension = vi.fn<(id: string) => unknown>()
const appOn = vi.fn()

vi.mock('electron', () => ({
  app: { on: appOn },
  session: {
    defaultSession: {
      extensions: { getExtension },
      serviceWorkers: { on: vi.fn() }
    },
    fromPartition: vi.fn()
  }
}))

vi.mock('orivon:crx-extensions', () => ({
  ElectronChromeExtensions: class {
    static handleCRXProtocol = vi.fn()
    on = vi.fn()
    addTab = vi.fn()
    removeTab = vi.fn()
    selectTab = vi.fn()
    clearActiveTab = vi.fn()
    constructor (opts: any) {
      capturedOptions = opts
      lastInstance = this
    }
  }
}))

vi.mock('orivon:crx-extensions-partition', () => ({ setSessionPartitionResolver: vi.fn() }))
vi.mock('orivon:crx-extensions-router', () => ({
  setRemoteMessageSenderCheck: vi.fn(),
  setMessageSenderIdCheck: vi.fn(),
  setEventListenerFilter: vi.fn()
}))
vi.mock('orivon:crx-extensions-cookies', () => ({ setCookieHostAccessCheck: vi.fn() }))
vi.mock('orivon:crx-extensions-tabs', () => ({ setTabUrlAccessCheck: vi.fn(), setTabHostAccessCheck: vi.fn() }))

const { createExtensionHost, attachExtensionShell } = await import('../extension-host.js')
const { session: mockedSession } = await import('electron')

function buildShell (): {
  services: ShellServices
  subscribed: { tabCreated: any, tabActivated: any, tabClosed: any, viewReplaced: any }
  findTab: ReturnType<typeof vi.fn>
  shellWindow: any
} {
  const win = { id: 1 } as unknown as BaseWindow
  const shellWindow = { window: win, tabs: { openTrusted: vi.fn() } }
  const findTab = vi.fn()
  let subscribed: any
  const services = {
    windows: {
      all: () => [shellWindow],
      focused: () => shellWindow,
      findTab
    },
    tabLifecycle: { subscribe: (cbs: any) => { subscribed = cbs } }
  } as unknown as ShellServices
  attachExtensionShell({} as unknown as SubsystemContext, services, {} as any)
  return { services, subscribed, findTab, shellWindow }
}

function fakeWc (session: unknown): WebContents {
  return { session, isDestroyed: () => false } as unknown as WebContents
}

describe('extension-host: tabActivated on an untracked tab (an orivon: page or a granted app)', () => {
  beforeEach(() => {
    capturedOptions = undefined
    lastInstance = undefined
    getExtension.mockReset()
  })

  it('clears the library\'s active tab for that window instead of leaving it stale', () => {
    getExtension.mockReturnValue(null)
    createExtensionHost('preload.js')
    const { subscribed, findTab, shellWindow } = buildShell()

    const untracked = fakeWc({ different: true })
    findTab.mockReturnValue({ window: shellWindow, tabId: 'x' })

    subscribed.tabActivated(untracked)

    expect(lastInstance.clearActiveTab).toHaveBeenCalledWith(shellWindow.window)
    expect(lastInstance.selectTab).not.toHaveBeenCalled()
  })

  it('still calls selectTab for a tracked tab (the ordinary case)', () => {
    getExtension.mockReturnValue(null)
    createExtensionHost('preload.js')
    const { subscribed } = buildShell()

    // session.defaultSession is the mocked object itself; tabCreated only
    // tracks a wc whose .session === session.defaultSession.
    const wc = { session: mockedSession.defaultSession, isDestroyed: () => false } as unknown as WebContents
    subscribed.tabCreated(wc, { id: 1 } as unknown as BaseWindow)

    subscribed.tabActivated(wc)

    expect(lastInstance.selectTab).toHaveBeenCalledWith(wc)
    expect(lastInstance.clearActiveTab).not.toHaveBeenCalled()
  })
})

describe('extension-host: viewReplaced adds the new tab before removing the old one', () => {
  beforeEach(() => {
    capturedOptions = undefined
    lastInstance = undefined
    getExtension.mockReset()
  })

  it('so a one-tab window is never seen as empty in between (store.ts\'s own "clear window if it has no remaining tabs" cleanup, which would otherwise delete and re-add the window)', () => {
    getExtension.mockReturnValue(null)
    createExtensionHost('preload.js')
    const { subscribed } = buildShell()

    const defaultSession = mockedSession.defaultSession
    const oldWc = { session: defaultSession, isDestroyed: () => false } as unknown as WebContents
    const newWc = { session: defaultSession, isDestroyed: () => false } as unknown as WebContents
    const win = { id: 1 } as unknown as BaseWindow

    subscribed.tabCreated(oldWc, win)
    subscribed.viewReplaced(oldWc, newWc, win)

    expect(lastInstance.addTab).toHaveBeenCalledWith(newWc, win)
    expect(lastInstance.removeTab).toHaveBeenCalledWith(oldWc)
    const addOrder = lastInstance.addTab.mock.invocationCallOrder[0]
    const removeOrder = lastInstance.removeTab.mock.invocationCallOrder[0]
    expect(addOrder).toBeLessThan(removeOrder)
  })
})

describe('extension-host: window-open policy for popups and MV2 background pages', () => {
  beforeEach(() => {
    capturedOptions = undefined
    lastInstance = undefined
    getExtension.mockReset()
    appOn.mockClear()
  })

  it('sets a window-open handler on a browserAction popup, denying and never letting Electron open a raw window', () => {
    getExtension.mockReturnValue(null)
    createExtensionHost('preload.js')
    buildShell()

    const onPopupCreated = lastInstance.on.mock.calls.find((call: any[]) => call[0] === 'browser-action-popup-created')?.[1]
    expect(onPopupCreated).toBeInstanceOf(Function)

    const setWindowOpenHandler = vi.fn()
    const once = vi.fn()
    const isDestroyed = vi.fn(() => false)
    const destroy = vi.fn()
    onPopupCreated({ browserWindow: { webContents: { setWindowOpenHandler, once } }, isDestroyed, destroy })

    expect(setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = setWindowOpenHandler.mock.calls[0]?.[0]
    expect(handler({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    // The popup-lifecycle wiring (tab switch/navigation closing it) also
    // registers a one-shot cleanup on the popup's own webContents
    // 'destroyed' -- this fake models enough of a real WebContents for
    // that registration to succeed, the same as setWindowOpenHandler above.
    expect(once).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('sets the same policy on a background page\'s own webContents, never an ordinary tab\'s', () => {
    getExtension.mockReturnValue(null)
    createExtensionHost('preload.js')
    buildShell()

    const onWebContentsCreated = appOn.mock.calls.find((call: any[]) => call[0] === 'web-contents-created')?.[1]
    expect(onWebContentsCreated).toBeInstanceOf(Function)

    const bgSetHandler = vi.fn()
    onWebContentsCreated(undefined, {
      session: mockedSession.defaultSession,
      getType: () => 'backgroundPage',
      setWindowOpenHandler: bgSetHandler
    })
    expect(bgSetHandler).toHaveBeenCalledTimes(1)

    const tabSetHandler = vi.fn()
    onWebContentsCreated(undefined, {
      session: mockedSession.defaultSession,
      getType: () => 'window',
      setWindowOpenHandler: tabSetHandler
    })
    expect(tabSetHandler).not.toHaveBeenCalled()
  })
})
