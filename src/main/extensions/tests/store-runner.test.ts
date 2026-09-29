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

vi.mock('../install-runner.js', () => ({
  installFromStoreCrx: (...args: any[]) => installFromStoreCrx(...args),
  installFromStore: vi.fn(),
  updateFromStore: vi.fn(),
  uninstall: (...args: any[]) => uninstallMock(...args)
}))

const readRegistry = vi.fn<(...args: any[]) => readonly InstalledExtension[]>()

vi.mock('../registry-runner.js', () => ({
  readRegistry: (...args: any[]) => readRegistry(...args),
  patchStoreUpdater: vi.fn()
}))

const { buildWebStoreHost } = await import('../store-runner.js')

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
    const host = buildWebStoreHost(ctxWith(async (description) => { seenMessage = description.message; return true }))
    await host.uninstall(STORE_ENTRY.id)
    expect(seenMessage).toBe(`Remove ${STORE_ENTRY.name}?`)
    expect(uninstallMock).toHaveBeenCalledWith(expect.anything(), STORE_ENTRY.id)
  })
})
