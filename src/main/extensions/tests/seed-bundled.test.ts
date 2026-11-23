import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { refreshBundledExtensions, seedBundledExtensions } from '../seed-bundled.js'
import { prepareBundledFolder } from '../bundled-folder.js'
import { readRegistry, writeRegistry } from '../registry-runner.js'
import { takePendingInstalled } from '../runtime-installed.js'
import { FIXTURE_MANIFEST, buildCrx, fakeSession, makeRsaKeyPair, withTempDir } from './install-runner-fixtures.js'

/** A default profile folder holding `a.crx`, unpacked as a build leaves it, and its list. */
function defaultProfile (root: string, manifest: Record<string, unknown> = FIXTURE_MANIFEST, developer = makeRsaKeyPair()): string {
  const dir = join(root, 'default-profile')
  mkdirSync(join(dir, 'extensions'), { recursive: true })
  const bytes = buildCrx(manifest, developer)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(dir, 'extensions', 'a.crx'), bytes)
  prepareBundledFolder(join(dir, 'extensions'), 'a.crx', 'a', sha256)
  writeFileSync(join(dir, 'bundled-extensions.json'), JSON.stringify([{ file: 'a.crx', name: 'A', pinned: true, sha256 }]))
  return dir
}

describe('seedBundledExtensions', () => {
  it('installs each listed extension, and leaves the registry file in place so no later start seeds again', async () => {
    await withTempDir(async (root) => {
      const dir = defaultProfile(root)
      const userDataPath = join(root, 'userData')
      expect(existsSync(join(userDataPath, 'extensions', 'registry.json'))).toBe(false)

      await seedBundledExtensions({ userDataPath, session: fakeSession().session, prompt: async () => { throw new Error('asked') } }, dir)

      expect(readRegistry(userDataPath)).toHaveLength(1)
      expect(readRegistry(userDataPath)[0]?.path).toBe(join(dir, 'extensions', 'a'))
      expect(existsSync(join(userDataPath, 'extensions', 'registry.json'))).toBe(true)
    })
  })

  it('logs an extension that is not unpacked and carries on', async () => {
    await withTempDir(async (root) => {
      const dir = join(root, 'default-profile')
      mkdirSync(join(dir, 'extensions'), { recursive: true })
      writeFileSync(join(dir, 'extensions', 'bad.crx'), 'not a crx')
      writeFileSync(join(dir, 'bundled-extensions.json'), JSON.stringify([{ file: 'bad.crx', name: 'Bad', pinned: false }]))
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      await seedBundledExtensions({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: async () => true }, dir)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Bad is not installed'))
      log.mockRestore()
    })
  })

  it('logs a folder whose record is missing and carries on', async () => {
    await withTempDir(async (root) => {
      const dir = defaultProfile(root)
      rmSync(join(dir, 'extensions', 'a.bundled.json'))
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      await seedBundledExtensions({ userDataPath: join(root, 'userData'), session: fakeSession().session, prompt: async () => true }, dir)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('A was not installed'))
      expect(readRegistry(join(root, 'userData'))).toEqual([])
      log.mockRestore()
    })
  })
})

