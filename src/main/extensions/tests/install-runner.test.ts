import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import AdmZip from 'adm-zip'
import { installFromFile, installFromFolder, resolveSlotKey } from '../install-runner.js'
import { readRegistry } from '../registry-runner.js'
import { takePendingInstalled } from '../runtime-installed.js'
import { generateId } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'
import { ALWAYS_ALLOW, ALWAYS_DENY, FIXTURE_MANIFEST, buildCrx, fakeSession, withTempDir, writeFixtureFolder } from './install-runner-fixtures.js'

describe('installFromFolder', () => {
  it('shows the prompt, copies the folder, loads it, and records it in the registry', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      expect(outcome.entry.name).toBe('Fixture Extension')
      expect(outcome.entry.source).toEqual({ kind: 'unpacked', from: source })
      expect(outcome.entry.updater.kind).toBe('none')
      expect(existsSync(join(outcome.entry.path, 'manifest.json'))).toBe(true)
      expect(existsSync(join(outcome.entry.path, 'content.js'))).toBe(true)
      const registry = readRegistry(userDataPath)
      expect(registry).toHaveLength(1)
      expect(registry[0]).toEqual(outcome.entry)
    })
  })

  it('never writes anything when the person declines the prompt', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_DENY }, source)
      expect(outcome).toEqual({ installed: false, reason: 'declined by the person' })
      expect(existsSync(join(userDataPath, 'extensions'))).toBe(false)
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('on a fresh install whose load fails, removes the folder it just wrote instead of leaving it behind', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded, setFailNextLoad } = fakeSession()
      setFailNextLoad(new Error('boom: simulated first-ever load failure'))
      await expect(installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)).rejects.toThrow('boom')

      // Nothing was loaded, and nothing was left on disk under extensions/
      // for a later boot to trip over -- the write happened (that is the
      // point of this test), but a failed load must not leave it behind.
      expect(loaded.size).toBe(0)
      expect(readRegistry(userDataPath)).toEqual([])
      const extensionsDir = join(userDataPath, 'extensions')
      const slotDirs = existsSync(extensionsDir) ? readdirSync(extensionsDir) : []
      for (const slot of slotDirs) {
        const versionDirs = readdirSync(join(extensionsDir, slot)).filter((name) => name !== 'key.pub')
        expect(versionDirs).toEqual([])
      }
    })
  })

  it('refuses a manifest carrying the orivon key before ever showing the prompt', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, { ...FIXTURE_MANIFEST, orivon: { permissions: ['self'] } })
      let promptCalled = false
      const { session } = fakeSession()
      const outcome = await installFromFolder(
        { userDataPath, session, prompt: async () => { promptCalled = true; return true } },
        source
      )
      expect(outcome).toEqual({ installed: false, reason: 'manifest refused: Orivon permissions are not supported yet' })
      expect(promptCalled).toBe(false)
    })
  })

  it('writes a loaded manifest.json with webRequest/declarativeNetRequest/nativeMessaging stripped', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, {
        ...FIXTURE_MANIFEST,
        permissions: ['storage', 'webRequest', 'nativeMessaging'],
        declarative_net_request: { rule_resources: [] }
      })
      const { session } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const written = JSON.parse(readFileSync(join(outcome.entry.path, 'manifest.json'), 'utf8')) as Record<string, unknown>
      expect(written.permissions).toEqual(['storage'])
      expect(written.declarative_net_request).toBeUndefined()
      expect([...outcome.entry.stripped.permissions].sort()).toEqual(['nativeMessaging', 'webRequest'])
    })
  })

  it('replaces an existing entry and removes the old version\'s folder on a re-install with a new version', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      const firstPath = first.entry.path

      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed).toBe(true)
      if (!second.installed) return

      // Same source folder -> same slot -> this is treated as an update,
      // even though a real unpacked extension's Electron-reported id
      // differs per version (its own path is what Electron hashes, and the
      // version segment of that path just changed) -- see finishInstall's
      // own comment on why matching is by slot, not by id, here.
      expect(second.entry.path).not.toBe(first.entry.path)
      expect(existsSync(firstPath)).toBe(false)
      expect(readRegistry(userDataPath)).toHaveLength(1)
    })
  })

  it('parks the onInstalled details before the load: install first, then update with the version it replaced', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      if (!first.installed) throw new Error('first install refused')
      expect(takePendingInstalled(first.entry.id)).toEqual({ reason: 'install' })

      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed).toBe(true)
      expect(takePendingInstalled(first.entry.id)).toEqual({ reason: 'update', previousVersion: first.entry.version })
    })
  })

  it('parks nothing when an update\'s load fails and the previous version is loaded back', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, setFailNextLoad } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      if (!first.installed) throw new Error('first install refused')
      expect(takePendingInstalled(first.entry.id)).toEqual({ reason: 'install' })

      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      setFailNextLoad(new Error('boom'))
      await expect(installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)).rejects.toThrow('boom')
      expect(takePendingInstalled(first.entry.id)).toBeUndefined()
    })
  })

  it('keeps the same id across an update, and unloads the old version from the session before the new one loads', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded, removedIds } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      const firstId = first.entry.id

      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed).toBe(true)
      if (!second.installed) return

      // A slot-generated key is reused for every install into the same
      // slot, so a real Electron session derives the same id every time --
      // chrome.storage, logins and every per-extension setting stay keyed
      // to the right entry across an update.
      expect(second.entry.id).toBe(firstId)
      // The old version was actually removed from the session before the
      // new one loaded, not just silently overwritten in the map.
      expect(removedIds).toEqual([firstId])
      expect(loaded.size).toBe(1)
      expect(loaded.get(firstId)).toBe(second.entry.path)
    })
  })

  it('on a failed load, reloads the previous version and leaves the registry and its folder untouched', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded, removedIds, setFailNextLoad } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      const firstPath = first.entry.path
      const firstId = first.entry.id

      writeFileSync(join(source, 'manifest.json'), JSON.stringify({ ...FIXTURE_MANIFEST, version: '2.0.0' }))
      setFailNextLoad(new Error('boom: simulated new-version load failure'))
      await expect(installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)).rejects.toThrow('boom')

      // The old version was removed before the failed load attempt, then
      // loaded back afterward -- under its own id and path, same as before.
      expect(removedIds).toEqual([firstId])
      expect(loaded.get(firstId)).toBe(firstPath)
      // The registry and the old version's folder are exactly as they were.
      expect(existsSync(firstPath)).toBe(true)
      const registry = readRegistry(userDataPath)
      expect(registry).toHaveLength(1)
      expect(registry[0]).toEqual(first.entry)
    })
  })

  it('reinstalls the same version over itself (Developer mode Reload, or a same-version store reinstall) without ENOTEMPTY', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded, removedIds } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      const firstId = first.entry.id
      const firstPath = first.entry.path

      // No version bump -- edited content only, as a Reload click would produce.
      writeFileSync(join(source, 'content.js'), 'console.log(2)')
      const second = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(second.installed).toBe(true)
      if (!second.installed) return

      expect(second.entry.path).toBe(firstPath)
      expect(second.entry.id).toBe(firstId)
      expect(readFileSync(join(second.entry.path, 'content.js'), 'utf8')).toBe('console.log(2)')
      expect(removedIds).toEqual([firstId])
      expect(loaded.get(firstId)).toBe(firstPath)
      expect(readRegistry(userDataPath)).toHaveLength(1)
      // The moved-aside old folder was deleted once the new one loaded.
      const siblings = readdirSync(dirname(firstPath))
      expect(siblings.some((name) => name.includes('.old-'))).toBe(false)
    })
  })

  it('on a failed same-version reinstall, restores the old folder\'s own content and reloads it', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded, removedIds, setFailNextLoad } = fakeSession()
      const first = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      const firstId = first.entry.id
      const firstPath = first.entry.path

      writeFileSync(join(source, 'content.js'), 'console.log(2)')
      setFailNextLoad(new Error('boom: simulated reinstall failure'))
      await expect(installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)).rejects.toThrow('boom')

      // The old folder's own content is back in place, loaded again under the same id.
      expect(readFileSync(join(firstPath, 'content.js'), 'utf8')).toBe('console.log(1)')
      expect(loaded.get(firstId)).toBe(firstPath)
      expect(removedIds).toEqual([firstId])
      const registry = readRegistry(userDataPath)
      expect(registry).toHaveLength(1)
      expect(registry[0]).toEqual(first.entry)
      const siblings = readdirSync(dirname(firstPath))
      expect(siblings.some((name) => name.includes('.old-'))).toBe(false)
    })
  })
})

