import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { createFakeKeyring } from '../dev-password-storage.js'
import { EncryptedVault } from '../encrypted-vault.js'
import { passwordsDomain } from '../passwords-domain.js'
import type { PasswordsHost, ReadResult } from '../passwords-domain.js'
import { memoryVault } from '../vault.js'
import type { PasswordVault } from '../vault.js'

const SITE = 'https://shop.example'
const caller = { page: 'settings', contents: {} } as unknown as InternalCaller
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-passwords-domain-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

interface Setup {
  vault: PasswordVault
  host: PasswordsHost
  ask: (command: unknown) => Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  copied: string[]
  written: Array<{ path: string, text: string }>
  picks: { open: string | undefined, save: string | undefined }
  files: Map<string, ReadResult>
}

async function setup (vault?: PasswordVault): Promise<Setup> {
  const made = vault ?? new EncryptedVault({ path: join(dir, 'passwords.json'), storage: createFakeKeyring() })
  await made.ready?.()
  const copied: string[] = []
  const written: Array<{ path: string, text: string }> = []
  const picks = { open: undefined as string | undefined, save: undefined as string | undefined }
  const files = new Map<string, ReadResult>()
  const host: PasswordsHost = {
    vault: made,
    clipboard: { copy: async (text) => { copied.push(text); return await Promise.resolve(true) } },
    revealHideMs: 30_000,
    pickImport: async () => await Promise.resolve(picks.open),
    pickExport: async () => await Promise.resolve(picks.save),
    readFile: async (path) => await Promise.resolve(files.get(path) ?? { ok: false, reason: 'unreadable' }),
    writeFile: async (path, text) => { written.push({ path, text }); return await Promise.resolve(true) }
  }
  const domain = passwordsDomain(host)
  return { vault: made, host, ask: async (command) => await domain.handle(command, caller), copied, written, picks, files }
}

