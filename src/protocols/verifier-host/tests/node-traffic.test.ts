import { describe, expect, it } from 'vitest'
import { createNodeTraffic, TRAFFIC_EVERY_MS } from '../node-traffic.js'

function harness (): { traffic: ReturnType<typeof createNodeTraffic>, posted: Array<{ active: number, bytes: number }>, clock: { now: number }, timers: Array<() => void> } {
  const posted: Array<{ active: number, bytes: number }> = []
  const clock = { now: 10_000 }
  const timers: Array<() => void> = []
  const traffic = createNodeTraffic((active, bytes) => posted.push({ active, bytes }), { now: () => clock.now, later: (callback) => { timers.push(callback) } })
  return { traffic, posted, clock, timers }
}

function bodyOf (...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start (controller) { for (const size of chunks) controller.enqueue(new Uint8Array(size)); controller.close() } })
}

describe('what the host counts of its reads from a local node', () => {
  it('counts a read as in flight from when it starts until its body has been read to the end, and counts every byte', async () => {
    const { traffic, posted } = harness()
    traffic.begin()
    expect(posted.at(-1)).toEqual({ active: 1, bytes: 0 })
    const response = traffic.wrap(new Response(bodyOf(100, 28), { status: 200, headers: { 'x-a': 'b' } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-a')).toBe('b')
    expect((await response.arrayBuffer()).byteLength).toBe(128)
    expect(traffic.snapshot()).toEqual({ active: 0, bytes: 128 })
  })

  it('ends a read whose body is cancelled, and one that has none', async () => {
    const { traffic } = harness()
    traffic.begin()
    await traffic.wrap(new Response(bodyOf(10, 10))).body?.cancel()
    expect(traffic.snapshot().active).toBe(0)
    traffic.begin()
    traffic.wrap(new Response(null, { status: 204 }))
    expect(traffic.snapshot().active).toBe(0)
  })

  it('ends a read whose caller aborted it, though its body was never read', () => {
    const { traffic } = harness()
    const controller = new AbortController()
    traffic.begin()
    traffic.wrap(new Response(bodyOf(10)), controller.signal)
    expect(traffic.snapshot().active).toBe(1)
    controller.abort()
    expect(traffic.snapshot().active).toBe(0)
  })

  it('ends a read once, whichever of the body\'s end and the abort comes first', async () => {
    const { traffic } = harness()
    const controller = new AbortController()
    traffic.begin()
    traffic.begin()
    const first = traffic.wrap(new Response(bodyOf(4)), controller.signal)
    await first.arrayBuffer()
    expect(traffic.snapshot().active).toBe(1)
    controller.abort()
    expect(traffic.snapshot().active).toBe(1)
  })

  it('ends a read that failed before it had a response', () => {
    const { traffic } = harness()
    traffic.begin()
    traffic.end()
    expect(traffic.snapshot()).toEqual({ active: 0, bytes: 0 })
  })

  it('reports at once the first time and then at most once in the interval, with a last report when it goes quiet', () => {
    const { traffic, posted, clock, timers } = harness()
    traffic.begin()
    traffic.begin()
    traffic.end()
    expect(posted).toEqual([{ active: 1, bytes: 0 }])
    expect(timers).toHaveLength(1)
    clock.now += TRAFFIC_EVERY_MS
    timers[0]?.()
    expect(posted.at(-1)).toEqual({ active: 1, bytes: 0 })
  })
})
