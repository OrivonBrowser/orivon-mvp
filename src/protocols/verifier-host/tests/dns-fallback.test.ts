import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGREED_FOR_MS, DIRECT_FOR_MS, withDnsFallback } from '../dns-fallback.js'
import type { DnsFallbackDeps } from '../dns-fallback.js'
import { DirectAnswerRefused } from '../direct-fetch.js'

const ORIGIN = 'https://gateway.example'
const OTHER = 'https://other.example'

function clock (start = 0): { now: () => number, set: (t: number) => void } {
  let time = start
  return { now: () => time, set: (t) => { time = t } }
}

function deps (overrides: Partial<DnsFallbackDeps> = {}): DnsFallbackDeps & { direct: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => new Response('ok', { status: 200 })),
    direct: vi.fn(async () => new Response('direct ok', { status: 200 })),
    systemAddresses: vi.fn(async () => ['10.0.0.1']),
    dohAddresses: vi.fn(async () => ['93.184.216.34']),
    ...overrides
  } as never
}

describe('withDnsFallback', () => {
  it('passes an origin outside the configured list straight through, unchecked', async () => {
    const d = deps()
    const fetch = withDnsFallback([ORIGIN], d)
    await fetch(`${OTHER}/x`, undefined)
    expect(d.fetch).toHaveBeenCalledTimes(1)
    expect(d.direct).not.toHaveBeenCalled()
    expect(d.systemAddresses).not.toHaveBeenCalled()
  })

  it('never checks anything on a plain HTTP error status -- only a transport failure', async () => {
    const d = deps({ fetch: vi.fn(async () => new Response('nope', { status: 404 })) })
    const fetch = withDnsFallback([ORIGIN], d)
    const response = await fetch(`${ORIGIN}/x`, undefined)
    expect(response.status).toBe(404)
    expect(d.systemAddresses).not.toHaveBeenCalled()
  })

  it('on a transport failure, disjoint answers switch to direct and retry once', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => ['85.38.30.66']), // the tampered address
      dohAddresses: vi.fn(async () => ['93.184.216.34']) // the real one
    })
    const fetch = withDnsFallback([ORIGIN], d)
    const response = await fetch(`${ORIGIN}/x`, undefined)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('direct ok')
    expect(d.direct).toHaveBeenCalledWith(`${ORIGIN}/x`, undefined, ['93.184.216.34'])
  })

  it('overlapping answers rethrow the original failure, never trying direct', async () => {
    const originalError = new TypeError('refused')
    const d = deps({
      fetch: vi.fn(async () => { throw originalError }),
      systemAddresses: vi.fn(async () => ['93.184.216.34']),
      dohAddresses: vi.fn(async () => ['93.184.216.34'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/x`, undefined)).rejects.toBe(originalError)
    expect(d.direct).not.toHaveBeenCalled()
  })

  it('a second failure within AGREED_FOR_MS of an agreeing verdict skips the check entirely', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => ['93.184.216.34']),
      dohAddresses: vi.fn(async () => ['93.184.216.34'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/x`, undefined)).rejects.toThrow('refused')
    expect(d.systemAddresses).toHaveBeenCalledTimes(1)

    await expect(fetch(`${ORIGIN}/y`, undefined)).rejects.toThrow('refused')
    expect(d.systemAddresses).toHaveBeenCalledTimes(1) // still 1: the recent 'net' verdict was honoured, not re-checked
  })

  it('a non-public DoH answer is never used, even if it disagrees with the system', async () => {
    // dohAddresses (doh.ts's own dohAddressResolver) already filters to
    // public-unicast only -- an empty answer here models that a resolver
    // named only private addresses, all dropped before reaching this module.
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => ['10.0.0.1']),
      dohAddresses: vi.fn(async () => [])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/x`, undefined)).rejects.toThrow('refused')
    expect(d.direct).not.toHaveBeenCalled()
  })

  it('an aborted caller signal is never treated as a transport failure worth checking', async () => {
    const controller = new AbortController()
    controller.abort()
    const d = deps({ fetch: vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }) })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/x`, { signal: controller.signal })).rejects.toThrow('aborted')
    expect(d.systemAddresses).not.toHaveBeenCalled()
  })

  it('concurrent failures for the same origin share one check', async () => {
    let systemCalls = 0
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => { systemCalls++; return ['10.0.0.1'] }),
      dohAddresses: vi.fn(async () => ['93.184.216.34'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await Promise.all([fetch(`${ORIGIN}/a`, undefined), fetch(`${ORIGIN}/b`, undefined)])
    expect(systemCalls).toBe(1)
  })

  it('a route expires and is re-checked afterward', async () => {
    const c = clock()
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => ['10.0.0.1']),
      dohAddresses: vi.fn(async () => ['93.184.216.34']),
      now: c.now
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await fetch(`${ORIGIN}/x`, undefined)
    expect(d.systemAddresses).toHaveBeenCalledTimes(1)

    c.set(DIRECT_FOR_MS + 1)
    vi.mocked(d.direct).mockImplementationOnce(async () => { throw new Error('direct also down now') })
    await expect(fetch(`${ORIGIN}/x`, undefined)).rejects.toThrow()
    // The expired route falls back to net.fetch, which still fails, triggering a fresh check.
    expect(d.systemAddresses).toHaveBeenCalledTimes(2)
  })

  it('a direct failure falls back to net on the next call, not immediately', async () => {
    const d = deps({
      fetch: vi.fn()
        .mockImplementationOnce(async () => { throw new TypeError('refused') })
        .mockImplementationOnce(async () => new Response('net ok now', { status: 200 })),
      direct: vi.fn(async () => { throw new Error('direct is down too') }),
      systemAddresses: vi.fn(async () => ['10.0.0.1']),
      dohAddresses: vi.fn(async () => ['93.184.216.34'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/x`, undefined)).rejects.toThrow('direct is down too')
    const response = await fetch(`${ORIGIN}/x`, undefined)
    expect(await response.text()).toBe('net ok now')
  })

  it('a direct attempt its caller abandoned keeps the direct route', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused (forged address)') }),
      direct: vi.fn(async (_url: string, init: RequestInit | undefined) => {
        if (init?.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
        return new Response('direct ok', { status: 200 })
      }),
      systemAddresses: vi.fn(async () => ['85.38.30.66'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    expect(await (await fetch(`${ORIGIN}/a`, undefined)).text()).toBe('direct ok')
    const controller = new AbortController()
    controller.abort(new Error('superseded by a faster attempt'))
    await expect(fetch(`${ORIGIN}/b`, { signal: controller.signal })).rejects.toThrow()
    expect(await (await fetch(`${ORIGIN}/c`, undefined)).text()).toBe('direct ok')
    expect(d.direct).toHaveBeenCalledTimes(3)
    expect(d.systemAddresses).toHaveBeenCalledTimes(1)
  })

  it('a gateway reached directly whose answer is refused keeps the direct route', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      direct: vi.fn()
        .mockImplementationOnce(async () => { throw new DirectAnswerRefused('status 999') })
        .mockImplementation(async () => new Response('direct ok', { status: 200 })),
      systemAddresses: vi.fn(async () => ['85.38.30.66'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/a`, undefined)).rejects.toBeInstanceOf(DirectAnswerRefused)
    expect(await (await fetch(`${ORIGIN}/b`, undefined)).text()).toBe('direct ok')
    expect(d.fetch).toHaveBeenCalledTimes(1)
  })

  it('a verdict reached while this request was in flight is honoured, not re-checked', async () => {
    let failSlow: (() => void) | undefined
    const d = deps({
      fetch: vi.fn()
        .mockImplementationOnce(async () => await new Promise<Response>((_resolve, reject) => { failSlow = () => { reject(new TypeError('refused, slowly')) } }))
        .mockImplementationOnce(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => ['85.38.30.66'])
    })
    const fetch = withDnsFallback([ORIGIN], d)
    const slow = fetch(`${ORIGIN}/slow`, undefined)
    expect(await (await fetch(`${ORIGIN}/fast`, undefined)).text()).toBe('direct ok')
    failSlow!()
    expect(await (await slow).text()).toBe('direct ok')
    expect(d.systemAddresses).toHaveBeenCalledTimes(1)
  })

  it('a system resolver that says the name does not exist counts as disagreeing', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') })
    })
    const fetch = withDnsFallback([ORIGIN], d)
    expect(await (await fetch(`${ORIGIN}/x`, undefined)).text()).toBe('direct ok')
  })

  it('a system resolver that fails any other way is no reason to go direct', async () => {
    const d = deps({
      fetch: vi.fn(async () => { throw new TypeError('refused') }),
      systemAddresses: vi.fn(async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED') })
    })
    const fetch = withDnsFallback([ORIGIN], d)
    await expect(fetch(`${ORIGIN}/x`, undefined)).rejects.toThrow('refused')
    expect(d.direct).not.toHaveBeenCalled()
  })

  describe('a system resolver that never answers', () => {
    afterEach(() => { vi.useRealTimers() })

    it('is given up on with the DoH side, and is no reason to go direct', async () => {
      vi.useFakeTimers()
      const d = deps({
        fetch: vi.fn(async () => { throw new TypeError('refused') }),
        systemAddresses: vi.fn(async () => await new Promise<readonly string[]>(() => {}))
      })
      const fetch = withDnsFallback([ORIGIN], d)
      const outcome = fetch(`${ORIGIN}/x`, undefined).then(() => 'answered', (error: unknown) => (error as Error).message)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await outcome).toBe('refused')
      expect(d.direct).not.toHaveBeenCalled()
    })

    it('does not hold a caller that aborts while the check runs', async () => {
      const d = deps({
        fetch: vi.fn(async () => { throw new TypeError('refused') }),
        systemAddresses: vi.fn(async () => await new Promise<readonly string[]>(() => {}))
      })
      const fetch = withDnsFallback([ORIGIN], d)
      const controller = new AbortController()
      const pending = fetch(`${ORIGIN}/x`, { signal: controller.signal })
      setTimeout(() => { controller.abort(new Error('the client left')) }, 10)
      await expect(pending).rejects.toThrow('the client left')
    })
  })

  it('AGREED_FOR_MS and DIRECT_FOR_MS are exported and positive', () => {
    expect(AGREED_FOR_MS).toBeGreaterThan(0)
    expect(DIRECT_FOR_MS).toBeGreaterThan(0)
  })
})
