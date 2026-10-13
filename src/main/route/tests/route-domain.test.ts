import { describe, expect, it, vi } from 'vitest'
import type { Socks5Probe } from '../../../broker/route/socks5-probe.js'
import { routeDomain } from '../route-domain.js'
import type { RouteSwitch } from '../route-switch.js'

const CALLER = {} as never

const ROWS = [{ origin: 'https://news.example', kind: 'site', entry: 'on', state: 'idle', profile: 'tunnel', apart: true }] as const

function domain (proxy: string, probe: (target: { host: string, port: number }) => Promise<Socks5Probe>, routeSwitch: Partial<RouteSwitch> = {}) {
  return routeDomain({ proxy: () => proxy, probe, routeSwitch: { rows: () => [...ROWS], removeSiteStorage: async () => true, ...routeSwitch } })
}

describe('routeDomain', () => {
  it('is for the Settings page only', () => {
    expect(domain('', async () => ({ ok: true, authentication: 'none' })).pages).toEqual(['settings'])
  })

  it('tests the proxy that is set, and passes the answer on', async () => {
    const probe = vi.fn(async () => ({ ok: true, authentication: 'password' }) as const)

    const answer = await domain('127.0.0.1:9050', probe).handle({ type: 'test' }, CALLER)

    expect(probe).toHaveBeenCalledWith({ host: '127.0.0.1', port: 9050 })
    expect(answer).toEqual({ ok: true, authentication: 'password' })
  })

  it('says so, and probes nothing, when no proxy is set or the setting is not an address', async () => {
    const probe = vi.fn(async () => ({ ok: true, authentication: 'none' }) as const)
    expect(await domain('', probe).handle({ type: 'test' }, CALLER)).toEqual({ ok: false, reason: 'no-proxy' })
    expect(await domain('not an address', probe).handle({ type: 'test' }, CALLER)).toEqual({ ok: false, reason: 'no-proxy' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('passes a failure on as the reason', async () => {
    expect(await domain('127.0.0.1:9050', async () => ({ ok: false, reason: 'unreachable' })).handle({ type: 'test' }, CALLER)).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('answers nothing to a command it does not know', async () => {
    expect(await domain('127.0.0.1:9050', async () => ({ ok: true, authentication: 'none' })).handle({ type: 'other' }, CALLER)).toBeUndefined()
    expect(await domain('127.0.0.1:9050', async () => ({ ok: true, authentication: 'none' })).handle('test', CALLER)).toBeUndefined()
  })

  it('lists the sites and apps with a setting or storage of their own', async () => {
    expect(await domain('', async () => ({ ok: true, authentication: 'none' })).handle({ type: 'list' }, CALLER)).toEqual({ rows: ROWS })
  })

  it('removes the separate storage of the origin it is asked about, and says whether that was done', async () => {
    const removeSiteStorage = vi.fn(async () => true)
    const answer = await domain('', async () => ({ ok: true, authentication: 'none' }), { removeSiteStorage }).handle({ type: 'removeStorage', origin: 'https://news.example' }, CALLER)
    expect(removeSiteStorage).toHaveBeenCalledWith('https://news.example')
    expect(answer).toEqual({ ok: true })
    expect(await domain('', async () => ({ ok: true, authentication: 'none' }), { removeSiteStorage: async () => false }).handle({ type: 'removeStorage', origin: 'https://news.example' }, CALLER)).toEqual({ ok: false })
  })

  it('refuses an origin that is not the canonical origin of an address, without reaching the switch', async () => {
    const removeSiteStorage = vi.fn(async () => true)
    for (const origin of ['https://news.example/path', 'news.example', 7, null, undefined]) {
      expect(await domain('', async () => ({ ok: true, authentication: 'none' }), { removeSiteStorage }).handle({ type: 'removeStorage', origin }, CALLER), String(origin)).toEqual({ ok: false })
    }
    expect(removeSiteStorage).not.toHaveBeenCalled()
  })

  it('reports a storage it could not remove instead of throwing into the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const answer = await domain('', async () => ({ ok: true, authentication: 'none' }), { removeSiteStorage: async () => { throw new Error('disk') } }).handle({ type: 'removeStorage', origin: 'https://news.example' }, CALLER)
    expect(answer).toEqual({ ok: false })
  })
})
