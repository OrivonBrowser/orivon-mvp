import { describe, expect, it } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { startupDomain } from '../startup-domain.js'

const tab = (displayUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: displayUrl, displayUrl, isInternal: false, isNewTab: false, ...extra })

function domain (tabs: Array<Record<string, unknown>>, owns = true) {
  const contents = {}
  return {
    contents,
    handle: (command: unknown) => startupDomain({ findOwner: () => (owns ? { tabs: { getState: () => ({ tabs }) } } : undefined) } as never)
      .handle(command, { page: 'settings', contents } as unknown as InternalCaller)
  }
}

describe('startupDomain', () => {
  it('answers the Settings page only', () => {
    expect(startupDomain({} as never).pages).toEqual(['settings'])
  })

  it('says whether an address would load, and as what', () => {
    const { handle } = domain([])
    expect(handle({ type: 'validate', text: 'example.com' })).toEqual({ ok: true, normalised: 'https://example.com/' })
    expect(handle({ type: 'validate', text: 'https://a.example/x' })).toEqual({ ok: true, normalised: 'https://a.example/x' })
    expect(handle({ type: 'validate', text: 'two words, not an address' })).toEqual({ ok: false })
    expect(handle({ type: 'validate', text: 'javascript:alert(1)' })).toEqual({ ok: false })
    expect(handle({ type: 'validate', text: '' })).toEqual({ ok: false })
  })

  it('refuses a text that is not a string or is oversize', () => {
    const { handle } = domain([])
    expect(handle({ type: 'validate', text: 5 })).toEqual({ ok: false })
    expect(handle({ type: 'validate' })).toEqual({ ok: false })
    expect(handle({ type: 'validate', text: 'a'.repeat(5000) })).toEqual({ ok: false })
  })

  it('lists the web pages open in the asking window, leaving out the shell\'s own pages and the new tab page', () => {
    const { handle } = domain([
      tab('https://a.example/'), tab('orivon://settings/startup', { isInternal: true }), tab('', { isNewTab: true }),
      tab('http://b.example/'), tab('ipfs://bafy/'), tab('https://a.example/')
    ])
    expect(handle({ type: 'currentPages' })).toEqual(['https://a.example/', 'http://b.example/'])
  })

  it('lists at most eight', () => {
    const { handle } = domain(Array.from({ length: 12 }, (_, n) => tab(`https://${String(n)}.example/`)))
    expect(handle({ type: 'currentPages' })).toHaveLength(8)
  })

  it('lists nothing for a page outside any window', () => {
    expect(domain([tab('https://a.example/')], false).handle({ type: 'currentPages' })).toEqual([])
  })

  it('ignores a command it does not know, however malformed', () => {
    const { handle } = domain([])
    for (const command of [undefined, null, 'validate', 5, {}, { type: 'other' }, { type: 7 }, []]) expect(handle(command)).toBeUndefined()
  })
})
