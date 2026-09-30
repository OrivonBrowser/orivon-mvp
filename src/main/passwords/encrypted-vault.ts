// The saved-login store on disk: one `passwords.json` whose passwords are each encrypted by the system keyring
// through `SafeStorageLike`, so another program reading the file sees origins and usernames but no password.
// Pure over that interface and a path; ./open-vault.ts chooses this store or the session-only one.
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { NO_REAL_KEYRING } from '../keyring/seed-store.js'
import type { SafeStorageLike } from '../keyring/seed-store.js'
import { isStorableOrigin, loginKey, MAX_LOGINS, MAX_NEVER, MAX_PASSWORD, MAX_USERNAME, parsePasswordsFile, printPasswordsFile } from './passwords-file.js'
import type { StoredLogin } from './passwords-file.js'
import type { Login, LoginInput, NeverSaved, PasswordVault, VaultState } from './vault.js'

export interface EncryptedVaultOptions {
  readonly path: string
  readonly storage: SafeStorageLike
  readonly now?: () => number
}

const toLogin = (stored: StoredLogin): Login => ({ id: stored.id, origin: stored.origin, username: stored.username, created: stored.created, used: stored.used })

/**
 * Keeps every login in memory (origin, username and ciphertext) and writes the whole file after a change.
 *
 * NEVER WRITES OVER A FILE IT CANNOT MAKE SENSE OF. A corrupt file leaves the store `unavailable` for the whole
 * run: nothing is listed and every change is refused, so a transient fault can never destroy real passwords. The
 * same holds when no real keyring is behind `safeStorage`, which would only encrypt with a key stored beside
 * the file.
 */
export class EncryptedVault implements PasswordVault {
  readonly never: NeverSaved
  readonly #path: string
  readonly #storage: SafeStorageLike
  readonly #now: () => number
  readonly #logins = new Map<string, StoredLogin>()
  readonly #neverSaved = new Set<string>()
  readonly #listeners = new Set<() => void>()
  readonly #ready: Promise<void>
  #state: VaultState = 'unavailable'
  #corrupt = false
  #keepCopyOfInvalid = false
  #pendingWrite: Promise<void> | undefined

