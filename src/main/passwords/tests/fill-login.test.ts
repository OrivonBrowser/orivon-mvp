import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { FormCommand } from '../form-message.js'
import { fillGenerated, fillLogin } from '../fill-login.js'
import { memoryVault } from '../vault.js'

const ORIGIN = 'https://site.example'

function page (url = `${ORIGIN}/login`, destroyed = false): { wc: WebContents, frame: { url: string } } {
  const frame = { url }
  return { wc: { isDestroyed: () => destroyed, mainFrame: frame } as unknown as WebContents, frame }
}

describe('fillLogin', () => {
  it('reads the password and sends it with the username to the page, then marks the login used', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'pw' })
    const touch = vi.spyOn(vault, 'touch')
    const send = vi.fn<(wc: WebContents, origin: string, command: FormCommand) => boolean>(() => true)
    expect(await fillLogin(page().wc, vault, login?.id ?? '', send)).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.anything(), ORIGIN, { type: 'fill', username: 'ada', password: 'pw', both: false })
    expect(touch).toHaveBeenCalledWith(login?.id)
  })

  it('does not mark a login used when nothing was sent', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'pw' })
    const touch = vi.spyOn(vault, 'touch')
    expect(await fillLogin(page().wc, vault, login?.id ?? '', () => false)).toBe(false)
    expect(touch).not.toHaveBeenCalled()
  })

  it('refuses a login of another origin than the page\'s', async () => {
    const vault = memoryVault()
    const other = await vault.save({ origin: 'https://other.example', username: 'x', password: 'pw' })
    const send = vi.fn(() => true)
    expect(await fillLogin(page().wc, vault, other?.id ?? '', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a page that is not http or https, and a destroyed one', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'pw' })
    const send = vi.fn(() => true)
    expect(await fillLogin(page('file:///tmp/x.html').wc, vault, login?.id ?? '', send)).toBe(false)
    expect(await fillLogin(page(undefined, true).wc, vault, login?.id ?? '', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a login whose password is gone', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'pw' })
    vi.spyOn(vault, 'reveal').mockResolvedValue(undefined)
    const send = vi.fn(() => true)
    expect(await fillLogin(page().wc, vault, login?.id ?? '', send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('passes the real check through: a page that moved while the password was read gets nothing', async () => {
    const vault = memoryVault()
    const login = await vault.save({ origin: ORIGIN, username: 'ada', password: 'pw' })
    const { wc, frame } = page()
    const sent: unknown[] = []
    ;(frame as { send?: (channel: string, command: unknown) => void }).send = (_channel, command) => { sent.push(command) }
    const reveal = vault.reveal.bind(vault)
    vault.reveal = async (id) => { const password = await reveal(id); frame.url = 'https://evil.example/'; return password }
    expect(await fillLogin(wc, vault, login?.id ?? '')).toBe(false)
    expect(sent).toEqual([])
  })
})

describe('fillGenerated', () => {
  it('sends the password to every password field and no username', () => {
    const send = vi.fn(() => true)
    expect(fillGenerated(page().wc, ORIGIN, 'Generated-Pw', send)).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.anything(), ORIGIN, { type: 'fill', username: null, password: 'Generated-Pw', both: true })
  })
})
