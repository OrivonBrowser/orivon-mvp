// Shared by the install-runner test files: a fake `Session`, prompts, a
// temp directory and the fixture manifests, plus the RSA key helper the
// CRX builders sign with.
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto'
import AdmZip from 'adm-zip'
import Pbf from 'pbf'
import type { InstallContext } from '../install-runner.js'
import { generateId } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'


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
export function fakeSession (): {
  session: InstallContext['session']
  loaded: Map<string, string>
  removedIds: string[]
  clearedStorage: unknown[]
  setFailNextLoad: (error: Error) => void
} {
  const loaded = new Map<string, string>() // id -> path
  const removedIds: string[] = []
  const clearedStorage: unknown[] = []
  let failNextLoad: Error | undefined
  const session = {
    clearStorageData: async (options: unknown) => { clearedStorage.push(options) },
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
  return { session, loaded, removedIds, clearedStorage, setFailNextLoad: (error) => { failNextLoad = error } }
}

export const ALWAYS_ALLOW: InstallContext['prompt'] = async () => true
export const ALWAYS_DENY: InstallContext['prompt'] = async () => false

export async function withTempDir (fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-install-runner-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function writeFixtureFolder (root: string, manifest: Record<string, unknown>): string {
  const dir = join(root, 'unpacked-fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'content.js'), 'console.log(1)')
  return dir
}

export const FIXTURE_MANIFEST = {
  manifest_version: 3,
  name: 'Fixture Extension',
  version: '1.0.0',
  permissions: ['storage']
}

export interface KeyPair { readonly publicKey: Buffer, readonly privateKey: KeyObject }

export function makeRsaKeyPair (): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  })
  return { publicKey: Buffer.from(publicKey), privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }) }
}

/** A CRX3 signed by one fresh developer key only. */
export function buildCrx (manifest: Record<string, unknown>): Buffer {
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
