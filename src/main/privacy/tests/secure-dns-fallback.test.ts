import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuad9Fallback, probeWithin, QUAD9_CHECK_MS, QUAD9_PROBE_TIMEOUT_MS } from '../secure-dns-fallback.js'
import type { Quad9FallbackDeps } from '../secure-dns-fallback.js'
import { secureDnsOptions } from '../secure-dns.js'

const SECURE = secureDnsOptions('quad9', 'linux')
const FALLBACK = secureDnsOptions('quad9Fallback', 'linux')

/** A fake machine: `answers` is whether Quad9 answers now, `ticks` the registered timers, `calls` what was done in order. */
function harness (initial: { answers: boolean, online?: boolean }) {
  const state = { answers: initial.answers, online: initial.online ?? true }
  const calls: string[] = []
  const logs: string[] = []
  const ticks: Array<{ task: () => void, ms: number, cancelled: boolean }> = []
  const deps: { -readonly [K in keyof Quad9FallbackDeps]: Quad9FallbackDeps[K] } = {
    configure: (options) => { calls.push(options.secureDnsMode === 'secure' ? 'secure' : 'fallback') },
    probe: async () => { calls.push('probe'); return state.answers },
    clearCaches: async () => { calls.push('clear') },
    online: () => state.online,
    log: (line) => { logs.push(line) },
    every: (task, ms) => {
      const tick = { task, ms, cancelled: false }
      ticks.push(tick)
      return () => { tick.cancelled = true }
    }
  }
  const settle = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
  const fire = async (ms: number): Promise<void> => { for (const tick of ticks) if (tick.ms === ms && !tick.cancelled) tick.task(); await settle() }
  return { state, calls, logs, ticks, deps, settle, fire }
}

describe('createQuad9Fallback', () => {
  it('starts in secure mode with Quad9, and stays there while Quad9 answers', async () => {
    const h = harness({ answers: true })
    createQuad9Fallback(h.deps).start()
    await h.settle()
    expect(h.calls).toEqual(['secure', 'clear', 'probe'])
    expect(h.logs).toEqual([])
  })

  it('applies the platform fallback, and logs one line, when Quad9 does not answer', async () => {
    const h = harness({ answers: false })
    createQuad9Fallback(h.deps).start()
    await h.settle()
    expect(h.calls).toEqual(['secure', 'clear', 'probe', 'fallback'])
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatch(/Quad9/)
  })

  it('treats a probe that throws as Quad9 not answering', async () => {
    const h = harness({ answers: true })
    h.deps.probe = async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') }
    createQuad9Fallback(h.deps).start()
    await h.settle()
    expect(h.calls).toEqual(['secure', 'clear', 'fallback'])
  })

  it('returns to secure mode and drops the cached answers when Quad9 answers again, on the periodic check', async () => {
    const h = harness({ answers: false })
    createQuad9Fallback(h.deps).start()
    await h.settle()
    h.calls.length = 0
    h.logs.length = 0
    h.state.answers = true
    await h.fire(QUAD9_CHECK_MS)
    expect(h.calls).toEqual(['secure', 'probe', 'clear'])
    expect(h.logs).toHaveLength(1)
  })

  it('tries secure mode out for the check and goes back, with no further line, while Quad9 still does not answer', async () => {
    const h = harness({ answers: false })
    createQuad9Fallback(h.deps).start()
    await h.settle()
    h.calls.length = 0
    h.logs.length = 0
    await h.fire(QUAD9_CHECK_MS)
    expect(h.calls).toEqual(['secure', 'probe', 'fallback'])
    expect(h.logs).toEqual([])
  })

  it('goes back to the fallback when a periodic check in secure mode fails', async () => {
    const h = harness({ answers: true })
    createQuad9Fallback(h.deps).start()
    await h.settle()
    h.calls.length = 0
    h.state.answers = false
    await h.fire(QUAD9_CHECK_MS)
    expect(h.calls).toEqual(['probe', 'fallback'])
    expect(h.logs).toHaveLength(1)
  })

  it('checks again when the network comes back online, and not while it stays online', async () => {
    const h = harness({ answers: false, online: false })
    createQuad9Fallback(h.deps).start()
    await h.settle()
    h.calls.length = 0
    await h.fire(10_000)
    expect(h.calls, 'still offline').toEqual([])
    h.state.online = true
    h.state.answers = true
    await h.fire(10_000)
    expect(h.calls).toEqual(['secure', 'probe', 'clear'])
    h.calls.length = 0
    await h.fire(10_000)
    expect(h.calls, 'already online').toEqual([])
  })

  it('runs one check at a time', async () => {
    const h = harness({ answers: true })
    let release: (answered: boolean) => void = () => {}
    h.deps.probe = async () => { h.calls.push('probe'); return await new Promise<boolean>((resolve) => { release = resolve }) }
    createQuad9Fallback(h.deps).start()
    await h.settle()
    await h.fire(QUAD9_CHECK_MS)
    expect(h.calls.filter((call) => call === 'probe')).toHaveLength(1)
    release(true)
    await h.settle()
  })

  it('stops checking, and ignores a probe still in flight, once stopped', async () => {
    const h = harness({ answers: false })
    const guard = createQuad9Fallback(h.deps)
    guard.start()
    guard.stop()
    await h.settle()
    expect(h.calls).toEqual(['secure', 'clear', 'probe'])
    expect(h.ticks.every((tick) => tick.cancelled)).toBe(true)
  })
})

describe('probeWithin', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is true when the name resolves with an address, asking with the cache disallowed', async () => {
    const resolveHost = vi.fn(async () => ({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' as const }] }))
    expect(await probeWithin(resolveHost, 'example.com', QUAD9_PROBE_TIMEOUT_MS)).toBe(true)
    expect(resolveHost).toHaveBeenCalledWith('example.com', { cacheUsage: 'disallowed' })
  })

  it('is false when the name resolves to nothing or the resolver fails', async () => {
    expect(await probeWithin(async () => ({ endpoints: [] }), 'example.com', 3000)).toBe(false)
    expect(await probeWithin(async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED') }, 'example.com', 3000)).toBe(false)
  })

  it('is false when the resolver is silent past the timeout', async () => {
    const outcome = probeWithin(async () => await new Promise<never>(() => {}), 'example.com', 3000)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await outcome).toBe(false)
  })
})
