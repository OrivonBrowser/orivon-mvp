import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { backgroundDomain } from '../background-domain.js'

const contents = {} as WebContents

describe('the new-tab picture domain', () => {
  it('is for the Settings page alone', () => {
    expect(backgroundDomain({ install: vi.fn() }, { pick: vi.fn() }).pages).toEqual(['settings'])
  })

  it('installs what the picker returns and reports the outcome', async () => {
    const install = vi.fn(() => ({ ok: true as const }))
    const domain = backgroundDomain({ install }, { pick: async () => '/pics/a.png' })
    expect(await domain.handle({ type: 'choose' }, { page: 'settings', contents })).toEqual({ ok: true })
    expect(install).toHaveBeenCalledWith('/pics/a.png')
  })

  it('passes a refusal on with its reason', async () => {
    const domain = backgroundDomain({ install: () => ({ ok: false, reason: 'No.' }) }, { pick: async () => '/x' })
    expect(await domain.handle({ type: 'choose' }, { page: 'settings', contents })).toEqual({ ok: false, reason: 'No.' })
  })

  it('changes nothing when the person cancels', async () => {
    const install = vi.fn()
    const domain = backgroundDomain({ install }, { pick: async () => undefined })
    expect(await domain.handle({ type: 'choose' }, { page: 'settings', contents })).toEqual({ ok: false, cancelled: true })
    expect(install).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 5, 'choose', {}, { type: 'install', path: '/etc/passwd' }])('ignores a request of the wrong shape: %j', async (command) => {
    const pick = vi.fn()
    const install = vi.fn()
    const domain = backgroundDomain({ install }, { pick })
    expect(await domain.handle(command, { page: 'settings', contents })).toBeUndefined()
    expect(pick).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
  })

  it('opens one picker at a time', async () => {
    let release: (path: string | undefined) => void = () => {}
    const pick = vi.fn(async () => await new Promise<string | undefined>((resolve) => { release = resolve }))
    const domain = backgroundDomain({ install: () => ({ ok: true }) }, { pick })
    const first = domain.handle({ type: 'choose' }, { page: 'settings', contents })
    expect(await domain.handle({ type: 'choose' }, { page: 'settings', contents })).toEqual({ ok: false, cancelled: true })
    release('/a.png')
    await first
    expect(pick).toHaveBeenCalledTimes(1)
  })
})
