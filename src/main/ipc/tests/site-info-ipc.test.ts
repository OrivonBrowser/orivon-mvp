import { describe, expect, it, vi } from 'vitest'
import type { SiteInfoController } from '../../permissions/site-info-controller.js'
import type { SiteInfo } from '../../permissions/site-info.js'
import type { SitePermissionsAccess } from '../../site-settings/site-permissions-view.js'

// The site-info popup's own channel -- get/trust/data/apply/
// revokePickedPath/clearBrowserData/reload/openSiteSettings, and the sender-
// identity check every command here gets (mirrors networks-ipc.ts's own
// isFromPermissionsPanel, against this popup's webContents instead).
// site-info-controller.test.ts already proves turnOn/turnOff reach a real
// broker; this file proves the IPC layer on top routes to the ORIGIN it
// was constructed with, never one a command payload could name, and
// refuses an impostor sender.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

vi.mock('../../permissions/site-data-runner.js', () => ({
  orivonStorageFor: vi.fn(async () => ({ filesBytes: 10, filesQuotaBytes: 20, codeBytes: 30, codeVersion: '1.0.0' })),
  browserStorageEstimateFor: vi.fn(async () => ({ usageBytes: 100, quotaBytes: 200 }))
}))

const { registerSiteInfoIpc } = await import('../site-info-ipc.js')
const { SITE_INFO_COMMAND_CHANNEL } = await import('../../channels.js')

const POPUP_URL = 'app://orivon/site-info/index.html'
const SITE_INFO_FRAME = { url: POPUP_URL }
// The handler is registered on the popup's own webContents.
const siteInfoWebContents = { mainFrame: SITE_INFO_FRAME, ipc: { handle: (channel: string, fn: (event: unknown, command: unknown) => unknown) => { handlers.set(channel, fn) } } } as unknown as import('electron').WebContents
const OTHER_FRAME = { url: POPUP_URL }
const OTHER_FRAME_URL = { url: 'https://evil.test/' }
const ORIGIN = 'https://app.example'

const COOKIES = [
  { name: 'sid', domain: '.app.example', path: '/', secure: true, httpOnly: true, value: 'secret-1' },
  { name: 'theme', domain: 'app.example', path: '/', value: 'secret-2' },
  { name: 'other', domain: '.other.example', path: '/', value: 'secret-3' }
]

function tabWithCookies (url = `${ORIGIN}/`): { tab: import('electron').WebContents, remove: ReturnType<typeof vi.fn>, flushStore: ReturnType<typeof vi.fn> } {
  const remove = vi.fn(async () => {})
  const flushStore = vi.fn(async () => {})
  const tab = { getURL: () => url, session: { cookies: { get: async () => COOKIES, remove, flushStore }, clearData: vi.fn(async () => {}) } } as unknown as import('electron').WebContents
  return { tab, remove, flushStore }
}

