// Where Orivon's own identity seed lives, and how it survives a restart.
// ADR-0031, security-model.md's cross-platform note: no keyring reachable
// means the seed is generated fresh IN MEMORY every launch and NEVER
// written to disk in plaintext -- there is no third option. Pure
// (`SafeStorageLike` is injected), so this is tested against a real temp
// directory the way ../sessions/notification-decisions.ts already is, with
// no Electron import here at all; ./electron-keychain.ts is the thin real
// wiring over Electron's own `safeStorage`.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'

/** The one shape this file needs from Electron's `safeStorage` -- the
 * ASYNC trio only. The sync one can block the main process on a keyring
 * unlock prompt; this file never calls it. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean, result: string }>
  getSelectedStorageBackend(): string
}

/** Electron's own two names for "no real keyring is behind this backend"
 * (electron.d.ts's `getSelectedStorageBackend`). Anything else -- including
 * a name this file has never heard of -- is treated as a real keyring:
 * failing open here would mean failing OPEN on which backends persist a
 * plaintext-adjacent secret, the wrong direction for this decision. */
const NO_REAL_KEYRING = new Set(['basic_text', 'unknown'])

const FILE_VERSION = 1
const SEED_BYTES = 32
const HEX_SEED = /^[0-9a-f]{64}$/

export interface SeedResolution {
  readonly seed: Uint8Array
  /** False for a seed that exists only for this process's lifetime -- no
   * keyring was reachable, or the persisted file could not be read or
   * written. `orivon.secrets.available()` is built on exactly this flag. */
  readonly persistent: boolean
}

function isHexSeed (value: unknown): value is string {
  return typeof value === 'string' && HEX_SEED.test(value)
}

function decodeCiphertext (value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
}

/**
 * One store per process, holding at most one seed for the lifetime of that
 * process: `resolve()` is memoized so every concurrent first caller shares
 * the same in-flight generation rather than each minting its own (a race
 * that would otherwise leave the LAST write on disk the one a later
 * restart silently adopts, even though every process this session derived
 * keys from whichever seed it individually generated first).
 *
 * NEVER OVERWRITES A FILE IT CANNOT MAKE SENSE OF. An unreadable, corrupt
 * or undecryptable file is left exactly as it is: this store falls back to
 * a session-only seed rather than risk destroying a real one a transient
 * fault (a locked keyring, a momentary disk error) only made LOOK broken.
 */
export class SeedStore {
  readonly #path: string
  readonly #safeStorage: SafeStorageLike
  #resolution: Promise<SeedResolution> | undefined

  constructor (path: string, safeStorage: SafeStorageLike) {
    this.#path = path
    this.#safeStorage = safeStorage
  }

  resolve (): Promise<SeedResolution> {
    this.#resolution ??= this.#resolveOnce()
    return this.#resolution
  }

  async #resolveOnce (): Promise<SeedResolution> {
    const existing = await this.#readExisting()
    // THE THREE-WAY SPLIT IS LOAD-BEARING, not the same as a plain
    // undefined check: 'absent' (nothing there yet) is the only case
    // allowed to reach `#generateAndPersist`, which WRITES to `#path`.
    // 'unreadable' (a file IS there, but this store could not make sense
    // of it) must never reach that write, or the "never overwrite" promise
    // in this class's own header is just a comment -- confirmed live, by
    // this file's own test suite, before this split existed.
    if (existing.status === 'ok') return { seed: existing.seed, persistent: true }
    if (existing.status === 'unreadable') {
      const seed = randomBytes(SEED_BYTES)
      console.error('[keyring] an existing seed file could not be used; using a seed for this session only, and the file is left untouched')
      return { seed, persistent: false }
    }
    return await this.#generateAndPersist()
  }

  async #keyringReachable (): Promise<boolean> {
    if (!await this.#safeStorage.isAsyncEncryptionAvailable()) return false
    return !NO_REAL_KEYRING.has(this.#safeStorage.getSelectedStorageBackend())
  }

  /** Reached only for `existing.status === 'absent'` -- see `#resolveOnce`'s own doc on why that split matters. */
  async #generateAndPersist (): Promise<SeedResolution> {
    const seed = randomBytes(SEED_BYTES)
    if (!await this.#keyringReachable()) {
      console.error('[keyring] no OS keyring is reachable; using an identity seed for this session only')
      return { seed, persistent: false }
    }
    try {
      await this.#writeSeed(seed)
      return { seed, persistent: true }
    } catch (error) {
      console.error('[keyring] could not persist a new identity seed; using one for this session only', error)
      return { seed, persistent: false }
    }
  }

  async #writeSeed (seed: Uint8Array): Promise<void> {
    const ciphertext = await this.#safeStorage.encryptStringAsync(Buffer.from(seed).toString('hex'))
    writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, ciphertext: ciphertext.toString('base64') }))
  }

  /**
   * `'absent'`: nothing at `#path` -- safe to generate a fresh seed AND
   * persist it. `'unreadable'`: something IS at `#path`, but this store
   * could not turn it into a seed (bad JSON, wrong version, a keyring that
   * refused to decrypt it, a malformed result) -- MUST NOT be treated the
   * same as absent, because the caller that only checks "did I get a seed
   * back" cannot otherwise tell a real gap from a file it must leave alone.
   * `'ok'`: a real seed, read successfully.
   */
  async #readExisting (): Promise<{ status: 'absent' } | { status: 'unreadable' } | { status: 'ok', seed: Uint8Array }> {
    if (!existsSync(this.#path)) return { status: 'absent' }

    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      console.error('[keyring] the seed file could not be read', error)
      return { status: 'unreadable' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.error('[keyring] the seed file is not valid JSON')
      return { status: 'unreadable' }
    }
    if (typeof parsed !== 'object' || parsed === null) return { status: 'unreadable' }
    const { version, ciphertext } = parsed as { version?: unknown, ciphertext?: unknown }
    if (version !== FILE_VERSION) return { status: 'unreadable' }
    const buffer = decodeCiphertext(ciphertext)
    if (buffer === undefined) return { status: 'unreadable' }

    let decrypted: { shouldReEncrypt: boolean, result: string }
    try {
      decrypted = await this.#safeStorage.decryptStringAsync(buffer)
    } catch (error) {
      console.error('[keyring] the seed could not be decrypted', error)
      return { status: 'unreadable' }
    }
    if (!isHexSeed(decrypted.result)) {
      console.error('[keyring] the decrypted seed is malformed')
      return { status: 'unreadable' }
    }
    // Fire-and-forget: the seed already decrypted successfully above, so a
    // failed re-encrypt costs nothing this session, only a repeat of the
    // same rotation prompt next time.
    if (decrypted.shouldReEncrypt) {
      this.#writeSeed(Buffer.from(decrypted.result, 'hex'))
        .catch((error: unknown) => { console.error('[keyring] could not re-encrypt the seed under the rotated key', error) })
    }
    return { status: 'ok', seed: Buffer.from(decrypted.result, 'hex') }
  }
}
