import { describe, expect, it } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, stubFs } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Broker } from '../broker-contracts.js'

// fs.open's bulk-stream paths -- readable()/writable() -- split out of
// fs-open.test.ts under code-guidelines.md's 800-line test limit, following
// index-fs-extended.test.ts's own split precedent. Both are proven here
// against `stubFs`'s in-memory streams, which is enough to prove
// fs-capability.ts's OWN wiring (the quota check on writable(), reuse of
// the same handle); whether the REAL adapter's streams behave correctly
// against a real fd is node-fs-adapter-open.test.ts's job.

async function fsBroker (files = new Map<string, Uint8Array>()): Promise<Broker> {
  const broker = createBroker(baseDeps({ fs: stubFs({ files }) }))
  broker.registerApp(APP, manifestWith({ fs: {} }))
  await broker.grant(APP, 'fs', [])
  return broker
}

async function drain (stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const reader = stream.getReader()
  const bytes: number[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes.push(...Array.from(value))
  }
  return bytes
}

describe('fs.open -- readable()/writable() are real WHATWG streams reachable through the SAME handle', () => {
  it('writable() writes bytes a subsequent readable() (or positional read) can see', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'stream.bin', 'w+')

    const writer = file.writable().getWriter()
    await writer.write(new Uint8Array([1, 2, 3]))
    await writer.close()

    expect(Array.from(await file.read({ position: 0, length: 3 }))).toEqual([1, 2, 3])
    await file.close()
  })

  it('readable() streams back what write() already landed', async () => {
    const broker = await fsBroker()
    const file = await broker.fs.open(APP, 'stream.bin', 'w+')
    await file.write({ position: 0, data: new Uint8Array([4, 5, 6]) })

    const bytes = await drain(file.readable())

    expect(bytes).toEqual([4, 5, 6])
    await file.close()
  })
})

describe('fs.open -- writable() is quota-checked per chunk, unlike UDP\'s counted loss (A87)', () => {
  it('a chunk that would exceed the declared quota ERRORS the stream -- it is not silently dropped', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 5 } }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'quota-stream.bin', 'w+')

    const writer = file.writable().getWriter()
    const error = await rejection(writer.write(new Uint8Array(10)))

    expect(error.code).toBe('limit')
    await file.close()
  })

  it('a chunk that fits lands, and counts against the SAME quota positional write() draws from', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 6 } }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'shared-quota.bin', 'w+')

    const writer = file.writable().getWriter()
    await writer.write(new Uint8Array(6))
    await writer.close()

    // The stream already spent the whole quota -- a positional write of
    // even one more byte must now be refused, proving the two paths share
    // one running counter rather than each keeping its own.
    const error = await rejection(file.write({ position: 6, data: new Uint8Array(1) }))
    expect(error.code).toBe('limit')
    await file.close()
  })

  it('a chunk refused by quota does not tear down the whole FileHandle -- a positional read still works', async () => {
    const broker = createBroker(baseDeps({ fs: stubFs() }))
    broker.registerApp(APP, manifestWith({ fs: { quotaBytes: 1 } }))
    await broker.grant(APP, 'fs', [])
    const file = await broker.fs.open(APP, 'still-alive.bin', 'w+')
    const writer = file.writable().getWriter()

    await rejection(writer.write(new Uint8Array(10)))

    await expect(file.read({ position: 0, length: 1 })).resolves.toBeInstanceOf(Uint8Array)
    await file.close()
  })
})