const EMPTY_INFO: SiteInfo = { origin: ORIGIN, displayOrigin: ORIGIN, claimedName: undefined, homeDomain: undefined, update: undefined, asked: false, capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing', extensionsOnSite: [] }

function fakeController (overrides: Partial<SiteInfoController> = {}): SiteInfoController {
  return {
    siteSummaryFor: vi.fn(async () => ({ asked: false, warning: false, missing: false })),
    siteInfoFor: vi.fn(async () => EMPTY_INFO),
    inSession: vi.fn((info: SiteInfo) => info),
    withBrowserTunnel: vi.fn((info: SiteInfo) => info),
    siteTrustFor: vi.fn(async () => null),
    storageDeclarationFor: vi.fn(async () => null),
    tabInfoFor: vi.fn(() => undefined),
    setTabTunnel: vi.fn(() => false),
    setBrowserTunnel: vi.fn(() => true),
    setNodesTunnel: vi.fn(() => true),
    setTunnel: vi.fn(async () => true),
    setProxyAddress: vi.fn(() => 'ok' as const),
    testTunnel: vi.fn(async () => null),
    turnOn: vi.fn(async () => 'ok' as const),
    turnOff: vi.fn(async () => {}),
    revokePickedPath: vi.fn(async () => {}),
    deleteLocalFileData: vi.fn(async () => false),
    applyUpdate: vi.fn(async () => ({ ok: true as const })),
    reviewPermissions: vi.fn(async () => true),
    ...overrides
  }
}

function dispatch (command: unknown, senderFrame: unknown = SITE_INFO_FRAME): unknown {
  const fn = handlers.get(SITE_INFO_COMMAND_CHANNEL)
  if (fn === undefined) throw new Error('registerSiteInfoIpc did not register a handler')
  return fn({ senderFrame }, command)
}

function register (
  controller: SiteInfoController,
  overrides: Partial<{ activeWebContents: () => import('electron').WebContents | undefined, reloadActiveTab: () => void, openSiteSettings: () => void, openExtensions: () => void }> = {}
): { reloadActiveTab: ReturnType<typeof vi.fn>, openSiteSettings: ReturnType<typeof vi.fn>, openExtensions: ReturnType<typeof vi.fn> } {
  const reloadActiveTab = vi.fn()
  const openSiteSettings = vi.fn()
  const openExtensions = vi.fn()
  registerSiteInfoIpc(
    siteInfoWebContents, POPUP_URL, controller, ORIGIN, '/tmp/orivon-test-userdata',
    overrides.activeWebContents ?? (() => undefined),
    overrides.reloadActiveTab ?? reloadActiveTab,
    overrides.openSiteSettings ?? openSiteSettings,
    overrides.openExtensions ?? openExtensions
  )
  return { reloadActiveTab, openSiteSettings, openExtensions }
}

describe('registerSiteInfoIpc -- applyUpdate', () => {
  it('takes the update for the popup\'s fixed origin, whatever origin the command names', async () => {
    const controller = fakeController()
    register(controller)

    const result = await dispatch({ type: 'applyUpdate', cid: 'bafyexample', origin: 'https://evil.example' })

    expect(controller.applyUpdate).toHaveBeenCalledWith(ORIGIN, 'bafyexample', undefined)
    expect(result).toEqual({ ok: true })
  })

  it('asks in the tab in front, so the question is drawn where the person is looking', async () => {
    const controller = fakeController()
    const { tab } = tabWithCookies()
    register(controller, { activeWebContents: () => tab })

    await dispatch({ type: 'applyUpdate', cid: 'bafyexample' })

    expect(controller.applyUpdate).toHaveBeenCalledWith(ORIGIN, 'bafyexample', expect.objectContaining({ contents: expect.any(Function), stillOn: expect.any(Function) }))
  })

  it('refuses a CID that is not a string, without reaching the controller', async () => {
    const controller = fakeController()
    register(controller)

    for (const cid of [undefined, 7, null, { x: 1 }]) {
      expect(await dispatch({ type: 'applyUpdate', cid })).toEqual({ ok: false, reason: 'no such offer' })
    }
    expect(controller.applyUpdate).not.toHaveBeenCalled()
  })

  it('refuses the command from a frame that is not the popup\'s own', async () => {
    const controller = fakeController()
    register(controller)

    await dispatch({ type: 'applyUpdate', cid: 'bafyexample' }, OTHER_FRAME_URL)

    expect(controller.applyUpdate).not.toHaveBeenCalled()
  })
})

describe('registerSiteInfoIpc -- setTunnel', () => {
  it('sends the popup\'s fixed origin through the tunnel asked for, or through none, whatever origin the command names, and returns the info after', async () => {
    const controller = fakeController()
    register(controller)

    const nym = await dispatch({ type: 'setTunnel', kind: 'nym', origin: 'https://evil.example' })
    const proxy = await dispatch({ type: 'setTunnel', kind: 'socks5' })
    const none = await dispatch({ type: 'setTunnel', kind: null })

    expect(controller.setTunnel).toHaveBeenNthCalledWith(1, ORIGIN, 'nym')
    expect(controller.setTunnel).toHaveBeenNthCalledWith(2, ORIGIN, 'socks5')
    expect(controller.setTunnel).toHaveBeenNthCalledWith(3, ORIGIN, null)
    for (const answer of [nym, proxy, none]) expect(answer).toEqual({ ok: true, info: EMPTY_INFO })
  })

  it('gives the info as the tab\'s session makes it, so a page opened through an app\'s tunnel is drawn as that tunnel\'s', async () => {
    const session = {}
    const inSession = vi.fn((info: SiteInfo) => ({ ...info, tunnelKind: 'nym' as const }))
    const controller = fakeController({ inSession })
    register(controller, { activeWebContents: () => ({ getURL: () => ORIGIN, session }) as unknown as import('electron').WebContents })
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' })).toEqual({ ok: true, info: { ...EMPTY_INFO, tunnelKind: 'nym' } })
    expect(inSession).toHaveBeenCalledWith(EMPTY_INFO, session)
  })

  it('refuses a page whose tunnel is fixed (opened through an app\'s tunnel, or adopted into its session) without reaching the controller', async () => {
    const fixed = { ...EMPTY_INFO, tunnel: { fixed: 'opened' } } as unknown as SiteInfo
    const controller = fakeController({ inSession: vi.fn(() => fixed) })
    register(controller, { activeWebContents: () => ({ getURL: () => ORIGIN, session: {} }) as unknown as import('electron').WebContents })
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' })).toEqual({ ok: false, info: fixed })
    expect(await dispatch({ type: 'setTunnel', kind: null })).toEqual({ ok: false, info: fixed })
    expect(controller.setTunnel).not.toHaveBeenCalled()
  })

  it('says it was not done when the controller could not', async () => {
    const controller = fakeController({ setTunnel: vi.fn(async () => false) })
    register(controller)
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' })).toEqual({ ok: false, info: EMPTY_INFO })
  })

  it('refuses a value that is not a tunnel, without reaching the controller, and answers nothing from another frame', async () => {
    const controller = fakeController()
    register(controller)
    for (const kind of [undefined, 1, 'true', true, false, 'tor', 'off']) {
      expect(await dispatch({ type: 'setTunnel', kind })).toEqual({ ok: false, info: EMPTY_INFO })
    }
    expect(await dispatch({ type: 'setTunnel', kind: 'nym' }, OTHER_FRAME_URL)).toBeUndefined()
    expect(controller.setTunnel).not.toHaveBeenCalled()
  })
})

describe('registerSiteInfoIpc -- the tunnel of the whole browser', () => {
  it('sends the whole browser through the tunnel asked for, or through none, and returns the info after, never touching the site\'s own entry', async () => {
    const controller = fakeController()
    register(controller)
    for (const kind of ['nym', 'socks5', null]) expect(await dispatch({ type: 'setBrowserTunnel', kind, origin: 'https://evil.example' }), String(kind)).toEqual({ ok: true, info: EMPTY_INFO })
    expect((controller.setBrowserTunnel as ReturnType<typeof vi.fn>).mock.calls).toEqual([['nym'], ['socks5'], [null]])
    expect(controller.setTunnel).not.toHaveBeenCalled()
  })

  it('says it was not done, with the info as it was, when the controller could not', async () => {
    register(fakeController({ setBrowserTunnel: vi.fn(() => false), setNodesTunnel: vi.fn(() => false) }))
    expect(await dispatch({ type: 'setBrowserTunnel', kind: 'nym' })).toEqual({ ok: false, info: EMPTY_INFO })
    expect(await dispatch({ type: 'setNodesTunnel', on: true })).toEqual({ ok: false, info: EMPTY_INFO })
  })

  it('refuses a browser-wide value that is not a tunnel, and a nodes value that is not a boolean, without reaching the controller', async () => {
    const controller = fakeController()
    register(controller)
    for (const kind of [undefined, 1, 'true', true, false, 'tor', 'off', 'direct']) expect(await dispatch({ type: 'setBrowserTunnel', kind }), String(kind)).toEqual({ ok: false, info: EMPTY_INFO })
    for (const on of [undefined, null, 1, 0, 'true', 'on', {}, []]) expect(await dispatch({ type: 'setNodesTunnel', on }), String(on)).toEqual({ ok: false, info: EMPTY_INFO })
    expect(controller.setBrowserTunnel).not.toHaveBeenCalled()
    expect(controller.setNodesTunnel).not.toHaveBeenCalled()
  })

  it('sets whether the nodes follow the tunnel for a true or a false, and answers nothing from another frame', async () => {
    const controller = fakeController()
    register(controller)
    expect(await dispatch({ type: 'setNodesTunnel', on: true })).toEqual({ ok: true, info: EMPTY_INFO })
    expect(await dispatch({ type: 'setNodesTunnel', on: false })).toEqual({ ok: true, info: EMPTY_INFO })
    expect((controller.setNodesTunnel as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true], [false]])
    expect(await dispatch({ type: 'setBrowserTunnel', kind: 'nym' }, OTHER_FRAME_URL)).toBeUndefined()
    expect(await dispatch({ type: 'setNodesTunnel', on: true }, OTHER_FRAME_URL)).toBeUndefined()
    expect(controller.setBrowserTunnel).toHaveBeenCalledTimes(0)
    expect(controller.setNodesTunnel).toHaveBeenCalledTimes(2)
  })

  it('gives the info as the tab\'s session makes it, with the tunnel of the whole browser in it', async () => {
    const session = {}
    const inSession = vi.fn((info: SiteInfo) => ({ ...info, tunnelKind: 'nym' as const }))
    const withBrowserTunnel = vi.fn((info: SiteInfo) => ({ ...info, everywhere: true }))
    register(fakeController({ inSession, withBrowserTunnel }), { activeWebContents: () => ({ getURL: () => ORIGIN, session }) as unknown as import('electron').WebContents })
    expect(await dispatch({ type: 'setBrowserTunnel', kind: 'nym' })).toEqual({ ok: true, info: { ...EMPTY_INFO, tunnelKind: 'nym', everywhere: true } })
    expect(await dispatch({ type: 'get' })).toEqual({ ...EMPTY_INFO, tunnelKind: 'nym', everywhere: true })
  })
})

