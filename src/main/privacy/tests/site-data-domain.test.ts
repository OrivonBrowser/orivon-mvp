import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { cookieKey } from '../cookie-list.js'
import { siteDataDomain } from '../site-data-domain.js'
import type { SiteDataSession } from '../site-data-domain.js'

const COOKIES = [
  { name: 'a', domain: '.shop.example', path: '/', secure: true, value: 'secret-a', expirationDate: 1_900_000_000 },
  { name: 'b', domain: 'www.shop.example', path: '/', value: 'secret-b' },
  { name: 'c', domain: 'other.example', path: '/', value: 'secret-c' }
]

function fake (): { session: SiteDataSession, clearData: ReturnType<typeof vi.fn>, remove: ReturnType<typeof vi.fn>, flush: ReturnType<typeof vi.fn> } {
  const clearData = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  return {
    session: { cookies: { get: async () => COOKIES, remove, flushStore: flush }, clearData, getCacheSize: async () => 1000, storagePath: null } as never,
    clearData, remove, flush
  }
}

const caller = {} as InternalCaller
const ask = async (domain: ReturnType<typeof siteDataDomain>, command: unknown): Promise<unknown> => await domain.handle(command, caller)

describe('the site data domain', () => {
  it('is for the Settings page only', () => {
    expect(siteDataDomain(() => fake().session).pages).toEqual(['settings'])
  })

  it('lists sites by registrable domain with counts, without the origins main keeps or any value', async () => {
    const domain = siteDataDomain(() => fake().session)
    const reply = await ask(domain, { type: 'list' }) as { sites: Array<Record<string, unknown>> }
    expect(reply.sites.map((site) => [site['domain'], site['cookies']])).toEqual([['other.example', 1], ['shop.example', 2]])
    expect(reply.sites[0]).not.toHaveProperty('origins')
    expect(JSON.stringify(reply)).not.toContain('secret')
  })

  it('answers the cookies of a listed domain by host, and refuses one it did not list', async () => {
    const domain = siteDataDomain(() => fake().session)
    expect(await ask(domain, { type: 'cookies', domain: 'shop.example' })).toBeUndefined()
    await ask(domain, { type: 'list' })
    const reply = await ask(domain, { type: 'cookies', domain: 'shop.example' }) as { hosts: Array<{ host: string, cookies: Array<{ name: string }> }> }
    expect(reply.hosts.map((entry) => [entry.host, entry.cookies.map((cookie) => cookie.name)])).toEqual([['shop.example', ['a']], ['www.shop.example', ['b']]])
    expect(JSON.stringify(reply)).not.toContain('secret')
    expect(await ask(domain, { type: 'cookies', domain: 'evil.example' })).toBeUndefined()
    expect(await ask(domain, { type: 'cookies', domain: 5 })).toBeUndefined()
  })

  it('removes one cookie by the key it minted, and ignores a stale or malformed key', async () => {
    const { session, remove, flush } = fake()
    const domain = siteDataDomain(() => session)
    expect(await ask(domain, { type: 'removeCookie', key: cookieKey(COOKIES[2] as never) })).toEqual({ ok: true })
    expect(remove).toHaveBeenCalledWith('http://other.example/', 'c')
    expect(flush).toHaveBeenCalled()
    remove.mockClear()
    expect(await ask(domain, { type: 'removeCookie', key: '0123456789abcdef' })).toEqual({ ok: false })
    expect(await ask(domain, { type: 'removeCookie', key: 'https://other.example' })).toBeUndefined()
    expect(await ask(domain, { type: 'removeCookie' })).toBeUndefined()
    expect(remove).not.toHaveBeenCalled()
  })

  it('removes a site only after listing it, clearing its origins and its cookies and no other site\'s', async () => {
    const { session, clearData, remove } = fake()
    const domain = siteDataDomain(() => session)
    expect(await ask(domain, { type: 'removeSite', domain: 'shop.example' })).toBeUndefined()
    expect(clearData).not.toHaveBeenCalled()
    await ask(domain, { type: 'list' })
    expect(await ask(domain, { type: 'removeSite', domain: 'shop.example' })).toEqual({ ok: true })
    const { origins } = clearData.mock.calls[0]?.[0] as { origins: string[] }
    expect(origins.sort()).toEqual(['http://shop.example', 'http://www.shop.example', 'https://shop.example', 'https://www.shop.example'])
    expect(remove.mock.calls.map((call) => call[1]).sort()).toEqual(['a', 'b'])
  })

  it('refuses a domain it never listed and one that is not text', async () => {
    const { session, clearData } = fake()
    const domain = siteDataDomain(() => session)
    await ask(domain, { type: 'list' })
    expect(await ask(domain, { type: 'removeSite', domain: 'evil.example' })).toBeUndefined()
    expect(await ask(domain, { type: 'removeSite', domain: ['shop.example'] })).toBeUndefined()
    expect(clearData).not.toHaveBeenCalled()
  })

  it('says a removal failed when the session could not clear', async () => {
    const { session, clearData } = fake()
    clearData.mockRejectedValueOnce(new Error('x'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const domain = siteDataDomain(() => session)
    await ask(domain, { type: 'list' })
    expect(await ask(domain, { type: 'removeSite', domain: 'shop.example' })).toEqual({ ok: false })
    logged.mockRestore()
  })

  it('adds the cache to what sites take for the total', async () => {
    const domain = siteDataDomain(() => fake().session)
    expect(await ask(domain, { type: 'total' })).toEqual({ bytes: 1000 })
  })

  it('answers nothing to an unknown command', async () => {
    const domain = siteDataDomain(() => fake().session)
    expect(await ask(domain, { type: 'wipe' })).toBeUndefined()
    expect(await ask(domain, null)).toBeUndefined()
  })
})
