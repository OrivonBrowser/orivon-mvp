import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FromHost } from '../protocol.js'
import { createSwarmNodeLink } from '../swarm-node-link.js'

afterEach(() => { vi.useRealTimers() })

function harness (waitMs = 20_000): { link: ReturnType<typeof createSwarmNodeLink>, posted: FromHost[], clock: { now: number } } {
  const posted: FromHost[] = []
  const clock = { now: 1_000_000 }
  return { link: createSwarmNodeLink((message) => posted.push(message), { waitMs, now: () => clock.now }), posted, clock }
}

const idle = (): AbortSignal => new AbortController().signal

describe('the verifier host\'s link to the Swarm node', () => {
  it('asks for the node on every mount, and goes on once main says it is ready', async () => {
    const { link, posted } = harness()
    const mount = link.ensure(idle())
    expect(posted).toEqual([{ type: 'swarm-node-wanted' }])
    link.notice({ type: 'swarm-node', state: 'starting' })
    link.notice({ type: 'swarm-node', state: 'ready' })
    await expect(mount).resolves.toBeUndefined()
  })

  it('asks again, and does not wait, while the node it was told is ready', async () => {
    const { link, posted } = harness()
    const first = link.ensure(idle())
    link.notice({ type: 'swarm-node', state: 'ready' })
    await first
    await link.ensure(idle())
    expect(posted).toHaveLength(2)
  })

  it('refuses in plain words, with the reason, when the node is off', async () => {
    const { link } = harness()
    const mount = link.ensure(idle())
    link.notice({ type: 'swarm-node', state: 'off', reason: 'the Swarm node is not installed' })
    await expect(mount).rejects.toMatchObject({ failure: 'unavailable', message: 'Swarm content loads only from the Swarm node Orivon runs on this computer, and it is off: the Swarm node is not installed' })
  })

  it('refuses in plain words, with the reason, when the node failed', async () => {
    const { link } = harness()
    const mount = link.ensure(idle())
    link.notice({ type: 'swarm-node', state: 'failed', reason: 'it trapped' })
    await expect(mount).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringContaining('is not running: it trapped') as string })
  })

  it('says the node is still finding peers when twenty seconds pass', async () => {
    vi.useFakeTimers()
    const { link } = harness()
    const mount = link.ensure(idle())
    const settled = expect(mount).rejects.toMatchObject({ failure: 'unavailable', message: "Orivon's Swarm node is still finding peers. Try again in a moment." })
    link.notice({ type: 'swarm-node', state: 'starting' })
    await vi.advanceTimersByTimeAsync(19_999)
    link.notice({ type: 'swarm-node', state: 'starting' })
    await vi.advanceTimersByTimeAsync(2)
    await settled
  })

  it('does not take an earlier answer for this ask: an off it was told is waited out again', async () => {
    const { link } = harness()
    const first = link.ensure(idle())
    link.notice({ type: 'swarm-node', state: 'off', reason: 'missing' })
    await expect(first).rejects.toBeDefined()
    const second = link.ensure(idle())
    link.notice({ type: 'swarm-node', state: 'ready' })
    await expect(second).resolves.toBeUndefined()
  })

  it('stops waiting when the mount is abandoned', async () => {
    const { link } = harness()
    const controller = new AbortController()
    const mount = link.ensure(controller.signal)
    controller.abort()
    await expect(mount).rejects.toBeDefined()
  })

  it('returns at once, asking main nothing, when the mount was already abandoned', async () => {
    const { link, posted } = harness()
    const controller = new AbortController()
    controller.abort()
    await expect(link.ensure(controller.signal)).rejects.toBeDefined()
    expect(posted).toEqual([])
  })

  it('lets every mount that waited at once read the failure, not only the first to wake', async () => {
    const { link } = harness()
    const first = link.ensure(idle())
    const second = link.ensure(idle())
    const third = link.ensure(idle())
    const reasons = Promise.allSettled([first, second, third])
    link.notice({ type: 'swarm-node', state: 'failed', reason: 'it trapped' })
    for (const outcome of await reasons) {
      expect(outcome).toMatchObject({ status: 'rejected', reason: { failure: 'unavailable', message: expect.stringContaining('is not running: it trapped') as string } })
    }
  })

  it('keeps a failure readable for a waiter that is waking when another mount asks', async () => {
    const { link } = harness()
    const waiter = link.ensure(idle())
    const outcome = expect(waiter).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringContaining('is not running: it trapped') as string })
    link.notice({ type: 'swarm-node', state: 'failed', reason: 'it trapped' })
    // Before the first waiter's continuation runs, a second mount asks.
    void link.ensure(idle()).catch(() => {})
    await outcome
  })

  it('does not hand a failure that preceded an ask to that ask, and a later ask still waits for its own answer', async () => {
    const { link } = harness()
    const early = link.ensure(idle())
    link.notice({ type: 'swarm-node', state: 'failed', reason: 'it trapped' })
    await expect(early).rejects.toBeDefined()
    const late = link.ensure(idle())
    const settled = vi.fn()
    void late.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    link.notice({ type: 'swarm-node', state: 'ready' })
    await expect(late).resolves.toBeUndefined()
  })

  describe('while chunks are read', () => {
    it('tells main the node is in use at most once every few seconds', async () => {
      const { link, posted, clock } = harness()
      for (let step = 0; step < 40; step++) { link.touch(); clock.now += 500 }
      // 20 s of reads, a touch every 0.5 s: one ask at the start and one each 5 s.
      expect(posted.length).toBe(4)
      expect(posted.every((message) => message.type === 'swarm-node-wanted')).toBe(true)
    })

    it('touches on each read, passes the answer through, and does not retry a read that worked', async () => {
      const { link, posted } = harness()
      const read = vi.fn(async () => new Response('chunk'))
      const response = await link.reading(read)('http://127.0.0.1:1/chunks/aa', { headers: {}, signal: idle() })
      expect(await response.text()).toBe('chunk')
      expect(read).toHaveBeenCalledTimes(1)
      expect(posted).toEqual([{ type: 'swarm-node-wanted' }])
    })

    it('asks for the node again when a read finds it gone, and reads again once main says it is ready', async () => {
      const { link, posted } = harness()
      let alive = false
      const read = vi.fn(async () => { if (!alive) throw new TypeError('fetch failed'); return new Response('chunk') })
      const pending = link.reading(read)('http://127.0.0.1:1/chunks/aa', { headers: {}, signal: idle() })
      await Promise.resolve()
      await Promise.resolve()
      expect(posted.length).toBeGreaterThanOrEqual(2)
      alive = true
      link.notice({ type: 'swarm-node', state: 'ready' })
      expect(await (await pending).text()).toBe('chunk')
      expect(read).toHaveBeenCalledTimes(2)
    })

    it('shares one ask among the reads that find the node gone together', async () => {
      const { link, posted } = harness()
      let alive = false
      const read = async (): Promise<Response> => { if (!alive) throw new TypeError('fetch failed'); return new Response('chunk') }
      const fetch = link.reading(read)
      const reads = [fetch('http://127.0.0.1:1/a', { headers: {}, signal: idle() }), fetch('http://127.0.0.1:1/b', { headers: {}, signal: idle() }), fetch('http://127.0.0.1:1/c', { headers: {}, signal: idle() })]
      await new Promise((resolve) => setImmediate(resolve))
      const asks = posted.length
      alive = true
      link.notice({ type: 'swarm-node', state: 'ready' })
      for (const response of await Promise.all(reads)) expect(await response.text()).toBe('chunk')
      expect(asks).toBeLessThanOrEqual(2)
    })

    it('fails the read with the reason when main says the node is off, and never reads again', async () => {
      const { link } = harness()
      const read = vi.fn(async () => { throw new TypeError('fetch failed') })
      const pending = link.reading(read)('http://127.0.0.1:1/chunks/aa', { headers: {}, signal: idle() })
      const settled = expect(pending).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringContaining('it is off: no proxy') as string })
      await new Promise((resolve) => setImmediate(resolve))
      link.notice({ type: 'swarm-node', state: 'off', reason: 'no proxy' })
      await settled
      expect(read).toHaveBeenCalledTimes(1)
    })

    it('does not ask again for a read that was abandoned', async () => {
      const { link, posted } = harness()
      const controller = new AbortController()
      const read = vi.fn(async () => { controller.abort(); throw new DOMException('aborted', 'AbortError') })
      await expect(link.reading(read)('http://127.0.0.1:1/chunks/aa', { headers: {}, signal: controller.signal })).rejects.toBeDefined()
      expect(posted).toHaveLength(1)
    })
  })
})