describe('registerSiteInfoIpc -- the proxy set from the menu', () => {
  it('saves the address the popup typed, whatever origin the command names, and returns the info after', async () => {
    const controller = fakeController({ setProxyAddress: vi.fn(() => 'ok' as const) })
    register(controller)
    expect(await dispatch({ type: 'setProxyAddress', text: '127.0.0.1:9150', origin: 'https://evil.example' })).toEqual({ ok: true, info: EMPTY_INFO })
    expect(controller.setProxyAddress).toHaveBeenCalledWith('127.0.0.1:9150')
  })

  it('says why it was not saved: the address is not one, or the settings hold it fixed', async () => {
    const controller = fakeController({ setProxyAddress: vi.fn(() => 'invalid' as const) })
    register(controller)
    expect(await dispatch({ type: 'setProxyAddress', text: 'nonsense' })).toEqual({ ok: false, reason: 'invalid', info: EMPTY_INFO })
    const fixed = fakeController({ setProxyAddress: vi.fn(() => 'refused' as const) })
    register(fixed)
    expect(await dispatch({ type: 'setProxyAddress', text: '127.0.0.1:9150' })).toEqual({ ok: false, reason: 'refused', info: EMPTY_INFO })
  })

  it('refuses a value that is not text without reaching the controller, and answers nothing from another frame', async () => {
    const controller = fakeController()
    register(controller)
    for (const text of [undefined, 1, null, {}, ['127.0.0.1:9050']]) expect(await dispatch({ type: 'setProxyAddress', text })).toEqual({ ok: false, reason: 'invalid', info: EMPTY_INFO })
    expect(await dispatch({ type: 'setProxyAddress', text: '127.0.0.1:9050' }, OTHER_FRAME_URL)).toBeUndefined()
    expect(controller.setProxyAddress).not.toHaveBeenCalled()
  })

  it('tests the tunnel the popup names, naming no address of its own, and nothing else', async () => {
    const controller = fakeController({ testTunnel: vi.fn(async () => ({ ok: true as const, authentication: 'none' as const })) })
    register(controller)
    expect(await dispatch({ type: 'testTunnel', kind: 'socks5', address: '10.0.0.1:1' })).toEqual({ ok: true, authentication: 'none' })
    expect(controller.testTunnel).toHaveBeenCalledWith('socks5')
    for (const kind of [undefined, 'tor', null, true]) expect(await dispatch({ type: 'testTunnel', kind }), String(kind)).toBeNull()
    expect(controller.testTunnel).toHaveBeenCalledTimes(1)
    expect(await dispatch({ type: 'testTunnel', kind: 'nym' }, OTHER_FRAME_URL)).toBeUndefined()
  })
})

