import { describe, expect, it, vi } from 'vitest'
import { cookieKey } from '../cookie-list.js'
import { cookieViewsFor, removeCookies, removeSiteCookie, removeSiteCookies } from '../cookie-runner.js'
import type { CookieJar } from '../cookie-runner.js'

const SHOP = { name: 'a', domain: '.shop.example', path: '/', secure: true, value: 'secret-1' }
const SHOP_B = { name: 'b', domain: 'www.shop.example', path: '/x', value: 'secret-2' }
const OTHER = { name: 'a', domain: '.other.example', path: '/', value: 'secret-3' }

function jar (cookies: object[] = [SHOP, SHOP_B, OTHER]): CookieJar & { remove: ReturnType<typeof vi.fn>, flushStore: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => cookies), remove: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) } as never
}

describe('cookies of a site through a jar', () => {
  it('lists the site\'s cookies with no value', async () => {
    const views = await cookieViewsFor(jar(), 'www.shop.example')
    expect(views.map((view) => view.name)).toEqual(['a', 'b'])
    expect(JSON.stringify(views)).not.toContain('secret')
  })

  it('lists nothing when the jar cannot be read', async () => {
    const broken = { get: async () => { throw new Error('no') } } as never
    expect(await cookieViewsFor(broken, 'shop.example')).toEqual([])
  })

  it('removes the one cookie a key names by its own address, then writes the jar', async () => {
    const j = jar()
    expect(await removeSiteCookie(j, 'www.shop.example', cookieKey(SHOP_B))).toBe(true)
    expect(j.remove).toHaveBeenCalledTimes(1)
    expect(j.remove).toHaveBeenCalledWith('http://www.shop.example/x', 'b')
    expect(j.flushStore).toHaveBeenCalledOnce()
  })

  it('ignores a key that is stale, or that names another site\'s cookie', async () => {
    const j = jar()
    expect(await removeSiteCookie(j, 'www.shop.example', 'ffffffffffffffff')).toBe(false)
    expect(await removeSiteCookie(j, 'www.shop.example', cookieKey(OTHER))).toBe(false)
    expect(j.remove).not.toHaveBeenCalled()
  })

  it('puts back a same-named cookie of another scope that the removal took along', async () => {
    const parent = { name: 'sid', domain: '.shop.example', path: '/', secure: true, value: 'parent', hostOnly: false, httpOnly: true, sameSite: 'lax', expirationDate: 1_900_000_000 }
    const own = { name: 'sid', domain: 'www.shop.example', path: '/', secure: true, value: 'own', hostOnly: true, session: true }
    let held: object[] = [parent, own]
    const set = vi.fn(async (details: object) => { held = [...held, details] })
    const j = {
      get: vi.fn(async () => held),
      remove: vi.fn(async () => { held = [] }),
      set,
      flushStore: vi.fn(async () => {})
    } as never as CookieJar
    expect(await removeSiteCookie(j, 'www.shop.example', cookieKey(own as never))).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://shop.example/', name: 'sid', value: 'parent', domain: '.shop.example', httpOnly: true, expirationDate: 1_900_000_000 }))
  })

  it('does not put back what the same removal was asked to remove', async () => {
    const one = { name: 'sid', domain: '.shop.example', path: '/', secure: true, value: '1' }
    const two = { name: 'sid', domain: 'www.shop.example', path: '/', secure: true, value: '2', hostOnly: true }
    let held: object[] = [one, two]
    const set = vi.fn(async () => {})
    const j = { get: vi.fn(async () => held), remove: vi.fn(async () => { held = [] }), set, flushStore: vi.fn(async () => {}) } as never as CookieJar
    expect(await removeCookies(j, [one, two])).toBe(0)
    expect(set).not.toHaveBeenCalled()
  })

  it('removes every cookie of the site and none of another', async () => {
    const j = jar()
    await removeSiteCookies(j, 'shop.example')
    expect(j.remove.mock.calls).toEqual([['https://shop.example/', 'a']])
  })

  it('counts what could not be removed and still writes the jar', async () => {
    const j = jar()
    j.remove.mockRejectedValueOnce(new Error('x'))
    expect(await removeCookies(j, [SHOP, SHOP_B])).toBe(1)
    expect(j.flushStore).toHaveBeenCalledOnce()
  })
})
