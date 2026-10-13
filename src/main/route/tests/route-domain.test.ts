import { describe, expect, it, vi } from 'vitest'
import type { Socks5Probe } from '../../../broker/route/socks5-probe.js'
import { routeDomain } from '../route-domain.js'

const CALLER = {} as never

function domain (proxy: string, probe: (target: { host: string, port: number }) => Promise<Socks5Probe>) {
  return routeDomain({ proxy: () => proxy, probe })
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
})