describe('registerSiteInfoIpc -- openHome', () => {
  function registerWithHome (home: string | undefined): ReturnType<typeof vi.fn> {
    const openHome = vi.fn()
    const controller = fakeController({ siteInfoFor: vi.fn(async () => ({ ...EMPTY_INFO, homeDomain: home })) })
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, controller, ORIGIN, '/tmp/orivon-test-userdata', () => undefined, () => undefined, () => undefined, () => undefined, undefined, undefined, undefined, undefined, openHome)
    return openHome
  }

  it('opens the domain the controller reports as home, and ignores any a command names', async () => {
    const openHome = registerWithHome('app.eth')
    await dispatch({ type: 'openHome', domain: 'evil.example' })
    expect(openHome).toHaveBeenCalledExactlyOnceWith('app.eth')
  })

  it('does nothing when the manifest names no home', async () => {
    const openHome = registerWithHome(undefined)
    await dispatch({ type: 'openHome' })
    expect(openHome).not.toHaveBeenCalled()
  })

  it('does nothing for a frame that is not the popup\'s own', async () => {
    const openHome = registerWithHome('app.eth')
    await dispatch({ type: 'openHome' }, OTHER_FRAME_URL)
    expect(openHome).not.toHaveBeenCalled()
  })
})

describe('registerSiteInfoIpc -- openSupport', () => {
  function registerWithSupport (issues: string | undefined): ReturnType<typeof vi.fn> {
    const openSupport = vi.fn()
    const controller = fakeController({ siteInfoFor: vi.fn(async () => ({ ...EMPTY_INFO, ...(issues === undefined ? {} : { supportIssues: issues }) })) })
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, controller, ORIGIN, '/tmp/orivon-test-userdata', () => undefined, () => undefined, () => undefined, () => undefined, undefined, undefined, undefined, undefined, undefined, undefined, openSupport)
    return openSupport
  }

  it('opens the address the controller reports, and ignores any a command names', async () => {
    const openSupport = registerWithSupport('https://example.com/issues')
    await dispatch({ type: 'openSupport', url: 'https://evil.example/' })
    expect(openSupport).toHaveBeenCalledExactlyOnceWith('https://example.com/issues')
  })

  it('does nothing when the manifest names none', async () => {
    const openSupport = registerWithSupport(undefined)
    await dispatch({ type: 'openSupport' })
    expect(openSupport).not.toHaveBeenCalled()
  })

  it('opens nothing that is not an https address, whatever the controller holds', async () => {
    const openSupport = registerWithSupport('mailto:help@example.com')
    await dispatch({ type: 'openSupport' })
    expect(openSupport).not.toHaveBeenCalled()
  })

  it('does nothing for a frame that is not the popup\'s own', async () => {
    const openSupport = registerWithSupport('https://example.com/issues')
    await dispatch({ type: 'openSupport' }, OTHER_FRAME_URL)
    expect(openSupport).not.toHaveBeenCalled()
  })
})

