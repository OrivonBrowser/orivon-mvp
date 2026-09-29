import { describe, expect, it } from 'vitest'
import { createHash, createPrivateKey, generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto'
import Pbf from 'pbf'
import { verifyCrx3 } from '../crx.js'
import { convertHexadecimalToIDAlphabet } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'

// Builds real CRX3 files with real key pairs, rather than mocking
// node:crypto -- crx.ts's whole job is verifying signatures, so a fixture
// that never produces one would not exercise it.

const SIGNED_DATA_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary')
const ARCHIVE = Buffer.from('fixture zip bytes, opaque to crx.ts')

interface KeyPair { readonly publicKey: Buffer, readonly privateKey: KeyObject }

function makeKeyPair (kind: 'rsa' | 'ec'): KeyPair {
  const { publicKey, privateKey } = kind === 'rsa'
    ? generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    })
    : generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    })
  return { publicKey: Buffer.from(publicKey), privateKey: createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }) }
}

function keyHash16 (publicKey: Buffer): Buffer {
  return createHash('sha256').update(publicKey).digest().subarray(0, 16)
}

function sha256 (data: Buffer): Buffer {
  return createHash('sha256').update(data).digest()
}

function encodeSignedData (crxId: Buffer): Buffer {
  const pbf = new Pbf()
  pbf.writeBytesField(1, crxId)
  return Buffer.from(pbf.finish())
}

function dataToVerify (signedHeaderData: Buffer, archive: Buffer): Buffer {
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0)
  return Buffer.concat([SIGNED_DATA_CONTEXT, lengthPrefix, signedHeaderData, archive])
}

interface ProofSpec { readonly tag: 2 | 3, readonly publicKey: Buffer, readonly signature: Buffer }

function writeProofMessage (obj: { publicKey: Buffer, signature: Buffer }, pbf: Pbf): void {
  pbf.writeBytesField(1, obj.publicKey)
  pbf.writeBytesField(2, obj.signature)
}

function encodeCrxFileHeader (proofs: readonly ProofSpec[], signedHeaderData: Buffer): Buffer {
  const pbf = new Pbf()
  for (const proof of proofs) {
    pbf.writeMessage(proof.tag, writeProofMessage, { publicKey: proof.publicKey, signature: proof.signature })
  }
  pbf.writeBytesField(10000, signedHeaderData)
  return Buffer.from(pbf.finish())
}

function encodeCrx3 (header: Buffer, archive: Buffer, version = 3): Buffer {
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'binary')
  prefix.writeUInt32LE(version, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, archive])
}

/** One developer proof, signed correctly over `archive`, for the base case
 * every tampering test starts from and mutates one piece of. */
function buildValidCrx (kind: 'rsa' | 'ec' = 'rsa', archive = ARCHIVE): { bytes: Buffer, dev: KeyPair, crxId: Buffer, tag: 2 | 3 } {
  const dev = makeKeyPair(kind)
  const crxId = keyHash16(dev.publicKey)
  const signedHeaderData = encodeSignedData(crxId)
  const signature = signWithKey('sha256', dataToVerify(signedHeaderData, archive), dev.privateKey)
  const tag = kind === 'rsa' ? 2 : 3
  const header = encodeCrxFileHeader([{ tag, publicKey: dev.publicKey, signature }], signedHeaderData)
  return { bytes: encodeCrx3(header, archive), dev, crxId, tag }
}

