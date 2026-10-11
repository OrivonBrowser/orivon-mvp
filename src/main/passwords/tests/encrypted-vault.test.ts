import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SafeStorageLike } from '../../keyring/seed-store.js'
import { createFakeKeyring } from '../dev-password-storage.js'
import { EncryptedVault } from '../encrypted-vault.js'
import { MAX_LOGINS, MAX_PASSWORD, MAX_USERNAME } from '../passwords-file.js'

const SITE = 'https://shop.example'
let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-passwords-'))
  path = join(dir, 'passwords.json')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function opened (storage: SafeStorageLike = createFakeKeyring()): Promise<EncryptedVault> {
  const vault = new EncryptedVault({ path, storage })
  await vault.ready()
  return vault
}

const fileText = (): string => readFileSync(path, 'utf8')

describe('EncryptedVault', () => {
  it('saves a login, lists it without a password and reveals the password by id', async () => {
    const vault = await opened()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'hunter2-long' })
    expect(login).toMatchObject({ origin: SITE, username: 'ada', used: 0 })
    expect(vault.list()).toEqual([login])
    expect(JSON.stringify(vault.list())).not.toContain('hunter2')
    expect(await vault.reveal(login?.id ?? '')).toBe('hunter2-long')
  })

  it('replaces the password of the same origin and username, and keeps one login', async () => {
    const vault = await opened()
    const first = await vault.save({ origin: SITE, username: 'ada', password: 'one' })
    const second = await vault.save({ origin: SITE, username: 'ada', password: 'two' })
    expect(second?.id).toBe(first?.id)
    expect(second?.created).toBe(first?.created)
    expect(vault.list()).toHaveLength(1)
    expect(await vault.reveal(first?.id ?? '')).toBe('two')
  })

  it('makes one login of two overlapping saves of it', async () => {
    const vault = await opened()
    await Promise.all([
      vault.save({ origin: SITE, username: 'ada', password: 'one' }),
      vault.save({ origin: SITE, username: 'ada', password: 'two' })
    ])
    expect(vault.list()).toHaveLength(1)
  })

  it('lists the logins of one origin', async () => {
    const vault = await opened()
    await vault.save({ origin: SITE, username: 'ada', password: 'a' })
    await vault.save({ origin: SITE, username: 'grace', password: 'b' })
    await vault.save({ origin: 'https://other.example', username: 'ada', password: 'c' })
    expect(vault.list(SITE).map((login) => login.username)).toEqual(['ada', 'grace'])
    expect(vault.list('https://none.example')).toEqual([])
  })

  it('writes a file that holds no password, and no readable one either', async () => {
    const vault = await opened()
    await vault.save({ origin: SITE, username: 'ada', password: 'correct horse battery' })
    const text = fileText()
    expect(text).not.toContain('correct horse battery')
    expect(text).not.toContain(Buffer.from('correct horse battery').toString('base64'))
    expect(text).toContain('ada')
    expect(text).toContain(SITE)
  })

  it.skipIf(process.platform === 'win32')('creates the file readable by its owner alone', async () => {
    const vault = await opened()
    await vault.save({ origin: SITE, username: 'ada', password: 'x' })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps logins and the never list across a restart', async () => {
    const vault = await opened()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'kept' })
    vault.never.add('https://never.example')
    await vault.flush()

    const again = await opened()
    expect(again.list()).toEqual([login])
    expect(await again.reveal(login?.id ?? '')).toBe('kept')
    expect(again.never.list()).toEqual(['https://never.example'])
    expect(again.never.has('https://never.example')).toBe(true)
  })

  it('removes a login, on disk too, and tells its listeners', async () => {
    const vault = await opened()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'x' })
    const listener = vi.fn()
    vault.onChange(listener)
    expect(await vault.remove(login?.id ?? '')).toBe(true)
    expect(await vault.remove(login?.id ?? '')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    await vault.flush()
    expect((await opened()).list()).toEqual([])
  })

  it('remembers sites never to save for, once, and lets one go', async () => {
    const vault = await opened()
    vault.never.add('https://never.example')
    vault.never.add('https://never.example')
    vault.never.add('not an origin')
    expect(vault.never.list()).toEqual(['https://never.example'])
    vault.never.remove('https://never.example')
    expect(vault.never.has('https://never.example')).toBe(false)
  })

  it('refuses what cannot be a login', async () => {
    const vault = await opened()
    expect(await vault.save({ origin: `${SITE}/login`, username: 'ada', password: 'x' })).toBeNull()
    expect(await vault.save({ origin: 'ftp://files.example', username: 'ada', password: 'x' })).toBeNull()
    expect(await vault.save({ origin: SITE, username: 'ada', password: '' })).toBeNull()
    expect(await vault.save({ origin: SITE, username: 'a'.repeat(MAX_USERNAME + 1), password: 'x' })).toBeNull()
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'p'.repeat(MAX_PASSWORD + 1) })).toBeNull()
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'p'.repeat(MAX_PASSWORD) })).not.toBeNull()
    expect(await vault.save({ origin: SITE, username: '', password: 'x' })).not.toBeNull()
  })

  it('stops at the most logins it keeps, but still updates one it has', async () => {
    const vault = await opened()
    const batch = async (from: number, to: number): Promise<void> => {
      await Promise.all(Array.from({ length: to - from }, async (_, index) => await vault.save({ origin: SITE, username: `u${String(from + index)}`, password: 'x' })))
    }
    await batch(0, MAX_LOGINS)
    expect(vault.list()).toHaveLength(MAX_LOGINS)
    expect(await vault.save({ origin: SITE, username: 'one-too-many', password: 'x' })).toBeNull()
    expect(await vault.save({ origin: SITE, username: 'u5', password: 'changed' })).not.toBeNull()
  })

  it('answers nothing for an id it does not hold', async () => {
    const vault = await opened()
    expect(await vault.reveal('nope')).toBeUndefined()
    expect(await vault.remove('nope')).toBe(false)
  })

  it('drops invalid entries on reading, keeps the rest, and keeps the old file beside the new one', async () => {
    const good = { id: 'a', origin: SITE, username: 'ada', secret: Buffer.from('x').toString('base64'), created: 1, used: 0 }
    writeFileSync(path, JSON.stringify({
      version: 1,
      logins: [good, { ...good, id: 'b', origin: 'https://x.example/path' }, { ...good, id: 'c', secret: 'not base64!' }, { ...good, id: 'a', username: 'dup-id' }, 7],
      never: ['https://never.example', 'nonsense']
    }))
    const vault = await opened()
    expect(vault.list().map((login) => login.id)).toEqual(['a'])
    expect(vault.never.list()).toEqual(['https://never.example'])
    await vault.save({ origin: SITE, username: 'grace', password: 'new' })
    expect(readdirSync(dir)).toContain('passwords.json.invalid')
    expect(JSON.parse(readFileSync(`${path}.invalid`, 'utf8')).logins).toHaveLength(5)
  })

  it('leaves a file it cannot read exactly as it is, and keeps nothing', async () => {
    writeFileSync(path, '{ this is not json')
    const vault = await opened()
    expect(vault.state()).toBe('unavailable')
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).toBeNull()
    vault.never.add('https://never.example')
    await vault.flush()
    expect(fileText()).toBe('{ this is not json')
  })

  it('leaves a file written by another version alone', async () => {
    const text = JSON.stringify({ version: 2, logins: [] })
    writeFileSync(path, text)
    const vault = await opened()
    expect(vault.state()).toBe('unavailable')
    expect(fileText()).toBe(text)
  })

  it('is unavailable, and writes nothing, without a real keyring', async () => {
    for (const backend of ['basic_text', 'unknown']) {
      const storage: SafeStorageLike = { ...createFakeKeyring(), getSelectedStorageBackend: () => backend }
      const vault = await opened(storage)
      expect(vault.state()).toBe('unavailable')
      expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).toBeNull()
      expect(vault.list()).toEqual([])
    }
    expect(readdirSync(dir)).toEqual([])
  })

  // Electron's safeStorage has getSelectedStorageBackend on Linux only.
  it('is ready on Windows and macOS, whose keyring has no backend name, and unavailable on Linux without one', async () => {
    const { getSelectedStorageBackend: _unused, ...storage } = createFakeKeyring()
    for (const platform of ['win32', 'darwin'] as const) {
      const vault = new EncryptedVault({ path, storage, platform })
      await vault.ready()
      expect(vault.state()).toBe('ready')
    }
    const linux = new EncryptedVault({ path, storage, platform: 'linux' })
    await linux.ready()
    expect(linux.state()).toBe('unavailable')
  })

  it('is unavailable when the system says encryption is not available, or cannot be asked', async () => {
    expect((await opened({ ...createFakeKeyring(), isAsyncEncryptionAvailable: async () => false })).state()).toBe('unavailable')
    expect((await opened({ ...createFakeKeyring(), isAsyncEncryptionAvailable: async () => { throw new Error('no bus') } })).state()).toBe('unavailable')
  })

  it('says unavailable until it has asked the system, then ready', async () => {
    const vault = new EncryptedVault({ path, storage: createFakeKeyring() })
    expect(vault.state()).toBe('unavailable')
    await vault.ready()
    expect(vault.state()).toBe('ready')
  })

  it('tells its listeners once the system has answered and the store is ready', async () => {
    const vault = new EncryptedVault({ path, storage: createFakeKeyring() })
    const listener = vi.fn()
    vault.onChange(listener)
    await vault.ready()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('records a fill on the login it names, writes it and tells its listeners', async () => {
    const vault = await opened()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'one' })
    const listener = vi.fn()
    vault.onChange(listener)
    vault.touch(login?.id ?? '')
    vault.touch('no-such-login')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(vault.list()[0]?.used).toBeGreaterThan(0)
    await vault.flush()
    expect(JSON.parse(fileText()).logins[0].used).toBe(vault.list()[0]?.used)
  })

  it('keeps nothing and says so when the keyring refuses to encrypt', async () => {
    const vault = await opened({ ...createFakeKeyring(), encryptStringAsync: async () => { throw new Error('locked') } })
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).toBeNull()
    expect(vault.list()).toEqual([])
  })

  it('answers nothing for a password the keyring cannot decrypt', async () => {
    const vault = await opened()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'x' })
    const locked = new EncryptedVault({ path, storage: { ...createFakeKeyring(), decryptStringAsync: async () => { throw new Error('locked') } } })
    await locked.ready()
    expect(await locked.reveal(login?.id ?? '')).toBeUndefined()
  })

  it('undoes a save whose file could not be written', async () => {
    const vault = await opened()
    await vault.save({ origin: SITE, username: 'ada', password: 'one' })
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'a file where the directory should be')
    expect(await vault.save({ origin: SITE, username: 'grace', password: 'two' })).toBeNull()
    expect(vault.list().map((login) => login.username)).toEqual(['ada'])
    rmSync(dir, { force: true })
  })

  it('keeps a login whose removal could not be written, and says so', async () => {
    const vault = await opened()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'one' })
    const listener = vi.fn()
    vault.onChange(listener)
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, 'a file where the directory should be')
    expect(await vault.remove(login?.id ?? '')).toBe(false)
    expect(vault.list().map((entry) => entry.username)).toEqual(['ada'])
    expect(listener).not.toHaveBeenCalled()
    rmSync(dir, { force: true })
  })

  it('never logs a username or a password', async () => {
    const log = vi.spyOn(console, 'error')
    const vault = await opened({ ...createFakeKeyring(), encryptStringAsync: async () => { throw new Error('locked') } })
    await vault.save({ origin: SITE, username: 'ada-the-user', password: 'secret-word' })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ada-the-user|secret-word/)
  })
})
