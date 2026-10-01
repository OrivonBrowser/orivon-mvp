// Test builds only: a keyring that encrypts reversibly and reports a real backend, so an end-to-end run, which
// has no system keyring, can exercise the path a person with one takes. Gated on the compiled-in flag of the
// developer grant, so an ordinary build carries none of it and an environment variable alone does nothing.
import type { SafeStorageLike } from '../keyring/seed-store.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  var __orivonDevPasswordStorage: SafeStorageLike | undefined
}

const MASK = 0x5a

const mask = (bytes: Uint8Array): Buffer => Buffer.from(Uint8Array.from(bytes, (byte) => byte ^ MASK))

/** Reversible and not secret: it stands in for a keyring, it does not protect anything. */
export function createFakeKeyring (): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: async () => await Promise.resolve(true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (plainText) => await Promise.resolve(mask(Buffer.from(plainText, 'utf8'))),
    decryptStringAsync: async (encrypted) => await Promise.resolve({ shouldReEncrypt: false, result: mask(encrypted).toString('utf8') })
  }
}

/** The fake keyring when a test build asked for it, else undefined. */
export function devPasswordStorage (env: NodeJS.ProcessEnv = process.env): SafeStorageLike | undefined {
  if (!SEAM_ENABLED || env['ORIVON_TEST_PASSWORD_KEYRING'] !== '1') return undefined
  globalThis.__orivonDevPasswordStorage = createFakeKeyring()
  return globalThis.__orivonDevPasswordStorage
}

/** How long a shown password stays up, shortened in a test build that asked for the fake keyring. */
export function devRevealHideMs (env: NodeJS.ProcessEnv = process.env): number | undefined {
  return SEAM_ENABLED && env['ORIVON_TEST_PASSWORD_KEYRING'] === '1' ? 1500 : undefined
}
