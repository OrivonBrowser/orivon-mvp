import { describe, expect, it } from 'vitest'
import { createSafeStorage } from '../safe-storage.js'
import { ElectronShimError } from '../errors.js'
import type { Orivon } from '../../contracts/capability-api.js'

function fakeSecrets (overrides: Partial<Orivon['secrets']> = {}): Pick<Orivon, 'secrets'> {
  return {
    secrets: {
      available: async () => true,
      encrypt: async () => new Uint8Array([1, 2, 3]),
      decrypt: async () => new TextEncoder().encode('decrypted'),
      ...overrides
    }
  }
}

describe('createSafeStorage -- the async trio (ADR-0031)', () => {
  it('isAsyncEncryptionAvailable mirrors orivon.secrets.available()', async () => {
    const trueOrivon = fakeSecrets({ available: async () => true })
    expect(await createSafeStorage(trueOrivon).isAsyncEncryptionAvailable()).toBe(true)

    const falseOrivon = fakeSecrets({ available: async () => false })
    expect(await createSafeStorage(falseOrivon).isAsyncEncryptionAvailable()).toBe(false)
  })

  it('encryptStringAsync UTF-8 encodes the string and hands it to orivon.secrets.encrypt, returning a Buffer', async () => {
    let seen: Uint8Array | undefined
    const orivon = fakeSecrets({ encrypt: async (plaintext) => { seen = plaintext; return new Uint8Array([9]) } })
    const result = await createSafeStorage(orivon).encryptStringAsync('a secret 🔑')
    expect(seen).toEqual(new TextEncoder().encode('a secret 🔑'))
    expect(Buffer.isBuffer(result)).toBe(true)
    expect([...result]).toEqual([9])
  })

  it('decryptStringAsync UTF-8 decodes what orivon.secrets.decrypt returns, with shouldReEncrypt always false', async () => {
    const orivon = fakeSecrets({ decrypt: async () => new TextEncoder().encode('a secret 🔑') })
    const result = await createSafeStorage(orivon).decryptStringAsync(Buffer.from([1]))
    expect(result).toEqual({ shouldReEncrypt: false, result: 'a secret 🔑' })
  })

  it('decryptStringAsync refuses (not-built) rather than return mangled text for bytes that are not valid UTF-8', async () => {
    const orivon = fakeSecrets({ decrypt: async () => new Uint8Array([0xff, 0xfe, 0xfd]) })
    await expect(createSafeStorage(orivon).decryptStringAsync(Buffer.from([1]))).rejects.toThrow(ElectronShimError)
  })
})

describe('createSafeStorage -- the sync trio refuses by name (async-only orivon.secrets)', () => {
  it('isEncryptionAvailable is unconditionally false -- a ported app takes its own documented fallback', () => {
    expect(createSafeStorage(fakeSecrets()).isEncryptionAvailable()).toBe(false)
  })

  it('encryptString throws a named not-built error rather than a bare TypeError', () => {
    const storage = createSafeStorage(fakeSecrets())
    expect(() => storage.encryptString('x')).toThrow(ElectronShimError)
    try {
      storage.encryptString('x')
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('not-built')
      expect((error as ElectronShimError).api).toBe('safeStorage.encryptString')
    }
  })

  it('decryptString throws a named not-built error rather than a bare TypeError', () => {
    const storage = createSafeStorage(fakeSecrets())
    expect(() => storage.decryptString(Buffer.from([1]))).toThrow(ElectronShimError)
  })
})

describe('createSafeStorage -- reading an unconsidered member is safe (A169); calling it refuses by name', () => {
  it.each(['getSelectedStorageBackend', 'setUsePlainTextEncryption', 'somethingNotRealEither'])('safeStorage.%s', (method) => {
    const storage = createSafeStorage(fakeSecrets()) as unknown as Record<string, () => unknown>
    expect(() => storage[method]).not.toThrow()
    expect(() => storage[method]!()).toThrow(ElectronShimError)
    try {
      storage[method]!()
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('unimplemented')
      expect((error as ElectronShimError).api).toBe(`safeStorage.${method}`)
    }
  })
})
