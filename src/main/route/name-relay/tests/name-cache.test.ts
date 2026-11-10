// What the relay remembers of the names it looked up, and for how long.

import { describe, expect, it, vi } from 'vitest'
import { createNameCache, MAX_ENTRIES, MAX_NEGATIVE_TTL_SECONDS, MAX_TTL_SECONDS } from '../name-cache.js'
import type { CacheKey, Fetched } from '../name-cache.js'

const key = (overrides: Partial<CacheKey> = {}): CacheKey => ({ name: 'site.test', family: 4, provider: 'quad9', via: 'http://proxy.test:8080', ...overrides })
const found = (ttl: number, ...addresses: string[]): Fetched => ({ addresses, nxdomain: false, ttl })
const missing = (ttl: number): Fetched => ({ addresses: [], nxdomain: true, ttl })

function clock () {
  let at = 1_000_000
  return { now: () => at, advance: (seconds: number) => { at += seconds * 1000 } }
}

describe('what is remembered', () => {
  it('serves a second ask from memory until the TTL has passed', async () => {
    const time = clock()
    const cache = createNameCache({ now: time.now })
    const fetch = vi.fn(async () => found(30, '192.0.2.1'))
    expect(await cache.get(key(), fetch)).toEqual({ addresses: ['192.0.2.1'], nxdomain: false })
    time.advance(29)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    time.advance(2)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps an answer at most an hour, whatever TTL it carries', async () => {
    const time = clock()
    const cache = createNameCache({ now: time.now })
    const fetch = vi.fn(async () => found(86_400, '192.0.2.1'))
    await cache.get(key(), fetch)
    time.advance(MAX_TTL_SECONDS - 1)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    time.advance(2)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps a name that was not found at most a minute', async () => {
    const time = clock()
    const cache = createNameCache({ now: time.now })
    const fetch = vi.fn(async () => missing(1739))
    expect(await cache.get(key(), fetch)).toEqual({ addresses: [], nxdomain: true })
    time.advance(MAX_NEGATIVE_TTL_SECONDS - 1)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    time.advance(2)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing whose TTL is 0, for an answer or for a missing name', async () => {
    const cache = createNameCache()
    const fetch = vi.fn(async () => found(0, '192.0.2.1'))
    await cache.get(key(), fetch)
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
    const none = vi.fn(async () => missing(0))
    await cache.get(key(), none)
    await cache.get(key(), none)
    expect(none).toHaveBeenCalledTimes(2)
    expect(cache.size()).toBe(0)
  })

  it('never keeps a failure: the next ask asks again', async () => {
    const cache = createNameCache()
    const fetch = vi.fn<() => Promise<Fetched>>().mockRejectedValueOnce(new Error('no-answer')).mockResolvedValueOnce(found(30, '192.0.2.1'))
    await expect(cache.get(key(), fetch)).rejects.toThrow('no-answer')
    expect(await cache.get(key(), fetch)).toEqual({ addresses: ['192.0.2.1'], nxdomain: false })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('what an answer is kept for', () => {
  it('keeps an answer for each name, family, provider and proxy entry apart', async () => {
    const cache = createNameCache()
    const fetch = vi.fn(async () => found(60, '192.0.2.1'))
    for (const other of [key(), key({ name: 'other.test' }), key({ family: 6 }), key({ provider: 'cloudflare' }), key({ via: 'socks5://proxy.test:1080' })]) await cache.get(other, fetch)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(cache.size()).toBe(5)
    await cache.get(key({ family: 6 }), fetch)
    expect(fetch).toHaveBeenCalledTimes(5)
  })

  it('shares one query among those who ask while it is in flight, a TTL of 0 included', async () => {
    const cache = createNameCache()
    let release: (value: Fetched) => void = () => {}
    const fetch = vi.fn(async () => await new Promise<Fetched>((resolve) => { release = resolve }))
    const first = cache.get(key(), fetch)
    const second = cache.get(key(), fetch)
    release(found(0, '192.0.2.1'))
    expect(await first).toEqual(await second)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails everyone who shared a query that failed, and asks again for the next', async () => {
    const cache = createNameCache()
    let fail: (error: Error) => void = () => {}
    const fetch = vi.fn<() => Promise<Fetched>>().mockImplementationOnce(async () => await new Promise<Fetched>((_resolve, reject) => { fail = reject }))
    const first = cache.get(key(), fetch)
    const second = cache.get(key(), fetch)
    fail(new Error('no-answer'))
    await expect(first).rejects.toThrow('no-answer')
    await expect(second).rejects.toThrow('no-answer')
    fetch.mockResolvedValueOnce(found(10, '192.0.2.1'))
    await cache.get(key(), fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('how much is kept', () => {
  it('holds at most 2,000 entries and drops the one used least recently', async () => {
    const cache = createNameCache()
    const fetch = async (): Promise<Fetched> => found(600, '192.0.2.1')
    expect(MAX_ENTRIES).toBe(2000)
    for (let index = 0; index < MAX_ENTRIES; index += 1) await cache.get(key({ name: `n${String(index)}.test` }), fetch)
    await cache.get(key({ name: 'n0.test' }), vi.fn(fetch))
    await cache.get(key({ name: 'last.test' }), fetch)
    expect(cache.size()).toBe(MAX_ENTRIES)
    const again = vi.fn(fetch)
    await cache.get(key({ name: 'n0.test' }), again)
    expect(again).not.toHaveBeenCalled()
    await cache.get(key({ name: 'n1.test' }), again)
    expect(again).toHaveBeenCalledTimes(1)
  })
})

describe('forgetting', () => {
  it('drops a name for both families at once, so the next ask asks again', async () => {
    const cache = createNameCache()
    const fetch = vi.fn(async () => found(600, '192.0.2.1'))
    await cache.get(key(), fetch)
    await cache.get(key({ family: 6 }), fetch)
    await cache.get(key({ name: 'other.test' }), fetch)
    cache.drop({ name: 'site.test', provider: 'quad9', via: 'http://proxy.test:8080' })
    expect(cache.size()).toBe(1)
  })

  it('clears everything, and an answer still on its way is not kept', async () => {
    const cache = createNameCache()
    let release: (value: Fetched) => void = () => {}
    const slow = vi.fn(async () => await new Promise<Fetched>((resolve) => { release = resolve }))
    const pending = cache.get(key({ name: 'slow.test' }), slow)
    await cache.get(key({ name: 'kept.test' }), async () => found(600, '192.0.2.1'))
    cache.clear()
    expect(cache.size()).toBe(0)
    release(found(600, '192.0.2.2'))
    expect(await pending).toEqual({ addresses: ['192.0.2.2'], nxdomain: false })
    expect(cache.size()).toBe(0)
    const again = vi.fn(async () => found(600, '192.0.2.3'))
    await cache.get(key({ name: 'slow.test' }), again)
    expect(again).toHaveBeenCalledTimes(1)
  })
})
