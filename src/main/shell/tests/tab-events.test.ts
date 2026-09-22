import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron'
import type { Broker } from '../../../broker/broker-contracts.js'
import { partitionFor } from '../../../broker/grants/origin-hash.js'

// wireView is where a tab's page-level events meet the shell: fullscreen,
// beforeunload, window.open and the context menu. These tests drive the same
// events Electron emits on a real tab's webContents.
const { showMessageBoxSync, buildFromTemplate, adoptedViews } = vi.hoisted(() => ({
  showMessageBoxSync: vi.fn(),
  buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
  adoptedViews: [] as Array<{ options: Record<string, unknown> }>
}))
vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: { options: Record<string, unknown>, webContents: unknown, setBounds: unknown }, options: Record<string, unknown>) {
    this.options = options
    this.webContents = options['webContents'] ?? fakeContents()
    this.setBounds = vi.fn()
    adoptedViews.push(this)
  }),
  dialog: { showMessageBoxSync },
  Menu: { buildFromTemplate },
  clipboard: { writeText: vi.fn() }
}))
vi.mock('../../../loader/electron-serve.js', () => ({ isOriginServedFromCacheSync: () => false }))

const { wireView } = await import('../tab-view.js')
type Host = Parameters<typeof wireView>[0]
type Record_ = Parameters<typeof wireView>[2]

const APP = 'https://app.example'
const APP_PARTITION = partitionFor(APP)

interface FakeContents extends EventEmitter {
  opener: unknown
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  getURL: () => string
  isDestroyed: () => boolean
}

function fakeContents (url = 'https://news.example/'): FakeContents {
  const wc = new EventEmitter() as FakeContents
  wc.opener = null
  wc.setWindowOpenHandler = vi.fn()
  wc.loadURL = vi.fn(async () => {})
  wc.close = vi.fn()
  wc.getURL = () => url
  wc.isDestroyed = () => false
  return wc
}

function fakeHost (overrides: Partial<Host> = {}): Host & Record<string, unknown> {
  return {
    preloadPath: '/preload/app.js',
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } as never,
    broker: { app: { hasGrantsSync: (o: string) => o === APP, isRegisteredSync: (o: string) => o === APP } } as unknown as Broker,
    dashboardUrl: 'http://localhost:5999/newtab/',
    window: { isDestroyed: () => false } as never,
    isActive: () => true,
    emitState: vi.fn(),
    captureFavicon: vi.fn(async () => {}),
    forgetTab: vi.fn(),
    openTab: vi.fn(),
    adoptPopup: vi.fn(),
    atCapacity: () => false,
    htmlFullscreenChanged: vi.fn(),
    getTabBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    ...overrides
  } as Host & Record<string, unknown>
}

function record (wc: FakeContents, partition?: string): Record_ {
  return { view: { webContents: wc } as never, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition, isDashboardTab: false }
}

function openHandler (wc: FakeContents): (details: Partial<HandlerDetails>) => WindowOpenHandlerResponse {
  const handler = wc.setWindowOpenHandler.mock.calls.at(-1)?.[0] as (d: HandlerDetails) => WindowOpenHandlerResponse
  return (details) => handler({ url: '', frameName: '', features: '', disposition: 'foreground-tab', referrer: { url: '', policy: 'default' }, ...details } as HandlerDetails)
}

beforeEach(() => {
  showMessageBoxSync.mockReset()
  buildFromTemplate.mockClear()
  adoptedViews.length = 0
})

describe('wireView -- HTML fullscreen', () => {
  it('reports a tab entering and leaving fullscreen to the window around it', () => {
    const wc = fakeContents()
    const host = fakeHost()
    wireView(host, 'tab-1', record(wc))

    wc.emit('enter-html-full-screen')
    wc.emit('leave-html-full-screen')

    expect(host.htmlFullscreenChanged).toHaveBeenNthCalledWith(1, 'tab-1', true)
    expect(host.htmlFullscreenChanged).toHaveBeenNthCalledWith(2, 'tab-1', false)
  })
})

