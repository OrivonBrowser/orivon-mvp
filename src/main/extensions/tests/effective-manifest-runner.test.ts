import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createManifestApplier, BASE_MANIFEST_FILE, readBaseManifestText, restoreBaseManifest } from '../effective-manifest-runner.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { writeRegistry } from '../registry-runner.js'
import type { InstalledExtension } from '../registry.js'
import { fakeSession, withTempDir } from './install-runner-fixtures.js'

// A stage that does something, so a change in the preferences changes the manifest.
vi.mock('../manifest-stage-granted.js', () => ({
  applyGrantedStage: (manifest: Record<string, unknown>, prefs: { granted: { permissions: readonly string[] } }) =>
    prefs.granted.permissions.length === 0 ? manifest : { ...manifest, permissions: [...(manifest['permissions'] as string[]), ...prefs.granted.permissions] }
}))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const BASE = { manifest_version: 3, name: 'x', version: '1.0.0', permissions: ['storage'] }

function seed (root: string, options: { enabled?: boolean, withBase?: boolean } = {}): { userDataPath: string, entry: InstalledExtension, slotDir: string } {
  const userDataPath = join(root, 'userData')
  const slotDir = join(userDataPath, 'extensions', 'slot')
  const path = join(slotDir, '1.0.0')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'manifest.json'), JSON.stringify(BASE))
  if (options.withBase !== false) writeFileSync(join(slotDir, BASE_MANIFEST_FILE), JSON.stringify(BASE))
  const entry: InstalledExtension = {
    id: ID, name: 'x', version: '1.0.0', enabled: options.enabled ?? true, installedAt: 1, updatedAt: 1,
    source: { kind: 'unpacked', from: '/x' }, updater: { kind: 'none', reason: 'none' }, path, stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
  }
  writeRegistry(userDataPath, [entry])
  return { userDataPath, entry, slotDir }
}

/** A fake session that already holds the extension, at the path its entry has. */
function loadedSession (entry: InstalledExtension): ReturnType<typeof fakeSession> {
  const fake = fakeSession()
  fake.loaded.set(ID, entry.path)
  return fake
}

const loadedText = (entry: InstalledExtension): string => readFileSync(join(entry.path, 'manifest.json'), 'utf8')

