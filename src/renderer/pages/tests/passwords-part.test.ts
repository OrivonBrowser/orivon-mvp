import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onArmEnded } from '../shared/armed.js'
import type { OrivonInternal } from '../shared/bridge.js'
import { ARM_MS, PasswordsPart } from '../settings/passwords/passwords-part.js'

const LOGINS = [
  { id: 'b', origin: 'https://shop.example', username: 'grace', created: 2, used: 0 },
  { id: 'a', origin: 'https://mail.example', username: 'ada', created: 1, used: 0 }
]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function setup (answers: Record<string, unknown> = {}, list: Record<string, unknown> = {}): { part: PasswordsPart, request: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn>, draws: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (_domain: string, command: { type: string }) => {
    await Promise.resolve()
    if (command.type === 'list') return { state: 'ready', logins: LOGINS, never: ['https://never.example'], hideMs: 30_000, ...list }
    return answers[command.type]
  })
  const notify = vi.fn()
  const part = new PasswordsPart({ request } as unknown as OrivonInternal, notify)
  const draws = vi.fn()
  part.subscribe(draws)
  return { part, request, notify, draws }
}

describe('PasswordsPart', () => {
  it('loads the list and sorts it by site, for a search to narrow', async () => {
    const { part } = setup()
    expect(part.vault).toBeNull()
    await part.load()
    expect(part.vault).toBe('ready')
    expect(part.entries().map((entry) => entry.login.id)).toEqual(['a', 'b'])
    part.setQuery('grace')
    expect(part.entries().map((entry) => entry.login.id)).toEqual(['b'])
    expect(part.page().matching).toBe(1)
  })

  it('ignores an answer it does not recognise', async () => {
    const { part } = setup({}, { logins: 'nope' })
    await part.load()
    expect(part.vault).toBeNull()
  })

  it('reloads once for a burst of changes pushed from main, and only takes its own topic', async () => {
    const { part, request, notify } = setup()
    await part.load()
    expect(part.handle('history.changed')).toBe(false)
    expect(part.handle('passwords.changed')).toBe(true)
    expect(part.handle('passwords.changed')).toBe(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(request.mock.calls.filter(([, command]) => (command as { type: string }).type === 'list')).toHaveLength(2)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  describe('showing a password', () => {
    it('takes two clicks: the first arms, the second asks main and shows', async () => {
      const { part, request } = setup({ reveal: { password: 'the-password' } })
      await part.load()
      part.pressReveal('a')
      expect(part.armedReveal).toBe('a')
      expect(part.revealed).toBeNull()
      expect(request).not.toHaveBeenCalledWith('passwords', { type: 'reveal', id: 'a' })
      part.pressReveal('a')
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledWith('passwords', { type: 'reveal', id: 'a' })
      expect(part.revealed).toEqual({ id: 'a', password: 'the-password' })
      expect(part.armedReveal).toBeNull()
    })

    it('starts over when the second click comes too late', async () => {
      const { part, request } = setup({ reveal: { password: 'x' } })
      await part.load()
      part.pressReveal('a')
      await vi.advanceTimersByTimeAsync(ARM_MS + 1)
      expect(part.armedReveal).toBeNull()
      part.pressReveal('a')
      expect(part.armedReveal).toBe('a')
      expect(request).not.toHaveBeenCalledWith('passwords', expect.objectContaining({ type: 'reveal' }))
    })

    it('arms another login instead of showing the first one', async () => {
      const { part } = setup({ reveal: { password: 'x' } })
      await part.load()
      part.pressReveal('a')
      part.pressReveal('b')
      expect(part.armedReveal).toBe('b')
      expect(part.revealed).toBeNull()
    })

    it('hides again on a third click, after the time main reported, and on demand', async () => {
      const { part } = setup({ reveal: { password: 'x' } }, { hideMs: 1500 })
      await part.load()
      const show = async (): Promise<void> => { part.pressReveal('a'); part.pressReveal('a'); await vi.advanceTimersByTimeAsync(0) }
      await show()
      expect(part.revealed?.id).toBe('a')
      part.pressReveal('a')
      expect(part.revealed).toBeNull()
      await show()
      await vi.advanceTimersByTimeAsync(1499)
      expect(part.revealed).not.toBeNull()
      await vi.advanceTimersByTimeAsync(2)
      expect(part.revealed).toBeNull()
      await show()
      part.hide()
      expect(part.revealed).toBeNull()
    })

    it('drops a reveal whose reply arrives after the page was told to hide', async () => {
      const { part } = setup({ reveal: { password: 'late' } })
      await part.load()
      part.pressReveal('a')
      part.pressReveal('a')
      part.hide()
      await vi.advanceTimersByTimeAsync(0)
      expect(part.revealed).toBeNull()
    })

    it('shows nothing when main has no password to give, and forgets one whose login went away', async () => {
      const { part } = setup({ reveal: undefined })
      await part.load()
      part.pressReveal('a')
      part.pressReveal('a')
      await vi.advanceTimersByTimeAsync(0)
      expect(part.revealed).toBeNull()
    })

    it('hides a shown password when its login is no longer listed', async () => {
      const { part, request } = setup({ reveal: { password: 'x' } })
      await part.load()
      part.pressReveal('a')
      part.pressReveal('a')
      await vi.advanceTimersByTimeAsync(0)
      expect(part.revealed).not.toBeNull()
      request.mockImplementation(async () => await Promise.resolve({ state: 'ready', logins: [LOGINS[0]], never: [], hideMs: 30_000 }))
      part.handle('passwords.changed')
      await vi.advanceTimersByTimeAsync(1100)
      expect(part.revealed).toBeNull()
    })
  })

  it('copies through main and says so for two seconds', async () => {
    const { part, request } = setup({ copy: { ok: true } })
    await part.load()
    await part.copy('a')
    expect(request).toHaveBeenCalledWith('passwords', { type: 'copy', id: 'a' })
    expect(part.toast).toEqual({ text: 'Password copied', where: 'list' })
    await vi.advanceTimersByTimeAsync(2001)
    expect(part.toast).toBeNull()
  })

  it('says nothing when main could not copy', async () => {
    const { part } = setup({ copy: { ok: false } })
    await part.load()
    await part.copy('a')
    expect(part.toast).toBeNull()
  })

  describe('deleting', () => {
    it('takes two clicks, and tells the page when the wait ends', async () => {
      const { part, request } = setup({ remove: { ok: true } })
      const ended = vi.fn()
      const off = onArmEnded(ended)
      await part.load()
      await part.pressDelete('a')
      expect(part.armedDelete).toBe('a')
      expect(request).not.toHaveBeenCalledWith('passwords', expect.objectContaining({ type: 'remove' }))
      await vi.advanceTimersByTimeAsync(ARM_MS + 1)
      expect(part.armedDelete).toBeNull()
      expect(ended).toHaveBeenCalledTimes(1)
      await part.pressDelete('a')
      await part.pressDelete('a')
      expect(request).toHaveBeenCalledWith('passwords', { type: 'remove', id: 'a' })
      expect(part.armedDelete).toBeNull()
      off()
    })
  })

  it('takes a site off the never list, and makes and copies a password', async () => {
    const { part, request } = setup({ generate: { password: 'generated-pw' }, copyGenerated: { ok: true } })
    await part.load()
    await part.removeNever('https://never.example')
    expect(request).toHaveBeenCalledWith('passwords', { type: 'neverRemove', origin: 'https://never.example' })
    await part.generate()
    expect(part.generated).toBe('generated-pw')
    await part.copyGenerated()
    expect(part.toast).toEqual({ text: 'Password copied', where: 'generated' })
  })

  describe('import and export', () => {
    it('shows what an import did, and nothing for a cancel', async () => {
      const { part } = setup({ import: { kind: 'imported', added: 42, updated: 0, unchanged: 0, skipped: 3 } })
      await part.load()
      await part.importFile()
      expect(part.notice).toEqual({ tone: 'ok', text: 'Imported 42 passwords. 3 rows were skipped.' })
      const cancelled = setup({ import: { kind: 'cancelled' } })
      await cancelled.part.load()
      await cancelled.part.importFile()
      expect(cancelled.part.notice).toBeNull()
    })

    it('asks for a second click before exporting, and sends the confirmation with it', async () => {
      const { part, request } = setup({ export: { kind: 'exported', count: 2 } })
      await part.load()
      await part.pressExport()
      expect(part.armedExport).toBe(true)
      expect(request).not.toHaveBeenCalledWith('passwords', expect.objectContaining({ type: 'export' }))
      await part.pressExport()
      expect(request).toHaveBeenCalledWith('passwords', { type: 'export', confirm: true })
      expect(part.armedExport).toBe(false)
      expect(part.notice?.tone).toBe('warn')
    })

    it('lets the wait for a second click run out', async () => {
      const { part, request } = setup({ export: { kind: 'exported', count: 2 } })
      await part.load()
      await part.pressExport()
      await vi.advanceTimersByTimeAsync(ARM_MS + 1)
      expect(part.armedExport).toBe(false)
      await part.pressExport()
      expect(request).not.toHaveBeenCalledWith('passwords', expect.objectContaining({ type: 'export' }))
    })

    it('reports a reply it cannot read as a failure', async () => {
      const { part } = setup({ import: undefined })
      await part.load()
      await part.importFile()
      expect(part.notice).toEqual({ tone: 'error', text: 'That did not work.' })
    })
  })
})
