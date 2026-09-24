import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SeedStore, type SafeStorageLike } from '../seed-store.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-seed-store-'))
  path = join(dir, 'seed.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A working keyring -- `encryptStringAsync`/`decryptStringAsync` are real
 * inverses of each other over an in-memory map, so a round trip through
 * SeedStore is genuinely exercised without touching a real OS keyring. */
function workingSafeStorage (backend = 'gnome_libsecret'): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (plainText: string) => Buffer.from(`enc:${plainText}`, 'utf8'),
    decryptStringAsync: async (encrypted: Buffer) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not our ciphertext')
      return { shouldReEncrypt: false, result: text.slice(4) }
    }
  }
}

function unreachableSafeStorage (): SafeStorageLike {
  return {
    isAsyncEncryptionAvailable: async () => false,
    getSelectedStorageBackend: () => 'basic_text',
    encryptStringAsync: async () => { throw new Error('unreachable in this test') },
    decryptStringAsync: async () => { throw new Error('unreachable in this test') }
  }
}

describe('SeedStore -- first launch', () => {
  it('generates a persistent seed and writes it when a keyring is reachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new SeedStore(path, workingSafeStorage())
    const { seed, persistent } = await store.resolve()
    expect(seed).toHaveLength(32)
    expect(persistent).toBe(true)
    expect(readdirSync(dir)).toEqual(['seed.json'])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('generates a session-only seed, writes nothing, when no keyring backend is reachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new SeedStore(path, unreachableSafeStorage())
    const { seed, persistent } = await store.resolve()
    expect(seed).toHaveLength(32)
    expect(persistent).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    expect(console.error).toHaveBeenCalled()
  })

  it('treats "basic_text" as no real keyring even when isAsyncEncryptionAvailable is true -- a Linux-specific case', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new SeedStore(path, {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptStringAsync: async () => { throw new Error('must not be called') },
      decryptStringAsync: async () => { throw new Error('must not be called') }
    })
    const { persistent } = await store.resolve()
    expect(persistent).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('memoizes: concurrent first callers all get the SAME seed, generated once', async () => {
    const store = new SeedStore(path, workingSafeStorage())
    const [a, b, c] = await Promise.all([store.resolve(), store.resolve(), store.resolve()])
    expect(a.seed).toEqual(b.seed)
    expect(b.seed).toEqual(c.seed)
  })
})

describe('SeedStore -- restart', () => {
  it('reads back the exact same seed a prior store persisted', async () => {
    const safeStorage = workingSafeStorage()
    const first = new SeedStore(path, safeStorage)
    const { seed: original } = await first.resolve()

    const second = new SeedStore(path, safeStorage)
    const { seed: reloaded, persistent } = await second.resolve()
    expect(reloaded).toEqual(original)
    expect(persistent).toBe(true)
  })

  it('re-encrypts and rewrites the file when the keyring reports shouldReEncrypt, without changing the returned seed', async () => {
    const safeStorage = workingSafeStorage()
    const first = new SeedStore(path, safeStorage)
    const { seed: original } = await first.resolve()

    // A call-count assertion, not a byte-comparison of the file: this
    // fake's `encryptStringAsync` is a pure function of its plaintext, and
    // the plaintext (the hex seed) never changes across a rotation, so a
    // real re-encrypt and a skipped one would write byte-IDENTICAL JSON --
    // a real keyring's IV would not, but this test must not depend on that.
    const encryptCalls: string[] = []
    const rotating: SafeStorageLike = {
      ...safeStorage,
      encryptStringAsync: async (plainText) => {
        encryptCalls.push(plainText)
        return await safeStorage.encryptStringAsync(plainText)
      },
      decryptStringAsync: async (encrypted) => {
        const text = encrypted.toString('utf8')
        return { shouldReEncrypt: true, result: text.slice(4) }
      }
    }
    const second = new SeedStore(path, rotating)
    const { seed: reloaded } = await second.resolve()
    expect(reloaded).toEqual(original)

    // The re-encrypt is fire-and-forget (seed-store.ts's own doc); give its
    // microtask a turn before asserting it actually ran.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(encryptCalls).toEqual([Buffer.from(original).toString('hex')])
  })
})

describe('SeedStore -- never overwrites a file it cannot make sense of', () => {
  it('falls back to a session-only seed, and leaves the file untouched, when decryption fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const safeStorage = workingSafeStorage()
    const first = new SeedStore(path, safeStorage)
    await first.resolve()
    const before = readFileSync(path, 'utf8')

    const locked: SafeStorageLike = {
      ...safeStorage,
      decryptStringAsync: async () => { throw new Error('keyring is locked') }
    }
    const second = new SeedStore(path, locked)
    const { persistent } = await second.resolve()
    expect(persistent).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('falls back and leaves the file untouched for a corrupt (non-JSON) file', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path, '{ not json')
    const store = new SeedStore(path, workingSafeStorage())
    const { persistent } = await store.resolve()
    expect(persistent).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{ not json')
  })

  it('falls back and leaves the file untouched for the wrong version', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(path, JSON.stringify({ version: 2, ciphertext: 'enc:aa' }))
    const store = new SeedStore(path, workingSafeStorage())
    const { persistent } = await store.resolve()
    expect(persistent).toBe(false)
  })

  it('falls back and leaves the file untouched for a decrypted result that is not 64 hex characters', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new SeedStore(path, {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptStringAsync: async () => Buffer.from('placeholder'),
      decryptStringAsync: async () => ({ shouldReEncrypt: false, result: 'not hex at all' })
    })
    writeFileSync(path, JSON.stringify({ version: 1, ciphertext: Buffer.from('placeholder').toString('base64') }))
    const { persistent } = await store.resolve()
    expect(persistent).toBe(false)
  })
})