describe('wireView -- a beforeunload guard asks instead of silently blocking', () => {
  it('leaves the page when the person chooses Leave', () => {
    const wc = fakeContents()
    wireView(fakeHost(), 'tab-1', record(wc))
    showMessageBoxSync.mockReturnValue(0)
    const event = { preventDefault: vi.fn() }

    wc.emit('will-prevent-unload', event)

    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('stays on the page when the person chooses Stay', () => {
    const wc = fakeContents()
    wireView(fakeHost(), 'tab-1', record(wc))
    showMessageBoxSync.mockReturnValue(1)
    const event = { preventDefault: vi.fn() }

    wc.emit('will-prevent-unload', event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('attaches the question to the window, so it cannot appear anywhere else on screen', () => {
    const wc = fakeContents()
    const window = { isDestroyed: () => false }
    wireView(fakeHost({ window: window as never }), 'tab-1', record(wc))
    showMessageBoxSync.mockReturnValue(1)

    wc.emit('will-prevent-unload', { preventDefault: vi.fn() })

    expect(showMessageBoxSync.mock.calls[0]?.[0]).toBe(window)
  })
})

describe('wireView -- window.open', () => {
  it('backs a same-session popup with a real tab built from Chromium\'s own webContents', () => {
    const wc = fakeContents()
    const host = fakeHost()
    wireView(host, 'tab-1', record(wc))

    const response = openHandler(wc)({ url: 'https://other.example/' })
    expect(response.action).toBe('allow')
    expect(response.outlivesOpener).toBe(true)

    const guest = fakeContents('https://other.example/')
    const webPreferences = response.overrideBrowserWindowOptions?.webPreferences
    const returned = response.createWindow?.({ webContents: guest, webPreferences } as never)

    expect(returned).toBe(guest)
    expect(adoptedViews[0]?.options).toEqual({ webContents: guest, webPreferences })
    expect(host.adoptPopup).toHaveBeenCalledWith(adoptedViews[0], undefined)
    expect(host.openTab).not.toHaveBeenCalled()
  })

  it('gives the popup a tab\'s own non-negotiable webPreferences and ordinary preload, and no partition of its own', () => {
    const wc = fakeContents()
    wireView(fakeHost(), 'tab-1', record(wc))

    const prefs = openHandler(wc)({ url: 'https://other.example/' }).overrideBrowserWindowOptions?.webPreferences
    expect(prefs).toMatchObject({ preload: '/preload/app.js', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
    expect(prefs).not.toHaveProperty('partition')
    expect(prefs).not.toHaveProperty('additionalArguments')
  })

  it('flags a popup onto a registered app\'s own origin as an app tab, exactly as a tab opened there would be', () => {
    const wc = fakeContents(`${APP}/`)
    wireView(fakeHost(), 'tab-1', record(wc, APP_PARTITION))

    const prefs = openHandler(wc)({ url: `${APP}/popout` }).overrideBrowserWindowOptions?.webPreferences
    expect(prefs?.additionalArguments).toEqual(['--orivon-app-tab'])
  })

  it('adopts the popup into its opener\'s partition, which is where Chromium created it', () => {
    const wc = fakeContents(`${APP}/`)
    const host = fakeHost()
    wireView(host, 'tab-1', record(wc, 'persist:app'))

    const response = openHandler(wc)({ url: 'https://accounts.example/auth', disposition: 'new-window', features: 'width=500' })
    response.createWindow?.({ webContents: fakeContents(), webPreferences: {} } as never)

    expect(host.adoptPopup).toHaveBeenCalledWith(expect.anything(), 'persist:app')
  })

  it('opens noopener as today\'s disconnected tab', () => {
    const wc = fakeContents()
    const host = fakeHost()
    wireView(host, 'tab-1', record(wc))

    const response = openHandler(wc)({ url: 'https://other.example/', features: 'noopener' })

    expect(response.action).toBe('deny')
    expect(host.openTab).toHaveBeenCalledWith('https://other.example/')
  })

  it('refuses outright at the tab ceiling', () => {
    const wc = fakeContents()
    const host = fakeHost({ atCapacity: () => true })
    wireView(host, 'tab-1', record(wc))

    expect(openHandler(wc)({ url: 'https://other.example/' }).action).toBe('deny')
    expect(host.openTab).not.toHaveBeenCalled()
  })
})

describe('wireView -- a popup keeps its session while its opener holds it', () => {
  it('does not repartition a tab whose opener is still there, even onto an origin that has its own session', () => {
    // The sign-in popup returning to the app's callback URL: swapping the
    // view would sever window.opener, which is the whole point of the popup.
    const wc = fakeContents()
    wc.opener = {}
    const host = fakeHost()
    const r = record(wc)
    wireView(host, 'tab-1', r)

    wc.emit('did-navigate', {}, `${APP}/callback`)

    expect(r.partition).toBeUndefined()
    expect(host.emitState).toHaveBeenCalled()
  })

  it('repartitions like any other tab once the opener is gone', () => {
    const wc = fakeContents()
    const r = record(wc)
    wireView(fakeHost(), 'tab-1', r)

    wc.emit('did-navigate', {}, `${APP}/callback`)

    expect(r.partition).toBe(APP_PARTITION)
  })
})

describe('wireView -- context menu', () => {
  it('builds a menu for a right-click in the tab', () => {
    const wc = fakeContents()
    wireView(fakeHost(), 'tab-1', record(wc))

    wc.emit('context-menu', {}, {
      x: 1, y: 1, linkURL: 'https://example.com/', srcURL: '', mediaType: 'none', hasImageContents: false,
      isEditable: false, selectionText: '', frame: null,
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }
    })

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
  })
})
