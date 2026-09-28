// The CRX3 header protobuf, read directly with `pbf`: the same library and
// the same message shapes (field tags 1-4 and 10000) as
// vendor/electron-chrome-web-store/src/browser/crx3.ts, reimplemented here
// rather than imported -- see this directory's README.md's Design notes for
// why.

import type Pbf from 'pbf'

export interface AsymmetricKeyProof {
  readonly public_key: Buffer | undefined
  readonly signature: Buffer | undefined
}

export interface CrxFileHeader {
  readonly sha256_with_rsa: AsymmetricKeyProof[]
  readonly sha256_with_ecdsa: AsymmetricKeyProof[]
  readonly signed_header_data: Buffer | undefined
}

export interface SignedData {
  readonly crx_id: Buffer | undefined
}

function readAsymmetricKeyProof (pbf: Pbf, end: number): AsymmetricKeyProof {
  let publicKey: Buffer | undefined
  let signature: Buffer | undefined
  pbf.readFields((tag, _obj, pbf) => {
    if (tag === 1) publicKey = Buffer.from(pbf.readBytes())
    else if (tag === 2) signature = Buffer.from(pbf.readBytes())
  }, null, end)
  return { public_key: publicKey, signature }
}

/** `CrxFileHeader`: tag 2 repeated `sha256_with_rsa`, tag 3 repeated
 * `sha256_with_ecdsa`, tag 10000 the signed, length-prefixed
 * `signed_header_data` bytes (`verified_contents`, tag 4, is never read --
 * crx.ts has no use for it). Matches
 * vendor/electron-chrome-web-store/src/browser/crx3.ts's own field tags. */
export function readCrxFileHeader (pbf: Pbf, end?: number): CrxFileHeader {
  const sha256WithRsa: AsymmetricKeyProof[] = []
  const sha256WithEcdsa: AsymmetricKeyProof[] = []
  let signedHeaderData: Buffer | undefined
  pbf.readFields((tag, _obj, pbf) => {
    if (tag === 2) sha256WithRsa.push(readAsymmetricKeyProof(pbf, pbf.readVarint() + pbf.pos))
    else if (tag === 3) sha256WithEcdsa.push(readAsymmetricKeyProof(pbf, pbf.readVarint() + pbf.pos))
    else if (tag === 10000) signedHeaderData = Buffer.from(pbf.readBytes())
  }, null, end)
  return { sha256_with_rsa: sha256WithRsa, sha256_with_ecdsa: sha256WithEcdsa, signed_header_data: signedHeaderData }
}

/** `SignedHeaderData`: tag 1 the 16-byte `crx_id`. */
export function readSignedData (pbf: Pbf, end?: number): SignedData {
  let crxId: Buffer | undefined
  pbf.readFields((tag, _obj, pbf) => {
    if (tag === 1) crxId = Buffer.from(pbf.readBytes())
  }, null, end)
  return { crx_id: crxId }
}
