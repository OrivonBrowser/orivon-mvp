// Exercises fs.createReadStream/createWriteStream (node-fs-streams.ts) --
// both real stream.Readable/Writable subclasses driven by node-fs-handle.ts's
// local-cursor FileHandle, never by the broker's readable()/writable()
// (still blocked on A184). Same stubbed-globalThis.orivon pattern as
// node-fs-handle.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { createFakeFileHandle, type FakeFileHandle } from './support/fake-file-handle.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (initial?: Uint8Array): { fake: FakeFileHandle, openCalls: Array<{ path: string, flags: string }> } {
  const fake = createFakeFileHandle(initial)
  const openCalls: Array<{ path: string, flags: string }> = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      open: async (path: string, flags: string) => { openCalls.push({ path, flags }); return fake.handle }
    }
  } as unknown as Orivon
  return { fake, openCalls }
}

function orivonError (code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function collect (stream: NodeJS.ReadableStream): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(chunks))
    stream.on('error', reject)
  })
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('fs.createReadStream', () => {
  it('opens read-only and streams the whole file as Buffer chunks by default', async () => {
    const { openCalls } = installFakeOrivon(new TextEncoder().encode('hello world'))
    const { createReadStream } = await import('../node-fs-streams.js')
    const stream = createReadStream('/x')
    const chunks = await collect(stream)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world')
    expect(openCalls).toEqual([{ path: '/x', flags: 'r' }])
  })

  it('decodes to strings when an encoding is given, matching fs.readFile\'s own behaviour', async () => {
    installFakeOrivon(new TextEncoder().encode('line one\nline two\n'))
    const { createReadStream } = await import('../node-fs-streams.js')
    const stream = createReadStream('/x', { encoding: 'utf8' })
    const text = await new Promise<string>((resolve, reject) => {
      let out = ''
      stream.on('data', (chunk) => { out += chunk })
      stream.on('end', () => resolve(out))
      stream.on('error', reject)
    })
    expect(text).toBe('line one\nline two\n')
  })

  it('start/end are INCLUSIVE of end, matching real Node\'s own fs.createReadStream contract', async () => {
    installFakeOrivon(new TextEncoder().encode('0123456789'))
    const { createReadStream } = await import('../node-fs-streams.js')
    const stream = createReadStream('/x', { start: 2, end: 4 })
    const chunks = await collect(stream)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('234')
  })

  it('emits open/ready with the real fd before any data', async () => {
    installFakeOrivon(new Uint8Array([1, 2, 3]))
    const { createReadStream } = await import('../node-fs-streams.js')
    const stream = createReadStream('/x')
    const fd = await new Promise<number>((resolve) => stream.once('open', resolve))
    expect(typeof fd).toBe('number')
    await collect(stream)
  })

  it('closes the underlying handle once the stream ends', async () => {
    const { fake } = installFakeOrivon(new Uint8Array([1, 2, 3]))
    const { createReadStream } = await import('../node-fs-streams.js')
    await collect(createReadStream('/x'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fake.closed()).toBe(true)
  })

  it('a failed open surfaces as a Node-shaped \'error\' event, never an unhandled rejection', async () => {
    (globalThis as GlobalWithOrivon).orivon = {
      fs: { open: async () => { throw orivonError('notFound', 'no such file') } }
    } as unknown as Orivon
    const { createReadStream } = await import('../node-fs-streams.js')
    const stream = createReadStream('/missing')
    const error = await new Promise<Error & { code?: string }>((resolve) => stream.once('error', resolve))
    expect(error.code).toBe('notFound')
  })
})

describe('fs.createWriteStream', () => {
  it('opens with flags \'w\' by default and writes chunks positionally from 0', async () => {
    const { fake, openCalls } = installFakeOrivon()
    const { createWriteStream } = await import('../node-fs-streams.js')
    const stream = createWriteStream('/x')
    stream.write('hel')
    stream.write('lo')
    await new Promise<void>((resolve, reject) => stream.end((err: Error | null) => (err !== null && err !== undefined ? reject(err) : resolve())))
    expect(openCalls).toEqual([{ path: '/x', flags: 'w' }])
    expect(new TextDecoder().decode(fake.bytes())).toBe('hello')
  })

  it('honours a custom start position', async () => {
    const { fake } = installFakeOrivon(new TextEncoder().encode('XXXXXXXXXX'))
    const { createWriteStream } = await import('../node-fs-streams.js')
    const stream = createWriteStream('/x', { start: 3 })
    stream.end('abc')
    await new Promise<void>((resolve) => stream.once('finish', resolve))
    expect(new TextDecoder().decode(fake.bytes())).toBe('XXXabcXXXX')
  })

  // @seald-io/nedb's own writeFileLinesAsync: several synchronous `.write()`
  // calls from a 'data' handler, then `.close(cb)` once the source ends --
  // never `.end()` directly. This is the exact shape that call makes.
  it('close(cb) ends the stream and reports once the handle is actually closed', async () => {
    const { fake } = installFakeOrivon()
    const { createWriteStream } = await import('../node-fs-streams.js')
    const stream = createWriteStream('/x')
    stream.write('a\n')
    stream.write('b\n')
    await new Promise<void>((resolve, reject) => {
      stream.close((err) => (err !== null && err !== undefined ? reject(err) : resolve()))
    })
    expect(new TextDecoder().decode(fake.bytes())).toBe('a\nb\n')
    expect(fake.closed()).toBe(true)
  })

  it('a write failure reaches the \'error\' event, matching what @seald-io/nedb\'s own storage.js listens for', async () => {
    const { fake } = installFakeOrivon()
    fake.handle.write = async () => { throw orivonError('limit', 'quota exceeded') }
    const { createWriteStream } = await import('../node-fs-streams.js')
    const stream = createWriteStream('/x')
    const errorSeen = new Promise<Error & { code?: string }>((resolve) => stream.once('error', resolve))
    stream.write('too much')
    const error = await errorSeen
    expect(error.code).toBe('limit')
  })
})
