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
// ONLY a cache-served origin gets its own partition; this file's own APP is
// that one cache-served, isolated origin throughout. Written as the literal
// string, not the APP constant below: vi.mock's factory is hoisted above
// every const in this file, so a reference to APP here would run before it
// is initialised.
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: (origin: string) => origin === 'https://app.example' }))

const { wireView } = await import('../tab-view.js')
type Record_ = Parameters<typeof wireView>[1]
type Host = Record_['host']

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
    broker: { app: { isRegisteredSync: (o: string) => o === APP, hasGrantsSync: () => false } } as unknown as Broker,
    dashboardUrl: 'http://localhost:5999/newtab/',
    window: { isDestroyed: () => false } as never,
    isShown: () => true,
    detachView: vi.fn(),
    attachView: vi.fn(),
    paneClicked: vi.fn(),
    openInSplit: vi.fn(),
    devtools: undefined,
    emitState: vi.fn(),
    captureFavicon: vi.fn(async () => {}),
    forgetTab: vi.fn(),
    openTab: vi.fn(),
    adoptPopup: vi.fn(),
    atCapacity: () => false,
    isClosing: () => false,
    htmlFullscreenChanged: vi.fn(),
    ...overrides
  } as Host & Record<string, unknown>
}

function record (wc: FakeContents, partition?: string, host: Host = fakeHost()): Record_ {
  return { host, view: { webContents: wc } as never, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition, isDashboardTab: false, internalPage: null, parkedViews: new Map() }
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
    wireView('tab-1', record(wc, undefined, host))

    wc.emit('enter-html-full-screen')
    wc.emit('leave-html-full-screen')

    expect(host.htmlFullscreenChanged).toHaveBeenNthCalledWith(1, 'tab-1', true)
    expect(host.htmlFullscreenChanged).toHaveBeenNthCalledWith(2, 'tab-1', false)
  })
})

