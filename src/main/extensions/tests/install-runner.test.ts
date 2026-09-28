import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto'
import AdmZip from 'adm-zip'
import Pbf from 'pbf'
import { installFromFile, installFromFolder, setEnabled, uninstall, type InstallContext } from '../install-runner.js'
import { readRegistry } from '../registry-runner.js'

/** A fake `Session` carrying just the two `extensions.*` methods
 * install-runner.ts calls -- a real `electron.Session` needs a running
 * Electron process, which this suite (plain vitest, no Electron) does not
 * have. `id` is derived from the loaded path, deterministically, the way a
 * real unpacked-extension id is (a hash of its own path) -- close enough
 * for these tests, which never assert a SPECIFIC id, only that one was
 * recorded and later found again. */
function fakeSession (): { session: InstallContext['session'], loaded: Map<string, string> } {
  const loaded = new Map<string, string>() // id -> path
  const session = {
    extensions: {
      loadExtension: async (path: string) => {
        const id = createHash('sha256').update(path).digest('hex').slice(0, 32)
        loaded.set(id, path)
        return { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
      },
      removeExtension: (id: string) => { loaded.delete(id) }
    }
  } as unknown as InstallContext['session']
  return { session, loaded }
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
