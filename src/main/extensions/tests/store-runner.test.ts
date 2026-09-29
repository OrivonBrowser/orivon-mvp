import { describe, expect, it, vi } from 'vitest'
import type { InstallContext, InstallOutcome } from '../install-runner.js'

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

const { buildWebStoreHost } = await import('../store-runner.js')

const CTX = {} as InstallContext

describe('buildWebStoreHost().installCrx', () => {
  it('throws the refusal reason when installFromStoreCrx refuses the install', async () => {
    installFromStoreCrx.mockResolvedValueOnce({ installed: false, reason: 'needs your approval: more host permissions' })
    const host = buildWebStoreHost(CTX)
    await expect(host.installCrx(Buffer.from('crx'), 'some-id', undefined, undefined))
      .rejects.toThrow('needs your approval: more host permissions')
  })

  it('resolves normally when the install succeeds', async () => {
    installFromStoreCrx.mockResolvedValueOnce({
      installed: true,
      entry: {
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
    })
    const host = buildWebStoreHost(CTX)
    await expect(host.installCrx(Buffer.from('crx'), 'some-id', undefined, undefined)).resolves.toBeUndefined()
  })
})
