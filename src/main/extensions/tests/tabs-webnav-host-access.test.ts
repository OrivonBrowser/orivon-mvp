import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// vendor/electron-chrome-extensions/src/browser/{router,api/tabs,api/web-navigation}.ts
// are reached from src/main/extensions/extension-host.ts only through
// virtual specifiers, never these real paths -- this suite drives the REAL
// ExtensionRouter.onExtensionMessage together with the REAL TabsAPI and
// WebNavigationAPI handlers, the same way router-listener-sender-id.test.ts
// drives the router's own ipcMain handlers.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const { ExtensionRouter, setEventListenerFilter } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { TabsAPI, setTabUrlAccessCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/tabs.js'
)
const { WebNavigationAPI } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/web-navigation.js'
)
const { hasApiOrHostAccess } = await import('../extension-host-access.js')

// The exact check extension-host.ts installs in production (createExtensionHost).
setTabUrlAccessCheck((manifest: unknown, url: string | undefined) => hasApiOrHostAccess(manifest, 'tabs', url))

function manifestWith (permissions: readonly string[], hostPermissions?: readonly string[]): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'x',
    version: '1.0.0',
    ...(permissions.length > 0 ? { permissions } : {}),
    ...(hostPermissions === undefined ? {} : { host_permissions: hostPermissions })
  }
}

function fakeTab (id: number, url: string, title: string): any {
  return {
    id,
    isDestroyed: () => false,
    isCurrentlyAudible: () => false,
    audioMuted: false,
    isLoading: () => false,
    getTitle: () => title,
    getURL: () => url,
    favicon: undefined
  }
}

function fakeStore (tabs: any[]): any {
  return {
    tabs: new Set(tabs),
    tabToWindow: new WeakMap(),
    tabDetailsCache: new Map(),
    lastFocusedWindowId: undefined,
    getActiveTabFromWebContents: () => undefined,
    getTabById: (id: number) => tabs.find((tab) => tab.id === id),
    on: vi.fn(),
    impl: {}
  }
}

function fakeSession (): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn() },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

function frameEvent (session: Session): any {
  return { type: 'frame', sender: { session } }
}

describe('chrome.tabs: url/title/favIconUrl gated on tabs or matching host permissions', () => {
  it('strips url/title from tabs.get for an extension with no permissions', async () => {
    const tab = fakeTab(1, 'https://a.example/', 'A')
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new TabsAPI({ router, session, store: fakeStore([tab]) } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([]) })) as any

    const result = await router.onExtensionMessage(frameEvent(session), 'ext', 'tabs.get', 1)
    expect(result.url).toBeUndefined()
    expect(result.title).toBeUndefined()
    expect(result.id).toBe(1)
  })

  it('keeps url/title in tabs.get for an extension holding the tabs permission', async () => {
    const tab = fakeTab(1, 'https://a.example/', 'A')
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new TabsAPI({ router, session, store: fakeStore([tab]) } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith(['tabs']) })) as any

    const result = await router.onExtensionMessage(frameEvent(session), 'ext', 'tabs.get', 1)
    expect(result.url).toBe('https://a.example/')
    expect(result.title).toBe('A')
  })

  it('keeps url/title only for a tab matching declared host permissions', async () => {
    const tabA = fakeTab(1, 'https://a.example/', 'A')
    const tabB = fakeTab(2, 'https://b.example/', 'B')
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new TabsAPI({ router, session, store: fakeStore([tabA, tabB]) } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([], ['https://a.example/*']) })) as any

    const resultA = await router.onExtensionMessage(frameEvent(session), 'ext', 'tabs.get', 1)
    const resultB = await router.onExtensionMessage(frameEvent(session), 'ext', 'tabs.get', 2)
    expect(resultA.url).toBe('https://a.example/')
    expect(resultB.url).toBeUndefined()
  })

  it('excludes a stripped tab from a tabs.query url filter instead of matching it by accident', async () => {
    const tabA = fakeTab(1, 'https://a.example/', 'A')
    const tabB = fakeTab(2, 'https://b.example/', 'B')
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new TabsAPI({ router, session, store: fakeStore([tabA, tabB]) } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([], ['https://a.example/*']) })) as any

    const result = await router.onExtensionMessage(frameEvent(session), 'ext', 'tabs.query', { url: 'https://b.example/*' })
    expect(result).toEqual([])
  })
})

describe('tabs.onUpdated: per-listener field stripping (UPSTREAM.md router.ts patch 15)', () => {
  it('an extension with no permissions receives it without url/title; one with tabs receives them; host access limits it to the matching tab', () => {
    const tabA = fakeTab(1, 'https://a.example/', 'A')
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    const manifests: Record<string, Record<string, unknown>> = {
      none: manifestWith([]),
      full: manifestWith(['tabs']),
      narrow: manifestWith([], ['https://a.example/*'])
    }
    session.extensions.getExtension = vi.fn((id: string) => ({ id, manifest: manifests[id] })) as any
    const tabsApi = new TabsAPI({ router, session, store: fakeStore([tabA]) } as any)

    setEventListenerFilter((extensionId: string, eventName: string, args: readonly unknown[]) => {
      if (eventName !== 'tabs.onUpdated') return args
      const manifest = manifests[extensionId]
      const tab = args[2] as { url?: string } | undefined
      if (hasApiOrHostAccess(manifest, 'tabs', tab?.url)) return args
      const strip = (value: unknown) => {
        if (value === null || typeof value !== 'object') return value
        const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) }
        delete copy.url
        delete copy.pendingUrl
        delete copy.title
        delete copy.favIconUrl
        return copy
      }
      return [args[0], strip(args[1]), strip(args[2])]
    })

    /** Typed `any`, like `router-event-listener-filter.test.ts`'s own
     * `fakeHost`: the real `EventListener` shape wants a full
     * `Electron.WebContents`. */
    function fakeHost (): any {
      return { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    }
    const hosts = { none: fakeHost(), full: fakeHost(), narrow: fakeHost() }
    router.addListener({ type: 'frame', host: hosts.none, extensionId: 'none' }, 'none', 'tabs.onUpdated')
    router.addListener({ type: 'frame', host: hosts.full, extensionId: 'full' }, 'full', 'tabs.onUpdated')
    router.addListener({ type: 'frame', host: hosts.narrow, extensionId: 'narrow' }, 'narrow', 'tabs.onUpdated')

    // Seed the cache with a prior snapshot, then change the tab so onUpdated finds a diff.
    ;(tabsApi as any).createTabDetails(tabA)
    tabA.getTitle = () => 'A2'
    tabsApi.onUpdated(1)

    const noneDetails = hosts.none.send.mock.calls[0]?.[3]
    const fullDetails = hosts.full.send.mock.calls[0]?.[3]
    const narrowDetails = hosts.narrow.send.mock.calls[0]?.[3]
    expect(noneDetails?.url).toBeUndefined()
    expect(noneDetails?.title).toBeUndefined()
    expect(fullDetails?.url).toBe('https://a.example/')
    expect(fullDetails?.title).toBe('A2')
    expect(narrowDetails?.url).toBe('https://a.example/')
  })
})

describe('chrome.webNavigation: the webNavigation permission', () => {
  it('refuses getAllFrames from an extension whose manifest has no webNavigation permission', async () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new WebNavigationAPI({ router, session, store: fakeStore([]) } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([]) })) as any

    await expect(
      router.onExtensionMessage(frameEvent(session), 'ext', 'webNavigation.getAllFrames', { tabId: 1 })
    ).rejects.toThrow(/webNavigation permission/)
  })
})
