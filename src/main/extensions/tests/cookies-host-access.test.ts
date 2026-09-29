import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// vendor/electron-chrome-extensions/src/browser/{router,api/cookies}.ts are
// reached from src/main/extensions/extension-host.ts only through virtual
// specifiers, never these real paths -- UPSTREAM.md patches 13-14 make
// router.ts satisfy the root tsconfig, and api/cookies.ts's own new setter
// is plain, dependency-light TypeScript, so this suite drives the REAL
// ExtensionRouter.onExtensionMessage and the REAL CookiesAPI handlers
// together, the same way router-listener-sender-id.test.ts drives the
// router's own ipcMain handlers.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const { ExtensionRouter, setEventListenerFilter } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { CookiesAPI, setCookieHostAccessCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/api/cookies.js'
)
const { hasApiPermission, hasHostAccess } = await import('../extension-host-access.js')

// The exact check extension-host.ts installs in production (createExtensionHost).
setCookieHostAccessCheck(hasHostAccess)

function manifestWith (permissions: readonly string[], hostPermissions?: readonly string[]): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'x',
    version: '1.0.0',
    ...(permissions.length > 0 ? { permissions } : {}),
    ...(hostPermissions === undefined ? {} : { host_permissions: hostPermissions })
  }
}

interface FakeCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  hostOnly: boolean
  session: boolean
  httpOnly: boolean
}

function fakeCookie (domain: string, path = '/'): FakeCookie {
  return { name: 'sid', value: 'v', domain, path, secure: true, hostOnly: true, session: false, httpOnly: false }
}

function setup (cookies: FakeCookie[]): { session: Session, router: any, cookiesApi: any, cookiesSet: ReturnType<typeof vi.fn>, cookiesRemove: ReturnType<typeof vi.fn> } {
  const cookiesGet = vi.fn(async () => cookies)
  const cookiesSet = vi.fn(async () => {})
  const cookiesRemove = vi.fn(async () => {})
  const session = {
    extensions: { on: vi.fn(), getExtension: vi.fn() },
    serviceWorkers: { on: vi.fn() },
    cookies: { get: cookiesGet, set: cookiesSet, remove: cookiesRemove, addListener: vi.fn() }
  } as unknown as Session
  const router = new ExtensionRouter(session)
  const cookiesApi = new CookiesAPI({ router, session, store: { tabs: new Set() } } as any)
  return { session, router, cookiesApi, cookiesSet, cookiesRemove }
}

function frameEvent (session: Session): any {
  return { type: 'frame', sender: { session } }
}

describe('chrome.cookies: the cookies permission (UPSTREAM.md api/cookies.ts entry)', () => {
  it('refuses cookies.getAll from an extension whose manifest has no cookies permission', async () => {
    const { session, router } = setup([fakeCookie('a.example')])
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([]) })) as any

    await expect(
      router.onExtensionMessage(frameEvent(session), 'ext', 'cookies.getAll', {})
    ).rejects.toThrow(/cookies permission/)
  })

  it('refuses cookies.set from an extension whose manifest has no cookies permission', async () => {
    const { session, router, cookiesSet } = setup([])
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([]) })) as any

    await expect(
      router.onExtensionMessage(frameEvent(session), 'ext', 'cookies.set', { url: 'https://a.example/', name: 'sid', value: 'v' })
    ).rejects.toThrow(/cookies permission/)
    expect(cookiesSet).not.toHaveBeenCalled()
  })
})

describe('chrome.cookies: host access on top of the permission', () => {
  it('refuses cookies.set for a URL outside declared host permissions, even with cookies granted', async () => {
    const { session, router, cookiesSet } = setup([])
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith(['cookies'], ['https://a.example/*']) })) as any

    await expect(
      router.onExtensionMessage(frameEvent(session), 'ext', 'cookies.set', { url: 'https://b.example/', name: 'sid', value: 'v' })
    ).rejects.toThrow(/host access/)
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('lets cookies.set through for a URL inside declared host permissions', async () => {
    const { session, router, cookiesSet } = setup([fakeCookie('a.example')])
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith(['cookies'], ['https://a.example/*']) })) as any

    await router.onExtensionMessage(frameEvent(session), 'ext', 'cookies.set', { url: 'https://a.example/', name: 'sid', value: 'v' })
    expect(cookiesSet).toHaveBeenCalledTimes(1)
  })

  it('filters cookies.getAll to only the cookies whose own domain the extension has host access to', async () => {
    const { session, router } = setup([fakeCookie('a.example'), fakeCookie('b.example')])
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith(['cookies'], ['https://a.example/*']) })) as any

    const result = await router.onExtensionMessage(frameEvent(session), 'ext', 'cookies.getAll', {})
    expect(result.map((c: FakeCookie) => c.domain)).toEqual(['a.example'])
  })
})

describe('cookies.onChanged: per-listener filtering (UPSTREAM.md router.ts patch 15)', () => {
  it('never reaches an extension without cookies host access to that cookie', () => {
    const { session, router, cookiesApi } = setup([])
    const manifests: Record<string, Record<string, unknown>> = {
      wide: manifestWith(['cookies'], ['https://a.example/*']),
      narrow: manifestWith(['cookies'], ['https://b.example/*']),
      none: manifestWith([])
    }
    session.extensions.getExtension = vi.fn((id: string) => ({ id, manifest: manifests[id] })) as any

    // The same rule extension-host.ts's own eventListenerFilter applies to
    // cookies.onChanged: both the permission AND host access to the
    // cookie's own URL (api/cookies.ts's UPSTREAM.md entry).
    setEventListenerFilter((extensionId: string, eventName: string, args: readonly unknown[]) => {
      if (eventName !== 'cookies.onChanged') return args
      const changeInfo = args[0] as { cookie: FakeCookie }
      const url = `${changeInfo.cookie.secure ? 'https' : 'http'}://${changeInfo.cookie.domain}${changeInfo.cookie.path}`
      const manifest = manifests[extensionId]
      return hasApiPermission(manifest, 'cookies') && hasHostAccess(manifest, url) ? args : undefined
    })

    const wideHost = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    const noneHost = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    router.addListener({ type: 'frame', host: wideHost, extensionId: 'wide' }, 'wide', 'cookies.onChanged')
    router.addListener({ type: 'frame', host: noneHost, extensionId: 'none' }, 'none', 'cookies.onChanged')

    ;(cookiesApi as any).onChanged({}, fakeCookie('a.example'), 'explicit', false)

    expect(wideHost.send).toHaveBeenCalledTimes(1)
    expect(noneHost.send).not.toHaveBeenCalled()
  })
})