describe('registerSiteInfoIpc -- get / trust', () => {
  it('get calls siteInfoFor with the FIXED origin, never one read from the command', async () => {
    const controller = fakeController()
    register(controller)

    await dispatch({ type: 'get' })

    expect(controller.siteInfoFor).toHaveBeenCalledWith(ORIGIN)
  })

  it('trust calls siteTrustFor with the fixed origin and returns what it resolves', async () => {
    const controller = fakeController({ siteTrustFor: vi.fn(async () => null) })
    register(controller)

    const result = await dispatch({ type: 'trust' })

    expect(controller.siteTrustFor).toHaveBeenCalledWith(ORIGIN)
    expect(result).toBeNull()
  })

  it('refuses every command from a frame that is not the popup\'s own', async () => {
    const controller = fakeController()
    register(controller)

    await dispatch({ type: 'get' }, OTHER_FRAME)

    expect(controller.siteInfoFor).not.toHaveBeenCalled()
  })

  // A269: identity alone lets a `senderFrame` reference kept past a
  // navigation Electron re-points elsewhere still pass -- the SAME frame
  // object, but committed at a URL that is no longer the popup's own.
  it('refuses a command from the popup\'s own frame reference once its committed URL is no longer the popup\'s', async () => {
    const controller = fakeController()
    register(controller)
    const originalUrl = SITE_INFO_FRAME.url
    SITE_INFO_FRAME.url = 'https://attacker.example/'

    try {
      await dispatch({ type: 'get' })
      expect(controller.siteInfoFor).not.toHaveBeenCalled()
    } finally {
      SITE_INFO_FRAME.url = originalUrl
    }
  })
})

describe('registerSiteInfoIpc -- apply', () => {
  it('turns on and off through the controller and returns the fresh info', async () => {
    const controller = fakeController({ turnOn: vi.fn(async () => 'ok' as const) })
    register(controller)

    const result = await dispatch({
      type: 'apply',
      changes: [
        { capability: 'fs', on: true, shownPatterns: [] },
        { capability: 'tcp.connect', on: false, shownPatterns: [] }
      ]
    })

    expect(controller.turnOn).toHaveBeenCalledWith(ORIGIN, 'fs', [])
    expect(controller.turnOff).toHaveBeenCalledWith(ORIGIN, 'tcp.connect')
    expect(result).toEqual({ info: EMPTY_INFO, staleCapabilities: [], refusedCapabilities: [] })
  })

  it('collects which capabilities came back stale, without aborting the rest', async () => {
    const controller = fakeController({
      turnOn: vi.fn(async (_origin, capability) => (capability === 'fs' ? 'stale' as const : 'ok' as const))
    })
    register(controller)

    const result = await dispatch({
      type: 'apply',
      changes: [
        { capability: 'fs', on: true, shownPatterns: [] },
        { capability: 'id', on: true, shownPatterns: [] }
      ]
    })

    expect(controller.turnOn).toHaveBeenCalledTimes(2)
    expect((result as { staleCapabilities: readonly string[] }).staleCapabilities).toEqual(['fs'])
  })

  it('reports a capability the broker did not grant (no manifest loaded, or no longer declared), so the card does not tell the person to reload for it', async () => {
    const answers: Record<string, 'not-registered' | 'not-declared' | 'ok'> = { fs: 'not-registered', id: 'not-declared', 'tcp.connect': 'ok' }
    const controller = fakeController({ turnOn: vi.fn(async (_origin, capability) => answers[capability] ?? 'ok') })
    register(controller)

    const result = await dispatch({
      type: 'apply',
      changes: [
        { capability: 'fs', on: true, shownPatterns: [] },
        { capability: 'id', on: true, shownPatterns: [] },
        { capability: 'tcp.connect', on: true, shownPatterns: [] }
      ]
    })

    expect(result).toEqual({ info: EMPTY_INFO, staleCapabilities: [], refusedCapabilities: ['fs', 'id'] })
  })
})