describe('wireView -- a beforeunload guard asks instead of silently blocking', () => {
  it('leaves the page when the person chooses Leave', () => {
    const wc = fakeContents()
    wireView('tab-1', record(wc))
    showMessageBoxSync.mockReturnValue(0)
    const event = { preventDefault: vi.fn() }

    wc.emit('will-prevent-unload', event)

    expect(showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('stays on the page when the person chooses Stay', () => {
    const wc = fakeContents()
    wireView('tab-1', record(wc))
    showMessageBoxSync.mockReturnValue(1)
    const event = { preventDefault: vi.fn() }

    wc.emit('will-prevent-unload', event)

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('attaches the question to the window, so it cannot appear anywhere else on screen', () => {
    const wc = fakeContents()
    const window = { isDestroyed: () => false }
    wireView('tab-1', record(wc, undefined, fakeHost({ window: window as never })))
    showMessageBoxSync.mockReturnValue(1)

    wc.emit('will-prevent-unload', { preventDefault: vi.fn() })

    expect(showMessageBoxSync.mock.calls[0]?.[0]).toBe(window)
  })
})

describe('wireView -- window.open', () => {
  it('backs a same-session popup with a real tab built from Chromium\'s own webContents', () => {
    const wc = fakeContents()
    const host = fakeHost()
    wireView('tab-1', record(wc, undefined, host))

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
    wireView('tab-1', record(wc))

    const prefs = openHandler(wc)({ url: 'https://other.example/' }).overrideBrowserWindowOptions?.webPreferences
    expect(prefs).toMatchObject({ preload: '/preload/app.js', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
    expect(prefs).not.toHaveProperty('partition')
    expect(prefs).not.toHaveProperty('additionalArguments')
  })

  it('flags a popup onto a registered app\'s own origin as an app tab, exactly as a tab opened there would be', () => {
    const wc = fakeContents(`${APP}/`)
    wireView('tab-1', record(wc, APP_PARTITION))

    const prefs = openHandler(wc)({ url: `${APP}/popout` }).overrideBrowserWindowOptions?.webPreferences
    expect(prefs?.additionalArguments).toEqual(['--orivon-app-tab'])
  })

  it('adopts the popup into its opener\'s partition, which is where Chromium created it', () => {
    const wc = fakeContents(`${APP}/`)
    const host = fakeHost()
    wireView('tab-1', record(wc, 'persist:app', host))

    const response = openHandler(wc)({ url: 'https://accounts.example/auth', disposition: 'new-window', features: 'width=500' })
    response.createWindow?.({ webContents: fakeContents(), webPreferences: {} } as never)

    expect(host.adoptPopup).toHaveBeenCalledWith(expect.anything(), 'persist:app')
  })

  it('opens noopener as today\'s disconnected tab', () => {
    const wc = fakeContents()
    const host = fakeHost()
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', features: 'noopener' })

    expect(response.action).toBe('deny')
    expect(host.openTab).toHaveBeenCalledWith('https://other.example/')
  })

  it('refuses outright at the tab ceiling', () => {
    const wc = fakeContents()
    const host = fakeHost({ atCapacity: () => true })
    wireView('tab-1', record(wc, undefined, host))

    expect(openHandler(wc)({ url: 'https://other.example/' }).action).toBe('deny')
    expect(host.openTab).not.toHaveBeenCalled()
  })
})

describe('wireView -- a popup keeps its session while its opener holds it', () => {
  it('keeps a popup that still has its opener in the app\'s session while it is on the open web', () => {
    // A sign-in provider's pages, between the app opening the popup and the
    // provider redirecting back: moving the view to the default session
    // would sever window.opener, which is the whole point of the popup.
    const wc = fakeContents()
    wc.opener = {}
    const host = fakeHost()
    const r = record(wc, APP_PARTITION, host)
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, 'https://accounts.example/consent')

    expect(r.partition).toBe(APP_PARTITION)
    expect(host.emitState).toHaveBeenCalled()
  })

  it('still moves a popup into an isolated app\'s own session, opener or not', () => {
    // Anywhere else the app's origin would run unpinned network code with
    // its grants; the opener link is the lesser loss.
    const wc = fakeContents()
    wc.opener = {}
    const r = record(wc)
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, `${APP}/callback`)

    expect(r.partition).toBe(APP_PARTITION)
  })

  it('makes no new view for a navigation that commits while the window is closing', () => {
    const wc = fakeContents()
    const host = fakeHost({ isClosing: () => true })
    const r = record(wc, undefined, host)
    wireView('tab-1', r)
    const before = r.view

    wc.emit('did-navigate', {}, `${APP}/callback`)

    expect(r.view).toBe(before)
    expect(r.partition).toBeUndefined()
    expect(adoptedViews).toHaveLength(0)
  })

  it('moves back to the default session like any other tab once the opener is gone', () => {
    const wc = fakeContents()
    const r = record(wc, APP_PARTITION)
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, 'https://accounts.example/consent')

    expect(r.partition).toBeUndefined()
  })
})

describe('wireView -- context menu', () => {
  it('builds a menu for a right-click in the tab', () => {
    const wc = fakeContents()
    wireView('tab-1', record(wc))

    wc.emit('context-menu', {}, {
      x: 1, y: 1, linkURL: 'https://example.com/', srcURL: '', mediaType: 'none', hasImageContents: false,
      isEditable: false, selectionText: '', frame: null,
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }
    })

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
  })
})

// A tab that moves to another window keeps the handlers wireView put on its
// views, so each one must ask the record for its host when the event arrives.
describe('wireView -- a tab that changes host', () => {
  function movedTab (): { wc: FakeContents, before: Host & Record<string, unknown>, after: Host & Record<string, unknown> } {
    const wc = fakeContents()
    const before = fakeHost()
    const after = fakeHost()
    const r = record(wc, undefined, before)
    wireView('tab-1', r)
    r.host = after
    return { wc, before, after }
  }

  it('reports title, loading and fullscreen events to the new host only', () => {
    const { wc, before, after } = movedTab()

    wc.emit('page-title-updated')
    wc.emit('did-start-loading')
    wc.emit('enter-html-full-screen')

    expect(after.emitState).toHaveBeenCalledTimes(2)
    expect(after.htmlFullscreenChanged).toHaveBeenCalledWith('tab-1', true)
    expect(before.emitState).not.toHaveBeenCalled()
    expect(before.htmlFullscreenChanged).not.toHaveBeenCalled()
  })

  it('forgets the tab in the new host when its view dies', () => {
    const { wc, before, after } = movedTab()

    wc.emit('destroyed')

    expect(after.forgetTab).toHaveBeenCalledWith('tab-1')
    expect(before.forgetTab).not.toHaveBeenCalled()
  })

  it('opens a page\'s popups in the new host, and honours its ceiling', () => {
    const { wc, before, after } = movedTab()

    openHandler(wc)({ url: 'https://other.example/', features: 'noopener' })

    expect(after.openTab).toHaveBeenCalledWith('https://other.example/')
    expect(before.openTab).not.toHaveBeenCalled()
  })

  it('asks the leave-page question in the new host\'s window', () => {
    const wc = fakeContents()
    const oldWindow = { isDestroyed: () => false }
    const newWindow = { isDestroyed: () => false }
    const r = record(wc, undefined, fakeHost({ window: oldWindow as never }))
    wireView('tab-1', r)
    r.host = fakeHost({ window: newWindow as never })
    showMessageBoxSync.mockReturnValue(1)

    wc.emit('will-prevent-unload', { preventDefault: vi.fn() })

    expect(showMessageBoxSync.mock.calls[0]?.[0]).toBe(newWindow)
  })
})
