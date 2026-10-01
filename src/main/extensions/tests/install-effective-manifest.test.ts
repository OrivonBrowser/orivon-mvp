// What an install and an uninstall do about the base manifest and the
// person's preferences (effective-manifest-runner.ts).
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installFromFolder } from '../install-runner.js'
import { uninstall } from '../install-lifecycle.js'
import { BASE_MANIFEST_FILE } from '../effective-manifest-runner.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { ALWAYS_ALLOW, FIXTURE_MANIFEST, fakeSession, withTempDir, writeFixtureFolder } from './install-runner-fixtures.js'

vi.mock('../manifest-stage-granted.js', () => ({
  applyGrantedStage: (manifest: Record<string, unknown>, prefs: { granted: { permissions: readonly string[] } }) =>
    prefs.granted.permissions.length === 0 ? manifest : { ...manifest, permissions: [...(manifest['permissions'] as string[]), ...prefs.granted.permissions] }
}))

const read = (path: string): { permissions: string[], key: string } => JSON.parse(readFileSync(path, 'utf8')) as { permissions: string[], key: string }

describe('finishInstall and the base manifest', () => {
  it('keeps the installed manifest beside the version folder, key included, and loads the same bytes with no choices made', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW, prefs: createExtensionPrefsStore(null) }, writeFixtureFolder(root, FIXTURE_MANIFEST))
      if (!outcome.installed) throw new Error('install failed')
      const base = join(dirname(outcome.entry.path), BASE_MANIFEST_FILE)
      expect(readFileSync(base, 'utf8')).toBe(readFileSync(join(outcome.entry.path, 'manifest.json'), 'utf8'))
      expect(read(base).key).toMatch(/^[A-Za-z0-9+/=]+$/)
    })
  })

  it('revokes a grant the new version no longer declares', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const prefs = createExtensionPrefsStore(null)
      const source = writeFixtureFolder(root, { ...FIXTURE_MANIFEST, optional_permissions: ['history'] })
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW, prefs }, source)
      if (!first.installed) throw new Error('install failed')
      prefs.update(first.entry.id, { granted: { permissions: ['history'], origins: [] } })
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '1.1.0' }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW, prefs }, source)
      if (!second.installed) throw new Error('update failed')
      expect(prefs.get(first.entry.id).granted.permissions).toEqual([])
      expect(read(join(second.entry.path, 'manifest.json')).permissions).toEqual(['storage'])
    })
  })

  it('writes the base without the choices and loads a copy with them, for an extension the person already configured', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const prefs = createExtensionPrefsStore(null)
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW, prefs }, source)
      if (!first.installed) throw new Error('install failed')
      prefs.update(first.entry.id, { granted: { permissions: ['history'], origins: [] } })

      // A new version of the same install (the same source folder, bumped).
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '1.1.0', optional_permissions: ['history'] }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW, prefs }, source)
      if (!second.installed) throw new Error('update failed')
      expect(second.entry.id).toBe(first.entry.id)
      expect(read(join(dirname(second.entry.path), BASE_MANIFEST_FILE)).permissions).toEqual(['storage'])
      expect(read(join(second.entry.path, 'manifest.json')).permissions).toEqual(['storage', 'history'])
    })
  })

  it('leaves no base file behind when the first load fails', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session, setFailNextLoad } = fakeSession()
      setFailNextLoad(new Error('boom'))
      await expect(installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, writeFixtureFolder(root, FIXTURE_MANIFEST))).rejects.toThrow('boom')
      const root2 = join(userDataPath, 'extensions')
      const withBase = existsSync(root2) ? readdirSync(root2).filter((name) => existsSync(join(root2, name, BASE_MANIFEST_FILE))) : []
      expect(withBase).toEqual([])
    })
  })

  it('keeps the earlier base when an update fails to load', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session, setFailNextLoad } = fakeSession()
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      if (!first.installed) throw new Error('install failed')
      const base = join(dirname(first.entry.path), BASE_MANIFEST_FILE)
      const before = readFileSync(base, 'utf8')
      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '1.1.0', permissions: ['storage', 'tabs'] }))
      setFailNextLoad(new Error('boom'))
      await expect(installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)).rejects.toThrow('boom')
      expect(readFileSync(base, 'utf8')).toBe(before)
    })
  })
})

describe('uninstall and the preferences', () => {
  it('forgets the extension\'s choices and removes its base manifest', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const prefs = createExtensionPrefsStore(null)
      const ctx = { userDataPath, session, prompt: ALWAYS_ALLOW, prefs }
      const outcome = await installFromFolder(ctx, writeFixtureFolder(root, FIXTURE_MANIFEST))
      if (!outcome.installed) throw new Error('install failed')
      prefs.update(outcome.entry.id, { pinned: true })
      const heard = vi.fn()
      prefs.onChange(heard)
      await uninstall(ctx, outcome.entry.id)
      expect(prefs.get(outcome.entry.id).pinned).toBeNull()
      expect(heard).toHaveBeenCalledWith(outcome.entry.id)
      expect(existsSync(join(dirname(outcome.entry.path), BASE_MANIFEST_FILE))).toBe(false)
    })
  })
})