describe('verifyCrx3', () => {
  it('accepts a validly signed CRX3 with one RSA developer proof', () => {
    const { bytes, dev, crxId } = buildValidCrx('rsa')
    const result = verifyCrx3(bytes, { requirePublisherProof: false })
    expect(result.id).toBe(convertHexadecimalToIDAlphabet(crxId.toString('hex')))
    expect(result.developerPublicKey.equals(dev.publicKey)).toBe(true)
    expect(result.archive.equals(ARCHIVE)).toBe(true)
  })

  it('accepts a validly signed CRX3 with one P-256 (ECDSA) developer proof', () => {
    const { bytes, dev, crxId } = buildValidCrx('ec')
    const result = verifyCrx3(bytes, { requirePublisherProof: false })
    expect(result.id).toBe(convertHexadecimalToIDAlphabet(crxId.toString('hex')))
    expect(result.developerPublicKey.equals(dev.publicKey)).toBe(true)
  })

  it('refuses a CRX3 whose archive bytes were tampered with after signing', () => {
    const { bytes } = buildValidCrx('rsa')
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff
    expect(() => verifyCrx3(tampered, { requirePublisherProof: false })).toThrow()
  })

  it('refuses a CRX3 whose signed_header_data was tampered with after signing', () => {
    const dev = makeKeyPair('rsa')
    const crxId = keyHash16(dev.publicKey)
    const signedHeaderDataSigned = encodeSignedData(crxId)
    const signature = signWithKey('sha256', dataToVerify(signedHeaderDataSigned, ARCHIVE), dev.privateKey)
    // The header actually shipped carries a DIFFERENT signed_header_data
    // than the one the signature above was computed over -- exactly what a
    // post-signing edit to the header would produce.
    const tamperedCrxId = Buffer.from(crxId)
    tamperedCrxId[0] = (tamperedCrxId[0] as number) ^ 0xff
    const signedHeaderDataShipped = encodeSignedData(tamperedCrxId)
    const header = encodeCrxFileHeader([{ tag: 2, publicKey: dev.publicKey, signature }], signedHeaderDataShipped)
    const bytes = encodeCrx3(header, ARCHIVE)
    expect(() => verifyCrx3(bytes, { requirePublisherProof: false })).toThrow()
  })

  it('refuses a proof whose key does not match the declared extension id, even with a genuinely valid signature', () => {
    const dev = makeKeyPair('rsa')
    const other = makeKeyPair('rsa')
    const crxId = keyHash16(dev.publicKey) // declares dev's id...
    const signedHeaderData = encodeSignedData(crxId)
    // ...but the only proof shipped is signed by a DIFFERENT key.
    const signature = signWithKey('sha256', dataToVerify(signedHeaderData, ARCHIVE), other.privateKey)
    const header = encodeCrxFileHeader([{ tag: 2, publicKey: other.publicKey, signature }], signedHeaderData)
    const bytes = encodeCrx3(header, ARCHIVE)
    expect(() => verifyCrx3(bytes, { requirePublisherProof: false })).toThrow(/matches the declared extension id/)
  })

  it('refuses when a publisher proof is required and absent', () => {
    const { bytes } = buildValidCrx('rsa')
    expect(() => verifyCrx3(bytes, { requirePublisherProof: true })).toThrow(/publisher/)
  })

  it('accepts a publisher proof whose key hash is supplied through options (test-only seam)', () => {
    const dev = makeKeyPair('rsa')
    const publisher = makeKeyPair('ec')
    const crxId = keyHash16(dev.publicKey)
    const signedHeaderData = encodeSignedData(crxId)
    const data = dataToVerify(signedHeaderData, ARCHIVE)
    const devSignature = signWithKey('sha256', data, dev.privateKey)
    const publisherSignature = signWithKey('sha256', data, publisher.privateKey)
    const header = encodeCrxFileHeader([
      { tag: 2, publicKey: dev.publicKey, signature: devSignature },
      { tag: 3, publicKey: publisher.publicKey, signature: publisherSignature }
    ], signedHeaderData)
    const bytes = encodeCrx3(header, ARCHIVE)
    const publisherKeyHash = sha256(publisher.publicKey)
    const result = verifyCrx3(bytes, { requirePublisherProof: true, publisherKeyHash })
    expect(result.id).toBe(convertHexadecimalToIDAlphabet(crxId.toString('hex')))
  })

  it('refuses CRX2', () => {
    const { bytes } = buildValidCrx('rsa')
    // Same 12-byte prefix shape, version field forced to 2 -- crx.ts checks
    // the version before it ever tries to parse the rest as CRX3 protobuf.
    const crx2 = Buffer.from(bytes)
    crx2.writeUInt32LE(2, 4)
    expect(() => verifyCrx3(crx2, { requirePublisherProof: false })).toThrow(/CRX2/)
  })
})
