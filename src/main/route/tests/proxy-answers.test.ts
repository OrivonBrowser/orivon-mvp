import { describe, expect, it, vi } from 'vitest'
import { createProxyAnswers, noteProxySet, PROXY_ANSWER_TTL_MS, PROXY_ASK_TIMEOUT_MS, proxyAnswerFor } from '../proxy-answers.js'

function clock (): { now: () => number, advance: (ms: number) => void } {
  let at = 1_000
  return { now: () => at, advance: (ms) => { at += ms } }
}

describe('a session that does not answer', () => {
  it('is given up on after the time allowed, and asked again by the next request', async () => {
    vi.useFakeTimers()
    try {
      const resolve = vi.fn(async () => await new Promise<string>(() => {}))
      const ask = createProxyAnswers({ resolve, epoch: () => 0 })
      const first = ask('https://a.eth/')
      const outcome = expect(first).rejects.toThrow('did not say which proxy')
      await vi.advanceTimersByTimeAsync(PROXY_ASK_TIMEOUT_MS)
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
})

describe('createProxyAnswers', () => {
  it('asks for the origin, and answers a second ask for the same host from memory', async () => {
    const resolve = vi.fn(async () => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    expect(await ask('https://name.eth/index.html?x=1')).toBe('DIRECT')
    expect(await ask('https://name.eth/other')).toBe('DIRECT')
    expect(resolve).toHaveBeenCalledExactlyOnceWith('https://name.eth/')
  })

  it('keeps host, port and scheme apart', async () => {
    const resolve = vi.fn(async (_url: string) => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    await ask('https://a.eth/')
    await ask('https://b.eth/')
    await ask('http://a.eth/')
    await ask('https://a.eth:8443/')
    expect(resolve.mock.calls.map((call) => call[0])).toEqual(['https://a.eth/', 'https://b.eth/', 'http://a.eth/', 'https://a.eth:8443/'])
  })

  it('asks again once the answer is older than the time it is kept', async () => {
    const time = clock()
    const resolve = vi.fn(async () => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0, now: time.now })
    await ask('https://a.eth/')
    time.advance(PROXY_ANSWER_TTL_MS - 1)
    await ask('https://a.eth/')
    expect(resolve).toHaveBeenCalledTimes(1)
    time.advance(1)
    await ask('https://a.eth/')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('asks again when the session\'s proxy was set since', async () => {
    let epoch = 0
    const resolve = vi.fn(async () => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => epoch })
    await ask('https://a.eth/')
    epoch += 1
    await ask('https://a.eth/')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not keep an answer that was on its way when the proxy was set', async () => {
    let epoch = 0
    let release: (answer: string) => void = () => {}
    const resolve = vi.fn(async () => await new Promise<string>((done) => { release = done }))
    const ask = createProxyAnswers({ resolve, epoch: () => epoch })
    const first = ask('https://a.eth/')
    epoch += 1
    release('PROXY old:1')
    expect(await first).toBe('PROXY old:1')
    const second = ask('https://a.eth/')
    release('DIRECT')
    expect(await second).toBe('DIRECT')
    expect(resolve).toHaveBeenCalledTimes(2)
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

  it('does not keep a failure', async () => {
    const resolve = vi.fn<(url: string) => Promise<string>>().mockRejectedValueOnce(new Error('no network context')).mockResolvedValue('DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    await expect(ask('https://a.eth/')).rejects.toThrow('no network context')
    expect(await ask('https://a.eth/')).toBe('DIRECT')
  })

  it('keeps the newest answers and lets the oldest go, so a page asking for many hosts cannot grow it', async () => {
    const resolve = vi.fn(async () => 'DIRECT')
    const ask = createProxyAnswers({ resolve, epoch: () => 0 })
    for (let index = 0; index < 300; index += 1) await ask(`https://h${String(index)}.eth/`)
    resolve.mockClear()
    await ask('https://h299.eth/')
    expect(resolve).not.toHaveBeenCalled()
    await ask('https://h0.eth/')
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe('proxyAnswerFor', () => {
  it('keeps one set of answers for a session, and forgets them when the session\'s proxy is set', async () => {
    const session = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    await proxyAnswerFor(session, 'https://a.eth/')
    await proxyAnswerFor(session, 'https://a.eth/')
    expect(session.resolveProxy).toHaveBeenCalledTimes(1)
    noteProxySet(session)
    await proxyAnswerFor(session, 'https://a.eth/')
    expect(session.resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('does not let one session\'s answers stand for another\'s', async () => {
    const direct = { resolveProxy: vi.fn(async () => 'DIRECT') }
    const proxied = { resolveProxy: vi.fn(async () => 'PROXY p:1') }
    expect(await proxyAnswerFor(direct, 'https://a.eth/')).toBe('DIRECT')
    expect(await proxyAnswerFor(proxied, 'https://a.eth/')).toBe('PROXY p:1')
  })
})
