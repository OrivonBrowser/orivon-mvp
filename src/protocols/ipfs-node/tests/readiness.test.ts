import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Fetcher } from '../../local-node/kind.js'
import type { FromNode } from '../../local-node/protocol.js'
import { watchReadiness } from '../readiness.js'

afterEach(() => { vi.useRealTimers() })

function watch (fetcher: Fetcher): { posted: FromNode[], stop: () => void } {
  const posted: FromNode[] = []
  const readiness = watchReadiness({ base: 'http://127.0.0.1:1', fetcher, post: (message) => posted.push(message), everyMs: 100 })
  return { posted, stop: readiness.stop }
}

describe('the IPFS node\'s readiness', () => {
  it('polls /health, and reports listening and ready together, once, when it answers', async () => {
    vi.useFakeTimers()
    const urls: string[] = []
    let up = false
    const { posted, stop } = watch(async (url) => {
      urls.push(url)
      if (!up) throw new Error('ECONNREFUSED')
      return { ok: true, json: async () => ({}) }
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(posted).toEqual([])
    up = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(posted).toEqual([{ type: 'listening' }, { type: 'ready', peers: 0 }])
    expect(urls.every((url) => url === 'http://127.0.0.1:1/health')).toBe(true)
    const polled = urls.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(urls).toHaveLength(polled)
    stop()
  })

  it('is not ready while /health answers with an error status', async () => {
    vi.useFakeTimers()
    const { posted, stop } = watch(async () => ({ ok: false, json: async () => ({}) }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(posted).toEqual([])
    stop()
  })

  it('reports nothing once stopped', async () => {
    vi.useFakeTimers()
    const { posted, stop } = watch(async () => ({ ok: true, json: async () => ({}) }))
    stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(posted).toEqual([])
  })
})
