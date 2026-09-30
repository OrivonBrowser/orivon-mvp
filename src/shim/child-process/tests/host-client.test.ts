import { describe, expect, it, vi } from 'vitest'
import { createRemoteWorker, hasChildHost, useWindowForTests } from '../host-client.js'
import type { ChildrenBridge as FakeBridge, WindowLike } from '../host-client.js'
import type { FromWorker, ToWorker } from '../../worker/protocol.js'
import type { HostStart } from '../../worker/host-protocol.js'

const START = { type: 'fork', url: 'https://app.example/app.js', argv: [], env: {}, cwd: '/', serialization: 'json' } as const satisfies HostStart

/** A fake bridge -- exactly the shape the real preload-side one exposes, so a test drives the
 * "host" end the same way `../../worker/host.ts`'s `startChild` would answer a real one. */
function fakeBridge (): {
  bridge: FakeBridge
  startCalls: unknown[]
  sentTo: (childId: string) => unknown[]
  killed: string[]
  /** Delivers `message` through the `onMessage` callback `start()` captured for `childId`. */
  deliver: (childId: string, message: FromWorker) => void
} {
  const startCalls: unknown[] = []
  const killed: string[] = []
  const sent = new Map<string, unknown[]>()
  const relays = new Map<string, (message: FromWorker) => void>()
  let nextId = 0

  const bridge: FakeBridge = {
    async start (start, onMessage) {
      startCalls.push(start)
      const childId = String(nextId++)
      relays.set(childId, onMessage)
      return childId
    },
    send (childId, message) {
      const list = sent.get(childId) ?? []
      list.push(message)
      sent.set(childId, list)
    },
    kill (childId) { killed.push(childId) }
  }

  return {
    bridge,
    startCalls,
    sentTo: (childId) => sent.get(childId) ?? [],
    killed,
    deliver: (childId, message) => { relays.get(childId)?.(message) }
  }
}

function windowWith (bridge: FakeBridge | undefined): WindowLike {
  return { [Symbol.for('orivon:children')]: bridge } as unknown as WindowLike
}

describe('hasChildHost', () => {
  it('is false with no window at all (a Worker\'s own nested children)', () => {
    useWindowForTests(undefined)
    expect(hasChildHost()).toBe(false)
    useWindowForTests()
  })

  it('is false when nothing installed the bridge', () => {
    useWindowForTests({} as WindowLike)
    expect(hasChildHost()).toBe(false)
    useWindowForTests()
  })

  it('is true once the bridge is installed under the registered symbol -- a plain structural check, no timeout', () => {
    const { bridge } = fakeBridge()
    useWindowForTests(windowWith(bridge))
    expect(hasChildHost()).toBe(true)
    useWindowForTests()
  })
})

describe('createRemoteWorker', () => {
  const getBridge = (bridge: FakeBridge | undefined): (() => FakeBridge | undefined) => () => bridge

  it('starts one child through the bridge, carrying the given start message', async () => {
    const { bridge, startCalls } = fakeBridge()
    createRemoteWorker(START, getBridge(bridge))
    await vi.waitFor(() => { expect(startCalls).toEqual([START]) })
  })

  it('relays messages the host sends back to the adapter\'s onmessage', async () => {
    const { bridge, startCalls, deliver } = fakeBridge()
    const adapter = createRemoteWorker(START, getBridge(bridge))

    const received: FromWorker[] = []
    adapter.onmessage = (event) => { received.push(event.data) }

    await vi.waitFor(() => { expect(startCalls).toHaveLength(1) })
    deliver('0', { type: 'started' } satisfies FromWorker)

    await vi.waitFor(() => { expect(received).toEqual([{ type: 'started' }]) })
  })

  it('queues postMessage/terminate before the host accepts the child, and replays them once it does', async () => {
    const { bridge, startCalls, sentTo, killed } = fakeBridge()
    const adapter = createRemoteWorker(START, getBridge(bridge))

    adapter.postMessage({ type: 'ipc', message: 1 } satisfies ToWorker)
    adapter.postMessage({ type: 'ipc', message: 2 } satisfies ToWorker)
    expect(sentTo('0')).toEqual([]) // not accepted yet

    await vi.waitFor(() => { expect(startCalls).toHaveLength(1) })
    await vi.waitFor(() => {
      expect(sentTo('0')).toEqual([{ type: 'ipc', message: 1 }, { type: 'ipc', message: 2 }])
    })
    expect(killed).toEqual([])
  })

  it('sends postMessage immediately once the host has already accepted the child', async () => {
    const { bridge, startCalls, sentTo } = fakeBridge()
    const adapter = createRemoteWorker(START, getBridge(bridge))
    await vi.waitFor(() => { expect(startCalls).toHaveLength(1) })

    adapter.postMessage({ type: 'ipc', message: 1 } satisfies ToWorker)
    expect(sentTo('0')).toEqual([{ type: 'ipc', message: 1 }])
  })

  it('terminate() before the host accepts the child kills it as soon as it does, replaying nothing else', async () => {
    const { bridge, startCalls, sentTo, killed } = fakeBridge()
    const adapter = createRemoteWorker(START, getBridge(bridge))

    adapter.postMessage({ type: 'ipc', message: 1 } satisfies ToWorker)
    adapter.terminate()

    await vi.waitFor(() => { expect(startCalls).toHaveLength(1) })
    await vi.waitFor(() => { expect(killed).toEqual(['0']) })
    expect(sentTo('0')).toEqual([])
  })

  it('terminate() after the host accepts the child kills it directly', async () => {
    const { bridge, startCalls, killed } = fakeBridge()
    const adapter = createRemoteWorker(START, getBridge(bridge))
    await vi.waitFor(() => { expect(startCalls).toHaveLength(1) })

    adapter.terminate()
    expect(killed).toEqual(['0'])
  })

  it('reports a failed start as a "failed" message rather than a silent hang (F5)', async () => {
    const bridge: FakeBridge = {
      start: async () => { throw new Error('no host for this app') },
      send: vi.fn(),
      kill: vi.fn()
    }
    const adapter = createRemoteWorker(START, getBridge(bridge))

    const received: FromWorker[] = []
    adapter.onmessage = (event) => { received.push(event.data) }

    await vi.waitFor(() => { expect(received).toHaveLength(1) })
    expect(received[0]).toMatchObject({ type: 'failed', error: { message: 'no host for this app' } })
  })

  it('reports a "failed" message rather than hanging when no bridge exists at all', async () => {
    const adapter = createRemoteWorker(START, getBridge(undefined))

    const received: FromWorker[] = []
    adapter.onmessage = (event) => { received.push(event.data) }

    await vi.waitFor(() => { expect(received).toHaveLength(1) })
    expect(received[0]?.type).toBe('failed')
  })
})
