import { describe, expect, it, vi } from 'vitest'
import { createRemoteWorker, requestHostConnection } from '../host-client.js'
import type { WindowLike } from '../host-client.js'
import type { FromWorker, ToWorker } from '../../worker/protocol.js'
import type { StartChildMessage } from '../../worker/host-protocol.js'

const ORIGIN = 'https://app.example'

/** A fake `window`: a real EventTarget for 'message', with a mutable `location` so a test can
 * simulate an origin change, and a spy on postMessage. */
function fakeWindow (): WindowLike & { readonly target: EventTarget, readonly postMessage: ReturnType<typeof vi.fn> } {
  const target = new EventTarget()
  const postMessage = vi.fn()
  return {
    location: { origin: ORIGIN },
    target,
    postMessage,
    addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => { target.addEventListener('message', listener as EventListener) },
    removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => { target.removeEventListener('message', listener as EventListener) }
  } as unknown as WindowLike & { readonly target: EventTarget, readonly postMessage: ReturnType<typeof vi.fn> }
}

function deliver (win: { target: EventTarget }, data: unknown, options: { source?: unknown, origin?: string, ports?: readonly unknown[] } = {}): void {
  const event = new MessageEvent('message', { data, origin: options.origin ?? ORIGIN })
  Object.defineProperty(event, 'source', { value: options.source ?? win })
  Object.defineProperty(event, 'ports', { value: options.ports ?? [] })
  win.target.dispatchEvent(event)
}

describe('requestHostConnection', () => {
  it('resolves with the port once the preload replies on the same window and origin', async () => {
    const win = fakeWindow()
    const promise = requestHostConnection(win, 1000)

    expect(win.postMessage).toHaveBeenCalledWith({ type: 'orivon:child-host:connect' }, ORIGIN)

    const port = {} as MessagePort
    deliver(win, { type: 'orivon:child-host:port' }, { source: win, ports: [port] })

    await expect(promise).resolves.toBe(port)
  })

  it('resolves undefined if nothing answers within the timeout', async () => {
    const win = fakeWindow()
    await expect(requestHostConnection(win, 20)).resolves.toBeUndefined()
  })

  it('ignores a message from a different source', async () => {
    const win = fakeWindow()
    const promise = requestHostConnection(win, 30)
    deliver(win, { type: 'orivon:child-host:port' }, { source: {}, ports: [{}] })
    await expect(promise).resolves.toBeUndefined()
  })

  it('ignores a message of the wrong type', async () => {
    const win = fakeWindow()
    const promise = requestHostConnection(win, 30)
    deliver(win, { type: 'something-else' }, { source: win, ports: [{}] })
    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves undefined immediately when there is no window at all (a Worker\'s own nested children)', async () => {
    await expect(requestHostConnection(undefined, 1000)).resolves.toBeUndefined()
  })
})

describe('createRemoteWorker', () => {
  it('sends one start-child message carrying a fresh port, the start base and any extra transferables', () => {
    const { port1: hostPort } = new MessageChannel()
    const posted: Array<{ message: StartChildMessage, transfer?: readonly Transferable[] }> = []
    hostPort.postMessage = vi.fn((message, transfer) => { posted.push({ message, transfer }) }) as never

    const start = { type: 'fork', url: `${ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json' } as const
    createRemoteWorker(hostPort, start)

    expect(posted).toHaveLength(1)
    expect(posted[0]?.message.type).toBe('start-child')
    expect(posted[0]?.message.start).toEqual(start)
  })

  it('relays FromWorker messages the host sends back to the adapter\'s onmessage', async () => {
    const { port1: hostPort, port2: hostFar } = new MessageChannel()
    const start = { type: 'fork', url: `${ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json' } as const
    const adapter = createRemoteWorker(hostPort, start)

    const received: FromWorker[] = []
    adapter.onmessage = (event) => { received.push(event.data) }

    hostFar.onmessage = (event: MessageEvent<StartChildMessage>) => {
      // The host's own per-child port is the transferred one.
      event.data.port.postMessage({ type: 'started' } satisfies FromWorker)
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toEqual([{ type: 'started' }])
  })

  it('postMessage forwards to the per-child port, and terminate() sends a terminate control message', async () => {
    const { port1: hostPort, port2: hostFar } = new MessageChannel()
    const start = { type: 'fork', url: `${ORIGIN}/app.js`, argv: [], env: {}, cwd: '/', serialization: 'json' } as const
    const adapter = createRemoteWorker(hostPort, start)

    let childPort: MessagePort | undefined
    const received: unknown[] = []
    hostFar.onmessage = (event: MessageEvent<StartChildMessage>) => {
      childPort = event.data.port
      childPort.onmessage = (inner) => { received.push(inner.data) }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))

    adapter.postMessage({ type: 'ipc', message: 1 } satisfies ToWorker)
    adapter.terminate()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received).toEqual([{ type: 'ipc', message: 1 }, { type: 'terminate' }])
  })
})
