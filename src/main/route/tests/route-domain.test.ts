import { describe, expect, it, vi } from 'vitest'
import type { Socks5Probe } from '../../../broker/route/socks5-probe.js'
import { routeDomain } from '../route-domain.js'
import type { RouteSwitch } from '../route-switch.js'
import type { RouteDomainDeps } from '../route-domain.js'

const CALLER = {} as never

const ROWS = [{ origin: 'https://news.example', kind: 'site', entry: 'on', state: 'idle', profile: 'tunnel', apart: true, apartIn: ['tunnel'] }] as const

const NYM_OFF: RouteDomainDeps['nym'] = { state: () => ({ state: 'off' }), test: async () => ({ ok: true, ms: 1234 }) }

function domain (proxy: string, probe: (target: { host: string, port: number }) => Promise<Socks5Probe>, routeSwitch: Partial<RouteSwitch> = {}, kind: 'nym' | 'socks5' = 'socks5', nym: RouteDomainDeps['nym'] = NYM_OFF) {
  return routeDomain({ proxy: () => proxy, kind: () => kind, probe, nym, routeSwitch: { rows: () => [...ROWS], removeSiteStorage: async () => true, ...routeSwitch } })
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

  it('tests Nym, and not the saved address, when Nym is the choice', async () => {
    const probe = vi.fn(async () => ({ ok: true, authentication: 'none' }) as const)
    const answer = await domain('127.0.0.1:9050', probe, {}, 'nym').handle({ type: 'test' }, CALLER)
    expect(answer).toEqual({ nym: true, ok: true, ms: 1234 })
    expect(probe).not.toHaveBeenCalled()
  })

  it('passes on why Nym could not be tested', async () => {
    const nym: RouteDomainDeps['nym'] = { ...NYM_OFF, test: async () => ({ ok: false, reason: 'unavailable', detail: 'the Nym tunnel is not in this build' }) }
    expect(await domain('', async () => ({ ok: true, authentication: 'none' }), {}, 'nym', nym).handle({ type: 'test' }, CALLER)).toEqual({ nym: true, ok: false, reason: 'unavailable', detail: 'the Nym tunnel is not in this build' })
  })

  it('says what Nym is doing', async () => {
    const nym: RouteDomainDeps['nym'] = { ...NYM_OFF, state: () => ({ state: 'connecting' }) }
    expect(await domain('', async () => ({ ok: true, authentication: 'none' }), {}, 'nym', nym).handle({ type: 'status' }, CALLER)).toEqual({ nym: { state: 'connecting' }, unreadable: false })
  })

  it('says when the settings file could not be read and the whole browser was put on the tunnel for that', async () => {
    const held = routeDomain({ proxy: () => '', kind: () => 'nym', probe: async () => ({ ok: true, authentication: 'none' }), nym: NYM_OFF, routeSwitch: { rows: () => [], removeSiteStorage: async () => true }, settingsUnreadable: () => true })
    expect(await held.handle({ type: 'status' }, CALLER)).toEqual({ nym: { state: 'off' }, unreadable: true })
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
