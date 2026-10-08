import { describe, expect, it } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import { createAppFileServer } from '../app-file-response.js'

const APP = 'https://app.example'
const BYTES = Uint8Array.from({ length: 100 }, (_, index) => index)

/** The part of `Broker` the server reads: `fs.open` over one in-memory file, counting handles left open. */
function fakeBroker (files: Record<string, Uint8Array | 'directory'>): { broker: Broker, open: () => number, opened: string[] } {
  let open = 0
  const opened: string[] = []
  const broker = {
    fs: {
      open: async (origin: string, path: string) => {
        opened.push(`${origin} ${path}`)
        const file = files[path]
        if (origin !== APP || file === undefined) throw new Error('denied')
        open += 1
        let closed = false
        return {
          stat: async () => file === 'directory' ? { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 } : { size: file.length, isFile: true, isDirectory: false, mtimeMs: 0 },
          readable: ({ start = 0, end }: { start?: number, end?: number } = {}) => {
            const slice = file === 'directory' ? new Uint8Array() : file.subarray(start, end)
            return new ReadableStream<Uint8Array>({ start (controller) { controller.enqueue(slice); controller.close() } })
          },
          close: async () => { if (!closed) { closed = true; open -= 1 } }
        }
      }
    }
  } as unknown as Broker
  return { broker, open: () => open, opened }
}

async function bytesOf (response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())]
}

describe('createAppFileServer -- the bytes behind a verified redirect', () => {
  const server = createAppFileServer(new Uint8Array(32).fill(7))
  const url = server.urlFor(APP, 'sound%20/add.wav')

  it('serves the file whole, typed by its extension, uncached and inert if navigated to', async () => {
    const { broker, open } = fakeBroker({ 'sound /add.wav': BYTES })
    const response = await server.serve(new Request(url), broker)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(response.headers.get('content-length')).toBe('100')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('access-control-allow-origin')).toBe(APP)
    expect(await bytesOf(response)).toEqual([...BYTES])
    expect(open(), 'the handle is closed once the body is read').toBe(0)
  })

  it('honours a Range header with a 206 and the slice, as a media element seeks', async () => {
    const { broker, open } = fakeBroker({ 'sound /add.wav': BYTES })
    const response = await server.serve(new Request(url, { headers: { range: 'bytes=10-19' } }), broker)
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(response.headers.get('content-length')).toBe('10')
    expect(await bytesOf(response)).toEqual([...BYTES.subarray(10, 20)])
    expect(open()).toBe(0)
  })

  it('answers an unsatisfiable range 416, and a HEAD with the headers alone, closing the handle both times', async () => {
    const { broker, open } = fakeBroker({ 'sound /add.wav': BYTES })
    const past = await server.serve(new Request(url, { headers: { range: 'bytes=500-' } }), broker)
    expect([past.status, past.headers.get('content-range')]).toEqual([416, 'bytes */100'])
    const head = await server.serve(new Request(url, { method: 'HEAD' }), broker)
    expect([head.status, head.headers.get('content-length'), (await head.arrayBuffer()).byteLength]).toEqual([200, '100', 0])
    expect(open()).toBe(0)
  })

  it('closes the handle when the reader gives up before the end', async () => {
    const { broker, open } = fakeBroker({ 'sound /add.wav': BYTES })
    const response = await server.serve(new Request(url), broker)
    await response.body?.cancel()
    expect(open()).toBe(0)
  })

  it('answers 404 for a file the broker refuses or does not have, and for a directory', async () => {
    const missing = fakeBroker({})
    expect((await server.serve(new Request(url), missing.broker)).status).toBe(404)
    const directory = fakeBroker({ 'sound /add.wav': 'directory' })
    expect((await server.serve(new Request(url), directory.broker)).status).toBe(404)
    expect(directory.open()).toBe(0)
  })

  it('answers 404 without asking the broker for a URL it did not make, whoever else made it', async () => {
    const { broker, opened } = fakeBroker({ 'sound /add.wav': BYTES })
    const other = createAppFileServer(new Uint8Array(32).fill(8))
    for (const forged of [other.urlFor(APP, 'sound%20/add.wav'), url.replace('add.wav', 'other.wav'), 'orivon-file://app/00/x/y']) {
      expect([forged, (await server.serve(new Request(forged), broker)).status]).toEqual([forged, 404])
    }
    expect(opened).toEqual([])
  })

  it('refuses a method that is not a read', async () => {
    const { broker } = fakeBroker({ 'sound /add.wav': BYTES })
    expect((await server.serve(new Request(url, { method: 'POST', body: 'x' }), broker)).status).toBe(405)
  })

  it('serves an empty file as an empty 200', async () => {
    const { broker, open } = fakeBroker({ 'sound /add.wav': new Uint8Array() })
    const response = await server.serve(new Request(url), broker)
    expect([response.status, response.headers.get('content-length'), (await bytesOf(response)).length]).toEqual([200, '0', 0])
    expect(open()).toBe(0)
  })
})
