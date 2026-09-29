// cachingProxyProbe -- T20's fail-closed check (security-model.md,
// docs/open-questions.md A263), tested here against a fake `resolveProxy`
// with no `electron` import: ./ipc.ts's own `afterReady` is the only place
// that wires the real `session.defaultSession.resolveProxy`.

import { describe, expect, it, vi } from 'vitest'
import { cachingProxyProbe } from '../proxy-probe.js'

const URL_A = 'https://api.example.com:443/'
const URL_B = 'https://other.example.com:443/'

describe('cachingProxyProbe', () => {
  it('answers false only for the exact literal DIRECT', async () => {
    const probe = cachingProxyProbe(async () => 'DIRECT')
    expect(await probe(URL_A)).toBe(false)
  })

  it('answers true for anything else a real resolveProxy can return', async () => {
    for (const answer of ['PROXY 127.0.0.1:8080', 'SOCKS5 127.0.0.1:9050', '', 'direct', 'PROXY 127.0.0.1:8080;DIRECT']) {
      const probe = cachingProxyProbe(async () => answer)
      expect(await probe(URL_A)).toBe(true)
    }
  })

  it('fails closed when resolveProxy rejects', async () => {
    const probe = cachingProxyProbe(async () => { throw new Error('no proxy service') })
    expect(await probe(URL_A)).toBe(true)
  })

  it('fails closed when resolveProxy never settles', async () => {
    vi.useFakeTimers()
    try {
      const probe = cachingProxyProbe(async () => await new Promise<string>(() => {}))
      const result = probe(URL_A)
      await vi.advanceTimersByTimeAsync(2_001)
      expect(await result).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caches one URL\'s answer rather than asking resolveProxy again inside the TTL', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT')
    let clock = 0
    const probe = cachingProxyProbe(resolveProxy, () => clock)

    await probe(URL_A)
    await probe(URL_A)
    expect(resolveProxy).toHaveBeenCalledTimes(1)
  })

  it('asks again once the cached answer\'s TTL has passed', async () => {
    const resolveProxy = vi.fn(async () => 'DIRECT')
    let clock = 0
    const probe = cachingProxyProbe(resolveProxy, () => clock)

    await probe(URL_A)
    clock = 60_000
    await probe(URL_A)
    expect(resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('caches each URL on its own, never sharing one answer across two different targets', async () => {
    const resolveProxy = vi.fn(async (url: string) => (url === URL_A ? 'DIRECT' : 'PROXY 127.0.0.1:8080'))
    const probe = cachingProxyProbe(resolveProxy)

    expect(await probe(URL_A)).toBe(false)
    expect(await probe(URL_B)).toBe(true)
    expect(resolveProxy).toHaveBeenCalledTimes(2)
  })
})
