import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TRUSTED_UPDATE_KEYS } from '../update-signing-key.js'
import { MANIFEST_FORMAT, MAX_MANIFEST_BYTES, verifyManifest } from '../update-manifest.js'

const pair = (): { pem: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey }
}
const KEY = pair()
const OTHER = pair()
const HASH = 'a'.repeat(64)
const body = (patch: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ format: MANIFEST_FORMAT, version: '1.2.0', files: [{ name: 'Orivon-1.2.0-x86_64.AppImage', size: 123, sha256: HASH }], ...patch })
const signed = (value: unknown, key = KEY): { bytes: Buffer, sig: string } => {
  const bytes = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  return { bytes, sig: sign(null, bytes, key.privateKey).toString('base64') }
}
const check = (value: unknown, tag = 'v1.2.0', keys: readonly string[] = [KEY.pem]): ReturnType<typeof verifyManifest> => {
  const { bytes, sig } = signed(value)
  return verifyManifest(bytes, sig, tag, keys)
}
const refusedFor = (value: unknown, tag?: string): string => {
  const result = check(value, tag)
  if (result.ok) throw new Error('expected a refusal')
  return result.reason
}

describe('verifyManifest', () => {
  it('answers the manifest of a release signed by a trusted key', () => {
    const result = check(body())
    expect(result).toEqual({ ok: true, manifest: body() })
  })

  it('accepts a key that was rotated in beside the old one', () => {
    const { bytes, sig } = signed(body(), OTHER)
    expect(verifyManifest(bytes, sig, 'v1.2.0', [KEY.pem, OTHER.pem]).ok).toBe(true)
  })

  it('refuses a signature made by a key nobody trusts', () => {
    const { bytes, sig } = signed(body(), OTHER)
    expect(verifyManifest(bytes, sig, 'v1.2.0', [KEY.pem]).ok).toBe(false)
  })

  it('refuses bytes changed after signing, by one character', () => {
    const { bytes, sig } = signed(body())
    const changed = Buffer.from(bytes.toString().replace('123', '124'))
    expect(verifyManifest(changed, sig, 'v1.2.0', [KEY.pem]).ok).toBe(false)
  })

  it('refuses a missing, malformed or oversized signature, and no key at all', () => {
    const { bytes, sig } = signed(body())
    expect(verifyManifest(bytes, '', 'v1.2.0', [KEY.pem]).ok).toBe(false)
    expect(verifyManifest(bytes, 'not base64!!', 'v1.2.0', [KEY.pem]).ok).toBe(false)
    expect(verifyManifest(bytes, 'A'.repeat(2000), 'v1.2.0', [KEY.pem]).ok).toBe(false)
    expect(verifyManifest(bytes, sig, 'v1.2.0', []).ok).toBe(false)
    expect(verifyManifest(bytes, sig, 'v1.2.0', ['not a key']).ok).toBe(false)
  })

  it('tolerates the newline a signature file ends with', () => {
    const { bytes, sig } = signed(body())
    expect(verifyManifest(bytes, `${sig}\n`, 'v1.2.0', [KEY.pem]).ok).toBe(true)
  })

  it('refuses a manifest over 64 KiB before reading it', () => {
    const big = Buffer.alloc(MAX_MANIFEST_BYTES + 1, 32)
    expect(verifyManifest(big, sign(null, big, KEY.privateKey).toString('base64'), 'v1.2.0', [KEY.pem]).ok).toBe(false)
  })

  it('refuses what is signed but not JSON, or not an object', () => {
    expect(refusedFor('not json')).toMatch(/JSON/)
    expect(refusedFor('[]')).toMatch(/format/)
    expect(refusedFor('null')).toMatch(/object/)
  })

  it('refuses another format, or a version that is not the tag\'s', () => {
    expect(refusedFor(body({ format: 'orivon-update/2' }))).toMatch(/format/)
    expect(refusedFor(body({ version: '1.2.1' }))).toMatch(/version/)
    expect(refusedFor(body(), 'v1.3.0')).toMatch(/version/)
    expect(check(body(), '1.2.0').ok).toBe(true)
  })

  it('refuses a file list that is empty, not a list, or has a non-object entry', () => {
    expect(refusedFor(body({ files: [] }))).toMatch(/no files/)
    expect(refusedFor(body({ files: 'x' }))).toMatch(/no files/)
    expect(refusedFor(body({ files: [3] }))).toMatch(/object/)
  })

  it('refuses a name that could reach outside a folder, or is empty, long or listed twice', () => {
    const entry = (name: string): Record<string, unknown> => ({ name, size: 1, sha256: HASH })
    for (const name of ['../x', 'a/b', '.hidden', '', 'a b', 'a'.repeat(129), 'a\\b']) {
      expect(refusedFor(body({ files: [entry(name)] }))).toMatch(/name/)
    }
    expect(refusedFor(body({ files: [entry('a.deb'), entry('a.deb')] }))).toMatch(/twice/)
  })

  it('refuses a hash that is not 64 lowercase hex digits', () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 7]) {
      expect(refusedFor(body({ files: [{ name: 'a.deb', size: 1, sha256 }] }))).toMatch(/hash/)
    }
  })

  it('refuses a size that is not an integer from 1 byte to 2 GiB', () => {
    for (const size of [0, -1, 1.5, 2 * 1024 ** 3 + 1, '10', null]) {
      expect(refusedFor(body({ files: [{ name: 'a.deb', size, sha256: HASH }] }))).toMatch(/size/)
    }
    expect(check(body({ files: [{ name: 'a.deb', size: 2 * 1024 ** 3, sha256: HASH }] })).ok).toBe(true)
  })

  it('has a trusted key that parses', () => {
    expect(TRUSTED_UPDATE_KEYS.length).toBeGreaterThan(0)
    for (const pem of TRUSTED_UPDATE_KEYS) expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519')
  })
})
