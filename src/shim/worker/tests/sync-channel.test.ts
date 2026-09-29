// The synchronous route from a Worker to the page's orivon: the reply
// encoding, its chunking, and a real second thread blocking on the page.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import esbuild from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { serveOrivon } from '../orivon-server.js'
import { MAX_REPLY_LENGTH, ReplyWriter, awaitReply, createChannelBuffer, decodeReply, encodeReply } from '../sync-channel.js'

describe('the reply encoding', () => {
  it('carries an ArrayBuffer as one, and leaves an object that merely looks like a marker alone', () => {
    const reply = decodeReply(encodeReply({ buffer: new Uint8Array([7, 8]).buffer, lookalike: { __orivonBytes: 0, other: true } })) as { buffer: unknown, lookalike: unknown }
    expect(reply.buffer).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(reply.buffer as ArrayBuffer)]).toEqual([7, 8])
    expect(reply.lookalike).toEqual({ __orivonBytes: 0, other: true })
  })

  it('refuses a channel with no room for a reply', () => {
    expect(() => new ReplyWriter(new SharedArrayBuffer(16))).toThrow(TypeError)
    expect(() => new ReplyWriter(new ArrayBuffer(64))).toThrow(TypeError)
  })

  it('refuses a reply too large for the signed Int32 length header, rather than writing a wrapped length', () => {
    const buffer = createChannelBuffer()
    const writer = new ReplyWriter(buffer)
    const header = new Int32Array(buffer, 0, 4)
    // A stand-in for a >=2 GiB reply: only its `length` is read before the writer refuses it,
    // so this never allocates the reply itself.
    const oversized = { length: MAX_REPLY_LENGTH + 1 } as unknown as Uint8Array
    expect(() => { writer.send(oversized) }).toThrow(/cannot cross the synchronous channel/)
    // Nothing was written: a Worker waiting on this channel never sees a wrapped, negative length.
    expect(Atomics.load(header, 0)).toBe(0)
  })

  it('carries byte arrays beside the JSON, whole and at any depth', () => {
    const reply = { id: 3, ok: true, value: { data: new Uint8Array([0, 1, 255]), nested: [new Uint8Array(0), 'text'], none: undefined } }
    expect(decodeReply(encodeReply(reply))).toEqual({ id: 3, ok: true, value: { data: new Uint8Array([0, 1, 255]), nested: [new Uint8Array(0), 'text'] } })
  })

  it('carries a reply larger than the buffer in chunks, each asked for in turn', () => {
    const buffer = createChannelBuffer()
    const writer = new ReplyWriter(buffer)
    const reply = new Uint8Array(buffer.byteLength * 2 + 5)
    for (let index = 0; index < reply.length; index++) reply[index] = index % 251
    let asked = 0
    // One thread: each answer is written before the wait, so Atomics.wait returns at once.
    const received = awaitReply(buffer, () => { writer.send(reply) }, () => { asked++; writer.more() })
    expect(Buffer.compare(received, reply)).toBe(0)
    expect(asked).toBe(2)
  })
})

async function bundledEntry (): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [join(import.meta.dirname, 'support', 'sync-client-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
  })
  return built.outputFiles[0]?.text ?? ''
}

describe('a Worker\'s synchronous orivon', () => {
  it('blocks its thread on the page\'s orivon: files, handles, errors, and what cannot cross', async () => {
    const disk = await createRealDiskFs()
    const size = 3 * 1024 * 1024 + 17
    const big = new Uint8Array(size)
    for (let index = 0; index < size; index++) big[index] = index % 251
    writeFileSync(join(disk.root, 'big.bin'), big)
    const { port1, port2 } = new MessageChannel()
    // `test.stream` returns what a synchronous reply cannot carry.
    const orivon = { fs: disk.orivon.fs, test: { stream: () => new ReadableStream() } }
    const server = serveOrivon(port1 as unknown as globalThis.MessagePort, orivon)
    const worker = new Worker(await bundledEntry(), { eval: true, workerData: { port: port2, size }, transferList: [port2 as never] })
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      expect(result).toMatchObject({
        bigLength: size,
        bigIntact: true,
        written: 14,
        readBack: 'blocking write',
        size: 14,
        stream: { error: { name: 'OrivonShimError' } },
        missing: { error: { name: 'OrivonError', code: 'notFound' } }
      })
    } finally {
      await worker.terminate()
      await server.dispose()
      await disk.cleanup()
    }
  })
})

