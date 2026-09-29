import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { ControlEvent } from '../../../broker/transport/relay/port-transport.js'
import type { ChildHost, ChildHostPool } from '../child-host.js'
import type { PageTracker } from '../page-tracker.js'

/** registry.ts's own `new MessageChannelMain()` -- a fake pair distinguishable by identity, so a
 * test can assert exactly which port went where. */
class FakeMessageChannelMain {
  readonly port1 = { name: 'port1' }
  readonly port2 = { name: 'port2' }
}

vi.mock('electron', () => ({ MessageChannelMain: FakeMessageChannelMain }))

const { createChildHostRegistry } = await import('../registry.js')
const { CHILD_HOST_PORT_CHANNEL } = await import('../../channels.js')

const APP_ORIGIN = 'https://app.example'

function fakeBroker (registered: ReadonlySet<string>): Broker {
  return { app: { isRegisteredSync: (origin: string) => registered.has(origin) } } as unknown as Broker
}

interface FakeFrame { origin: string | undefined, url: string, postMessage: ReturnType<typeof vi.fn> }

function fakeFrame (origin: string | null): FakeFrame {
  return { origin: origin ?? undefined, url: origin === null ? '' : `${origin}/page`, postMessage: vi.fn() }
}

function event (frame: FakeFrame | null): ControlEvent {
  return { senderFrame: frame as unknown as ControlEvent['senderFrame'] }
}

interface FakeHost { origin: string, postPagePort: ReturnType<typeof vi.fn> }

function fakePool (host: FakeHost): ChildHostPool & { getOrCreate: ReturnType<typeof vi.fn> } {
  return {
    getOrCreate: vi.fn(async () => host as unknown as ChildHost),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {})
  } as unknown as ChildHostPool & { getOrCreate: ReturnType<typeof vi.fn> }
}

function fakeTracker (): PageTracker & { onceEmpty: ReturnType<typeof vi.fn> } {
  return {
    countAt: () => 0,
    recordPageOpened: vi.fn(),
    recordPageClosed: vi.fn(),
    onceEmpty: vi.fn(() => () => {})
  } as unknown as PageTracker & { onceEmpty: ReturnType<typeof vi.fn> }
}

describe('createChildHostRegistry.connect', () => {
  let host: FakeHost

  beforeEach(() => {
    host = { origin: APP_ORIGIN, postPagePort: vi.fn() }
  })

  it('refuses a frame with no derivable origin -- never reaches the pool', async () => {
    const pool = fakePool(host)
    const registry = createChildHostRegistry(() => fakeBroker(new Set([APP_ORIGIN])), pool, fakeTracker())

    await registry.connect(event(null))

    expect(pool.getOrCreate).not.toHaveBeenCalled()
  })

  it('refuses a frame whose origin is not a registered app', async () => {
    const pool = fakePool(host)
    const registry = createChildHostRegistry(() => fakeBroker(new Set()), pool, fakeTracker())

    await registry.connect(event(fakeFrame(APP_ORIGIN)))

    expect(pool.getOrCreate).not.toHaveBeenCalled()
    expect(host.postPagePort).not.toHaveBeenCalled()
  })

  it('connects a registered app: the host gets one port, the frame the other', async () => {
    const pool = fakePool(host)
    const registry = createChildHostRegistry(() => fakeBroker(new Set([APP_ORIGIN])), pool, fakeTracker())
    const frame = fakeFrame(APP_ORIGIN)

    await registry.connect(event(frame))

    expect(host.postPagePort).toHaveBeenCalledWith({ name: 'port1' })
    expect(frame.postMessage).toHaveBeenCalledWith(CHILD_HOST_PORT_CHANNEL, null, [{ name: 'port2' }])
  })

  it('re-derives the origin before delivering the port, and abandons the whole connection if the frame navigated away meanwhile', async () => {
    const frame = fakeFrame(APP_ORIGIN)
    const pool = {
      getOrCreate: vi.fn(async (origin: string) => {
        // The frame changes origin while the host is still being built.
        frame.origin = 'https://elsewhere.example'
        frame.url = 'https://elsewhere.example/page'
        return { origin, postPagePort: host.postPagePort } as unknown as ChildHost
      }),
      close: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {})
    } as unknown as ChildHostPool
    const registry = createChildHostRegistry(() => fakeBroker(new Set([APP_ORIGIN])), pool, fakeTracker())

    await registry.connect(event(frame))

    // Neither end is created: a port the host holds with nobody ever able to
    // reach the other end is exactly the dangling state to avoid.
    expect(host.postPagePort).not.toHaveBeenCalled()
    expect(frame.postMessage).not.toHaveBeenCalled()
  })

  it('subscribes the tracker at most once per origin across concurrent connects', async () => {
    const pool = fakePool(host)
    const tracker = fakeTracker()
    const registry = createChildHostRegistry(() => fakeBroker(new Set([APP_ORIGIN])), pool, tracker)

    await Promise.all([
      registry.connect(event(fakeFrame(APP_ORIGIN))),
      registry.connect(event(fakeFrame(APP_ORIGIN)))
    ])

    expect(tracker.onceEmpty).toHaveBeenCalledOnce()
  })

  it('closeAll closes every open host', async () => {
    const pool = fakePool(host)
    const registry = createChildHostRegistry(() => fakeBroker(new Set([APP_ORIGIN])), pool, fakeTracker())

    await registry.closeAll()

    expect(pool.closeAll).toHaveBeenCalledOnce()
  })
})
