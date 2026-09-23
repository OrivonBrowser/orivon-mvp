import { describe, expect, it, vi } from 'vitest'
import type { SiteInfoController } from '../../permissions/site-info-controller.js'
import type { SiteInfo } from '../../permissions/site-info.js'

// The site-info popup's own channel -- get/trust/data/apply/
// revokePickedPath/clearBrowserData/reload/openAllSites, and the sender-
// identity check every command here gets (mirrors settings-ipc.ts's own
// isFromSettingsWindow, against this popup's webContents instead).
// site-info-controller.test.ts already proves turnOn/turnOff reach a real
// broker; this file proves the IPC layer on top routes to the ORIGIN it
// was constructed with, never one a command payload could name, and
// refuses an impostor sender.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, command: unknown) => unknown) => {
      handlers.set(channel, fn)
    })
  }
}))

vi.mock('../../permissions/site-data-runner.js', () => ({
  orivonStorageFor: vi.fn(async () => ({ filesBytes: 10, filesQuotaBytes: 20, codeBytes: 30, codeVersion: '1.0.0' })),
  cookieCountFor: vi.fn(async () => 2),
  browserStorageEstimateFor: vi.fn(async () => ({ usageBytes: 100, quotaBytes: 200 }))
}))

const { registerSiteInfoIpc } = await import('../site-info-ipc.js')
const { SITE_INFO_COMMAND_CHANNEL } = await import('../../channels.js')

const SITE_INFO_FRAME = {}
const siteInfoWebContents = { mainFrame: SITE_INFO_FRAME } as unknown as import('electron').WebContents
const OTHER_FRAME = {}
const ORIGIN = 'https://app.example'

const EMPTY_INFO: SiteInfo = { origin: ORIGIN, displayOrigin: ORIGIN, claimedName: undefined, asked: false, capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing' }

function fakeController (overrides: Partial<SiteInfoController> = {}): SiteInfoController {
  return {
    siteSummaryFor: vi.fn(async () => ({ asked: false, warning: false })),
    siteInfoFor: vi.fn(async () => EMPTY_INFO),
    siteTrustFor: vi.fn(async () => null),
    storageDeclarationFor: vi.fn(async () => null),
    turnOn: vi.fn(async () => 'ok' as const),
    turnOff: vi.fn(async () => {}),
    revokePickedPath: vi.fn(async () => {}),
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
  overrides: Partial<{ activeWebContents: () => import('electron').WebContents | undefined, reloadActiveTab: () => void, openAllSites: () => void }> = {}
): { reloadActiveTab: ReturnType<typeof vi.fn>, openAllSites: ReturnType<typeof vi.fn> } {
  const reloadActiveTab = vi.fn()
  const openAllSites = vi.fn()
  registerSiteInfoIpc(
    siteInfoWebContents, controller, ORIGIN, '/tmp/orivon-test-userdata',
    overrides.activeWebContents ?? (() => undefined),
    overrides.reloadActiveTab ?? reloadActiveTab,
    overrides.openAllSites ?? openAllSites
  )
  return { reloadActiveTab, openAllSites }
}

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
    expect(result).toEqual({ info: EMPTY_INFO, staleCapabilities: [] })
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
})

describe('registerSiteInfoIpc -- revokePickedPath / reload / openAllSites', () => {
  it('revokePickedPath forwards the fixed origin and pickId, then returns the fresh info', async () => {
    const controller = fakeController()
    register(controller)

    const result = await dispatch({ type: 'revokePickedPath', pickId: 'pick-1' })

    expect(controller.revokePickedPath).toHaveBeenCalledWith(ORIGIN, 'pick-1')
    expect(result).toBe(EMPTY_INFO)
  })

  it('reload calls the injected reloadActiveTab, not a command with a tab id to trust', async () => {
    const { reloadActiveTab } = register(fakeController())
    await dispatch({ type: 'reload' })
    expect(reloadActiveTab).toHaveBeenCalledOnce()
  })

  it('openAllSites calls the injected callback', async () => {
    const { openAllSites } = register(fakeController())
    await dispatch({ type: 'openAllSites' })
    expect(openAllSites).toHaveBeenCalledOnce()
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
    const fakeTab = { session: {} } as unknown as import('electron').WebContents
    const controller = fakeController({ storageDeclarationFor: vi.fn(async () => ({ filesQuotaBytes: 20, codeVersion: '1.0.0' })) })
    register(controller, { activeWebContents: () => fakeTab })

    const result = await dispatch({ type: 'data' })

    expect(result).toEqual({
      cookieCount: 2,
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

describe('registerSiteInfoIpc -- contentHeight', () => {
  it('a finite height reaches the injected callback', async () => {
    const onContentHeight = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, vi.fn(), vi.fn(), onContentHeight)

    await dispatch({ type: 'contentHeight', height: 240 })

    expect(onContentHeight).toHaveBeenCalledWith(240)
  })

  it('NaN/Infinity never reach the callback', async () => {
    const onContentHeight = vi.fn()
    registerSiteInfoIpc(siteInfoWebContents, fakeController(), ORIGIN, '/tmp/orivon-test-userdata', () => undefined, vi.fn(), vi.fn(), onContentHeight)

    await dispatch({ type: 'contentHeight', height: Number.NaN })
    await dispatch({ type: 'contentHeight', height: Number.POSITIVE_INFINITY })

    expect(onContentHeight).not.toHaveBeenCalled()
  })
})
