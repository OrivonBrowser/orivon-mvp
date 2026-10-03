import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { installFromFolder } from '../install-runner.js'
import { readRegistry, writeRegistry } from '../registry-runner.js'
import { ALWAYS_ALLOW, FIXTURE_MANIFEST, fakeSession, withTempDir, writeFixtureFolder } from './install-runner-fixtures.js'

describe('what an update or reinstall keeps of the entry it replaces', () => {
  it('leaves a disabled extension disabled and unloaded, at the new version', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      writeRegistry(userDataPath, readRegistry(userDataPath).map((entry) => ({ ...entry, enabled: false })))
      session.extensions.removeExtension(first.entry.id)

      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed).toBe(true)
      if (!second.installed) return

      expect(second.entry.version).toBe('2.0.0')
      expect(second.entry.enabled).toBe(false)
      expect(readRegistry(userDataPath).map((entry) => [entry.version, entry.enabled])).toEqual([['2.0.0', false]])
      expect(loaded.size).toBe(0)
    })
  })

  it('keeps an enabled extension enabled and loaded', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed && second.entry.enabled).toBe(true)
      expect(loaded.size).toBe(1)
    })
  })
})
