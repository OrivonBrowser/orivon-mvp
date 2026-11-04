import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adapterClaim, PROBE_TIMEOUT_MS, probeAdapter } from '../webgpu-probe.js'

describe('probeAdapter', () => {
  it('reports the adapter\'s vendor and architecture', async () => {
    const nav = { gpu: { requestAdapter: async () => ({ info: { vendor: 'intel', architecture: 'xe-lpg', device: 'ignored' } }) } }
    expect(await probeAdapter(nav)).toEqual({ kind: 'adapter', vendor: 'intel', architecture: 'xe-lpg' })
  })

  it('reports an adapter that names nothing as one with empty fields', async () => {
    expect(await probeAdapter({ gpu: { requestAdapter: async () => ({}) } })).toEqual({ kind: 'adapter', vendor: '', architecture: '' })
    expect(await probeAdapter({ gpu: { requestAdapter: async () => ({ info: { vendor: 7, architecture: null } }) } })).toEqual({ kind: 'adapter', vendor: '', architecture: '' })
  })

  it('cuts a long name', async () => {
    const reply = await probeAdapter({ gpu: { requestAdapter: async () => ({ info: { vendor: 'x'.repeat(500), architecture: '' } }) } })
    expect(reply).toMatchObject({ kind: 'adapter' })
    expect((reply as { vendor: string }).vendor).toHaveLength(64)
  })

  it('reports none when the browser gives no adapter or the request fails', async () => {
    expect(await probeAdapter({ gpu: { requestAdapter: async () => null } })).toEqual({ kind: 'none' })
    expect(await probeAdapter({ gpu: { requestAdapter: async () => { throw new Error('refused') } } })).toEqual({ kind: 'none' })
  })

  it('reports no API when the page has no WebGPU', async () => {
    expect(await probeAdapter({})).toEqual({ kind: 'no-api' })
  })

  describe('when the graphics process never answers', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    const hung = { gpu: { requestAdapter: async () => await new Promise<never>(() => {}) } }

    it('gives up after the time limit and reads nothing', async () => {
      const probe = probeAdapter(hung)
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1)
      let settled = false
      void probe.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await probe).toEqual({ kind: 'unread' })
    })

    it('takes the time limit as an argument, and leaves no timer behind once an adapter answered', async () => {
      expect(await probeAdapter({ gpu: { requestAdapter: async () => null } })).toEqual({ kind: 'none' })
      expect(vi.getTimerCount()).toBe(0)
      const probe = probeAdapter(hung, 50)
      await vi.advanceTimersByTimeAsync(50)
      expect(await probe).toEqual({ kind: 'unread' })
    })
  })
})

describe('adapterClaim', () => {
  it('tells main which outcome a page saw, and nothing for a probe that read none', () => {
    expect(adapterClaim({ kind: 'adapter', vendor: 'intel', architecture: 'xe' })).toEqual({ kind: 'adapter' })
    expect(adapterClaim({ kind: 'none' })).toEqual({ kind: 'none' })
    expect(adapterClaim({ kind: 'no-api' })).toEqual({ kind: 'no-api' })
    expect(adapterClaim({ kind: 'unread' })).toBeUndefined()
  })
})