describe('registerSiteInfoIpc -- revokePickedPath / reload / openSiteSettings', () => {
  it('revokePickedPath forwards the fixed origin and pickId, then returns the fresh info', async () => {
    const controller = fakeController()
    register(controller)

    const result = await dispatch({ type: 'revokePickedPath', pickId: 'pick-1' })

    expect(controller.revokePickedPath).toHaveBeenCalledWith(ORIGIN, 'pick-1')
    expect(result).toBe(EMPTY_INFO)
  })

  it('reviewPermissions gives the question back for the popup\'s own origin, then reloads the tab in front', async () => {
    const controller = fakeController()
    const { reloadActiveTab } = register(controller)
    await dispatch({ type: 'reviewPermissions', origin: 'https://other.example' })
    expect(controller.reviewPermissions).toHaveBeenCalledWith(ORIGIN)
    expect(reloadActiveTab).toHaveBeenCalledTimes(1)
  })

  it('reviewPermissions reloads nothing for an origin that was never let out of the question', async () => {
    const controller = fakeController({ reviewPermissions: vi.fn(async () => false) })
    const { reloadActiveTab } = register(controller)
    await dispatch({ type: 'reviewPermissions' })
    expect(reloadActiveTab).not.toHaveBeenCalled()
  })

  it('reload calls the injected reloadActiveTab, not a command with a tab id to trust', async () => {
    const { reloadActiveTab } = register(fakeController())
    await dispatch({ type: 'reload' })
    expect(reloadActiveTab).toHaveBeenCalledOnce()
  })

  it('openSiteSettings calls the injected callback', async () => {
    const { openSiteSettings } = register(fakeController())
    await dispatch({ type: 'openSiteSettings' })
    expect(openSiteSettings).toHaveBeenCalledOnce()
  })

  it('openSiteSettings opens Settings at its default section, openTunnelSettings at Tunnels, and at the browser-wide switch when asked', async () => {
    const { openSiteSettings } = register(fakeController())
    await dispatch({ type: 'openSiteSettings' })
    await dispatch({ type: 'openTunnelSettings', everywhere: false })
    await dispatch({ type: 'openTunnelSettings', everywhere: true })
    await dispatch({ type: 'openTunnelSettings', everywhere: '/privacy' })
    expect(openSiteSettings.mock.calls).toEqual([[], ['/tunnels'], ['/tunnels#route-everywhere'], ['/tunnels']])
  })

  it('certificate calls the injected callback, from the popup only', async () => {
    const openCertificate = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, () => undefined, () => undefined, () => undefined, undefined, openCertificate)
    await dispatch({ type: 'certificate' })
    expect(openCertificate).toHaveBeenCalledOnce()
    await dispatch({ type: 'certificate' }, { url: 'https://evil.test/' })
    expect(openCertificate).toHaveBeenCalledOnce()
  })

  it('openScoreHelp calls the injected callback with no argument, from the popup only', async () => {
    const openScoreHelp = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, () => undefined, () => undefined, () => undefined, undefined, undefined, undefined, undefined, undefined, openScoreHelp)
    await dispatch({ type: 'openScoreHelp', url: 'https://evil.test/' })
    expect(openScoreHelp).toHaveBeenCalledExactlyOnceWith()
    await dispatch({ type: 'openScoreHelp' }, { url: 'https://evil.test/' })
    expect(openScoreHelp).toHaveBeenCalledOnce()
  })

  it('openExtensions calls the injected callback', async () => {
    const { openExtensions } = register(fakeController())
    await dispatch({ type: 'openExtensions' })
    expect(openExtensions).toHaveBeenCalledOnce()
  })
})

