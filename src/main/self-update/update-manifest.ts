// The signed list of a release's packages, and the check that decides whether to believe it. Pure: the bytes, the
// signature text and the keys come in; no network, no Electron.
import { createPublicKey, verify } from 'node:crypto'

export const MANIFEST_FORMAT = 'orivon-update/1'
export const MAX_MANIFEST_BYTES = 64 * 1024
export const MAX_SIGNATURE_BYTES = 1024
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export interface ManifestFile {
  readonly name: string
  readonly size: number
  readonly sha256: string
}

export interface UpdateManifest {
  readonly format: typeof MANIFEST_FORMAT
  readonly version: string
  readonly files: readonly ManifestFile[]
}

export type ManifestResult = { readonly ok: true, readonly manifest: UpdateManifest } | { readonly ok: false, readonly reason: string }

const refuse = (reason: string): ManifestResult => ({ ok: false, reason })

function signedBy (bytes: Uint8Array, signature: Buffer, keys: readonly string[]): boolean {
  return keys.some((pem) => {
    try {
      return verify(null, bytes, createPublicKey(pem), signature)
    } catch {
      return false
    }
  })
}

function readFiles (value: unknown): ManifestFile[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'the manifest lists no files'
  const files: ManifestFile[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return 'a file entry is not an object'
    const { name, size, sha256 } = entry as Record<string, unknown>
    if (typeof name !== 'string' || !FILE_NAME.test(name)) return 'a file name is not a plain name'
    if (files.some((file) => file.name === name)) return `the file ${name} is listed twice`
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_PACKAGE_BYTES) return `the size of ${name} is out of range`
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return `the hash of ${name} is not 64 lowercase hex digits`
    files.push({ name, size, sha256 })
  }
  return files
}

/**
 * The manifest `bytes` hold, once `signatureText` (base64 of an Ed25519 signature over those exact bytes) verifies
 * under one of `trustedKeys` and the content has the expected shape for release `tag`. The signature is checked
 * before the bytes are parsed.
 */
export function verifyManifest (bytes: Uint8Array, signatureText: string, tag: string, trustedKeys: readonly string[]): ManifestResult {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) return refuse('the manifest is too large')
  const text = signatureText.trim()
  if (text.length > MAX_SIGNATURE_BYTES) return refuse('the signature is too large')
  if (text === '' || !BASE64.test(text)) return refuse('the signature is not base64')
  if (!signedBy(bytes, Buffer.from(text, 'base64'), trustedKeys)) return refuse('the signature does not match any trusted key')

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return refuse('the manifest is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) return refuse('the manifest is not an object')
  const { format, version, files } = parsed as Record<string, unknown>
  if (format !== MANIFEST_FORMAT) return refuse('the manifest has an unknown format')
  if (typeof version !== 'string' || version !== tag.replace(/^v/, '')) return refuse('the manifest is for another version')
  const listed = readFiles(files)
  if (typeof listed === 'string') return refuse(listed)
  return { ok: true, manifest: { format: MANIFEST_FORMAT, version, files: listed } }
}