describe('the Passwords domain', () => {
  it('serves the Settings page only', () => {
    expect(passwordsDomain({ vault: memoryVault() } as unknown as PasswordsHost).pages).toEqual(['settings'])
  })

  it('lists the logins, the never list and the state, with no password and no ciphertext', async () => {
    const { vault, ask } = await setup()
    await vault.save({ origin: SITE, username: 'ada', password: 'hunter2-hunter2' })
    vault.never.add('https://never.example')
    const reply = await ask({ type: 'list' })
    expect(reply).toMatchObject({ state: 'ready', never: ['https://never.example'], hideMs: 30_000 })
    expect(reply.logins).toEqual([expect.objectContaining({ origin: SITE, username: 'ada' })])
    expect(Object.keys(reply.logins[0]).sort()).toEqual(['created', 'id', 'origin', 'used', 'username'])
    expect(JSON.stringify(reply)).not.toMatch(/hunter2|secret/)
  })

  it('reports a store that keeps nothing as such, with an empty list', async () => {
    const vault = new EncryptedVault({ path: join(dir, 'passwords.json'), storage: { ...createFakeKeyring(), getSelectedStorageBackend: () => 'basic_text' } })
    expect(await (await setup(vault)).ask({ type: 'list' })).toMatchObject({ state: 'unavailable', logins: [] })
    expect(await (await setup(memoryVault('private'))).ask({ type: 'list' })).toMatchObject({ state: 'private', logins: [] })
  })

  it('reveals the password of a login it holds, and only that', async () => {
    const { vault, ask } = await setup()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'the-password' })
    expect(await ask({ type: 'reveal', id: login?.id })).toEqual({ password: 'the-password' })
    expect(await ask({ type: 'reveal', id: 'unknown-id' })).toBeUndefined()
  })

  it('copies a password from main, so it never reaches the page', async () => {
    const { vault, ask, copied } = await setup()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'the-password' })
    const reply = await ask({ type: 'copy', id: login?.id })
    expect(reply).toEqual({ ok: true })
    expect(copied).toEqual(['the-password'])
    expect(await ask({ type: 'copy', id: 'unknown-id' })).toEqual({ ok: false })
    expect(copied).toHaveLength(1)
  })

  it('removes a login and lets a never-saved site go', async () => {
    const { vault, ask } = await setup()
    const login = await vault.save({ origin: SITE, username: 'ada', password: 'x' })
    vault.never.add('https://never.example')
    expect(await ask({ type: 'remove', id: login?.id })).toEqual({ ok: true })
    expect(await ask({ type: 'remove', id: login?.id })).toEqual({ ok: false })
    expect(await ask({ type: 'neverRemove', origin: 'https://never.example' })).toEqual({ ok: true })
    expect(vault.list()).toEqual([])
    expect(vault.never.list()).toEqual([])
  })

  it('answers nothing to a request of the wrong shape', async () => {
    const { ask, copied } = await setup()
    for (const command of [undefined, null, 'list', 7, {}, { type: 'nope' }, { type: 'reveal' }, { type: 'reveal', id: 7 }, { type: 'reveal', id: '' }, { type: 'reveal', id: 'x'.repeat(65) },
      { type: 'copy', id: {} }, { type: 'remove', id: ['a'] }, { type: 'neverRemove', origin: 'javascript:alert(1)' }, { type: 'neverRemove' }, { type: 'export' }, { type: 'export', confirm: 'yes' }]) {
      expect(await ask(command), JSON.stringify(command)).toBeUndefined()
    }
    expect(copied).toEqual([])
  })

  it('makes a 20-character password, and copies the last one it made, never one the page names', async () => {
    const { ask, copied } = await setup()
    expect(await ask({ type: 'copyGenerated' })).toEqual({ ok: false })
    const { password } = await ask({ type: 'generate' })
    expect(password).toHaveLength(20)
    expect(await ask({ type: 'copyGenerated', password: 'something else' })).toEqual({ ok: true })
    expect(copied).toEqual([password])
  })

  describe('import', () => {
    it('adds, updates and counts what the file holds', async () => {
      const { vault, ask, picks, files } = await setup()
      await vault.save({ origin: SITE, username: 'ada', password: 'old' })
      await vault.save({ origin: SITE, username: 'same', password: 'same-pw' })
      picks.open = '/tmp/in.csv'
      files.set('/tmp/in.csv', { ok: true, text: `url,username,password\n${SITE},ada,new\n${SITE},same,same-pw\nhttps://b.example,grace,pw\nnot-a-url,x,y\n${SITE},ada,newest\n` })
      expect(await ask({ type: 'import' })).toEqual({ kind: 'imported', added: 1, updated: 1, unchanged: 1, skipped: 2 })
      const ada = vault.list(SITE).find((login) => login.username === 'ada')
      expect(await vault.reveal(ada?.id ?? '')).toBe('newest')
      expect(vault.list()).toHaveLength(3)
    })

    it('does nothing when the person cancels, and says why a file did not work', async () => {
      const { vault, ask, picks, files } = await setup()
      expect(await ask({ type: 'import' })).toEqual({ kind: 'cancelled' })
      picks.open = '/tmp/in.csv'
      expect(await ask({ type: 'import' })).toEqual({ kind: 'failed', reason: 'unreadable' })
      files.set('/tmp/in.csv', { ok: false, reason: 'too-large' })
      expect(await ask({ type: 'import' })).toEqual({ kind: 'failed', reason: 'too-large' })
      files.set('/tmp/in.csv', { ok: true, text: 'a,b\n1,2\n' })
      expect(await ask({ type: 'import' })).toEqual({ kind: 'failed', reason: 'not-passwords' })
      expect(vault.list()).toEqual([])
    })

    it('refuses while nothing can be kept, without opening a dialog', async () => {
      const { ask } = await setup(memoryVault('private'))
      const pick = vi.fn()
      const domain = passwordsDomain({ vault: memoryVault('private'), pickImport: pick, pickExport: pick } as unknown as PasswordsHost)
      expect(await domain.handle({ type: 'import' }, caller)).toEqual({ kind: 'failed', reason: 'unavailable' })
      expect(await domain.handle({ type: 'export', confirm: true }, caller)).toEqual({ kind: 'failed', reason: 'unavailable' })
      expect(pick).not.toHaveBeenCalled()
      expect(await ask({ type: 'import' })).toEqual({ kind: 'failed', reason: 'unavailable' })
    })
  })

  describe('export', () => {
    it('writes every login with its password as CSV, sorted, to the place picked', async () => {
      const { vault, ask, picks, written } = await setup()
      await vault.save({ origin: 'https://b.example', username: 'grace', password: 'p2' })
      await vault.save({ origin: SITE, username: 'ada', password: 'p,1' })
      picks.save = '/tmp/out.csv'
      expect(await ask({ type: 'export', confirm: true })).toEqual({ kind: 'exported', count: 2 })
      expect(written).toEqual([{ path: '/tmp/out.csv', text: 'name,url,username,password,note\r\nb.example,https://b.example,grace,p2,\r\nshop.example,https://shop.example,ada,"p,1",\r\n' }])
    })

    it('writes nothing when the person cancels the dialog', async () => {
      const { ask, written } = await setup()
      expect(await ask({ type: 'export', confirm: true })).toEqual({ kind: 'cancelled' })
      expect(written).toEqual([])
    })

    it('says so when the file could not be written', async () => {
      const { host, vault } = await setup()
      await vault.save({ origin: SITE, username: 'ada', password: 'p' })
      const domain = passwordsDomain({ ...host, pickExport: async () => await Promise.resolve('/x.csv'), writeFile: async () => await Promise.resolve(false) })
      expect(await domain.handle({ type: 'export', confirm: true }, caller)).toEqual({ kind: 'failed', reason: 'not-written' })
    })
  })
})
