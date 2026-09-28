// A Worker's orivon: every method becomes a call over a MessagePort to the
// page (orivon-server.ts), and every handle that comes back becomes an
// object whose methods call back by the handle's number. The shape matches
// window.orivon, so the Node shim and the WASI host run unchanged on it.

import type { CallBody, HandleDescriptor, Request, ServerMessage } from './orivon-server.js'
import type { WireError } from './protocol.js'

interface Pending { resolve: (value: unknown) => void, reject: (error: unknown) => void }

function isDescriptor (value: unknown): value is HandleDescriptor {
  return typeof value === 'object' && value !== null && typeof (value as { __orivonHandle?: unknown }).__orivonHandle === 'number'
}

function toError (wire: WireError & { platformCode?: string }): Error {
  return Object.assign(new Error(wire.message), {
    name: wire.name,
    ...(wire.code === undefined ? {} : { code: wire.code }),
    ...(wire.platformCode === undefined ? {} : { platformCode: wire.platformCode })
  })
}

/** readFileSync cannot block a Worker on the page without SharedArrayBuffer, so it refuses by name. */
function syncUnavailable (): never {
  throw Object.assign(new Error('orivon.fs.readFileSync is not available in a Worker: use the asynchronous fs calls'), {
    name: 'OrivonShimError', api: 'orivon.fs.readFileSync', reason: 'not-applicable'
  })
}

/** A forked child's liveness: a pending call or an open handle keeps it running. */
export interface ClientActivity {
  ref (): void
  unref (): void
}

export function createOrivonClient (port: MessagePort, activity?: ClientActivity): Record<string, unknown> {
  const pending = new Map<number, Pending>()
  const closedHandles = new Map<number, { resolve: () => void, reject: (error: unknown) => void }>()
  const streams = new Map<number, ReadableStreamDefaultController<unknown>>()
  let nextId = 1

  const send = (request: Request): void => { port.postMessage(request) }

  const call = async (body: CallBody): Promise<unknown> => {
    const id = nextId++
    activity?.ref()
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ ...body, id })
      })
    } finally {
      activity?.unref()
    }
  }

  const decode = (value: unknown): unknown => {
    if (isDescriptor(value)) return handleOf(value)
    if (Array.isArray(value)) return value.map(decode)
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer ||
      value instanceof ReadableStream || value instanceof WritableStream) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
  }

  const pumpedStream = (id: number): ReadableStream<unknown> => new ReadableStream({
    start: (controller) => { streams.set(id, controller) },
    pull: () => { send({ pull: id }) },
    cancel: () => { streams.delete(id); send({ cancel: id }) }
  }, { highWaterMark: 0 })

  const handleOf = (descriptor: HandleDescriptor): Record<string, unknown> => {
    const handle: Record<string, unknown> = { ...(decode(descriptor.data) as Record<string, unknown>) }
    for (const method of descriptor.methods) {
      handle[method] = async (...args: unknown[]) => await call({ handle: descriptor.__orivonHandle, method, args })
    }
    for (const [name, id] of Object.entries(descriptor.pumped)) handle[name] = pumpedStream(id)
    activity?.ref()
    handle.closed = new Promise<void>((resolve, reject) => { closedHandles.set(descriptor.__orivonHandle, { resolve, reject }) })
      .finally(() => { activity?.unref() })
    ;(handle.closed as Promise<void>).catch(() => {})
    return handle
  }

  port.onmessage = (event: MessageEvent<ServerMessage>) => {
    const message = event.data
    if ('closed' in message) {
      const waiter = closedHandles.get(message.closed)
      closedHandles.delete(message.closed)
      if (message.error === undefined) waiter?.resolve()
      else waiter?.reject(toError(message.error))
    } else if ('stream' in message) {
      const controller = streams.get(message.stream)
      if (message.error !== undefined) { controller?.error(toError(message.error)); streams.delete(message.stream) }
      else if (message.done === true) { controller?.close(); streams.delete(message.stream) }
      else controller?.enqueue(decode(message.chunk))
    } else {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.ok) waiter?.resolve(decode(message.value))
      else waiter?.reject(toError(message.error))
    }
  }

  const namespace = (name: string): object => new Proxy({}, {
    get: (_target, member) => {
      // Never a thenable, a primitive or anything awaited by accident.
      if (typeof member !== 'string' || member === 'then') return undefined
      if (name === 'fs' && member === 'readFileSync') return syncUnavailable
      return async (...args: unknown[]) => await call({ path: [name, member], args })
    }
  })

  return new Proxy({}, {
    get: (_target, name) => {
      if (typeof name !== 'string' || name === 'then') return undefined
      if (name === 'version') return 0
      return namespace(name)
    }
  }) as Record<string, unknown>
}