/** Lets serveOrivon's port.onmessage handler (and the async `call` it starts) run to completion, without a real Worker thread on the other end. */
async function settle (): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve) })
  await new Promise((resolve) => { setImmediate(resolve) })
}

describe('serveOrivon\'s synchronous fallback reply, when the writer refuses what it is given', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('delivers a short, fixed error when the writer\'s own refusal carries a large message, never that message\'s text', async () => {
    const bigMessage = 'x'.repeat(2_000)
    const { port1, port2 } = new MessageChannel()
    serveOrivon(port1 as unknown as globalThis.MessagePort, { test: { ok: () => 'fine' } })
    const sent: Uint8Array[] = []
    let calls = 0
    // The FIRST send always refuses, with an exception whose own message is as large as the
    // reply it was refusing would have been -- a fallback built from that exception's text,
    // rather than a fixed one, would be just as large. The SECOND send stands in for
    // ReplyWriter's real MAX_REPLY_LENGTH check at a size this test can reach without
    // allocating gigabytes: past 200 bytes is "too large for this channel".
    vi.spyOn(ReplyWriter.prototype, 'send').mockImplementation(function (bytes: Uint8Array) {
      sent.push(bytes)
      calls++
      if (calls === 1) throw new Error(bigMessage)
      if (bytes.length > 200) throw new RangeError('too large for this channel')
    })

    ;(port2 as unknown as globalThis.MessagePort).postMessage({ syncBuffer: createChannelBuffer() })
    ;(port2 as unknown as globalThis.MessagePort).postMessage({ id: 1, path: ['test', 'ok'], args: [], sync: true })
    await settle()

    expect(sent).toHaveLength(2)
    const fallback = decodeReply(sent[1] as Uint8Array) as { id: number, ok: boolean, error: { message: string } }
    expect(fallback).toMatchObject({ id: 1, ok: false })
    expect(fallback.error.message).not.toContain(bigMessage)
    expect(fallback.error.message.length).toBeLessThan(200)
  })

  it('logs rather than leaving an unhandled rejection when even the fallback reply cannot be written', async () => {
    const { port1, port2 } = new MessageChannel()
    serveOrivon(port1 as unknown as globalThis.MessagePort, { test: { fail: () => { throw new Error('boom') } } })
    vi.spyOn(ReplyWriter.prototype, 'send').mockImplementation(() => { throw new Error('the channel is gone') })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)

    try {
      ;(port2 as unknown as globalThis.MessagePort).postMessage({ syncBuffer: createChannelBuffer() })
      ;(port2 as unknown as globalThis.MessagePort).postMessage({ id: 1, path: ['test', 'fail'], args: [], sync: true })
      await settle()
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
    expect(errorLog).toHaveBeenCalled()
  })

  it('releases a handle a refused SUCCESSFUL reply would have carried, leaving no entry in the handle table', async () => {
    let closeCalls = 0
    let resolveClosed: () => void = () => {}
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    // Matches isHandle: an `id` string and a `close` method. describe() registers it (and
    // wires handles.delete(id) to run once `closed` resolves) the moment encode() sees it,
    // before the reply carrying it is ever attempted on the wire.
    const handle = { id: 'h1', close: async (): Promise<void> => { closeCalls++; resolveClosed() }, closed }
    const { port1, port2 } = new MessageChannel()
    const server = serveOrivon(port1 as unknown as globalThis.MessagePort, { test: { handle: () => handle } })
    vi.spyOn(ReplyWriter.prototype, 'send').mockImplementation(() => { throw new Error('refused') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const p2 = port2 as unknown as globalThis.MessagePort
    const received: unknown[] = []
    p2.onmessage = (event: MessageEvent) => { received.push(event.data) }

    try {
      p2.postMessage({ syncBuffer: createChannelBuffer() })
      p2.postMessage({ id: 1, path: ['test', 'handle'], args: [], sync: true })
      await settle()

      expect(closeCalls).toBe(1)

      // The id counter starts at 1 for a fresh serveOrivon instance, and this was the only
      // handle it ever described: an ordinary (async) call against that same id now finds it
      // gone from the table, the same way it would for a handle the Worker itself closed.
      p2.postMessage({ id: 2, handle: 1, method: 'whatever', args: [] })
      await settle()
    } finally {
      port1.close()
      port2.close()
      await server.dispose()
    }

    expect(received).toContainEqual(expect.objectContaining({
      id: 2, ok: false, error: expect.objectContaining({ message: 'handle is closed' })
    }))
  })
})
