import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto'
import AdmZip from 'adm-zip'
import Pbf from 'pbf'
import {
  installFromFile, installFromFolder, installFromStoreCrx, isStrictlyInsideDirectory, resolveSlotKey, setEnabled,
  uninstall, type InstallContext
} from '../install-runner.js'
import { readRegistry } from '../registry-runner.js'
import { convertHexadecimalToIDAlphabet, generateId } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'

/** The id a real Electron session would derive for a loaded copy at `path`:
 * `generateId` (Chromium's own algorithm) of its manifest's own `key` when
 * it has one -- every copy install-runner.ts writes does, after the id-
 * stability fix -- else a hash of the path itself, the closest a manifest
 * with no key at all gets in real Electron (Chromium's
 * `id_util::GenerateIdForPath`). */
function idForLoadedPath (path: string): string {
  const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const key = typeof manifest.key === 'string' ? manifest.key : undefined
  return key !== undefined ? generateId(key) : createHash('sha256').update(path).digest('hex').slice(0, 32)
}

/** A fake `Session` carrying just the three `extensions.*` methods
 * install-runner.ts calls -- a real `electron.Session` needs a running
 * Electron process, which this suite (plain vitest, no Electron) does not
 * have. `setFailNextLoad` lets a test make the NEXT `loadExtension` call
 * throw, to exercise finishInstall's rollback path without touching real
 * Electron. `removedIds` records every `removeExtension` call, in order --
 * `loaded` alone cannot show a remove-then-reload of the SAME id happened,
 * since overwriting a Map entry looks identical to never having removed it. */
function fakeSession (): {
  session: InstallContext['session']
  loaded: Map<string, string>
  removedIds: string[]
  setFailNextLoad: (error: Error) => void
} {
  const loaded = new Map<string, string>() // id -> path
  const removedIds: string[] = []
  let failNextLoad: Error | undefined
  const session = {
    extensions: {
      loadExtension: async (path: string) => {
        if (failNextLoad !== undefined) {
          const error = failNextLoad
          failNextLoad = undefined
          throw error
        }
        const id = idForLoadedPath(path)
        loaded.set(id, path)
        return { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
      },
      removeExtension: (id: string) => { removedIds.push(id); loaded.delete(id) },
      getExtension: (id: string) => {
        const path = loaded.get(id)
        return path === undefined ? undefined : { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
      }
    }
  } as unknown as InstallContext['session']
  return { session, loaded, removedIds, setFailNextLoad: (error) => { failNextLoad = error } }
}

const ALWAYS_ALLOW: InstallContext['prompt'] = async () => true
const ALWAYS_DENY: InstallContext['prompt'] = async () => false

async function withTempDir (fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-install-runner-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function writeFixtureFolder (root: string, manifest: Record<string, unknown>): string {
  const dir = join(root, 'unpacked-fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'content.js'), 'console.log(1)')
  return dir
}

const FIXTURE_MANIFEST = {
  manifest_version: 3,
  name: 'Fixture Extension',
  version: '1.0.0',
  permissions: ['storage']
}

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

interface KeyPair { readonly publicKey: Buffer, readonly privateKey: KeyObject }

function makeRsaKeyPair (): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  })
  return { publicKey: Buffer.from(publicKey), privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }) }
}

function buildCrx (manifest: Record<string, unknown>): Buffer {
  const archiveZip = new AdmZip()
  archiveZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const archive = archiveZip.toBuffer()

  const dev = makeRsaKeyPair()
  const crxId = createHash('sha256').update(dev.publicKey).digest().subarray(0, 16)
  const signedHeaderData = (() => {
    const pbf = new Pbf()
    pbf.writeBytesField(1, crxId)
    return Buffer.from(pbf.finish())
  })()
  const context = Buffer.from('CRX3 SignedData\0', 'binary')
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0)
  const dataToVerify = Buffer.concat([context, lengthPrefix, signedHeaderData, archive])
  const signature = signWithKey('sha256', dataToVerify, dev.privateKey)

  const header = (() => {
    const pbf = new Pbf()
    pbf.writeMessage(2, (obj: { publicKey: Buffer, signature: Buffer }, pbf: Pbf) => {
      pbf.writeBytesField(1, obj.publicKey)
      pbf.writeBytesField(2, obj.signature)
    }, { publicKey: dev.publicKey, signature })
    pbf.writeBytesField(10000, signedHeaderData)
    return Buffer.from(pbf.finish())
  })()

  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'binary')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, archive])
}

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