describe('registerSiteInfoIpc -- sitePermissions / setSitePermission', () => {
  const VIEW = { rows: [], shown: [], isPrivate: false }
  function registerWith (access: SitePermissionsAccess): void {
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, () => undefined, () => undefined, () => undefined, undefined, undefined, access)
  }

  it('reads the permissions of the FIXED origin', async () => {
    const access = { view: vi.fn((_origin: string) => VIEW), set: vi.fn((_origin: string, _kind: unknown, _value: unknown) => VIEW) }
    registerWith(access)
    expect(await dispatch({ type: 'sitePermissions', origin: 'https://evil.test' })).toBe(VIEW)
    expect(access.view).toHaveBeenCalledWith(ORIGIN)
  })

  it('sets one answer for the fixed origin, whatever origin the command carries', async () => {
    const access = { view: vi.fn((_origin: string) => VIEW), set: vi.fn((_origin: string, _kind: unknown, _value: unknown) => VIEW) }
    registerWith(access)
    await dispatch({ type: 'setSitePermission', kind: 'camera', value: 'block', origin: 'https://evil.test' })
    expect(access.set).toHaveBeenCalledWith(ORIGIN, 'camera', 'block')
  })

  it('refuses a kind or a value that is not a string, and answers nothing from another frame', async () => {
    const access = { view: vi.fn((_origin: string) => VIEW), set: vi.fn((_origin: string, _kind: unknown, _value: unknown) => VIEW) }
    registerWith(access)
    expect(await dispatch({ type: 'setSitePermission', kind: 3, value: 'block' })).toBeNull()
    expect(await dispatch({ type: 'setSitePermission', kind: 'camera', value: { toString: 1 } })).toBeNull()
    await dispatch({ type: 'setSitePermission', kind: 'camera', value: 'block' }, OTHER_FRAME)
    await dispatch({ type: 'sitePermissions' }, OTHER_FRAME)
    expect(access.set).not.toHaveBeenCalled()
    expect(access.view).not.toHaveBeenCalled()
  })

  it('answers null when nothing was wired', async () => {
    register(fakeController())
    expect(await dispatch({ type: 'sitePermissions' })).toBeNull()
    expect(await dispatch({ type: 'setSitePermission', kind: 'camera', value: 'block' })).toBeNull()
  })
})

describe('registerSiteInfoIpc -- clearBrowserData', () => {
  it('clears the active tab\'s own session, scoped to the fixed origin', async () => {
    const clearData = vi.fn(async () => {})
    const fakeTab = { session: { clearData } } as unknown as import('electron').WebContents
    register(fakeController(), { activeWebContents: () => fakeTab })

    await dispatch({ type: 'clearBrowserData' })

    expect(clearData).toHaveBeenCalledWith({ origins: [ORIGIN] })
  })

  it('with no active tab, does nothing rather than throwing', async () => {
    register(fakeController(), { activeWebContents: () => undefined })
    await expect(dispatch({ type: 'clearBrowserData' })).resolves.toBeUndefined()
  })

  it('a clearData failure is swallowed, not thrown back at the popup', async () => {
    const clearData = vi.fn(async () => { throw new Error('boom') })
    const fakeTab = { session: { clearData } } as unknown as import('electron').WebContents
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    register(fakeController(), { activeWebContents: () => fakeTab })

    await expect(dispatch({ type: 'clearBrowserData' })).resolves.toBeUndefined()

    logged.mockRestore()
  })
})

describe('registerSiteInfoIpc -- data', () => {
  it('combines Orivon storage, cookie count and the browser storage estimate for the active tab', async () => {
    const { tab: fakeTab } = tabWithCookies()
    const controller = fakeController({ storageDeclarationFor: vi.fn(async () => ({ filesQuotaBytes: 20, codeVersion: '1.0.0' })) })
    register(controller, { activeWebContents: () => fakeTab })

    const result = await dispatch({ type: 'data' })

    expect(result).toEqual({
      cookieCount: 2,
      cookies: [
        expect.objectContaining({ name: 'sid', domain: '.app.example', secure: true, httpOnly: true, session: true }),
        expect.objectContaining({ name: 'theme', domain: 'app.example' })
      ],
      browserStorage: { usageBytes: 100, quotaBytes: 200 },
      orivonFilesBytes: 10,
      orivonFilesQuotaBytes: 20,
      orivonCodeBytes: 30,
      orivonCodeVersion: '1.0.0'
    })
  })

  it('with no active tab, still reports Orivon storage but no cookies or browser estimate', async () => {
    const controller = fakeController()
    register(controller, { activeWebContents: () => undefined })

    const result = await dispatch({ type: 'data' })

    expect(result).toMatchObject({ cookieCount: 0, browserStorage: null })
  })
})