describe('applyManifest', () => {
  it('reloads nothing when the effective manifest is the one already loaded', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry } = seed(root)
      const fake = loadedSession(entry)
      const applier = createManifestApplier({ userDataPath, session: fake.session, prefs: createExtensionPrefsStore(null), isOpen: () => false })
      expect(await applier.applyManifest(ID, 'now')).toBe('unchanged')
      expect(fake.removedIds).toEqual([])
    })
  })

  it('writes the effective manifest into the version folder and reloads the extension', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry, slotDir } = seed(root)
      const fake = loadedSession(entry)
      const prefs = createExtensionPrefsStore(null)
      const applier = createManifestApplier({ userDataPath, session: fake.session, prefs, isOpen: () => false })
      prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
      expect(await applier.applyManifest(ID, 'now')).toBe('applied')
      expect(JSON.parse(loadedText(entry)).permissions).toEqual(['storage', 'history'])
      expect(fake.removedIds).toEqual([ID])
      expect([...fake.loaded.values()]).toEqual([entry.path])
      expect(JSON.parse(readBaseManifestText(slotDir) as string).permissions).toEqual(['storage'])
    })
  })

  it('goes back to the base manifest when the choice is taken back', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry } = seed(root)
      const fake = loadedSession(entry)
      const prefs = createExtensionPrefsStore(null)
      const applier = createManifestApplier({ userDataPath, session: fake.session, prefs, isOpen: () => false })
      prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
      await applier.applyManifest(ID, 'now')
      prefs.update(ID, { granted: { permissions: [], origins: [] } })
      expect(await applier.applyManifest(ID, 'now')).toBe('applied')
      expect(JSON.parse(loadedText(entry))).toEqual(BASE)
    })
  })

  it('makes the base from the loaded copy for an install that predates it', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry, slotDir } = seed(root, { withBase: false })
      const prefs = createExtensionPrefsStore(null)
      const applier = createManifestApplier({ userDataPath, session: loadedSession(entry).session, prefs, isOpen: () => false })
      expect(await applier.applyManifest(ID, 'now')).toBe('unchanged')
      expect(JSON.parse(readBaseManifestText(slotDir) as string)).toEqual(BASE)
    })
  })

  it('only writes the file for a disabled extension, and loads nothing', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry } = seed(root, { enabled: false })
      const fake = fakeSession()
      const prefs = createExtensionPrefsStore(null)
      const applier = createManifestApplier({ userDataPath, session: fake.session, prefs, isOpen: () => false })
      prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
      expect(await applier.applyManifest(ID, 'now')).toBe('applied')
      expect(JSON.parse(loadedText(entry)).permissions).toEqual(['storage', 'history'])
      expect(fake.loaded.size).toBe(0)
    })
  })

  it('answers unknown for an id the registry does not hold', async () => {
    await withTempDir(async (root) => {
      const { userDataPath } = seed(root)
      const applier = createManifestApplier({ userDataPath, session: fakeSession().session, prefs: createExtensionPrefsStore(null), isOpen: () => false })
      expect(await applier.applyManifest('zzz', 'now')).toBe('unknown')
    })
  })

  it('puts the old manifest back and reloads it when the new one will not load', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry } = seed(root)
      const fake = loadedSession(entry)
      const prefs = createExtensionPrefsStore(null)
      const applier = createManifestApplier({ userDataPath, session: fake.session, prefs, isOpen: () => false })
      prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
      fake.setFailNextLoad(new Error('bad manifest'))
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await applier.applyManifest(ID, 'now')).toBe('failed')
      error.mockRestore()
      expect(JSON.parse(loadedText(entry))).toEqual(BASE)
      expect([...fake.loaded.values()]).toEqual([entry.path])
    })
  })

  describe('quiet', () => {
    it('applies at once when no page of the extension is open', async () => {
      await withTempDir(async (root) => {
        const { userDataPath, entry } = seed(root)
        const prefs = createExtensionPrefsStore(null)
        const applier = createManifestApplier({ userDataPath, session: loadedSession(entry).session, prefs, isOpen: () => false })
        prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
        expect(await applier.applyManifest(ID, 'quiet')).toBe('applied')
      })
    })

    it('waits while a page is open and applies once it closes', async () => {
      await withTempDir(async (root) => {
        const { userDataPath, entry } = seed(root)
        const fake = loadedSession(entry)
        const prefs = createExtensionPrefsStore(null)
        let open = true
        let waits = 0
        const applier = createManifestApplier({
          userDataPath, session: fake.session, prefs, isOpen: () => open,
          wait: async () => { waits += 1; if (waits === 3) open = false }
        })
        prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
        expect(await applier.applyManifest(ID, 'quiet')).toBe('applied')
        expect(waits).toBe(3)
        expect(JSON.parse(loadedText(entry)).permissions).toEqual(['storage', 'history'])
      })
    })

    it('gives up after the longest wait, changes nothing and leaves the change for the next launch', async () => {
      await withTempDir(async (root) => {
        const { userDataPath, entry } = seed(root)
        const fake = loadedSession(entry)
        const prefs = createExtensionPrefsStore(null)
        const applier = createManifestApplier({
          userDataPath, session: fake.session, prefs, isOpen: () => true,
          wait: async () => {}, pollMs: 1000, maxWaitMs: 5000
        })
        prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
        expect(await applier.applyManifest(ID, 'quiet')).toBe('deferred')
        expect(JSON.parse(loadedText(entry))).toEqual(BASE)
        expect(fake.removedIds).toEqual([])
        // The next launch applies it before anything loads.
        createManifestApplier({ userDataPath, session: fakeSession().session, prefs, isOpen: () => false }).applyAtBoot()
        expect(JSON.parse(loadedText(entry)).permissions).toEqual(['storage', 'history'])
      })
    })

    it('lets a later "now" go ahead of a waiting quiet apply, which then finds nothing left to do', async () => {
      await withTempDir(async (root) => {
        const { userDataPath, entry } = seed(root)
        const fake = loadedSession(entry)
        const prefs = createExtensionPrefsStore(null)
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => { release = resolve })
        const applier = createManifestApplier({ userDataPath, session: fake.session, prefs, isOpen: () => true, wait: async () => { await gate } })
        prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
        const quiet = applier.applyManifest(ID, 'quiet')
        expect(await applier.applyManifest(ID, 'now')).toBe('applied')
        release()
        expect(await quiet).toBe('unchanged')
        expect(fake.removedIds).toEqual([ID])
      })
    })

    it('shares one wait between two quiet requests for the same extension', async () => {
      await withTempDir(async (root) => {
        const { userDataPath, entry } = seed(root)
        const prefs = createExtensionPrefsStore(null)
        let open = true
        const applier = createManifestApplier({ userDataPath, session: loadedSession(entry).session, prefs, isOpen: () => open, wait: async () => { open = false } })
        prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
        const results = await Promise.all([applier.applyManifest(ID, 'quiet'), applier.applyManifest(ID, 'quiet')])
        expect(results).toEqual(['applied', 'applied'])
      })
    })
  })
})

describe('applyAtBoot', () => {
  it('rewrites a loaded manifest that differs from its effective one, and nothing else', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry } = seed(root)
      const prefs = createExtensionPrefsStore(null)
      const applier = createManifestApplier({ userDataPath, session: fakeSession().session, prefs, isOpen: () => false })
      applier.applyAtBoot()
      expect(JSON.parse(loadedText(entry))).toEqual(BASE)
      prefs.update(ID, { granted: { permissions: ['tabs'], origins: [] } })
      applier.applyAtBoot()
      expect(JSON.parse(loadedText(entry)).permissions).toEqual(['storage', 'tabs'])
    })
  })

  it('goes on past an entry whose folder is gone', async () => {
    await withTempDir(async (root) => {
      const { userDataPath, entry } = seed(root)
      writeRegistry(userDataPath, [{ ...entry, id: 'gone', path: join(dirname(entry.path), 'missing') }, entry])
      const prefs = createExtensionPrefsStore(null)
      prefs.update(ID, { granted: { permissions: ['tabs'], origins: [] } })
      createManifestApplier({ userDataPath, session: fakeSession().session, prefs, isOpen: () => false }).applyAtBoot()
      expect(JSON.parse(loadedText(entry)).permissions).toEqual(['storage', 'tabs'])
    })
  })
})

describe('restoreBaseManifest', () => {
  it('puts the earlier text back, or removes the file when there was none', async () => {
    await withTempDir(async (root) => {
      const { slotDir } = seed(root)
      restoreBaseManifest(slotDir, '{"a":1}')
      expect(readBaseManifestText(slotDir)).toBe('{"a":1}')
      restoreBaseManifest(slotDir, undefined)
      expect(existsSync(join(slotDir, BASE_MANIFEST_FILE))).toBe(false)
    })
  })
})