describe('uninstall / setEnabled', () => {
  it('uninstall removes the session extension, the folder, and the registry entry', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      await uninstall({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id)
      expect(loaded.has(outcome.entry.id)).toBe(false)
      expect(existsSync(outcome.entry.path)).toBe(false)
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('setEnabled(false) unloads from the session and flips the registry flag; setEnabled(true) reloads it', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeFixtureFolder(root, FIXTURE_MANIFEST)
      const { session, loaded } = fakeSession()
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return

      await setEnabled({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id, false)
      expect(loaded.has(outcome.entry.id)).toBe(false)
      expect(readRegistry(userDataPath)[0]?.enabled).toBe(false)

      await setEnabled({ userDataPath, session, prompt: ALWAYS_ALLOW }, outcome.entry.id, true)
      expect(loaded.has(outcome.entry.id)).toBe(true)
      expect(readRegistry(userDataPath)[0]?.enabled).toBe(true)
    })
  })
})

interface StoreCrx { readonly bytes: Buffer, readonly id: string, readonly publisherKeyHash: Buffer }

/** A CRX3 signed by both a developer key and a "publisher" key -- the shape
 * `verifyCrx3(bytes, { requirePublisherProof: true })` requires. `dev`,
 * fixed across two calls, keeps the same declared extension id, the way two
 * versions of the same real store extension would. `publisherKeyHash` is
 * install-runner.ts's own injectable seam (crx.test.ts's own doc on why one
 * exists): a test has no way to sign with the real Chrome Web Store's key. */
function buildStoreCrx (manifest: Record<string, unknown>, dev: KeyPair = makeRsaKeyPair()): StoreCrx {
  const archiveZip = new AdmZip()
  archiveZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const archive = archiveZip.toBuffer()

  const publisher = makeRsaKeyPair()
  const crxId = createHash('sha256').update(dev.publicKey).digest().subarray(0, 16)
  const signedHeaderData = (() => {
    const pbf = new Pbf()
    pbf.writeBytesField(1, crxId)
    return Buffer.from(pbf.finish())
  })()
  const context = Buffer.from('CRX3 SignedData\0', 'binary')
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0)
  const dataToVerify = Buffer.concat([context, lengthPrefix, signedHeaderData, archive])
  const writeProof = (obj: { publicKey: Buffer, signature: Buffer }, pbf: Pbf): void => {
    pbf.writeBytesField(1, obj.publicKey)
    pbf.writeBytesField(2, obj.signature)
  }
  const header = (() => {
    const pbf = new Pbf()
    pbf.writeMessage(2, writeProof, { publicKey: dev.publicKey, signature: signWithKey('sha256', dataToVerify, dev.privateKey) })
    pbf.writeMessage(2, writeProof, { publicKey: publisher.publicKey, signature: signWithKey('sha256', dataToVerify, publisher.privateKey) })
    pbf.writeBytesField(10000, signedHeaderData)
    return Buffer.from(pbf.finish())
  })()
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'binary')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return {
    bytes: Buffer.concat([prefix, header, archive]),
    id: convertHexadecimalToIDAlphabet(crxId.toString('hex')),
    publisherKeyHash: createHash('sha256').update(publisher.publicKey).digest()
  }
}

const STORE_MANIFEST = {
  manifest_version: 3,
  name: 'Store Fixture',
  version: '1.0.0',
  host_permissions: ['https://a.example/*']
}