describe('registerSiteInfoIpc -- cookies', () => {
  it('sends no cookie value, and none of another site\'s cookies', async () => {
    const { tab } = tabWithCookies()
    register(fakeController(), { activeWebContents: () => tab })

    const result = await dispatch({ type: 'data' })

    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('other.example')
  })

  it('removes the one cookie a key names, from the active tab\'s session', async () => {
    const { tab, remove, flushStore } = tabWithCookies()
    register(fakeController(), { activeWebContents: () => tab })
    const data = await dispatch({ type: 'data' }) as { cookies: Array<{ key: string }> }

    await dispatch({ type: 'removeCookie', key: data.cookies[1]?.key })

    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('http://app.example/', 'theme')
    expect(flushStore).toHaveBeenCalled()
  })

  it('ignores a key that names another site\'s cookie, a stale key and a key that is not text', async () => {
    const { tab, remove } = tabWithCookies()
    register(fakeController(), { activeWebContents: () => tab })

    await dispatch({ type: 'removeCookie', key: 'ffffffffffffffff' })
    await dispatch({ type: 'removeCookie', key: { toString: () => 'x' } })
    await dispatch({ type: 'removeCookie' })

    expect(remove).not.toHaveBeenCalled()
  })

  it('removes every cookie of the site and none of another with clearCookies', async () => {
    const { tab, remove } = tabWithCookies()
    register(fakeController(), { activeWebContents: () => tab })

    await dispatch({ type: 'clearCookies' })

    expect(remove.mock.calls.map((call) => call[1]).sort()).toEqual(['sid', 'theme'])
  })

  it('does nothing once the tab is on another origin, or with no tab', async () => {
    const away = tabWithCookies('https://other.example/')
    register(fakeController(), { activeWebContents: () => away.tab })
    await dispatch({ type: 'clearCookies' })
    await dispatch({ type: 'removeCookie', key: 'ffffffffffffffff' })
    expect(away.remove).not.toHaveBeenCalled()

    register(fakeController(), { activeWebContents: () => undefined })
    await expect(dispatch({ type: 'clearCookies' })).resolves.toBeUndefined()
  })

  it('refuses both commands from a frame that is not the popup\'s own', async () => {
    const { tab, remove } = tabWithCookies()
    register(fakeController(), { activeWebContents: () => tab })

    await dispatch({ type: 'clearCookies' }, OTHER_FRAME_URL)
    await dispatch({ type: 'removeCookie', key: 'ffffffffffffffff' }, OTHER_FRAME_URL)

    expect(remove).not.toHaveBeenCalled()
  })
})

describe('registerSiteInfoIpc -- contentHeight', () => {
  it('a finite height reaches the injected callback', async () => {
    const onContentHeight = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, vi.fn(), vi.fn(), vi.fn(), onContentHeight)

    await dispatch({ type: 'contentHeight', height: 240 })

    expect(onContentHeight).toHaveBeenCalledWith(240)
  })

  it('NaN/Infinity never reach the callback', async () => {
    const onContentHeight = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, vi.fn(), vi.fn(), vi.fn(), onContentHeight)

    await dispatch({ type: 'contentHeight', height: Number.NaN })
    await dispatch({ type: 'contentHeight', height: Number.POSITIVE_INFINITY })

    expect(onContentHeight).not.toHaveBeenCalled()
  })
})

describe('registerSiteInfoIpc -- close', () => {
  it('asks the popup to close, after the reply has gone, and only for the popup itself', async () => {
    const close = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, close)
    await dispatch({ type: 'close' })
    expect(close).not.toHaveBeenCalled()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(close).toHaveBeenCalledTimes(1)
    await dispatch({ type: 'close' }, OTHER_FRAME_URL)
    await dispatch({ type: 'close' }, OTHER_FRAME)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('registerSiteInfoIpc -- deleteLocalFile', () => {
  const FILE = 'file:///home/u/notes/app.html'

  it('deletes the data of the file the popup was opened for, whatever the command carries, and only for the popup itself', async () => {
    const deleteLocalFileData = vi.fn(async () => true)
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, fakeController({ deleteLocalFileData }), FILE, '/tmp/orivon-test-userdata', () => undefined, vi.fn(), vi.fn(), vi.fn())
    expect(await dispatch({ type: 'deleteLocalFile', key: 'file:///other.html' })).toBe(true)
    expect(deleteLocalFileData).toHaveBeenCalledExactlyOnceWith(FILE)
    expect(await dispatch({ type: 'deleteLocalFile' }, OTHER_FRAME)).toBeUndefined()
    expect(deleteLocalFileData).toHaveBeenCalledTimes(1)
  })

  it('shows no cookies for a local file, which has none of its own', async () => {
    const controller = fakeController({ storageDeclarationFor: vi.fn(async () => null) })
    const { tab } = tabWithCookies(FILE)
    registerSiteInfoIpc(siteInfoWebContents, POPUP_URL, controller, FILE, '/tmp/orivon-test-userdata', () => tab, vi.fn(), vi.fn(), vi.fn())
    expect(await dispatch({ type: 'data' })).toMatchObject({ cookieCount: 0, cookies: [] })
  })
})
