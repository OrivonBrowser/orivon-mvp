import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron'
import type { Broker } from '../../../broker/broker-contracts.js'

// A shift-click opens a window of its own, not a tab. These tests drive the
// open handler wireView installs, with and without the guest webContents
// Electron 44.9 now hands a link-opened window, and check the budgets that
// stop a page opening windows without end.
const { askQuestion, buildFromTemplate, adoptedViews } = vi.hoisted(() => ({
  askQuestion: vi.fn(),
  buildFromTemplate: vi.fn((_template: unknown) => ({ popup: vi.fn() })),
  adoptedViews: [] as Array<{ options: Record<string, unknown> }>
}))
vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: { options: Record<string, unknown>, webContents: unknown, setBounds: unknown, setVisible: unknown, setBackgroundColor: unknown }, options: Record<string, unknown>) {
    this.options = options
    this.webContents = options['webContents'] ?? fakeContents()
    this.setBounds = vi.fn()
    this.setVisible = vi.fn()
    this.setBackgroundColor = vi.fn()
    adoptedViews.push(this)
  }),
  Menu: { buildFromTemplate },
  clipboard: { writeText: vi.fn() }
}))
// ONLY a cache-served origin gets its own partition; this file's own APP is
// that one cache-served, isolated origin throughout. Written as the literal
// string, not the APP constant below: vi.mock's factory is hoisted above
// every const in this file, so a reference to APP here would run before it
// is initialised.
vi.mock('../question/ask-question.js', () => ({ askQuestion }))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: (origin: string) => origin === 'https://app.example' }))

const { wireView } = await import('../tab-view.js')
const { MAX_NEW_WINDOWS_PER_MINUTE_PROCESS, processWindowBudget } = await import('../popups.js')
type Record_ = Parameters<typeof wireView>[1]
type Host = Record_['host']

const APP = 'https://app.example'

interface FakeContents extends EventEmitter {
  opener: unknown
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  ipc: { on: ReturnType<typeof vi.fn> }
  loadURL: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  getURL: () => string
  isDestroyed: () => boolean
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean, goBack: () => void, goForward: () => void, getAllEntries: () => never[], getActiveIndex: () => number }
}

function fakeContents (url = 'https://news.example/'): FakeContents {
  const wc = new EventEmitter() as FakeContents
  wc.opener = null
  wc.setWindowOpenHandler = vi.fn()
  wc.ipc = { on: vi.fn() }
  wc.loadURL = vi.fn(async () => {})
  wc.close = vi.fn()
  wc.getURL = () => url
  wc.isDestroyed = () => false
  wc.navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn(), getAllEntries: () => [], getActiveIndex: () => -1 }
  return wc
}

function fakeHost (overrides: Partial<Host> = {}): Host & Record<string, unknown> {
  return {
    preloadPath: '/preload/app.js',
    broker: { app: { isRegisteredSync: (o: string) => o === APP, hasGrantsSync: () => false } } as unknown as Broker,
    dashboardUrl: 'http://localhost:5999/newtab/',
    window: { isDestroyed: () => false } as never,
    isShown: () => true,
    attachView: vi.fn(),
    paneCommitted: vi.fn(),
    paneClicked: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    openInSplit: vi.fn(),
    devtools: undefined,
    emitState: vi.fn(),
    captureFavicon: vi.fn(async () => {}),
    forgetTab: vi.fn(),
    openTab: vi.fn(),
    adoptPopup: vi.fn(),
    openBlobTab: vi.fn(),
    openLocalFile: vi.fn(),
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
  askQuestion.mockReset()
  buildFromTemplate.mockClear()
  adoptedViews.length = 0
})

