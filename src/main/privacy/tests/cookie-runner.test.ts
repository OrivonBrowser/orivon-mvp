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
