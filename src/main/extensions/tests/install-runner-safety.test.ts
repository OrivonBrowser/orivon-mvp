// Split out of install-runner.test.ts (Rule 2, docs/development/code-
// guidelines.md): the safety checks around a manifest's own `key` and the
// path-containment check `finishInstall` applies to the slot/version
// directories it is about to write into -- self-contained enough to carry
// its own small fixtures rather than sharing install-runner.test.ts's.

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { installFromFolder, isStrictlyInsideDirectory, type InstallContext } from '../install-runner.js'
import { readRegistry } from '../registry-runner.js'
import { convertHexadecimalToIDAlphabet, generateId } from '../../../../vendor/electron-chrome-web-store/src/browser/id.js'

const ALWAYS_ALLOW: InstallContext['prompt'] = async () => true

async function withTempDir (fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-install-runner-safety-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const FIXTURE_MANIFEST = {
  manifest_version: 3,
  name: 'Fixture Extension',
  version: '1.0.0',
  permissions: ['storage']
}

function writeManifestFolder (dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
  return dir
}

/** A fake `Session` carrying just the three `extensions.*` methods
 * install-runner.ts calls -- see install-runner.test.ts's own copy for the
 * full doc; this file only needs the happy path plus a controllable id. */
function fakeSession (): { session: InstallContext['session'] } {
  const loaded = new Map<string, string>()
  const session = {
    extensions: {
      loadExtension: async (path: string) => {
        const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Record<string, unknown>
        const key = typeof manifest.key === 'string' ? manifest.key : undefined
        const id = key !== undefined ? generateId(key) : createHash('sha256').update(path).digest('hex').slice(0, 32)
        loaded.set(id, path)
        return { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
      },
      removeExtension: (id: string) => { loaded.delete(id) },
      getExtension: (id: string) => {
        const path = loaded.get(id)
        return path === undefined ? undefined : { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
      }
    }
  } as unknown as InstallContext['session']
  return { session }
}

describe('PEM-armoured manifest key', () => {
  /** A base64 SPKI DER public key -- the plain form Chrome itself writes
   * into a manifest's `key` field. */
  function derPublicKeyBase64 (): string {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' }
    })
    return publicKey.toString('base64')
  }

  /** The same key, wrapped the way an ordinary PEM export (`openssl pkey
   * -pubout`, for one) would -- Chromium's own `ParsePEMKeyBytes` accepts
   * this form too, stripping the markers and whitespace before decoding. */
  function pemArmor (base64Key: string): string {
    const lines = base64Key.match(/.{1,64}/g) ?? [base64Key]
    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`
  }

  /** The id a real Electron session derives for a manifest `key`, PEM
   * armour and all: strip the markers and whitespace, decode, hash -- built
   * independently of registry-runner.ts's own canonicalization (never calls
   * `generateId` on the raw armoured text the way the closed bug once did),
   * so it cannot accidentally agree with a wrong answer by sharing the same
   * mistake. */
  function chromiumIdForManifestKey (rawKey: string): string {
    const stripped = rawKey.replace(/-----BEGIN [^-]*-----/g, '').replace(/-----END [^-]*-----/g, '').replace(/\s+/g, '')
    const der = Buffer.from(stripped, 'base64')
    const hash = createHash('sha256').update(der).digest()
    return convertHexadecimalToIDAlphabet(hash.subarray(0, 16).toString('hex'))
  }

  it('resolves a PEM-armoured manifest key to the SAME id as its plain form, so a wrapped copy of an installed extension\'s key is caught by "one id, one slot" instead of taking it over', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const plainKey = derPublicKeyBase64()

      // Two DIFFERENT folders: a shared subdirectory name would land both
      // installs in the same slot, hiding the very collision this test
      // exists to catch.
      const victimDir = writeManifestFolder(join(root, 'victim'), { ...FIXTURE_MANIFEST, name: 'Victim', key: plainKey })
      const victim = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, victimDir)
      expect(victim.installed).toBe(true)
      if (!victim.installed) return
      // Sanity: this suite's own id deriver agrees with what was actually
      // installed for the plain, unwrapped key -- so the refusal below is
      // not merely two wrong answers matching each other.
      expect(victim.entry.id).toBe(chromiumIdForManifestKey(plainKey))

      // A different folder (a different slot) whose manifest carries the
      // SAME key, PEM-armoured. Before canonicalization, `generateId`
      // hashed the armoured string's own lenient base64 decode -- a
      // different id from the victim's -- so this slipped past "one id,
      // one slot" and would have taken over the victim's id, and its
      // storage, the moment a real Electron `loadExtension` parsed the
      // armour itself.
      const attackerDir = writeManifestFolder(join(root, 'attacker'), { ...FIXTURE_MANIFEST, name: 'Impostor', key: pemArmor(plainKey) })
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, attackerDir)
      expect(outcome).toEqual({ installed: false, reason: 'another installed extension already uses this id' })
      expect(readRegistry(userDataPath)).toHaveLength(1)
      expect(readRegistry(userDataPath)[0]?.name).toBe('Victim')
    })
  })

  it('refuses a manifest key that is not a parsable public key, PEM-wrapped or not', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const { session } = fakeSession()
      const source = writeManifestFolder(join(root, 'unpacked-fixture'), { ...FIXTURE_MANIFEST, key: 'not a real key at all' })
      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome).toEqual({ installed: false, reason: 'install refused: the manifest key is not a parsable public key' })
    })
  })

  it('rolls back a fresh install whose loaded id does not match its resolved key', async () => {
    await withTempDir(async (root) => {
      const userDataPath = join(root, 'userData')
      const source = writeManifestFolder(join(root, 'unpacked-fixture'), FIXTURE_MANIFEST)
      // A session that reports a fixed id no matter what it was asked to
      // load -- standing in for whatever future discrepancy this check
      // exists to catch (a correctly-behaving fake, like a correctly-
      // behaving real Electron, never disagrees with install-runner.ts's
      // own id in the first place).
      const mismatchedId = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
      const loaded = new Map<string, string>()
      const session = {
        extensions: {
          loadExtension: async (path: string) => {
            loaded.set(mismatchedId, path)
            return { id: mismatchedId, name: 'fake', manifest: {}, path, url: `chrome-extension://${mismatchedId}/` }
          },
          removeExtension: (id: string) => { loaded.delete(id) },
          getExtension: (id: string) => {
            const path = loaded.get(id)
            return path === undefined ? undefined : { id, name: 'fake', manifest: {}, path, url: `chrome-extension://${id}/` }
          }
        }
      } as unknown as InstallContext['session']

      const outcome = await installFromFolder({ userDataPath, session, prompt: ALWAYS_ALLOW }, source)
      expect(outcome).toEqual({ installed: false, reason: 'install refused: the loaded extension\'s id does not match its resolved key' })
      expect(loaded.size).toBe(0)
      expect(readRegistry(userDataPath)).toEqual([])
      const extensionsDir = join(userDataPath, 'extensions')
      const slotDirs = existsSync(extensionsDir) ? readdirSync(extensionsDir) : []
      for (const slot of slotDirs) {
        const versionDirs = readdirSync(join(extensionsDir, slot)).filter((name) => name !== 'key.pub')
        expect(versionDirs).toEqual([])
      }
    })
  })
})

// The second, grammar-independent layer README.md's Design notes describes:
// finishInstall refuses a targetDir/slotDir that does not resolve strictly
// inside its own parent, the same shape unpack-runner.ts's checkZipEntryPath
// uses for a zip entry -- tested directly here, not only through a `version`
// string readExtensionManifest's own grammar check already refuses.
describe('isStrictlyInsideDirectory', () => {
  it('is true for an ordinary child directory', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot/1.0.0')).toBe(true)
  })

  it('is false for the parent itself', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot')).toBe(false)
  })

  it('is false for a path that escapes via ..', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot/../../../../.config/autostart')).toBe(false)
  })

  it('is false for a sibling directory with the parent as a string prefix', () => {
    expect(isStrictlyInsideDirectory('/a/extensions/slot', '/a/extensions/slot-evil/x')).toBe(false)
  })
})
