import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { finishInstall, installFromFile, installFromFolder, type InstallContext } from '../install-runner.js'
import { installFromStore, installFromStoreCrx, updateFromStore } from '../install-store-runner.js'
import { PRIVATE_INSTALL_REASON, refusePrivateInstall } from '../install-private.js'
import { FIXTURE_MANIFEST, buildCrx, fakeSession, withTempDir, writeFixtureFolder } from './install-runner-fixtures.js'

const REFUSED = { installed: false, reason: 'Extensions are not available in a private or guest window.' }

function privateCtx (userDataPath: string, prompt = vi.fn(async () => true)): { ctx: InstallContext, prompt: typeof prompt, loaded: Map<string, string> } {
  const { session, loaded } = fakeSession()
  return { ctx: { userDataPath, session, prompt, privateSession: true }, prompt, loaded }
}

describe('a private or guest runtime refuses every install entry point', () => {
  it('says so in the words the page shows', () => {
    expect(PRIVATE_INSTALL_REASON).toBe(REFUSED.reason)
  })

  it('refuses installFromFolder before reading the folder, prompting or writing', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { ctx, prompt, loaded } = privateCtx(userDataPath)
      await expect(installFromFolder(ctx, writeFixtureFolder(root, FIXTURE_MANIFEST))).resolves.toEqual(REFUSED)
      await expect(installFromFolder(ctx, join(root, 'no-such-folder'))).resolves.toEqual(REFUSED)
      expect(prompt).not.toHaveBeenCalled()
      expect(loaded.size).toBe(0)
      expect(existsSync(join(userDataPath, 'extensions'))).toBe(false)
    })
  })

  it('refuses installFromFile, whether the file exists or not', async () => {
    await withTempDir(async (root) => {
      const { ctx, prompt } = privateCtx(join(root, 'userData'))
      await expect(installFromFile(ctx, join(root, 'missing.crx'))).resolves.toEqual(REFUSED)
      expect(prompt).not.toHaveBeenCalled()
    })
  })

  it('refuses installFromStore without downloading anything', async () => {
    await withTempDir(async (root) => {
      const { ctx } = privateCtx(join(root, 'userData'))
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      await expect(installFromStore(ctx, 'a'.repeat(32))).resolves.toEqual(REFUSED)
      expect(fetchSpy).not.toHaveBeenCalled()
      fetchSpy.mockRestore()
    })
  })

  it('refuses updateFromStore and installFromStoreCrx', async () => {
    await withTempDir(async (root) => {
      const { ctx, prompt } = privateCtx(join(root, 'userData'))
      await expect(updateFromStore(ctx, 'a'.repeat(32))).resolves.toEqual(REFUSED)
      await expect(installFromStoreCrx(ctx, buildCrx(FIXTURE_MANIFEST), 'a'.repeat(32))).resolves.toEqual(REFUSED)
      expect(prompt).not.toHaveBeenCalled()
    })
  })

  it('refuses finishInstall itself, so a route added later is covered too', async () => {
    await withTempDir(async (root) => {
      const { ctx, prompt } = privateCtx(join(root, 'userData'))
      const write = vi.fn()
      await expect(finishInstall(ctx, {
        rawManifest: FIXTURE_MANIFEST,
        source: { kind: 'unpacked', from: root },
        updater: { kind: 'none', reason: 'x' },
        slot: 'u-1',
        write
      })).resolves.toEqual(REFUSED)
      expect(write).not.toHaveBeenCalled()
      expect(prompt).not.toHaveBeenCalled()
    })
  })

  it('leaves an ordinary runtime alone', async () => {
    await withTempDir(async (root) => {
      const { session } = fakeSession()
      const ctx: InstallContext = { userDataPath: join(root, 'userData'), session, prompt: async () => true }
      expect(refusePrivateInstall(ctx)).toBeUndefined()
      expect(refusePrivateInstall({ privateSession: false })).toBeUndefined()
      const outcome = await installFromFolder(ctx, writeFixtureFolder(root, FIXTURE_MANIFEST))
      expect(outcome.installed).toBe(true)
    })
  })
})
