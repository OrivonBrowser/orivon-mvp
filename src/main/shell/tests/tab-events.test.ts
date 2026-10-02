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
  buildFromTemplate: vi.fn((_template: unknown) => ({ popup: vi.fn() })),
  adoptedViews: [] as Array<{ options: Record<string, unknown> }>
}))
vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: { options: Record<string, unknown>, webContents: unknown, setBounds: unknown, setBackgroundColor: unknown }, options: Record<string, unknown>) {
    this.options = options
    this.webContents = options['webContents'] ?? fakeContents()
    this.setBounds = vi.fn()
    this.setBackgroundColor = vi.fn()
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

const { wireView, makeTabView } = await import('../tab-view.js')
const { MAX_NEW_WINDOWS_PER_MINUTE_PROCESS, processWindowBudget } = await import('../popups.js')
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
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean, goBack: () => void, goForward: () => void }
}

function fakeContents (url = 'https://news.example/'): FakeContents {
  const wc = new EventEmitter() as FakeContents
  wc.opener = null
  wc.setWindowOpenHandler = vi.fn()
  wc.loadURL = vi.fn(async () => {})
  wc.close = vi.fn()
  wc.getURL = () => url
  wc.isDestroyed = () => false
  wc.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() }
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
    openBlobTab: vi.fn(),
    openWindow: vi.fn(),
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