describe('refreshBundledExtensions', () => {
  async function seeded (root: string, developer = makeRsaKeyPair()): Promise<{ dir: string, userDataPath: string }> {
    const dir = defaultProfile(root, FIXTURE_MANIFEST, developer)
    const userDataPath = join(root, 'userData')
    await seedBundledExtensions({ userDataPath, session: fakeSession().session, prompt: async () => { throw new Error('asked') } }, dir)
    return { dir, userDataPath }
  }

  it('changes nothing when the entry already describes its folder', async () => {
    await withTempDir(async (root) => {
      const { dir, userDataPath } = await seeded(root)
      const before = readRegistry(userDataPath)
      refreshBundledExtensions(userDataPath, dir)
      expect(readRegistry(userDataPath)).toEqual(before)
    })
  })

  it('moves the entry to the folder where the application is now, as a package that mounts elsewhere at each start needs', async () => {
    await withTempDir(async (root) => {
      const { dir, userDataPath } = await seeded(root)
      const [entry] = readRegistry(userDataPath)
      writeRegistry(userDataPath, [{ ...entry!, path: join(root, 'gone', 'default-profile', 'extensions', 'a') }])
      refreshBundledExtensions(userDataPath, dir)
      expect(readRegistry(userDataPath)[0]?.path).toBe(join(dir, 'extensions', 'a'))
      expect(readRegistry(userDataPath)[0]?.updatedAt).toBe(entry!.updatedAt)
    })
  })

  it('brings the version of a newer Orivon, keeping what the person chose, and tells the extension it was updated', async () => {
    await withTempDir(async (root) => {
      const developer = makeRsaKeyPair()
      const { userDataPath } = await seeded(root, developer)
      const [entry] = readRegistry(userDataPath)
      takePendingInstalled(entry!.id) // what the first install parked, taken by its worker
      writeRegistry(userDataPath, [{ ...entry!, enabled: false }])
      const newer = join(root, 'newer-orivon', 'default-profile')
      mkdirSync(join(newer, 'extensions'), { recursive: true })
      const bytes = buildCrx({ ...FIXTURE_MANIFEST, version: '2.0.0' }, developer)
      writeFileSync(join(newer, 'extensions', 'a.crx'), bytes)
      prepareBundledFolder(join(newer, 'extensions'), 'a.crx', 'a', createHash('sha256').update(bytes).digest('hex'))
      writeFileSync(join(newer, 'bundled-extensions.json'), JSON.stringify([{ file: 'a.crx', name: 'A', pinned: true }]))

      refreshBundledExtensions(userDataPath, newer)
      const [after] = readRegistry(userDataPath)
      expect(after).toMatchObject({ id: entry!.id, version: '2.0.0', path: join(newer, 'extensions', 'a'), enabled: false, installedAt: entry!.installedAt, source: { kind: 'bundled', folder: 'a' } })
      expect(after!.updatedAt).toBeGreaterThanOrEqual(entry!.updatedAt)
      // Switched off, it is not told anything: nothing loads it.
      expect(takePendingInstalled(entry!.id)).toBeUndefined()

      writeRegistry(userDataPath, [{ ...after!, enabled: true, version: '1.0.0' }])
      refreshBundledExtensions(userDataPath, newer)
      expect(takePendingInstalled(entry!.id)).toEqual({ reason: 'update', previousVersion: '1.0.0' })
    })
  })

  it('leaves alone an extension the person installed over the bundled one, and adds nothing to a registry without it', async () => {
    await withTempDir(async (root) => {
      const { dir, userDataPath } = await seeded(root)
      const [entry] = readRegistry(userDataPath)
      const theirs = { ...entry!, version: '9.0.0', path: join(userDataPath, 'extensions', entry!.id, '9.0.0'), source: { kind: 'file' as const, fileName: '/somewhere/a.crx' } }
      writeRegistry(userDataPath, [theirs])
      refreshBundledExtensions(userDataPath, dir)
      expect(readRegistry(userDataPath)).toEqual([theirs])

      writeRegistry(userDataPath, [])
      refreshBundledExtensions(userDataPath, dir)
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('keeps the folder an entry has when the folder is another extension', async () => {
    await withTempDir(async (root) => {
      const { userDataPath } = await seeded(root)
      const other = defaultProfile(join(root, 'other'))
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const before = readRegistry(userDataPath)
      refreshBundledExtensions(userDataPath, other)
      expect(readRegistry(userDataPath)).toEqual(before)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('is not the extension in'))
      log.mockRestore()
    })
  })

  it('never throws, whatever the list holds', async () => {
    await withTempDir(async (root) => {
      const { dir, userDataPath } = await seeded(root)
      writeFileSync(join(dir, 'bundled-extensions.json'), '{ not json')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(() => { refreshBundledExtensions(userDataPath, dir) }).not.toThrow()
      log.mockRestore()
    })
  })
})
