import { describe, expect, it, vi } from 'vitest'
import { createProxyAnswers, PROXY_ASK_TIMEOUT_MS, PROXY_SETTLE_MS, proxyAnswerFor, proxyEpoch, proxySetInFlight, proxySetOverran, proxySettled, trackProxySet } from '../proxy-answers.js'

describe('a session that does not answer', () => {
  it('is given up on after the time allowed, long enough for automatic detection, and asked again by the next request', async () => {
    expect(PROXY_ASK_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    vi.useFakeTimers()
    try {
      const resolve = vi.fn(async () => await new Promise<string>(() => {}))
      const ask = createProxyAnswers({ resolve, epoch: () => 0 })
      const first = ask('https://a.eth/')
      const outcome = expect(first).rejects.toThrow('did not say which proxy')
      await vi.advanceTimersByTimeAsync(PROXY_ASK_TIMEOUT_MS - 1)
      expect(resolve).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await outcome
      const second = ask('https://a.eth/')
      const again = expect(second).rejects.toThrow('did not say which proxy')
      await vi.advanceTimersByTimeAsync(PROXY_ASK_TIMEOUT_MS)
      await again
      expect(resolve).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is waited for through a first answer that takes longer than two seconds', async () => {
    vi.useFakeTimers()
    try {
      const resolve = vi.fn(async () => await new Promise<string>((done) => { setTimeout(() => { done('DIRECT') }, 9_000) }))
      const ask = createProxyAnswers({ resolve, epoch: () => 0 })
      const answer = ask('https://slow.eth/')
      await vi.advanceTimersByTimeAsync(9_000)
      expect(await answer).toBe('DIRECT')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createProxyAnswers', () => {
  it('asks for the origin of the URL', async () => {
    const resolve = vi.fn(async () => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    expect(await ask('https://name.eth/index.html?x=1')).toBe('DIRECT')
    expect(resolve).toHaveBeenCalledExactlyOnceWith('https://name.eth/')
  })

  it('keeps nothing once an answer has come: the next request asks again', async () => {
    const resolve = vi.fn<(url: string) => Promise<string>>().mockResolvedValueOnce('DIRECT').mockResolvedValue('PROXY p:1')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    expect(await ask('https://a.eth/')).toBe('DIRECT')
    expect(await ask('https://a.eth/')).toBe('PROXY p:1')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('keeps host, port and scheme apart', async () => {
    const released: Array<(answer: string) => void> = []
    const resolve = vi.fn(async (_url: string) => await new Promise<string>((done) => { released.push(done) }))
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    const all = Promise.all([ask('https://a.eth/'), ask('https://b.eth/'), ask('http://a.eth/'), ask('https://a.eth:8443/')])
    expect(resolve.mock.calls.map((call) => call[0])).toEqual(['https://a.eth/', 'https://b.eth/', 'http://a.eth/', 'https://a.eth:8443/'])
    for (const release of released) release('DIRECT')
    await all
  })

  it('shares one question between asks that overlap', async () => {
    let release: (answer: string) => void = () => {}
    const resolve = vi.fn(async () => await new Promise<string>((done) => { release = done }))
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    const both = Promise.all([ask('https://a.eth/x'), ask('https://a.eth/y')])
    release('PROXY p:1')
    expect(await both).toEqual(['PROXY p:1', 'PROXY p:1'])
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does not share a question that was on its way when the proxy was set with an ask made after', async () => {
    let epoch = 0
    const released: Array<(answer: string) => void> = []
    const resolve = vi.fn(async () => await new Promise<string>((done) => { released.push(done) }))
    const ask = createProxyAnswers({ resolve, epoch: () => epoch })
    const first = ask('https://a.eth/')
    epoch += 1
    const second = ask('https://a.eth/')
    released[0]?.('PROXY old:1')
    released[1]?.('DIRECT')
    expect(await first).toBe('PROXY old:1')
    expect(await second).toBe('DIRECT')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not keep a failure', async () => {
    const resolve = vi.fn<(url: string) => Promise<string>>().mockRejectedValueOnce(new Error('no network context')).mockResolvedValue('DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    await expect(ask('https://a.eth/')).rejects.toThrow('no network context')
    expect(await ask('https://a.eth/')).toBe('DIRECT')
  })

  it('forgets a question when it ends, so a page asking for many hosts cannot grow it', async () => {
    const resolve = vi.fn(async () => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    for (let index = 0; index < 300; index += 1) await ask(`https://h${String(index)}.eth/`)
    await ask('https://h299.eth/')
    expect(resolve).toHaveBeenCalledTimes(301)
  })
})

describe('proxyAnswerFor', () => {
  it('asks the session each time, and tells the answers of one session from another\'s', async () => {
    const direct = { resolveProxy: vi.fn(async () => 'DIRECT') }
    const proxied = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    expect(await proxyAnswerFor(direct, 'https://a.eth/')).toBe('DIRECT')
    expect(await proxyAnswerFor(proxied, 'https://a.eth/')).toBe('PROXY p:1')
    await proxyAnswerFor(direct, 'https://a.eth/')
    expect(direct.resolveProxy).toHaveBeenCalledTimes(2)
  })
})

describe('a change of a session\'s proxy', () => {
  it('moves the epoch on either side of it, and is under way until the call ends, however it ends', async () => {
    const session = {}
    expect(proxySetInFlight(session)).toBe(false)
    let end: () => void = () => {}
    const change = trackProxySet(session, async () => { await new Promise<void>((done) => { end = done }) })
    expect(proxySetInFlight(session)).toBe(true)
    expect(proxyEpoch(session) % 2, 'odd while it is being set').toBe(1)
    end()
    await change
    expect(proxySetInFlight(session)).toBe(false)
    expect(proxyEpoch(session) % 2).toBe(0)

    await expect(trackProxySet(session, async () => { throw new Error('refused') })).rejects.toThrow('refused')
    expect(proxySetInFlight(session)).toBe(false)
  })

  it('stays under way when whoever waited for it gave up: the call has not ended', async () => {
    vi.useFakeTimers()
    try {
      const session = {}
      let end: () => void = () => {}
      const change = trackProxySet(session, async () => { await new Promise<void>((done) => { end = done }) }, 1_000)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(proxySetInFlight(session)).toBe(true)
      end()
      await change
      expect(proxySetInFlight(session)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts several at once, and is over when the last one is', async () => {
    const session = {}
    const ends: Array<() => void> = []
    const changes = [1, 2].map(async () => { await trackProxySet(session, async () => { await new Promise<void>((done) => { ends.push(done) }) }) })
    ends[0]?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(proxySetInFlight(session)).toBe(true)
    ends[1]?.()
    await Promise.all(changes)
    expect(proxySetInFlight(session)).toBe(false)
  })

  it('is waited for by proxySettled, which gives up after the time allowed', async () => {
    vi.useFakeTimers()
    try {
      const session = {}
      await expect(proxySettled(session)).resolves.toBeUndefined()
      let end: () => void = () => {}
      const change = trackProxySet(session, async () => { await new Promise<void>((done) => { end = done }) })
      const waited = proxySettled(session)
      const settled = vi.fn()
      void waited.then(settled, () => {})
      await vi.advanceTimersByTimeAsync(PROXY_SETTLE_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      end()
      await change
      await waited
      expect(settled).toHaveBeenCalledTimes(1)

      let stuck: () => void = () => {}
      const hung = trackProxySet(session, async () => { await new Promise<void>((done) => { stuck = done }) })
      const late = expect(proxySettled(session)).rejects.toThrow('still being set')
      await vi.advanceTimersByTimeAsync(PROXY_SETTLE_MS)
      await late
      stuck()
      await hung
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the session marked as overrun when the call outlasts the wait for it, until a later one is quick', async () => {
    vi.useFakeTimers()
    try {
      const session = {}
      await trackProxySet(session, async () => {}, 1_000)
      expect(proxySetOverran(session)).toBe(false)

      const slow = trackProxySet(session, async () => { await new Promise<void>((done) => { setTimeout(done, 5_000) }) }, 1_000)
      await vi.advanceTimersByTimeAsync(1_001)
      expect(proxySetOverran(session)).toBe(true)
      await vi.advanceTimersByTimeAsync(5_000)
      await slow
      expect(proxySetInFlight(session)).toBe(false)
      expect(proxySetOverran(session), 'the call ended, but not in the time it was waited for').toBe(true)

      await trackProxySet(session, async () => {}, 1_000)
      expect(proxySetOverran(session)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
