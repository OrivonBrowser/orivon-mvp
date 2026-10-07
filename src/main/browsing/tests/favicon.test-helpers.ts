// The fake net.request both favicon test files drive: one scripted response per call, read by favicon-fetch.ts's
// requestOnce. The importing file mocks 'electron' before importing this.
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { vi } from 'vitest'

const { net } = await import('electron')

/** The page declaring the icon. Loopback candidates are judged against this, a public page. */
export const PUBLIC_PAGE = 'https://example.com/page'

export interface FakeClientRequest extends EventEmitter {
  end: () => void
  abort: ReturnType<typeof vi.fn>
}

/** Every request the harness below handed out, in order. */
export const requests: FakeClientRequest[] = []

export function fakeClientRequest (): FakeClientRequest {
  const emitter = new EventEmitter() as FakeClientRequest
  emitter.end = vi.fn()
  emitter.abort = vi.fn(() => { emitter.emit('error', new Error('aborted')) })
  requests.push(emitter)
  return emitter
}

export function fakeIncomingMessage (statusCode: number): Readable & { statusCode: number } {
  const stream = new Readable({ read () {} }) as Readable & { statusCode: number }
  stream.statusCode = statusCode
  return stream
}

/** Queues one `net.request(...)` call's whole behaviour. Deferred to a
 * microtask so it fires only once requestOnce's own synchronous listener
 * registration (three `.on(...)` calls, then `.end()`) has already run --
 * none of that registration ever awaits, so a plain microtask is enough. */
export function mockRequestOnce (act: (request: FakeClientRequest) => void): void {
  vi.mocked(net.request).mockImplementationOnce(() => {
    const request = fakeClientRequest()
    queueMicrotask(() => { act(request) })
    return request as never
  })
}

export function respondOk (statusCode: number, chunks: Uint8Array[]): Readable & { statusCode: number } {
  const stream = fakeIncomingMessage(statusCode)
  for (const chunk of chunks) stream.push(Buffer.from(chunk))
  stream.push(null)
  return stream
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