  constructor (options: EncryptedVaultOptions) {
    this.#path = options.path
    this.#storage = options.storage
    this.#now = options.now ?? Date.now
    this.never = {
      has: (origin) => this.#neverSaved.has(origin),
      add: (origin) => { this.#addNever(origin) },
      remove: (origin) => { this.#removeNever(origin) },
      list: () => [...this.#neverSaved]
    }
    this.#load()
    this.#ready = this.#probe()
  }

  state (): VaultState {
    return this.#state
  }

  async ready (): Promise<void> {
    await this.#ready
  }

  list (origin?: string): readonly Login[] {
    if (this.#state !== 'ready') return []
    return [...this.#logins.values()].filter((stored) => origin === undefined || stored.origin === origin).map(toLogin)
  }

  async reveal (id: string): Promise<string | undefined> {
    await this.#ready
    const stored = this.#state === 'ready' ? this.#logins.get(id) : undefined
    if (stored === undefined) return undefined
    try {
      const { result, shouldReEncrypt } = await this.#storage.decryptStringAsync(Buffer.from(stored.secret, 'base64'))
      if (shouldReEncrypt) void this.#reEncrypt(id, result)
      return result
    } catch {
      console.error('[passwords] the keyring could not decrypt a saved password')
      return undefined
    }
  }

  async save (entry: LoginInput): Promise<Login | null> {
    await this.#ready
    const valid = this.#state === 'ready' && isStorableOrigin(entry.origin) &&
      typeof entry.username === 'string' && entry.username.length <= MAX_USERNAME &&
      typeof entry.password === 'string' && entry.password !== '' && entry.password.length <= MAX_PASSWORD
    if (!valid) return null
    let secret: string
    try {
      secret = (await this.#storage.encryptStringAsync(entry.password)).toString('base64')
    } catch {
      console.error('[passwords] the keyring could not encrypt a password')
      return null
    }
    // Looked up only now, after the keyring's answer, so two saves of one login that overlap make one login.
    const existing = this.#find(entry.origin, entry.username)
    if (existing === undefined && this.#logins.size >= MAX_LOGINS) return null
    const before = existing === undefined ? undefined : { ...existing }
    const stored = existing ?? { id: randomUUID(), origin: entry.origin, username: entry.username, secret, created: this.#now(), used: 0 }
    stored.secret = secret
    this.#logins.set(stored.id, stored)
    try {
      await this.#persist()
    } catch (error) {
      console.error('[passwords] the passwords file could not be written', error)
      if (before === undefined) this.#logins.delete(stored.id)
      else Object.assign(stored, before)
      return null
    }
    this.#changed()
    return toLogin(stored)
  }

  remove (id: string): boolean {
    if (this.#state !== 'ready' || !this.#logins.delete(id)) return false
    this.#writeInBackground()
    this.#changed()
    return true
  }

  touch (id: string): void {
    const stored = this.#logins.get(id)
    if (this.#state !== 'ready' || stored === undefined) return
    stored.used = this.#now()
    this.#writeInBackground()
    this.#changed()
  }

  onChange (listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Resolves when every change made so far is on disk. */
  async flush (): Promise<void> {
    await this.#pendingWrite
  }

  #find (origin: string, username: string): StoredLogin | undefined {
    const key = loginKey(origin, username)
    for (const stored of this.#logins.values()) if (loginKey(stored.origin, stored.username) === key) return stored
    return undefined
  }

  #addNever (origin: string): void {
    if (this.#state !== 'ready' || !isStorableOrigin(origin) || this.#neverSaved.has(origin) || this.#neverSaved.size >= MAX_NEVER) return
    this.#neverSaved.add(origin)
    this.#writeInBackground()
    this.#changed()
  }

  #removeNever (origin: string): void {
    if (this.#state !== 'ready' || !this.#neverSaved.delete(origin)) return
    this.#writeInBackground()
    this.#changed()
  }

  #changed (): void {
    for (const listener of [...this.#listeners]) listener()
  }

  #load (): void {
    let text: string
    try {
      text = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.#corrupt = true
      console.error('[passwords] the passwords file could not be read; it is left as it is')
      return
    }
    const parsed = parsePasswordsFile(text)
    if (parsed.status === 'corrupt') {
      this.#corrupt = true
      console.error(`[passwords] the passwords file is not usable (${parsed.reason}); it is left as it is`)
      return
    }
    for (const stored of parsed.logins) this.#logins.set(stored.id, stored)
    for (const origin of parsed.never) this.#neverSaved.add(origin)
    if (parsed.dropped > 0) {
      this.#keepCopyOfInvalid = true
      console.error(`[passwords] ${String(parsed.dropped)} entries of the passwords file were not valid and are not used`)
    }
  }

  async #probe (): Promise<void> {
    if (this.#corrupt) return
    try {
      if (!await this.#storage.isAsyncEncryptionAvailable()) return
      if (NO_REAL_KEYRING.has(this.#storage.getSelectedStorageBackend())) return
      this.#state = 'ready'
      // Watchers that started while the answer was pending learn it only from a change.
      this.#changed()
    } catch {
      console.error('[passwords] the system keyring could not be asked')
    }
  }

  async #reEncrypt (id: string, password: string): Promise<void> {
    try {
      const secret = (await this.#storage.encryptStringAsync(password)).toString('base64')
      const stored = this.#logins.get(id)
      if (stored === undefined) return
      stored.secret = secret
      await this.#persist()
    } catch {
      // The old ciphertext still decrypts; the next reveal tries again.
    }
  }

  #writeInBackground (): void {
    this.#persist().catch((error: unknown) => { console.error('[passwords] the passwords file could not be written', error) })
  }

  /** Changes made in the same turn share one write; every caller learns whether it landed. */
  async #persist (): Promise<void> {
    this.#pendingWrite ??= new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        this.#pendingWrite = undefined
        try {
          this.#writeNow()
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error('write failed'))
        }
      })
    })
    await this.#pendingWrite
  }

  #writeNow (): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    if (this.#keepCopyOfInvalid) {
      // Entries this build dropped on reading may be good ones a newer build wrote: keep the file they came from.
      try {
        copyFileSync(this.#path, `${this.#path}.invalid`)
        chmodSync(`${this.#path}.invalid`, 0o600)
      } catch {
        // Nothing to keep when the file is already gone.
      }
      this.#keepCopyOfInvalid = false
    }
    writeFileAtomic(this.#path, printPasswordsFile(this.#logins.values(), this.#neverSaved), 0o600)
    try {
      chmodSync(this.#path, 0o600)
    } catch {
      // Windows has no such bits; its per-user profile directory is the protection there.
    }
  }
}
