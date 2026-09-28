// A Worker's orivon.* over a MessagePort: the page-side server against a fake
// orivon, the Worker-side client on the other end of a real MessageChannel.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrivonClient } from '../orivon-client.js'
import { type OrivonServer, serveOrivon } from '../orivon-server.js'

interface FakeHandle { id: string, closed: Promise<void>, close: () => Promise<void>, closedCount: () => number }

function fakeHandle (id: string, extra: Record<string, unknown> = {}): FakeHandle & Record<string, unknown> {
  let resolve: () => void = () => {}
  let count = 0
  const closed = new Promise<void>((done) => { resolve = done })
  return { id, closed, close: async () => { count++; resolve() }, closedCount: () => count, ...extra }
}

let server: OrivonServer | undefined
let channel: MessageChannel | undefined

afterEach(async () => {
  await server?.dispose()
  channel?.port2.close()
  server = undefined
})

type Method = (...args: unknown[]) => Promise<unknown>

function connect (orivon: object): { fs: Record<'readFile' | 'stat' | 'missing' | 'toString' | 'open' | 'readFileSync', Method>, net: Record<'connect' | 'listen', Method> } {
  channel = new MessageChannel()
  server = serveOrivon(channel.port1, orivon)
  return createOrivonClient(channel.port2) as never
}

describe('calls', () => {
  it('makes a namespace call on the page and returns its value', async () => {
    const client = connect({ fs: { readFile: async (path: string) => new TextEncoder().encode(`contents of ${path}`) } })
    expect(new TextDecoder().decode(await client.fs.readFile('a.txt') as Uint8Array)).toBe('contents of a.txt')
  })

  it('rethrows the page\'s error with its code and platformCode, so the shim maps it as it would on the page', async () => {
    const client = connect({ fs: { stat: async () => { throw Object.assign(new Error('nope'), { name: 'OrivonError', code: 'internal', platformCode: 'EISDIR' }) } } })
    await expect(client.fs.stat('x')).rejects.toMatchObject({ name: 'OrivonError', code: 'internal', platformCode: 'EISDIR', message: 'nope' })
  })

  it('names a method the page\'s orivon does not have, and never reaches an inherited one', async () => {
    const client = connect({ fs: {} })
    await expect(client.fs.missing()).rejects.toThrow(/orivon has no method fs.missing/)
    await expect(client.fs.toString()).rejects.toThrow(/orivon has no method fs.toString/)
  })

  it('refuses readFileSync by name, and is never mistaken for a promise', async () => {
    const client = connect({ fs: {} })
    expect(() => (client.fs.readFileSync as unknown as () => void)()).toThrow(/not available in a Worker/)
    expect((client as { then?: unknown }).then).toBeUndefined()
    expect(await Promise.resolve(client.fs)).toBeDefined()
  })
})

describe('handles', () => {
  it('calls a returned handle\'s methods by number, and resolves its closed when the page\'s does', async () => {
    const file = fakeHandle('f1', { read: async ({ length }: { length: number }) => new Uint8Array(length).fill(7) })
    const client = connect({ fs: { open: async () => file } })
    const handle = await client.fs.open('a', 'r') as { id: string, closed: Promise<void>, read: Method, close: Method }
    expect(handle.id).toBe('f1')
    expect(await handle.read({ position: 0, length: 3 })).toEqual(new Uint8Array([7, 7, 7]))
    await handle.close()
    await expect(handle.closed).resolves.toBeUndefined()
    await expect(handle.read({ position: 0, length: 1 })).rejects.toMatchObject({ code: 'closed' })
  })

  it('transfers a socket\'s byte streams to the Worker whole, and copies its plain fields', async () => {
    const readable = new ReadableStream<Uint8Array>({ start: (controller) => { controller.enqueue(new Uint8Array([1, 2])); controller.close() } })
    const written: Uint8Array[] = []
    const writable = new WritableStream<Uint8Array>({ write: (chunk) => { written.push(chunk) } })
    const socket = fakeHandle('s1', { readable, writable, remoteAddress: '1.2.3.4', remotePort: 443 })
    const client = connect({ net: { connect: async () => socket } })
    const remote = await client.net.connect({ host: 'x', port: 443 }) as { readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, remotePort: number }
    expect(remote.remotePort).toBe(443)
    expect((await remote.readable.getReader().read()).value).toEqual(new Uint8Array([1, 2]))
    const writer = remote.writable.getWriter()
    await writer.write(new Uint8Array([9]))
    await writer.close()
    await vi.waitFor(() => { expect(written).toEqual([new Uint8Array([9])]) })
  })

  it('pumps a server\'s connections one handle at a time, since a stream of handles cannot be transferred', async () => {
    const accepted = fakeHandle('c1', { remotePort: 5555 })
    const connections = new ReadableStream({ start: (controller) => { controller.enqueue(accepted); controller.close() } })
    const client = connect({ net: { listen: async () => fakeHandle('l1', { connections, localPort: 8080 }) } })
    const listener = await client.net.listen({ port: 8080 }) as { connections: ReadableStream<{ id: string, remotePort: number }>, localPort: number }
    const reader = listener.connections.getReader()
    const first = await reader.read()
    expect(first.value).toMatchObject({ id: 'c1', remotePort: 5555 })
    expect((await reader.read()).done).toBe(true)
  })

  it('closes every handle the Worker still holds when it is disposed', async () => {
    const file = fakeHandle('f2')
    const client = connect({ fs: { open: async () => file } })
    await client.fs.open('a', 'r')
    await server?.dispose()
    server = undefined
    expect(file.closedCount()).toBe(1)
  })
})
