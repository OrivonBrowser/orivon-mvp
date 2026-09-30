// A Worker's orivon.* over a MessagePort: the page-side server against a fake
// orivon, the Worker-side client on the other end of a real MessageChannel.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrivonClient } from '../orivon-client.js'
import { type OrivonServer, type RunSpawnSync, serveOrivon } from '../orivon-server.js'
import { createChannelBuffer, decodeReply } from '../sync-channel.js'

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

  it('serves its own orivon to a child of its own, so a call from that child reaches the page', async () => {
    // A Worker that spawns a program serves the Worker's client as that program's orivon.
    const inner = connect({ fs: { mkdir: async (path: string) => `made ${path}` } })
    const nested = new MessageChannel()
    const nestedServer = serveOrivon(nested.port1, inner)
    try {
      const grandchild = createOrivonClient(nested.port2) as unknown as { fs: { mkdir: Method, toString: Method } }
      expect(await grandchild.fs.mkdir('/data')).toBe('made /data')
      // The page's own-property check still decides: an inherited member is refused there.
      await expect(grandchild.fs.toString()).rejects.toThrow(/orivon has no method fs.toString/)
    } finally {
      await nestedServer.dispose()
      nested.port2.close()
    }
  })

  it('refuses readFileSync by name without shared memory, and is never mistaken for a promise', async () => {
    // A Worker of an app that is not cross-origin isolated has no SharedArrayBuffer to block on.
    vi.stubGlobal('SharedArrayBuffer', undefined)
    const client = connect({ fs: {} })
    vi.unstubAllGlobals()
    expect(() => (client.fs.readFileSync as unknown as () => void)()).toThrow(/not available in a Worker of an app that is not cross-origin isolated/)
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

  it('keeps a handle\'s platformCode when its closed rejects, as a socket reset carries it', async () => {
    let fail: (error: unknown) => void = () => {}
    const socket = { id: 's2', closed: new Promise<void>((_resolve, reject) => { fail = reject }), close: async () => {} }
    const client = connect({ net: { connect: async () => socket } })
    const remote = await client.net.connect({}) as { closed: Promise<void> }
    fail(Object.assign(new Error('reset'), { name: 'OrivonError', code: 'reset', platformCode: 'ECONNRESET' }))
    await expect(remote.closed).rejects.toMatchObject({ code: 'reset', platformCode: 'ECONNRESET' })
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

/**
 * One synchronous call answered by the server, read without blocking: this
 * thread serves it too. The header is sync-channel.ts's: a state word
 * (1 once written), the chunk's length, and the data after 16 bytes.
 */
async function syncReply (orivon: object, path: string[]): Promise<unknown> {
  channel = new MessageChannel()
  server = serveOrivon(channel.port1, orivon)
  const buffer = createChannelBuffer()
  const header = new Int32Array(buffer, 0, 4)
  channel.port2.postMessage({ syncBuffer: buffer })
  channel.port2.postMessage({ path, args: [], id: 1, sync: true })
  await vi.waitFor(() => { expect(Atomics.load(header, 0)).toBe(1) })
  return decodeReply(new Uint8Array(buffer, 16, header[1]).slice())
}

describe('synchronous calls', () => {
  it('refuse a value holding a stream, and cancel it rather than leave it open on the page', async () => {
    const cancel = vi.fn(async () => {})
    const stream = new ReadableStream({ cancel })
    expect(await syncReply({ net: { stream: async () => stream } }, ['net', 'stream'])).toMatchObject({ ok: false, error: { name: 'OrivonShimError' } })
    expect(cancel).toHaveBeenCalled()
  })

  it('refuse a handle whose streams are pumped, and close it', async () => {
    const server = fakeHandle('listener', { connections: new ReadableStream() })
    expect(await syncReply({ net: { listen: async () => server } }, ['net', 'listen'])).toMatchObject({ ok: false })
    expect(server.closedCount()).toBe(1)
  })

  it('answer a value that cannot be encoded with an error, never silence the Worker is waiting on', async () => {
    expect(await syncReply({ app: { big: async () => 1n } }, ['app', 'big'])).toMatchObject({ ok: false, error: { name: 'TypeError' } })
  })

  it('ignore a reply channel the page cannot write into', () => {
    channel = new MessageChannel()
    server = serveOrivon(channel.port1, {})
    expect(() => { (channel?.port1.onmessage as (event: { data: unknown }) => void)({ data: { syncBuffer: new SharedArrayBuffer(16) } }) }).not.toThrow()
    expect(() => { (channel?.port1.onmessage as (event: { data: unknown }) => void)({ data: { syncBuffer: new ArrayBuffer(64) } }) }).not.toThrow()
  })
})

/** spawnSync's own request kind (CallBody's spawnSync variant): answered by the runSpawnSync serveOrivon is given, never by an orivon.* path. */
async function syncSpawnReply (runSpawnSync: RunSpawnSync, payload: unknown): Promise<unknown> {
  channel = new MessageChannel()
  server = serveOrivon(channel.port1, {}, runSpawnSync)
  const buffer = createChannelBuffer()
  const header = new Int32Array(buffer, 0, 4)
  channel.port2.postMessage({ syncBuffer: buffer })
  channel.port2.postMessage({ spawnSync: payload, id: 1, sync: true })
  await vi.waitFor(() => { expect(Atomics.load(header, 0)).toBe(1) })
  return decodeReply(new Uint8Array(buffer, 16, header[1]).slice())
}

describe('child_process\'s spawnSync request kind', () => {
  it('is answered by the runSpawnSync serveOrivon was given, with its payload untouched', async () => {
    const seen: unknown[] = []
    const runSpawnSync = async (payload: unknown): Promise<unknown> => { seen.push(payload); return { pid: 1, status: 0, signal: null } }
    expect(await syncSpawnReply(runSpawnSync, { command: '/bin/echo' })).toMatchObject({ ok: true, value: { pid: 1, status: 0, signal: null } })
    expect(seen).toEqual([{ command: '/bin/echo' }])
  })

  it('is a named error, never silence, when no runSpawnSync was given to serve it', async () => {
    channel = new MessageChannel()
    server = serveOrivon(channel.port1, {})
    const buffer = createChannelBuffer()
    const header = new Int32Array(buffer, 0, 4)
    channel.port2.postMessage({ syncBuffer: buffer })
    channel.port2.postMessage({ spawnSync: {}, id: 1, sync: true })
    await vi.waitFor(() => { expect(Atomics.load(header, 0)).toBe(1) })
    expect(decodeReply(new Uint8Array(buffer, 16, header[1]).slice())).toMatchObject({ ok: false, error: { message: expect.stringContaining('child_process.spawnSync') } })
  })

  // The client's own SPAWN_SYNC-exposed function genuinely blocks (callSync,
  // orivon-client.ts) -- calling it here, on the same thread that would have
  // to answer it, would deadlock (this file's own syncReply/syncSpawnReply
  // helpers exist to avoid exactly that). worker/tests/sync-channel.test.ts
  // proves the client's blocking route end to end, in a real thread;
  // child-process/tests/child-process.test.ts's runSpawnSync suite proves
  // what the server side does with a spawnSync payload against real WASI
  // programs.

  // Finding 20: a Worker killed (or its page tab closed) while blocked in
  // spawnSync used to leave its own grandchild running forever on this
  // side -- nothing here ever asked it to stop. `registerChild` is how
  // runSpawnSync now hands this server a way to.
  it('dispose() kills a spawnSync grandchild still running when the Worker that asked for it goes away', async () => {
    let killed = false
    let started: (() => void) | undefined
    const stillRunning = new Promise<void>((resolve) => { started = resolve })
    const runSpawnSync: RunSpawnSync = async (_payload, registerChild) => {
      registerChild((/* kill */) => { killed = true })
      started?.()
      return await new Promise(() => {}) // never resolves on its own -- only dispose() ends this test's own wait
    }
    channel = new MessageChannel()
    server = serveOrivon(channel.port1, {}, runSpawnSync)
    channel.port2.postMessage({ spawnSync: { command: '/bin/x' }, id: 1 })
    await stillRunning
    expect(killed).toBe(false)
    await server.dispose()
    expect(killed).toBe(true)
  })

  it('does not try to kill a spawnSync grandchild that already finished', async () => {
    let killCalls = 0
    const runSpawnSync: RunSpawnSync = async (_payload, registerChild) => {
      registerChild(() => { killCalls++ })
      return { pid: 1, status: 0, signal: null }
    }
    expect(await syncSpawnReply(runSpawnSync, { command: '/bin/x' })).toMatchObject({ ok: true })
    await server?.dispose()
    expect(killCalls).toBe(0)
  })
})
