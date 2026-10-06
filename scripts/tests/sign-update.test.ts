import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { packageName } from '../../src/main/self-update/install-kind.js'
import { TRUSTED_UPDATE_KEYS } from '../../src/main/self-update/update-signing-key.js'
import { verifyManifest } from '../../src/main/self-update/update-manifest.js'
import { embeddedKeys, expectedPackages, hashPackages, manifestText, signedByAny, signManifest } from '../release/sign-update.mjs'

const pair = (): { pem: string, privatePem: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-sign-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const fillPackages = (version: string): void => { for (const name of expectedPackages(version)) writeFileSync(join(dir, name), `package ${name}`) }

describe('sign-update.mjs', () => {
  it('expects the five packages the browser looks for, under the names it computes', () => {
    expect([...expectedPackages('1.2.0')].sort()).toEqual([
      packageName('appimage', '1.2.0', 'x64'),
      packageName('deb', '1.2.0', 'x64'),
      packageName('nsis', '1.2.0', 'x64'),
      packageName('mac', '1.2.0', 'arm64'),
      packageName('mac', '1.2.0', 'x64')
    ].sort())
  })

  it('reads the keys the browser embeds, as the browser does', () => {
    expect(embeddedKeys().map((pem) => pem.trim())).toEqual(TRUSTED_UPDATE_KEYS.map((pem) => pem.trim()))
  })

  it('refuses to sign unless all five packages are there, naming what is missing', () => {
    fillPackages('1.2.0')
    rmSync(join(dir, 'orivon_1.2.0_amd64.deb'))
    expect(() => hashPackages(dir, '1.2.0')).toThrow(/orivon_1\.2\.0_amd64\.deb/)
  })

  it('writes a manifest and a signature the browser\'s own verifier accepts', () => {
    fillPackages('1.2.0')
    const key = pair()
    const text = manifestText('1.2.0', hashPackages(dir, '1.2.0'))
    const signature = signManifest(text, key.privatePem, [key.pem])
    const result = verifyManifest(Buffer.from(text), signature, 'v1.2.0', [key.pem])
    expect(result.ok).toBe(true)
    expect(result.ok && result.manifest.files.map((file) => file.name)).toEqual([...expectedPackages('1.2.0')].sort())
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('lists files sorted by name whatever order they came in', () => {
    const text = manifestText('1.0.0', [{ name: 'b', size: 1, sha256: 'x' }, { name: 'a', size: 2, sha256: 'y' }])
    expect((JSON.parse(text) as { files: Array<{ name: string }> }).files.map((file) => file.name)).toEqual(['a', 'b'])
  })

  it('refuses to sign with a key the browser does not trust', () => {
    const stranger = pair()
    expect(() => signManifest('{}\n', stranger.privatePem, embeddedKeys())).toThrow(/not one the browser trusts/)
  })

  it('does not take a signature of other bytes for a signature of these', () => {
    const key = pair()
    const signature = signManifest('one\n', key.privatePem, [key.pem])
    expect(signedByAny(Buffer.from('one\n'), signature, [key.pem])).toBe(true)
    expect(signedByAny(Buffer.from('two\n'), signature, [key.pem])).toBe(false)
  })
})
