import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallContext, InstallOutcome } from '../install-runner.js'
import type { InstalledExtension } from '../registry.js'

// store-runner.ts imports 'electron' at module scope through the vendored
// electron-chrome-web-store package it wires in (this file's own header) --
// mocked the same way extension-install-prompt.test.ts's own header does,
// even though this suite never calls startWebStore itself: importing
// store-runner.ts still runs that whole import chain.
vi.mock('electron', () => ({
  app: {},
  session: { defaultSession: {}, fromPartition: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  powerMonitor: {}
}))

const installFromStoreCrx = vi.fn<(...args: any[]) => Promise<InstallOutcome>>()
const uninstallMock = vi.fn()

vi.mock('../install-store-runner.js', () => ({
  installFromStoreCrx: (...args: any[]) => installFromStoreCrx(...args),
  installFromStore: vi.fn(),
  updateFromStore: vi.fn()
}))

vi.mock('../install-lifecycle.js', () => ({
  uninstall: (...args: any[]) => uninstallMock(...args)
}))

const readRegistry = vi.fn<(...args: any[]) => readonly InstalledExtension[]>()

vi.mock('../registry-runner.js', () => ({
  readRegistry: (...args: any[]) => readRegistry(...args),
  patchStoreUpdater: vi.fn()
}))

const installChromeWebStore = vi.fn(async (_options: Record<string, any>) => {})

vi.mock('../../../../vendor/electron-chrome-web-store/src/browser/index.js', () => ({
  installChromeWebStore: (options: Record<string, any>) => installChromeWebStore(options),
  updateExtensions: vi.fn()
}))

const { buildWebStoreHost, recordUpdateCheck, startWebStore } = await import('../store-runner.js')
const { patchStoreUpdater } = await import('../registry-runner.js')

const STORE_ENTRY: InstalledExtension = {
  id: 'abcdefghijklmnopabcdefghijklmnop',
  name: 'Fixture',
  version: '1.0.0',
  enabled: true,
  installedAt: 0,
  updatedAt: 0,
  source: { kind: 'store', storeId: 'abcdefghijklmnopabcdefghijklmnop' },
  updater: { kind: 'store' },
  path: '/userData/extensions/abcdefghijklmnopabcdefghijklmnop/1.0.0',
  stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
}

function ctxWith (prompt: InstallContext['prompt'] = async () => true): InstallContext {
  return { userDataPath: '/userData', session: {} as InstallContext['session'], prompt }
}

beforeEach(() => {
  readRegistry.mockReset()
  installFromStoreCrx.mockReset()
  uninstallMock.mockReset()
})

describe('buildWebStoreHost().installCrx', () => {
  it('throws the refusal reason when installFromStoreCrx refuses the install', async () => {
    readRegistry.mockReturnValueOnce([])
    installFromStoreCrx.mockResolvedValueOnce({ installed: false, reason: 'needs your approval: more host permissions' })
    const host = buildWebStoreHost(ctxWith())
    await expect(host.installCrx(Buffer.from('crx'), 'some-id', undefined, undefined))
      .rejects.toThrow('needs your approval: more host permissions')
  })

  it('resolves normally when the install succeeds', async () => {
    readRegistry.mockReturnValueOnce([])
    installFromStoreCrx.mockResolvedValueOnce({ installed: true, entry: STORE_ENTRY })
    const host = buildWebStoreHost(ctxWith())
    await expect(host.installCrx(Buffer.from('crx'), 'some-id', undefined, undefined)).resolves.toBeUndefined()
  })

  it('refuses without calling installFromStoreCrx when the id already names a non-store entry', async () => {
    const fileEntry: InstalledExtension = {
      ...STORE_ENTRY,
      source: { kind: 'file', fileName: '/home/person/downloaded-from-store.crx' },
      updater: { kind: 'none', reason: 'installed from a local file' }
    }
    readRegistry.mockReturnValueOnce([fileEntry])
    const host = buildWebStoreHost(ctxWith())
    await expect(host.installCrx(Buffer.from('crx'), fileEntry.id, undefined, undefined)).rejects.toThrow(/not managed by the Chrome Web Store/)
    expect(installFromStoreCrx).not.toHaveBeenCalled()
  })

  it('proceeds when the id already names a store-managed entry (an ordinary update)', async () => {
    readRegistry.mockReturnValueOnce([STORE_ENTRY])
    installFromStoreCrx.mockResolvedValueOnce({ installed: true, entry: STORE_ENTRY })
    const host = buildWebStoreHost(ctxWith())
    await expect(host.installCrx(Buffer.from('crx'), STORE_ENTRY.id, undefined, undefined)).resolves.toBeUndefined()
    expect(installFromStoreCrx).toHaveBeenCalled()
  })
})

describe('buildWebStoreHost().uninstall', () => {
  it('does nothing, and never prompts, for an entry that is not source.kind store', async () => {
    const fileEntry: InstalledExtension = {
      ...STORE_ENTRY,
      source: { kind: 'unpacked', from: '/home/person/my-extension' },
      updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' }
    }
    readRegistry.mockReturnValueOnce([fileEntry])
    let promptCalled = false
    const host = buildWebStoreHost(ctxWith(async () => { promptCalled = true; return true }))
    await host.uninstall(fileEntry.id)
    expect(promptCalled).toBe(false)
    expect(uninstallMock).not.toHaveBeenCalled()
  })

  it('does nothing for an id the registry does not know', async () => {
    readRegistry.mockReturnValueOnce([])
    const host = buildWebStoreHost(ctxWith())
    await host.uninstall('unknown-id')
    expect(uninstallMock).not.toHaveBeenCalled()
  })

  it('asks for confirmation before removing a store entry, and skips the removal when declined', async () => {
    readRegistry.mockReturnValueOnce([STORE_ENTRY])
    const host = buildWebStoreHost(ctxWith(async () => false))
    await host.uninstall(STORE_ENTRY.id)
    expect(uninstallMock).not.toHaveBeenCalled()
  })

  it('removes a store entry once the person confirms', async () => {
    readRegistry.mockReturnValueOnce([STORE_ENTRY])
    let seenMessage: string | undefined
    let seenAccept: string | undefined
    const host = buildWebStoreHost(ctxWith(async (description) => { seenMessage = description.message; seenAccept = description.accept; return true }))
    await host.uninstall(STORE_ENTRY.id)
    expect(seenMessage).toBe(`Remove ${STORE_ENTRY.name}?`)
    expect(seenAccept).toBe('Remove')
    expect(uninstallMock).toHaveBeenCalledWith(expect.anything(), STORE_ENTRY.id)
  })
})

describe('buildWebStoreHost().crxUrl', () => {
  it('is undefined outside a test-seam build, so the library keeps the store\'s own download URL', () => {
    expect(buildWebStoreHost(ctxWith()).crxUrl?.(STORE_ENTRY.id)).toBeUndefined()
  })
})

describe('startWebStore', () => {
  beforeEach(() => { installChromeWebStore.mockClear() })

  it('starts the store with updates and the install question in an ordinary runtime', async () => {
    const prompt = vi.fn(async () => true)
    await startWebStore({ ...ctxWith(prompt), privateSession: false }, '/preload.js')
    const options = installChromeWebStore.mock.calls[0]![0]
    expect(options['autoUpdate']).toBe(true)
    expect(options['allowlist']).toBeUndefined()
    expect(options['preloadPath']).toBe('/preload.js')
  })

  it('in a private runtime keeps the page APIs, runs no updater and denies every install with no question', async () => {
    const prompt = vi.fn(async () => true)
    await startWebStore({ ...ctxWith(prompt), privateSession: true }, '/preload.js')
    const options = installChromeWebStore.mock.calls[0]![0]
    expect(options['autoUpdate']).toBe(false)
    // An empty allowlist answers every status and install "blocked_by_policy" before the library fetches the page's icon.
    expect(options['allowlist']).toEqual([])
    const manifest = { name: 'x', version: '1', manifest_version: 3 }
    await expect(options['beforeInstall']({ manifest, frame: {} })).resolves.toEqual({ action: 'deny' })
    expect(prompt).not.toHaveBeenCalled()
  })
})

describe('recordUpdateCheck', () => {
  const check = { extensionId: STORE_ENTRY.id, checkedAt: 7 }

  it('notes the outcome on the entry', () => {
    vi.mocked(patchStoreUpdater).mockResolvedValueOnce(undefined)
    recordUpdateCheck('/userData', { ...check, to: '2.0.0' } as Parameters<typeof recordUpdateCheck>[1])
    expect(patchStoreUpdater).toHaveBeenCalledWith('/userData', STORE_ENTRY.id, { lastCheckedAt: 7, lastResult: 'update to 2.0.0 available' })
  })

  it('logs a failed registry write instead of leaving the rejection unhandled', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(patchStoreUpdater).mockRejectedValueOnce(new Error('EROFS'))
    recordUpdateCheck('/userData', check as Parameters<typeof recordUpdateCheck>[1])
    await new Promise((resolve) => setTimeout(resolve, 10))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })
})