describe('wireView -- the listeners every tab collects', () => {
  it('leaves room for the dozen subsystems that each watch did-navigate, without allowing an unbounded number', () => {
    const wc = fakeContents()
    expect(wc.getMaxListeners()).toBe(10)
    wireView('tab-1', record(wc))

    expect(wc.getMaxListeners()).toBeGreaterThanOrEqual(24)
    expect(wc.getMaxListeners()).toBeLessThan(100)
  })

  it('does not lower a limit that is already higher', () => {
    const wc = fakeContents()
    wc.setMaxListeners(50)
    wireView('tab-1', record(wc))
    expect(wc.getMaxListeners()).toBe(50)
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
    expect(host.adoptPopup).toHaveBeenCalledWith(adoptedViews[0], undefined, true)
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

    expect(host.adoptPopup).toHaveBeenCalledWith(expect.anything(), 'persist:app', true)
    expect(host.openWindow).not.toHaveBeenCalled()
  })

  it('routes a modifier-click open with no guest webContents through the ordinary tab pipeline, never a view of its own', () => {
    const wc = fakeContents()
    const opened = fakeContents('https://other.example/')
    const openTab = vi.fn((): never => opened as never)
    const host = fakeHost({ openTab })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', disposition: 'background-tab' })
    const returned = response.createWindow?.({ webPreferences: {} } as never)

    expect(openTab).toHaveBeenCalledWith('https://other.example/', false, undefined)
    expect(returned).toBe(opened)
    expect(adoptedViews).toHaveLength(0)
    expect(host.adoptPopup).not.toHaveBeenCalled()
  })

  it('opens a same-origin blob: URL as a tab in the opener\'s own partition, never about:blank', () => {
    // The bug this guards: routePopup returns 'adopt' here (the blob's own minter origin equals
    // the opener's), but a modifier-click never carries a guest to adopt, and the ordinary tab
    // pipeline (openTab/createTab) refuses a blob: URL outright (sanitizeDirectUrl) -- silently
    // landing it on about:blank instead of the same-origin content it can safely show.
    const wc = fakeContents('https://other.example/')
    const opened = fakeContents('blob:https://other.example/1b4e28ba-2fa1')
    const openBlobTab = vi.fn((): never => opened as never)
    const host = fakeHost({ openBlobTab })
    wireView('tab-1', record(wc, 'persist:other', host))

    const response = openHandler(wc)({ url: 'blob:https://other.example/1b4e28ba-2fa1', disposition: 'background-tab' })
    const returned = response.createWindow?.({ webPreferences: {} } as never)

    expect(openBlobTab).toHaveBeenCalledWith('blob:https://other.example/1b4e28ba-2fa1', 'persist:other', false, undefined)
    expect(returned).toBe(opened)
    expect(host.openTab).not.toHaveBeenCalled()
    expect(adoptedViews).toHaveLength(0)
  })

  it('never opens a cross-origin blob: URL at all -- its bytes are not in this session, whatever the opener', () => {
    const wc = fakeContents('https://opener.example/')
    const openTab = vi.fn((): never => fakeContents('about:blank') as never)
    const openBlobTab = vi.fn()
    const host = fakeHost({ openTab, openBlobTab })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'blob:https://minter.example/1b4e28ba-2fa1', disposition: 'background-tab' })

    expect(response.action).toBe('deny')
    expect(openTab).toHaveBeenCalledWith('blob:https://minter.example/1b4e28ba-2fa1', false, undefined)
    expect(openBlobTab).not.toHaveBeenCalled()
  })

  it('routes a same-origin middle-click inside a cache-served app through the ordinary tab pipeline, never an unpartitioned view of its own', () => {
    // The bug this guards: routePopup returns 'adopt' here (the target's own
    // partition -- cache-served, ADR-0044 -- equals the opener's), but a
    // middle click never carries a guest to adopt (guestOf's own doc). The
    // fix routes through openTab/createTab (correct partition AND
    // sanitizeDirectUrl) instead of building an unpartitioned view that
    // would load the app's origin into session.defaultSession, network-
    // served, with the broker still keying the app's grants to that origin.
    const wc = fakeContents(`${APP}/`)
    const opened = fakeContents(`${APP}/other`)
    const openTab = vi.fn((): never => opened as never)
    const host = fakeHost({ openTab })
    wireView('tab-1', record(wc, APP_PARTITION, host))

    const response = openHandler(wc)({ url: `${APP}/other`, disposition: 'background-tab' })
    const returned = response.createWindow?.({ webPreferences: {} } as never)

    expect(openTab).toHaveBeenCalledWith(`${APP}/other`, false, undefined)
    expect(returned).toBe(opened)
    expect(adoptedViews).toHaveLength(0)
    expect(host.adoptPopup).not.toHaveBeenCalled()
  })

  it('opens a shift-click (new-window, no guest) in a new window rather than adopting a tab here', () => {
    const wc = fakeContents()
    const openedContents = fakeContents('https://other.example/')
    const openWindow = vi.fn((): never => openedContents as never)
    const host = fakeHost({ openWindow })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window' })
    const returned = response.createWindow?.({ webPreferences: {} } as never)

    expect(openWindow).toHaveBeenCalledWith('https://other.example/', undefined)
    expect(returned).toBe(openedContents)
    expect(adoptedViews).toHaveLength(0)
    expect(host.adoptPopup).not.toHaveBeenCalled()
  })

  it('rate-limits new-window opens per tab: one a second, and a small cap within a minute, falling back to an ordinary tab past either', () => {
    // Electron's HandlerDetails carries no per-open user-gesture flag (measured against 44's own
    // type), and a page's own synthetic, untrusted dispatchEvent click still reaches here with a
    // real 'new-window' disposition (measured against a real launch) -- so a script could open
    // windows without bound if nothing here budgeted them.
    processWindowBudget.reset()
    const wc = fakeContents()
    const openWindow = vi.fn((): never => fakeContents('https://other.example/') as never)
    const host = fakeHost({ openWindow })
    wireView('tab-1', record(wc, undefined, host))
    const openOnce = (): void => { openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window' }).createWindow?.({ webPreferences: {} } as never) }

    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      openOnce()
      expect(openWindow).toHaveBeenCalledTimes(1)

      // Under a second later: too soon, falls back to an ordinary (foreground) tab instead.
      vi.setSystemTime(500)
      openOnce()
      expect(openWindow).toHaveBeenCalledTimes(1)
      expect(host.openTab).toHaveBeenCalledWith('https://other.example/', true, undefined)

      // Spaced a full second apart, up to the cap: each opens a real window.
      for (let seconds = 2; seconds <= 5; seconds++) {
        vi.setSystemTime(seconds * 1000)
        openOnce()
      }
      expect(openWindow).toHaveBeenCalledTimes(5)

      // A sixth, even spaced a full second later, exceeds the rolling-minute cap.
      vi.setSystemTime(6_000)
      openOnce()
      expect(openWindow).toHaveBeenCalledTimes(5)

      // Past a minute since the first, the oldest opens age out and one more is allowed again.
      vi.setSystemTime(61_000)
      openOnce()
      expect(openWindow).toHaveBeenCalledTimes(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('also rate-limits new-window opens process-wide: a page that opens itself gets a fresh per-tab budget in every window, but not a fresh process one', () => {
    // Each open below simulates a page shift-clicking itself: a BRAND NEW opener tab every time
    // (wireView called fresh, its own windowOpenHandler and so its own per-tab budget), spaced a
    // full second apart so the per-tab throttle alone would wave every one of them through, the
    // same way each new window's own copy of the page would if only a per-tab budget existed --
    // 5, 25, 125 windows. Only the shared process budget can catch this.
    processWindowBudget.reset()
    const openWindow = vi.fn((): never => fakeContents('https://other.example/') as never)
    const openAsNewOpener = (): void => {
      const wc = fakeContents()
      const host = fakeHost({ openWindow })
      wireView('tab-1', record(wc, undefined, host))
      openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window' }).createWindow?.({ webPreferences: {} } as never)
    }

    vi.useFakeTimers()
    try {
      const attempts = MAX_NEW_WINDOWS_PER_MINUTE_PROCESS + 10
      for (let seconds = 0; seconds < attempts; seconds++) {
        vi.setSystemTime(seconds * 1000)
        openAsNewOpener()
      }
      expect(openWindow.mock.calls.length).toBeLessThan(attempts)
      expect(openWindow.mock.calls.length).toBeLessThanOrEqual(MAX_NEW_WINDOWS_PER_MINUTE_PROCESS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens noopener as today\'s disconnected tab', () => {
    const wc = fakeContents()
    const host = fakeHost()
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', features: 'noopener' })

    expect(response.action).toBe('deny')
    expect(host.openTab).toHaveBeenCalledWith('https://other.example/', true, undefined)
  })

  it('carries a modifier-click form submit\'s referrer and POST body to the tab it opens', () => {
    // Measured against Electron 44: details.postBody/referrer are populated for a modifier-click
    // submit of a method=post form exactly as for an ordinary click, but createTab's own
    // loadURL(target) call otherwise carries neither, silently turning the POST into a GET with
    // no referrer.
    const wc = fakeContents()
    const opened = fakeContents('https://other.example/target')
    const openTab = vi.fn((): never => opened as never)
    const host = fakeHost({ openTab })
    wireView('tab-1', record(wc, undefined, host))
    const referrer = { url: 'https://other.example/', policy: 'strict-origin-when-cross-origin' as const }
    const postBody = { contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData' as const, bytes: Buffer.from('field=value') }] }

    const response = openHandler(wc)({ url: 'https://other.example/target', disposition: 'background-tab', referrer, postBody })
    response.createWindow?.({ webPreferences: {} } as never)

    expect(openTab).toHaveBeenCalledWith('https://other.example/target', false, {
      httpReferrer: referrer,
      postData: postBody.data,
      extraHeaders: 'content-type: application/x-www-form-urlencoded\n'
    })
  })

  it('sends a shift-click that routePopup would otherwise send straight to a tab, to a new window instead', () => {
    // routePopup returns 'new-tab' here (noopener) before disposition is ever weighed, but a
    // shift-click still reaches here with the same 'new-window' disposition it gets everywhere
    // else -- it deserves a window, not a tab, same as any other shift-click.
    const wc = fakeContents()
    const openedWindow = fakeContents('https://other.example/')
    const openWindow = vi.fn((): never => openedWindow as never)
    const host = fakeHost({ openWindow })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', features: 'noopener', disposition: 'new-window' })

    expect(response.action).toBe('deny')
    expect(openWindow).toHaveBeenCalledWith('https://other.example/', undefined)
    expect(host.openTab).not.toHaveBeenCalled()
  })

  it('keeps a plain window.open() to a noopener target an ordinary tab -- its disposition is never new-window', () => {
    // Measured against Electron 44: a plain window.open(url) (no sizing features) always gets
    // 'foreground-tab', whatever features string it passes -- only a real sized popup or a
    // genuine shift-click ever produces 'new-window'.
    const wc = fakeContents()
    const openWindow = vi.fn()
    const host = fakeHost({ openWindow })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', features: 'noopener', disposition: 'foreground-tab' })

    expect(response.action).toBe('deny')
    expect(openWindow).not.toHaveBeenCalled()
    expect(host.openTab).toHaveBeenCalledWith('https://other.example/', true, undefined)
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

describe('wireView -- a popup\'s opener is cut once it navigates itself into a DIFFERENT granted app', () => {
  // routePopup's own isApp check (popups.ts) only ever runs at window.open()
  // time, against the URL window.open() was given. A same-origin popup that
  // later moves itself (w.location = ...) into a granted app never goes
  // through routePopup again, so did-navigate is where this has to be
  // caught -- using the very same isApp reading (popupTargetIsApp).
  it('rebuilds the view, dropping the stale opener, when a same-origin popup navigates itself into a granted, network-served app', () => {
    const R = 'https://r.example'
    const G = 'https://g.example'
    const host = fakeHost({
      broker: { app: { isRegisteredSync: (o: string) => o === R || o === G, hasGrantsSync: (o: string) => o === G } } as unknown as Broker
    })
    const view = makeTabView('/preload/app.js', undefined, ['--orivon-app-tab'], { target: `${R}/` })
    const wc = view.webContents as unknown as FakeContents
    wc.opener = { url: `${R}/` }
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: undefined, isDashboardTab: false, internalPage: null, parkedViews: new Map() } as Record_
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, `${G}/`)

    // G is granted but not cache-served, so its partition is the same
    // `undefined` R's was -- the fix must still rebuild the view, since a
    // freshly built WebContents is the only thing Electron gives with no
    // `.opener` at all.
    expect(r.partition).toBeUndefined()
    expect(r.view).not.toBe(view)
  })

  it('moves the view out of a cache-served opener\'s own partition when it navigates itself into a different granted app, opener or not', () => {
    const X = APP // cache-served, per this file's own module mock
    const G = 'https://g.example'
    const host = fakeHost({
      broker: { app: { isRegisteredSync: (o: string) => o === X || o === G, hasGrantsSync: (o: string) => o === G } } as unknown as Broker
    })
    const view = makeTabView('/preload/app.js', APP_PARTITION, ['--orivon-app-tab'], { target: `${X}/` })
    const wc = view.webContents as unknown as FakeContents
    wc.opener = { url: `${X}/` }
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: APP_PARTITION, isDashboardTab: false, internalPage: null, parkedViews: new Map() } as Record_
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, `${G}/`)

    expect(r.partition).toBeUndefined()
  })

  it('still keeps the opener session for a popup that navigates itself onto another registered site that holds no grant and is not cache-served', () => {
    const R = 'https://r.example'
    const R2 = 'https://r2.example'
    const host = fakeHost({
      broker: { app: { isRegisteredSync: (o: string) => o === R || o === R2, hasGrantsSync: () => false } } as unknown as Broker
    })
    const view = makeTabView('/preload/app.js', undefined, ['--orivon-app-tab'], { target: `${R}/` })
    const wc = view.webContents as unknown as FakeContents
    wc.opener = { url: `${R}/` }
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: undefined, isDashboardTab: false, internalPage: null, parkedViews: new Map() } as Record_
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, `${R2}/`)

    expect(r.view).toBe(view)
  })
})

describe('wireView -- an internal-page tab that stops being one', () => {
  // guardInternalView (../pages/internal-tab.ts) refuses every navigation an
  // internal page's OWN content could trigger, so the one path that reaches
  // did-navigate with a foreign target is the address bar typing something
  // with no derivable origin straight onto this view -- about:blank here.
  it('clears record.internalPage and resets the SAME view\'s background, so a site with no CSS background of its own does not render on the page\'s own theme colour', () => {
    const host = fakeHost()
    const view = makeTabView('/preload/internal.js', 'orivon-internal', [], { backgroundColor: '#f4f4f8' })
    const wc = view.webContents as unknown as FakeContents
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: 'orivon-internal', isDashboardTab: false, internalPage: 'settings', parkedViews: new Map() } as Record_
    wireView('tab-1', r)
    ;(view.setBackgroundColor as ReturnType<typeof vi.fn>).mockClear()

    wc.emit('did-navigate', {}, 'about:blank')

    expect(r.internalPage).toBeNull()
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#FFFFFF')
  })

  it('leaves record.internalPage and the view\'s colour alone for an ordinary in-page navigation (a different path, same page)', () => {
    const host = fakeHost()
    const view = makeTabView('/preload/internal.js', 'orivon-internal', [], { backgroundColor: '#f4f4f8' })
    const wc = view.webContents as unknown as FakeContents
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: 'orivon-internal', isDashboardTab: false, internalPage: 'settings', parkedViews: new Map() } as Record_
    wireView('tab-1', r)
    ;(view.setBackgroundColor as ReturnType<typeof vi.fn>).mockClear()

    wc.emit('did-navigate', {}, 'orivon://settings/privacy')

    expect(r.internalPage).toBe('settings')
    expect(view.setBackgroundColor).not.toHaveBeenCalled()
  })
})

describe('wireView -- context menu', () => {
  it('builds a menu for a right-click in the tab', () => {
    const wc = fakeContents()
    wireView('tab-1', record(wc))

    wc.emit('context-menu', {}, {
      x: 1, y: 1, linkURL: 'https://example.com/', linkText: '', srcURL: '', mediaType: 'none', hasImageContents: false,
      isEditable: false, selectionText: '', frame: null,
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }
    })

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
  })

  const LINK_PARAMS = {
    x: 1, y: 1, linkURL: 'https://example.com/a', linkText: 'a', srcURL: '', mediaType: 'none', hasImageContents: false,
    isEditable: false, selectionText: '', frame: null,
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }
  }
  const services = (isPrivate: boolean): Record<string, unknown> => ({
    isPrivate, profiles: { openPrivate: vi.fn() }, settings: { get: () => true, set: vi.fn() }
  })
  const menuItems = (): Array<{ label?: string, click?: () => void }> => (buildFromTemplate.mock.calls.at(-1)?.[0] ?? []) as Array<{ label?: string, click?: () => void }>
  const choose = (label: string): void => { menuItems().find((item) => item.label === label)?.click?.() }

  it('opens a link beside the page, in a window, or in a private session of its own', () => {
    const wc = fakeContents()
    const shared = services(false)
    const host = fakeHost({ services: shared as never })
    wireView('tab-1', record(wc, undefined, host))
    wc.emit('context-menu', {}, LINK_PARAMS)

    choose('Open Link in New Tab')
    choose('Open Link in New Window')
    choose('Open Link in Private Window')
    expect(host.openTab).toHaveBeenCalledWith('https://example.com/a', false)
    expect(host.openWindow).toHaveBeenCalledWith('https://example.com/a')
    expect((shared['profiles'] as { openPrivate: ReturnType<typeof vi.fn> }).openPrivate).toHaveBeenCalledWith('https://example.com/a')
  })

  it('offers no private window from inside a private one', () => {
    const wc = fakeContents()
    wireView('tab-1', record(wc, undefined, fakeHost({ services: services(true) as never })))
    wc.emit('context-menu', {}, LINK_PARAMS)

    expect(menuItems().map((item) => item.label)).not.toContain('Open Link in Private Window')
    expect(menuItems().map((item) => item.label)).toContain('Open Link in New Window')
  })

  it('shows only navigation on a tab that holds an internal page', () => {
    const wc = fakeContents()
    const r = record(wc)
    r.internalPage = 'settings'
    wireView('tab-1', r)
    wc.emit('context-menu', {}, { ...LINK_PARAMS, linkURL: '', selectionText: '', editFlags: { ...LINK_PARAMS.editFlags, canSelectAll: false } })

    expect(menuItems().map((item) => item.label)).toEqual(['Back', 'Forward', 'Reload'])
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

    expect(after.openTab).toHaveBeenCalledWith('https://other.example/', true, undefined)
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

describe('wireView -- developer tools do not survive a navigation between two granted apps', () => {
  // Both A and B hold grants and are served from the network (neither is
  // in the cache-served mock above), so a navigation between them swaps no
  // partition and flips no app-tab flag: the SAME view and webContents stay
  // in place. Without closing devtools here, whatever was confirmed for A
  // keeps working, unprompted, once the page is actually B's.
  it('closes an open console when an in-place navigation changes the origin between two granted, network-served apps', () => {
    const A = 'https://app-a.example'
    const B = 'https://app-b.example'
    const closeFor = vi.fn()
    const host = fakeHost({
      broker: { app: { isRegisteredSync: () => true, hasGrantsSync: (origin: string) => origin === A || origin === B } } as unknown as Broker,
      devtools: { allowed: vi.fn(), inspect: vi.fn(), closeFor } as unknown as Host['devtools']
    })
    const view = makeTabView('/preload/app.js', undefined, ['--orivon-app-tab'], { target: `${A}/` })
    const wc = view.webContents as unknown as FakeContents
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: undefined, isDashboardTab: false, internalPage: null, parkedViews: new Map() } as Record_
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, `${B}/`)

    expect(closeFor).toHaveBeenCalledWith(wc)
    expect(r.view).toBe(view) // neither a partition swap nor a flag change rebuilt the view
  })

  it('leaves the console alone across an in-place navigation that stays on the same granted app\'s origin', () => {
    const A = 'https://app-a.example'
    const closeFor = vi.fn()
    const host = fakeHost({
      broker: { app: { isRegisteredSync: () => true, hasGrantsSync: (origin: string) => origin === A } } as unknown as Broker,
      devtools: { allowed: vi.fn(), inspect: vi.fn(), closeFor } as unknown as Host['devtools']
    })
    const view = makeTabView('/preload/app.js', undefined, ['--orivon-app-tab'], { target: `${A}/page-one` })
    const wc = view.webContents as unknown as FakeContents
    const r = { host, view, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition: undefined, isDashboardTab: false, internalPage: null, parkedViews: new Map() } as Record_
    wireView('tab-1', r)

    wc.emit('did-navigate', {}, `${A}/page-two`)

    expect(closeFor).not.toHaveBeenCalled()
  })
})
