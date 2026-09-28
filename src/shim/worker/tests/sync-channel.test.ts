// The synchronous route from a Worker to the page's orivon: the reply
// encoding, its chunking, and a real second thread blocking on the page.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { serveOrivon } from '../orivon-server.js'
import { ReplyWriter, awaitReply, createChannelBuffer, decodeReply, encodeReply } from '../sync-channel.js'

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
