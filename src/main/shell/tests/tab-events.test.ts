import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'

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
    htmlFullscreenChanged: vi.fn(),
    getTabBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    ...overrides
  } as Host & Record<string, unknown>
}

function record (wc: FakeContents, partition?: string): Record_ {
  return { view: { webContents: wc } as never, favicon: null, faviconOrigin: null, pendingFaviconUrl: null, partition, isDashboardTab: false }
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