// Symlink refusal is tested directly against `writeFolderCopy` in
// unpack-runner.test.ts, which is where that check now lives.

describe('installFromFile', () => {
  it('installs a .zip with no signature, slotted by the file\'s own bytes', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const zip = new AdmZip()
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(FIXTURE_MANIFEST)))
      const zipPath = join(root, 'fixture.zip')
      writeFileSync(zipPath, zip.toBuffer())
      const { session } = fakeSession()
      const outcome = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, zipPath)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      expect(outcome.entry.source).toEqual({ kind: 'file', fileName: zipPath })
      expect(existsSync(join(outcome.entry.path, 'manifest.json'))).toBe(true)
    })
  })

  it('a newer keyed .zip lands in the SAME slot as an earlier keyed .zip carrying the same key, as an update', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const { publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' }
      })
      const key = publicKey.toString('base64')

      const zipV1 = new AdmZip()
      zipV1.addFile('manifest.json', Buffer.from(JSON.stringify({ ...FIXTURE_MANIFEST, key })))
      const pathV1 = join(root, 'fixture-v1.zip')
      writeFileSync(pathV1, zipV1.toBuffer())
      const first = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, pathV1)
      expect(first.installed).toBe(true)
      if (!first.installed) return

      // A DIFFERENT .zip file (different bytes, different name, a bumped
      // version), carrying the same manifest key -- before this fix, a
      // `.zip`'s slot was always the hash of its own bytes, so this landed
      // as a second, unrelated extension instead of updating the first.
      const zipV2 = new AdmZip()
      zipV2.addFile('manifest.json', Buffer.from(JSON.stringify({ ...FIXTURE_MANIFEST, key, version: '2.0.0' })))
      zipV2.addFile('extra.js', Buffer.from('// v2'))
      const pathV2 = join(root, 'fixture-v2.zip')
      writeFileSync(pathV2, zipV2.toBuffer())
      const second = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, pathV2)
      expect(second.installed).toBe(true)
      if (!second.installed) return

      expect(second.entry.id).toBe(first.entry.id)
      expect(second.entry.version).toBe('2.0.0')
      expect(readRegistry(userDataPath)).toHaveLength(1)
      expect(existsSync(first.entry.path)).toBe(false)
    })
  })

  it('two key-less .zip files never collide, each installing as its own extension', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()

      const zipA = new AdmZip()
      zipA.addFile('manifest.json', Buffer.from(JSON.stringify(FIXTURE_MANIFEST)))
      const pathA = join(root, 'fixture-a.zip')
      writeFileSync(pathA, zipA.toBuffer())
      const a = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, pathA)
      expect(a.installed).toBe(true)

      const zipB = new AdmZip()
      zipB.addFile('manifest.json', Buffer.from(JSON.stringify({ ...FIXTURE_MANIFEST, name: 'Second' })))
      const pathB = join(root, 'fixture-b.zip')
      writeFileSync(pathB, zipB.toBuffer())
      const b = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, pathB)
      expect(b.installed).toBe(true)
      if (!a.installed || !b.installed) return

      expect(a.entry.id).not.toBe(b.entry.id)
      expect(readRegistry(userDataPath)).toHaveLength(2)
    })
  })

  it('installs a signed .crx, requiring only the developer proof, and writes the derived key into the loaded manifest', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const crxBytes = buildCrx(FIXTURE_MANIFEST)
      const crxPath = join(root, 'fixture.crx')
      writeFileSync(crxPath, crxBytes)
      const { session } = fakeSession()
      const outcome = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, crxPath)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const written = JSON.parse(readFileSync(join(outcome.entry.path, 'manifest.json'), 'utf8')) as Record<string, unknown>
      expect(typeof written.key).toBe('string')
    })
  })

  it('refuses a tampered .crx before ever writing or prompting', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const crxBytes = buildCrx(FIXTURE_MANIFEST)
      crxBytes[crxBytes.length - 1] = (crxBytes[crxBytes.length - 1] as number) ^ 0xff
      const crxPath = join(root, 'fixture.crx')
      writeFileSync(crxPath, crxBytes)
      const { session } = fakeSession()
      await expect(installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, crxPath)).rejects.toThrow()
      expect(existsSync(join(userDataPath, 'extensions'))).toBe(false)
    })
  })

  it('replaces a signed .crx\'s own manifest key with the verified developer key, never keeping the manifest\'s claim', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      // A manifest key plausibly belonging to another, already-installed
      // extension -- Chrome ignores a packed CRX's manifest `key`, and so
      // must this install: keeping it would let a signed .crx take over
      // whatever id that key derives.
      const foreignKey = resolveSlotKey(userDataPath, 'someone-elses-slot')
      const crxBytes = buildCrx({ ...FIXTURE_MANIFEST, key: foreignKey })
      const crxPath = join(root, 'fixture.crx')
      writeFileSync(crxPath, crxBytes)
      const outcome = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, crxPath)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      const written = JSON.parse(readFileSync(join(outcome.entry.path, 'manifest.json'), 'utf8')) as Record<string, unknown>
      expect(written.key).not.toBe(foreignKey)
      expect(outcome.entry.id).not.toBe(generateId(foreignKey))
    })
  })

  it('refuses an install whose resolved id is already used by a different slot', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const crxBytes = buildCrx(FIXTURE_MANIFEST)
      const crxPath = join(root, 'fixture.crx')
      writeFileSync(crxPath, crxBytes)
      const first = await installFromFile({ userDataPath, session, prompt: ALWAYS_ALLOW }, crxPath)
      expect(first.installed).toBe(true)
      if (!first.installed) return
      const smuggledKey = (JSON.parse(readFileSync(join(first.entry.path, 'manifest.json'), 'utf8')) as { key: string }).key

      // A folder install (no developer key of its own) whose manifest
      // claims the .crx's own derived key -- the same id, a different slot.
      const folderDir = writeFixtureFolder(root, { ...FIXTURE_MANIFEST, name: 'Impostor', key: smuggledKey })
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, folderDir)
      expect(outcome).toEqual({ installed: false, reason: 'another installed extension already uses this id' })
      expect(readRegistry(userDataPath)).toHaveLength(1)
    })
  })
})