describe('installFromStoreCrx', () => {
  it('accepts a CRX carrying both a developer and a publisher proof, and installs it with source store', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const crx = buildStoreCrx(STORE_MANIFEST)
      const outcome = await installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_DENY }, // preApproved:true must skip this entirely
        crx.bytes,
        crx.id,
        JSON.stringify(STORE_MANIFEST),
        { skipPrompt: true, publisherKeyHash: crx.publisherKeyHash }
      )
      expect(outcome.installed).toBe(true)
      if (!outcome.installed) return
      expect(outcome.entry.id).toBe(crx.id)
      expect(outcome.entry.source).toEqual({ kind: 'store', storeId: crx.id })
      expect(outcome.entry.updater.kind).toBe('store')
    })
  })

  it('refuses when the CRX\'s own declared id does not match the requested id', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const crx = buildStoreCrx(STORE_MANIFEST)
      await expect(installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_ALLOW },
        crx.bytes,
        'some-other-requested-id',
        undefined,
        { skipPrompt: true, publisherKeyHash: crx.publisherKeyHash }
      )).rejects.toThrow(/does not match the requested/)
    })
  })

  it('refuses a CRX with no publisher proof, even with a valid developer proof', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const crxBytes = buildCrx(STORE_MANIFEST) // dev-only signed, this file's own helper above
      await expect(installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_ALLOW },
        crxBytes,
        'irrelevant', // never reached: verification fails first
        undefined,
        { skipPrompt: true }
      )).rejects.toThrow(/publisher/)
    })
  })

  it('holds back a downloaded manifest that asks for more than the approved one, writing nothing', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const dev = makeRsaKeyPair()
      const wider = { ...STORE_MANIFEST, host_permissions: ['https://a.example/*', 'https://b.example/*'] }
      const crx = buildStoreCrx(wider, dev)
      const outcome = await installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_ALLOW }, // must never be reached
        crx.bytes,
        crx.id,
        JSON.stringify(STORE_MANIFEST),
        { skipPrompt: true, publisherKeyHash: crx.publisherKeyHash }
      )
      expect(outcome).toEqual({ installed: false, reason: expect.stringMatching(/^needs your approval:/) })
      expect(readRegistry(userDataPath)).toEqual([])
    })
  })

  it('refuses a prompt-less store install that carries no approved manifest, and writes nothing', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const crx = buildStoreCrx(STORE_MANIFEST)
      const outcome = await installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_ALLOW },
        crx.bytes,
        crx.id,
        undefined,
        { skipPrompt: true, publisherKeyHash: crx.publisherKeyHash }
      )
      expect(outcome.installed).toBe(false)
      expect(existsSync(join(userDataPath, 'extensions', 'registry.json'))).toBe(false)
    })
  })

  it('an update wider than what is installed is held back, and the held-back entry\'s lastResult says so', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const dev = makeRsaKeyPair()
      const narrow = buildStoreCrx(STORE_MANIFEST, dev)
      const first = await installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_ALLOW },
        narrow.bytes,
        narrow.id,
        JSON.stringify(STORE_MANIFEST),
        { skipPrompt: true, publisherKeyHash: narrow.publisherKeyHash }
      )
      expect(first.installed).toBe(true)
      if (!first.installed) return

      const wider = { ...STORE_MANIFEST, version: '2.0.0', host_permissions: ['https://a.example/*', 'https://b.example/*'] }
      const update = buildStoreCrx(wider, dev)
      const outcome = await installFromStoreCrx(
        { userDataPath, session, prompt: ALWAYS_ALLOW },
        update.bytes,
        narrow.id,
        JSON.stringify(STORE_MANIFEST),
        { skipPrompt: true, publisherKeyHash: update.publisherKeyHash, downloadUrl: 'https://example.test/update.crx' }
      )
      expect(outcome.installed).toBe(false)
      if (outcome.installed) return
      expect(outcome.reason).toMatch(/^needs your approval:/)

      const held = readRegistry(userDataPath).find((entry) => entry.id === narrow.id)
      expect(held?.updater.kind).toBe('store')
      expect(held?.updater.kind === 'store' ? held.updater.lastResult : undefined).toBe(outcome.reason)
      expect(held?.updater.kind === 'store' ? held.updater.pendingUpdate : undefined).toEqual({
        url: 'https://example.test/update.crx',
        version: '2.0.0'
      })
      // The version actually loaded is still the first, narrow one.
      expect(held?.version).toBe('1.0.0')
    })
  })
})

// The second, grammar-independent layer README.md's Design notes describes:
// finishInstall refuses a targetDir/slotDir that does not resolve strictly
// inside its own parent, the same shape unpack-runner.ts's checkZipEntryPath
// uses for a zip entry -- tested directly here, not only through a `version`
// string readExtensionManifest's own grammar check already refuses.
describe('isStrictlyInsideDirectory', () => {
  it('is true for an ordinary child directory', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot/1.0.0')).toBe(true)
  })

  it('is false for the parent itself', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot')).toBe(false)
  })

  it('is false for a path that escapes via ..', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot/../../../../.config/autostart')).toBe(false)
  })

  it('is false for a sibling directory with the parent as a string prefix', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot-evil/x')).toBe(false)
  })
})
