import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeKeyring } from '../dev-password-storage.js'
import { openVault } from '../open-vault.js'

const SITE = 'https://shop.example'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-open-vault-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('openVault', () => {
  it('gives a private window a store that keeps nothing and never touches the file', async () => {
    const vault = openVault({ path: join(dir, 'passwords.json'), isPrivate: true, storage: createFakeKeyring() })
    await vault.ready?.()
    expect(vault.state()).toBe('private')
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).toBeNull()
    vault.never.add('https://never.example')
    expect(vault.never.list()).toEqual([])
    expect(existsSync(join(dir, 'passwords.json'))).toBe(false)
  })

  it.each(['basic_text', 'unknown'])('is unavailable on the %s backend, and writes nothing', async (backend) => {
    const vault = openVault({ path: join(dir, 'passwords.json'), isPrivate: false, storage: { ...createFakeKeyring(), getSelectedStorageBackend: () => backend } })
    await vault.ready?.()
    expect(vault.state()).toBe('unavailable')
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).toBeNull()
    expect(existsSync(join(dir, 'passwords.json'))).toBe(false)
  })

  it.each(['gnome_libsecret', 'kwallet5', 'kwallet6', 'keychain', 'a name nobody has heard of'])('keeps passwords on the %s backend', async (backend) => {
    const vault = openVault({ path: join(dir, 'passwords.json'), isPrivate: false, storage: { ...createFakeKeyring(), getSelectedStorageBackend: () => backend } })
    await vault.ready?.()
    expect(vault.state()).toBe('ready')
    expect(await vault.save({ origin: SITE, username: 'ada', password: 'x' })).not.toBeNull()
  })

  it('asks the system at once, so the state is final without anyone waiting for it', async () => {
    const vault = openVault({ path: join(dir, 'passwords.json'), isPrivate: false, storage: createFakeKeyring() })
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(vault.state()).toBe('ready')
  })
})
