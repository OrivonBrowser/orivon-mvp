import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { deleteExtensionData } from '../extension-data.js'
import type { InstallContext } from '../install-runner.js'

const ID = 'a'.repeat(32)
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function session (name: string, holds: boolean, root: string | null = null): Session & { cleared: string[] } {
  const cleared: string[] = []
  return {
    cleared,
    extensions: { getExtension: () => holds ? { id: ID } : null },
    clearStorageData: async (options: { origin: string }) => { cleared.push(`${name} ${options.origin}`) },
    getStoragePath: () => root
  } as unknown as Session & { cleared: string[] }
}

describe('what an uninstall empties', () => {
  it('empties the extension in the default session and each profile that holds it, and its settings folders in one that does not', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-extension-data-'))
    dirs.push(root)
    for (const folder of ['Local Extension Settings', 'Sync Extension Settings']) {
      mkdirSync(join(root, folder, ID), { recursive: true })
      writeFileSync(join(root, folder, ID, 'CURRENT'), 'x')
      mkdirSync(join(root, folder, 'b'.repeat(32)), { recursive: true })
    }
    const normal = session('default', true)
    const loaded = session('loaded', true)
    const idle = session('idle', false, root)
    const cleared = vi.fn(async () => {})
    const ctx = { session: normal, clearExtensionStorage: cleared, profileSessions: () => [loaded, idle] } as unknown as InstallContext

    await deleteExtensionData(ctx, ID)

    expect(cleared.mock.calls.map((call) => (call as unknown[])[1])).toEqual([normal, loaded])
    expect(normal.cleared.concat(loaded.cleared, idle.cleared)).toEqual([`default chrome-extension://${ID}`, `loaded chrome-extension://${ID}`, `idle chrome-extension://${ID}`])
    expect(existsSync(join(root, 'Local Extension Settings', ID))).toBe(false)
    expect(existsSync(join(root, 'Sync Extension Settings', ID))).toBe(false)
    expect(existsSync(join(root, 'Local Extension Settings', 'b'.repeat(32))), 'another extension\'s settings stay').toBe(true)
  })

  it('refuses an id that is not an extension id, so no path is built from it', async () => {
    const normal = session('default', true)
    await deleteExtensionData({ session: normal, profileSessions: () => [] } as unknown as InstallContext, '../x')
    expect(normal.cleared).toEqual([])
  })
})