describe('wireView -- a shift-click opens a window', () => {
  it('gives a shift-click that carries a guest (Electron 44.9) a window of its own and adopts the guest into it', () => {
    processWindowBudget.reset()
    const wc = fakeContents()
    const adoptWindow = vi.fn()
    const host = fakeHost({ adoptWindow })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window', features: '' })
    const guest = fakeContents('https://other.example/')
    const returned = response.createWindow?.({ webContents: guest, webPreferences: {} } as never)

    expect(returned).toBe(guest)
    expect(adoptedViews[0]?.options).toEqual({ webContents: guest, webPreferences: {} })
    expect(adoptWindow).toHaveBeenCalledWith(adoptedViews[0], undefined, undefined)
    expect(host.adoptPopup).not.toHaveBeenCalled()
  })

  it('opens a shift-click from an app to the open web in a fresh window of the right session, never the guest built in the app\'s', () => {
    processWindowBudget.reset()
    const wc = fakeContents(`${APP}/`)
    const adoptWindow = vi.fn()
    const openWindow = vi.fn((): never => fakeContents('https://github.example/') as never)
    const host = fakeHost({ adoptWindow, openWindow })
    wireView('tab-1', record(wc, 'persist:app', host))

    const response = openHandler(wc)({ url: 'https://github.example/', disposition: 'new-window', features: '' })

    expect(response.action).toBe('deny')
    expect(openWindow).toHaveBeenCalledWith('https://github.example/', undefined, undefined)
    expect(adoptWindow).not.toHaveBeenCalled()
    expect(host.adoptPopup).not.toHaveBeenCalled()
  })

  it('keeps a sized popup that carries a guest a tab of the opener\'s window, though the shell can open windows', () => {
    processWindowBudget.reset()
    const wc = fakeContents()
    const adoptWindow = vi.fn()
    const host = fakeHost({ adoptWindow })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://accounts.example/auth', disposition: 'new-window', features: 'width=500,height=600' })
    response.createWindow?.({ webContents: fakeContents(), webPreferences: {} } as never)

    expect(host.adoptPopup).toHaveBeenCalledTimes(1)
    expect(adoptWindow).not.toHaveBeenCalled()
  })

  it('adopts a shift-click\'s guest as a tab once the process has used its window budget', () => {
    processWindowBudget.reset()
    for (let i = 0; i < MAX_NEW_WINDOWS_PER_MINUTE_PROCESS; i++) processWindowBudget.allow()
    const wc = fakeContents()
    const adoptWindow = vi.fn()
    const host = fakeHost({ adoptWindow })
    wireView('tab-1', record(wc, undefined, host))

    openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window', features: '' }).createWindow?.({ webContents: fakeContents(), webPreferences: {} } as never)

    expect(adoptWindow).not.toHaveBeenCalled()
    expect(host.adoptPopup).toHaveBeenCalledTimes(1)
  })

  it('adopts a shift-click\'s guest as a tab when the tab opens a second window within a second', () => {
    processWindowBudget.reset()
    const wc = fakeContents()
    const adoptWindow = vi.fn()
    const host = fakeHost({ adoptWindow })
    wireView('tab-1', record(wc, undefined, host))
    const openOnce = (): void => { openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window', features: '' }).createWindow?.({ webContents: fakeContents(), webPreferences: {} } as never) }

    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      openOnce()
      openOnce()
      expect(adoptWindow).toHaveBeenCalledTimes(1)
      expect(host.adoptPopup).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a shift-click (new-window, no guest) in a new window rather than adopting a tab here', () => {
    const wc = fakeContents()
    const openedContents = fakeContents('https://other.example/')
    const openWindow = vi.fn((): never => openedContents as never)
    const host = fakeHost({ openWindow })
    wireView('tab-1', record(wc, undefined, host))

    const response = openHandler(wc)({ url: 'https://other.example/', disposition: 'new-window' })
    const returned = response.createWindow?.({ webPreferences: {} } as never)

    expect(openWindow).toHaveBeenCalledWith('https://other.example/', undefined, undefined)
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
      expect(host.openTab).toHaveBeenCalledWith('https://other.example/', true, undefined, undefined)

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
    expect(openWindow).toHaveBeenCalledWith('https://other.example/', undefined, undefined)
    expect(host.openTab).not.toHaveBeenCalled()
  })
})
