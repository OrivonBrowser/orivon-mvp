// CRX3 verification -- pure, `node:crypto` allowed (no `electron`, no
// filesystem: the caller reads the bytes). ./README.md's Design notes say
// why Orivon checks this itself rather than trusting the Chrome Web Store's
// transport (electron-chrome-web-store's own vendored `verifyCrx` hook,
// UPSTREAM.md patch 1, is what install-runner.ts wires this into).
//
// Format reference: Chromium's own crx_verifier.cc,
// https://github.com/chromium/chromium/blob/3b505743bc9f8871e748b0dc79fff94d5a3c2416/components/crx_file/crx_verifier.cc
// (Cr-Commit-Position refs/heads/main@{#1702232}, fetched 2026-09-28). The
// protobuf reader for the header is reimplemented in ./crx3-format.ts, not
// imported from vendor/electron-chrome-web-store/src/browser/crx3.ts --
// ./README.md's Design notes say why.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import Pbf from 'pbf'
import { readCrxFileHeader, readSignedData } from './crx3-format.js'
import { convertHexadecimalToIDAlphabet } from '../../../vendor/electron-chrome-web-store/src/browser/id.js'

const MAGIC = 'Cr24'
const CRX3_VERSION = 3
const SIGNED_DATA_CONTEXT = Buffer.from('CRX3 SignedData\0', 'binary')

/**
 * The Chrome Web Store's publisher signing key hash (SHA-256 of its DER
 * SPKI), `kPublisherKeyHash` in the Chromium source cited above. A CRX
 * install carries this proof only when it came from the store itself;
 * `installFromFile` never requires it (a local file need not have come from
 * the store), `install-runner.ts`'s own doc says so.
 */
export const CHROME_WEB_STORE_PUBLISHER_KEY_HASH = Buffer.from(
  '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf', 'hex'
)

export interface VerifyCrx3Options {
  /** Also require a valid proof from the Chrome Web Store's own publisher
   * key -- only meaningful for a download that claims to be from the store. */
  readonly requirePublisherProof: boolean
  /** Overrides CHROME_WEB_STORE_PUBLISHER_KEY_HASH -- test-only seam, so a
   * test can build its own "publisher" key pair instead of holding the real
   * store's private key. */
  readonly publisherKeyHash?: Buffer
}

export interface VerifiedCrx3 {
  /** The a-p alphabet extension id (Chromium's own alphabet -- see
   * convertHexadecimalToIDAlphabet's own doc for why: an id must never look
   * like a hostname made only of digits). */
  readonly id: string
  /** DER SubjectPublicKeyInfo of the proof that matched `id` -- install-runner.ts
   * writes this into the loaded manifest's `key` field (base64), as Chrome
   * does, so Electron derives the same id. */
  readonly developerPublicKey: Buffer
  /** The zip archive that follows the header -- unpack-runner.ts's input. */
  readonly archive: Buffer
}

interface RawProof { readonly public_key: Buffer | undefined, readonly signature: Buffer | undefined }

/** `proof`'s signature over `signedData`, or null if it does not verify
 * (missing fields, a malformed key, or a genuine mismatch -- all three are
 * "this proof does not count", never a throw: a CRX can carry proofs this
 * verifier does not have to understand, as long as ONE developer proof and,
 * if required, one publisher proof do check out). */
function verifiedProofKey (proof: RawProof, signedData: Buffer): Buffer | null {
  if (proof.public_key === undefined || proof.signature === undefined) return null
  try {
    const publicKey = createPublicKey({ key: Buffer.from(proof.public_key), format: 'der', type: 'spki' })
    const ok = verifySignature('sha256', signedData, publicKey, Buffer.from(proof.signature))
    return ok ? Buffer.from(proof.public_key) : null
  } catch {
    // A key or signature shaped so oddly node:crypto itself refuses it is
    // exactly as untrustworthy as a wrong signature -- both mean "this
    // proof does not count", not "this file is unreadable".
    return null
  }
}

function keyHash (publicKey: Buffer): Buffer {
  return createHash('sha256').update(publicKey).digest()
}

/**
 * Parses and verifies a CRX3 file. Throws (never returns a partial result)
 * on anything that fails closed: not a CRX, a CRX2 file (refused, never
 * translated), a corrupt header, a proof whose signature does not verify,
 * no valid proof whose key hashes to the declared `crx_id` (the developer
 * proof this file's own header names), or, when
 * `options.requirePublisherProof`, no valid proof matching the publisher
 * key hash.
 */
export function verifyCrx3 (bytes: Buffer, options: VerifyCrx3Options): VerifiedCrx3 {
  if (bytes.length < 12 || bytes.toString('binary', 0, 4) !== MAGIC) {
    throw new Error('not a CRX file (bad magic number)')
  }
  const version = bytes.readUInt32LE(4)
  if (version !== CRX3_VERSION) {
    throw new Error(`CRX${version} is not supported -- only CRX3`)
  }
  const headerSize = bytes.readUInt32LE(8)
  if (12 + headerSize > bytes.length) throw new Error('CRX3 header_size runs past the end of the file')
  const header = bytes.subarray(12, 12 + headerSize)
  const archive = Buffer.from(bytes.subarray(12 + headerSize))

  const crxFileHeader = readCrxFileHeader(new Pbf(header))
  const signedHeaderData = crxFileHeader.signed_header_data
  if (signedHeaderData === undefined) throw new Error('CRX3 header carries no signed_header_data')
  const signedHeaderDataBuffer = Buffer.from(signedHeaderData)

  const crxSignedData = readSignedData(new Pbf(signedHeaderDataBuffer))
  const declaredId = crxSignedData.crx_id
  if (declaredId === undefined) throw new Error('CRX3 signed_header_data carries no crx_id')
  const declaredIdBuffer = Buffer.from(declaredId)

  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32LE(signedHeaderDataBuffer.length, 0)
  const dataToVerify = Buffer.concat([SIGNED_DATA_CONTEXT, lengthPrefix, signedHeaderDataBuffer, archive])

  const allProofs: RawProof[] = [...crxFileHeader.sha256_with_rsa, ...crxFileHeader.sha256_with_ecdsa]
  const validKeys = allProofs
    .map((proof) => verifiedProofKey(proof, dataToVerify))
    .filter((key): key is Buffer => key !== null)

  const developerKey = validKeys.find((key) => keyHash(key).subarray(0, 16).equals(declaredIdBuffer))
  if (developerKey === undefined) {
    throw new Error('no valid CRX3 proof whose key matches the declared extension id')
  }

  if (options.requirePublisherProof) {
    const publisherKeyHash = options.publisherKeyHash ?? CHROME_WEB_STORE_PUBLISHER_KEY_HASH
    const hasPublisherProof = validKeys.some((key) => keyHash(key).equals(publisherKeyHash))
    if (!hasPublisherProof) throw new Error('no valid CRX3 proof from the required publisher key')
  }

  return {
    id: convertHexadecimalToIDAlphabet(declaredIdBuffer.toString('hex')),
    developerPublicKey: developerKey,
    archive
  }
}
