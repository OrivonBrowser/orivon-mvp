import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createHash, sign as signWithKey } from 'node:crypto'
import AdmZip from 'adm-zip'
import Pbf from 'pbf'
import { installFromStoreCrx } from '../install-store-runner.js'
import { readRegistry } from '../registry-runner.js'
import { convertHexadecimalToIDAlphabet } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'
import { ALWAYS_ALLOW, ALWAYS_DENY, buildCrx, fakeSession, makeRsaKeyPair, withTempDir, type KeyPair } from './install-runner-fixtures.js'

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


