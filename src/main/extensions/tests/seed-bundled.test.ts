import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedBundledExtensions } from '../seed-bundled.js'
import { readRegistry, registryFileExists } from '../registry-runner.js'
import { FIXTURE_MANIFEST, buildCrx, fakeSession, withTempDir } from './install-runner-fixtures.js'

describe('seedBundledExtensions', () => {
  it('installs each listed extension, and leaves the registry file in place so no later start seeds again', async () => {
    await withTempDir(async (root) => {
      const dir = join(root, 'default-profile')
      mkdirSync(join(dir, 'extensions'), { recursive: true })
      writeFileSync(join(dir, 'extensions', 'a.crx'), buildCrx(FIXTURE_MANIFEST))
      writeFileSync(join(dir, 'bundled-extensions.json'), JSON.stringify([{ file: 'a.crx', name: 'A', pinned: true }]))
      const userDataPath = join(root, 'userData')
      expect(registryFileExists(userDataPath)).toBe(false)

      await seedBundledExtensions({ userDataPath, session: fakeSession().session, prompt: async () => { throw new Error('asked') } }, dir)

      expect(readRegistry(userDataPath)).toHaveLength(1)
      expect(registryFileExists(userDataPath)).toBe(true)
    })
  })

  it('logs a file that is not an extension and carries on', async () => {
    await withTempDir(async (root) => {
      const dir = join(root, 'default-profile')
      mkdirSync(join(dir, 'extensions'), { recursive: true })
      writeFileSync(join(dir, 'extensions', 'bad.crx'), 'not a crx')
      writeFileSync(join(dir, 'bundled-extensions.json'), JSON.stringify([{ file: 'bad.crx', name: 'Bad', pinned: false }]))
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      await seedBundledExtensions({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: async () => true }, dir)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Bad was not installed'))
      log.mockRestore()
    })
  })
})
