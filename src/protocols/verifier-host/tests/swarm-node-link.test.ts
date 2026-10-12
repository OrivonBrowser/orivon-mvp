import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FromHost } from '../protocol.js'
import { createSwarmNodeLink } from '../swarm-node-link.js'

afterEach(() => { vi.useRealTimers() })

function harness (waitMs = 20_000): { link: ReturnType<typeof createSwarmNodeLink>, posted: FromHost[] } {
  const posted: FromHost[] = []
  return { link: createSwarmNodeLink((message) => posted.push(message), waitMs), posted }
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
})
