import { describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../shared/bridge.js'
import { proxyTestWords, resultOf, RoutePart } from '../settings/route-part.js'

function part (reply: unknown | (() => Promise<unknown>)): { part: RoutePart, request: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => typeof reply === 'function' ? await (reply as () => Promise<unknown>)() : reply)
  const notify = vi.fn()
  return { part: new RoutePart({ request } as unknown as OrivonInternal, notify), request, notify }
}

describe('RoutePart', () => {
  it('asks main to test the saved proxy, naming no address of its own, and keeps the answer with the address it was for', async () => {
    const { part: route, request, notify } = part({ ok: true, authentication: 'none' })

    await route.test('127.0.0.1:9050')

    expect(request).toHaveBeenCalledWith('route', { type: 'test' })
    expect(route.last).toEqual({ address: '127.0.0.1:9050', result: { ok: true, authentication: 'none' } })
    expect(route.busy).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('is busy while main has not answered, and ignores a second press', async () => {
    let answer: (value: unknown) => void = () => {}
    const { part: route, request } = part(async () => await new Promise((resolve) => { answer = resolve }))

    const first = route.test('127.0.0.1:9050')
    expect(route.busy).toBe(true)
    await route.test('127.0.0.1:9050')
    expect(request).toHaveBeenCalledTimes(1)
    answer({ ok: false, reason: 'silent' })
    await first

    expect(route.busy).toBe(false)
    expect(route.last?.result).toEqual({ ok: false, reason: 'silent' })
  })

  it('reads a failed request, or an answer it does not know, as nothing answering', async () => {
    const failing = part(async () => { throw new Error('closed') })
    await failing.part.test('x:1')
    expect(failing.part.last?.result).toEqual({ ok: false, reason: 'unreachable' })
    expect(resultOf(undefined)).toEqual({ ok: false, reason: 'unreachable' })
    expect(resultOf({ ok: true })).toEqual({ ok: false, reason: 'unreachable' })
    expect(resultOf({ ok: false, reason: 'because' })).toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('proxyTestWords', () => {
  it('says what was found, in words about the proxy', () => {
    expect(proxyTestWords({ ok: true, authentication: 'none' })).toBe('A SOCKS5 proxy answered.')
    expect(proxyTestWords({ ok: true, authentication: 'password' })).toContain('its own')
    for (const reason of ['no-proxy', 'unreachable', 'silent', 'not-socks5', 'refused'] as const) {
      expect(proxyTestWords({ ok: false, reason }).length, reason).toBeGreaterThan(10)
    }
  })
})
