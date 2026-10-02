// Builds a Chrome Web Store style CRX3 from a fixture folder, signed by a
// developer key and a stand-in publisher key, for the e2e suites that install
// from the store offline (store-download-seam.ts's test seam points the
// download and the publisher key hash at what these build).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto'
import AdmZip from 'adm-zip'
import Pbf from 'pbf'
import { convertHexadecimalToIDAlphabet } from '../vendor/electron-chrome-web-store/src/browser/id.js'

export interface KeyPair { readonly publicKey: Buffer, readonly privateKey: KeyObject }

export function makeRsaKeyPair (): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  })
  return { publicKey: Buffer.from(publicKey), privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }) }
}

const SIGNED_DATA_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary')

function writeProof (obj: { publicKey: Buffer, signature: Buffer }, pbf: Pbf): void {
  pbf.writeBytesField(1, obj.publicKey)
  pbf.writeBytesField(2, obj.signature)
}

function filesUnder (root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(root, path) : [path]
  })
}

/** A CRX3 around `archive` (a zip), signed by `dev` and, when `publisher` is given, also by it: the second proof
 * is what `requirePublisherProof: true` needs; omitting it builds the "refused" fixture. */
export function buildCrx (archive: Buffer, dev: KeyPair, publisher?: KeyPair): { bytes: Buffer, id: string } {
  const crxId = createHash('sha256').update(dev.publicKey).digest().subarray(0, 16)
  const signedHeaderData = (() => {
    const pbf = new Pbf()
    pbf.writeBytesField(1, crxId)
    return Buffer.from(pbf.finish())
  })()
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0)
  const dataToVerify = Buffer.concat([SIGNED_DATA_CONTEXT, lengthPrefix, signedHeaderData, archive])

  const proofs: KeyPair[] = publisher === undefined ? [dev] : [dev, publisher]
  const header = (() => {
    const pbf = new Pbf()
    for (const proof of proofs) {
      pbf.writeMessage(2, writeProof, { publicKey: proof.publicKey, signature: signWithKey('sha256', dataToVerify, proof.privateKey) })
    }
    pbf.writeBytesField(10000, signedHeaderData)
    return Buffer.from(pbf.finish())
  })()

  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'binary')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return { bytes: Buffer.concat([prefix, header, archive]), id: convertHexadecimalToIDAlphabet(crxId.toString('hex')) }
}

/** A CRX3 holding only a manifest.json. */
export function buildManifestCrx (manifest: Record<string, unknown>, dev: KeyPair, publisher?: KeyPair): { bytes: Buffer, id: string } {
  const archiveZip = new AdmZip()
  archiveZip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  return buildCrx(archiveZip.toBuffer(), dev, publisher)
}

/** A CRX3 of every file under `folder`, signed by `dev` and `publisher`. */
export function buildFolderCrx (folder: string, dev: KeyPair, publisher: KeyPair): { bytes: Buffer, id: string, publisherKeyHash: string } {
  const archiveZip = new AdmZip()
  for (const file of filesUnder(folder)) archiveZip.addFile(relative(folder, file).split(sep).join('/'), readFileSync(file))
  return {
    ...buildCrx(archiveZip.toBuffer(), dev, publisher),
    publisherKeyHash: createHash('sha256').update(publisher.publicKey).digest().toString('hex')
  }
}
