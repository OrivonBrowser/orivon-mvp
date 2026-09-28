// The page's end of a Worker's orivon.* calls. A Worker has no window.orivon
// (contextBridge reaches documents only), so each call arrives here over a
// MessagePort and is made on the page's own orivon. The Worker is the app's
// own code: it reaches exactly what the page already could.
//
// A handle a call returns stays here, named by a number; the Worker calls
// its methods by that number. Its byte streams are transferred to the
// Worker whole. A stream whose chunks are themselves handles
// (TcpServer.connections) is pumped instead, one handle per chunk.

import { type WireError, toWireError } from './protocol.js'

/** Streams whose chunks are handles, which structured clone cannot carry. */
const HANDLE_STREAMS = new Set(['connections'])

export type CallBody =
  | { readonly path: readonly string[], readonly args: readonly unknown[] }
  | { readonly handle: number, readonly method: string, readonly args: readonly unknown[] }

export type CallRequest = CallBody & { readonly id: number }

export type Request = CallRequest | { readonly pull: number } | { readonly cancel: number }

export interface HandleDescriptor {
  readonly __orivonHandle: number
  readonly methods: readonly string[]
  readonly data: Readonly<Record<string, unknown>>
  /** Property name to pumped-stream number. */
  readonly pumped: Readonly<Record<string, number>>
}

export type ServerMessage =
  | { readonly id: number, readonly ok: true, readonly value: unknown }
  | { readonly id: number, readonly ok: false, readonly error: WireError & { readonly platformCode?: string } }
  | { readonly closed: number, readonly error?: WireError & { readonly platformCode?: string } }
  | { readonly stream: number, readonly chunk?: unknown, readonly done?: true, readonly error?: WireError & { readonly platformCode?: string } }

interface LiveHandle { readonly handle: Record<string, unknown> }

export interface OrivonServer {
  /** Closes every handle the Worker still holds: a Worker that ends leaves nothing open in the broker. */
  dispose (): Promise<void>
}

function isHandle (value: unknown): value is Record<string, unknown> & { close: () => Promise<void> } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { id?: unknown }).id === 'string' && typeof (value as { close?: unknown }).close === 'function'
}

function isStream (value: unknown): value is ReadableStream | WritableStream {
  return value instanceof ReadableStream || value instanceof WritableStream
}

/** Own and inherited property names, since a handle may be a class instance. */
function propertyNames (value: object): string[] {
  const names = new Set<string>()
  for (let object: object | null = value; object !== null && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) if (name !== 'constructor') names.add(name)
  }
  return [...names]
}

function wireErrorOf (error: unknown): WireError & { platformCode?: string } {
  const platformCode = (error as { platformCode?: unknown } | null)?.platformCode
  return { ...toWireError(error), ...(typeof platformCode === 'string' ? { platformCode } : {}) }
}

export function serveOrivon (port: MessagePort, orivon: object): OrivonServer {
  const handles = new Map<number, LiveHandle>()
  const readers = new Map<number, ReadableStreamDefaultReader<unknown>>()
  let nextId = 1

  const post = (message: ServerMessage, transfer: Transferable[] = []): void => { port.postMessage(message, transfer) }

  const encode = (value: unknown, transfer: Transferable[]): unknown => {
    if (isStream(value)) { transfer.push(value as unknown as Transferable); return value }
    if (isHandle(value)) return describe(value, transfer)
    if (Array.isArray(value)) return value.map((item) => encode(item, transfer))
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item, transfer)]))
  }

  const describe = (handle: Record<string, unknown>, transfer: Transferable[]): HandleDescriptor => {
    const id = nextId++
    handles.set(id, { handle })
    const methods: string[] = []
    const data: Record<string, unknown> = {}
    const pumped: Record<string, number> = {}
    for (const name of propertyNames(handle)) {
      if (name === 'closed') continue
      const value = handle[name]
      if (typeof value === 'function') methods.push(name)
      else if (value instanceof ReadableStream && HANDLE_STREAMS.has(name)) pumped[name] = pump(value)
      else data[name] = encode(value, transfer)
    }
    const closed = handle.closed as Promise<void> | undefined
    void closed?.then(
      () => { handles.delete(id); post({ closed: id }) },
      (error: unknown) => { handles.delete(id); post({ closed: id, error: wireErrorOf(error) }) }
    )
    return { __orivonHandle: id, methods, data, pumped }
  }

  const pump = (stream: ReadableStream<unknown>): number => {
    const id = nextId++
    readers.set(id, stream.getReader())
    return id
  }

  const pull = async (id: number): Promise<void> => {
    const reader = readers.get(id)
    if (reader === undefined) return
    try {
      const { done, value } = await reader.read()
      if (done) { readers.delete(id); post({ stream: id, done: true }); return }
      const transfer: Transferable[] = []
      post({ stream: id, chunk: encode(value, transfer) }, transfer)
    } catch (error) {
      readers.delete(id)
      post({ stream: id, error: wireErrorOf(error) })
    }
  }

  const target = (request: CallRequest): { fn: unknown, self: unknown } => {
    if ('handle' in request) {
      const live = handles.get(request.handle)
      if (live === undefined) throw Object.assign(new Error('handle is closed'), { name: 'OrivonError', code: 'closed' })
      return { fn: live.handle[request.method], self: live.handle }
    }
    let self: unknown = orivon
    let fn: unknown = orivon
    for (const key of request.path) {
      self = fn
      fn = typeof fn === 'object' && fn !== null && Object.hasOwn(fn, key) ? (fn as Record<string, unknown>)[key] : undefined
    }
    return { fn, self }
  }

  const call = async (request: CallRequest): Promise<void> => {
    try {
      const { fn, self } = target(request)
      if (typeof fn !== 'function') throw new TypeError(`orivon has no method ${'path' in request ? request.path.join('.') : request.method}`)
      const value: unknown = await (fn as (...args: unknown[]) => unknown).apply(self, [...request.args])
      const transfer: Transferable[] = []
      post({ id: request.id, ok: true, value: encode(value, transfer) }, transfer)
    } catch (error) {
      post({ id: request.id, ok: false, error: wireErrorOf(error) })
    }
  }

  port.onmessage = (event: MessageEvent<Request>) => {
    const request = event.data
    if ('pull' in request) void pull(request.pull)
    else if ('cancel' in request) { void readers.get(request.cancel)?.cancel(); readers.delete(request.cancel) }
    else void call(request)
  }

  return {
    dispose: async () => {
      port.onmessage = null
      port.close()
      for (const reader of readers.values()) void reader.cancel().catch(() => {})
      readers.clear()
      const open = [...handles.values()]
      handles.clear()
      await Promise.allSettled(open.map(async ({ handle }) => { await (handle.close as () => Promise<void>)() }))
    }
  }
}
