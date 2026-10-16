import { describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../shared/bridge.js'
import { nymStateOf, RoutePart } from '../settings/route-part.js'
import { proxyTestWords, resultOf } from '../shared/proxy-words.js'

function part (reply: unknown | (() => Promise<unknown>)): { part: RoutePart, request: ReturnType<typeof vi.fn>, notify: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async () => typeof reply === 'function' ? await (reply as () => Promise<unknown>)() : reply)
  const notify = vi.fn()
  return { part: new RoutePart({ request } as unknown as OrivonInternal, notify), request, notify }
}

describe('RoutePart', () => {
  it('asks main to test the saved proxy, naming no address of its own, and keeps the answer with the address it was for', async () => {
    const { part: route, request, notify } = part({ ok: true, authentication: 'none' })

    await route.test('127.0.0.1:9050', 'socks5')

    expect(request).toHaveBeenCalledWith('route', { type: 'test', kind: 'socks5' })
    expect(route.last).toEqual({ kind: 'socks5', subject: '127.0.0.1:9050', result: { ok: true, authentication: 'none' } })
    expect(route.busy).toBe(false)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('is busy while main has not answered, and ignores a second press', async () => {
    let answer: (value: unknown) => void = () => {}
    const { part: route, request } = part(async () => await new Promise((resolve) => { answer = resolve }))

    const first = route.test('127.0.0.1:9050', 'socks5')
    expect(route.busy).toBe(true)
    expect(route.testing).toBe('socks5')
    await route.test('127.0.0.1:9050', 'socks5')
    expect(request).toHaveBeenCalledTimes(1)
    answer({ ok: false, reason: 'silent' })
    await first

    expect(route.busy).toBe(false)
    expect(route.testing).toBeNull()
    expect(route.last?.result).toEqual({ ok: false, reason: 'silent' })
  })

  it('asks Nym to be tested by name, and keeps its answer apart from the proxy\'s', async () => {
    const { part: route, request } = part({ nym: true, ok: true, ms: 1200 })
    await route.test('nym', 'nym')
    expect(request).toHaveBeenCalledWith('route', { type: 'test', kind: 'nym' })
    expect(route.last).toEqual({ kind: 'nym', subject: 'nym', result: { nym: true, ok: true, ms: 1200 } })
  })

  it('reads a failed request, or an answer it does not know, as nothing answering', async () => {
    const failing = part(async () => { throw new Error('closed') })
    await failing.part.test('x:1', 'socks5')
    expect(failing.part.last?.result).toEqual({ ok: false, reason: 'unreachable' })
    expect(resultOf(undefined)).toEqual({ ok: false, reason: 'unreachable' })
    expect(resultOf({ ok: true })).toEqual({ ok: false, reason: 'unreachable' })
    expect(resultOf({ ok: false, reason: 'because' })).toEqual({ ok: false, reason: 'unreachable' })
  })
})

describe('proxyTestWords', () => {
  it('says what was found, in words about the proxy', () => {
    expect(proxyTestWords({ ok: true, authentication: 'none' })).toBe('The tunnel answered.')
    expect(proxyTestWords({ ok: true, authentication: 'password' })).toContain('its own')
    for (const reason of ['no-proxy', 'unreachable', 'silent', 'not-socks5', 'refused'] as const) {
      expect(proxyTestWords({ ok: false, reason }).length, reason).toBeGreaterThan(10)
    }
  })
})

describe('Nym in the tunnel part', () => {
  it('reads a Nym test answer, and a reason it does not know as a connection that failed', () => {
    expect(resultOf({ nym: true, ok: true, ms: 4200 })).toEqual({ nym: true, ok: true, ms: 4200 })
    expect(resultOf({ nym: true, ok: false, reason: 'unavailable', detail: 'not in this build' })).toEqual({ nym: true, ok: false, reason: 'unavailable', detail: 'not in this build' })
    expect(resultOf({ nym: true, ok: false, reason: 'because' })).toEqual({ nym: true, ok: false, reason: 'failed', detail: '' })
    expect(resultOf({ nym: true, ok: true, ms: 'slow' })).toEqual({ nym: true, ok: false, reason: 'failed', detail: '' })
  })

  it('loads what Nym is doing, follows main\'s pushes, and reads anything else as not started', async () => {
    const { part: route, request, notify } = part({ nym: { state: 'connecting' } })
    await route.load()
    expect(request).toHaveBeenCalledWith('route', { type: 'status' })
    expect(route.nym).toEqual({ state: 'connecting' })
    expect(route.rows, 'the list of sites and apps is read in the same load').toEqual([])
    notify.mockClear()
    expect(route.handle('nym.changed', { nym: { state: 'unavailable', cause: 'not-in-build', reason: 'missing' } })).toBe(true)
    expect(route.nym).toEqual({ state: 'unavailable', cause: 'not-in-build', reason: 'missing' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(route.handle('apps.changed', undefined)).toBe(false)
    expect(nymStateOf({ state: 'sleepy' })).toEqual({ state: 'off' })
    expect(nymStateOf(null)).toEqual({ state: 'off' })
  })
})
