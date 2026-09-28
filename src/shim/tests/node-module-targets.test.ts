// The subpath module targets and the package-backed wrappers: each is the
// same object as the member it names, keeps the package's real members, and
// refuses one it lacks by name when called, never on the read.

import { describe, expect, it } from 'vitest'
import { pageStream } from './support/page-stream.js'
import { PageBuffer } from './support/page-buffer.js'

function refusalOf (call: () => unknown): unknown {
  try { call(); return undefined } catch (error) { return error }
}

describe('subpath targets', () => {
  it('fs/promises is fs.promises, with named members', async () => {
    const fs = await import('../fs/fs.js')
    const fsPromises = await import('../fs/promises.js')
    expect(fsPromises.default).toBe(fs.promises)
    expect(fsPromises.readFile).toBe(fs.promises.readFile)
  })

  it('util/types is util.types, with named members', async () => {
    const util = await import('../polyfills/util.js')
    const types = await import('../polyfills/util-types.js')
    expect(types.default).toBe(util.types)
    expect(types.isPromise(Promise.resolve())).toBe(true)
  })

  it('dns/promises is dns.promises', async () => {
    const dns = await import('../net/dns.js')
    const dnsPromises = await import('../net/dns-promises.js')
    expect(dnsPromises.default).toBe(dns.promises)
    expect(typeof dnsPromises.lookup).toBe('function')
  })

  it('path/posix is path itself', async () => {
    const path = await import('../polyfills/path.js')
    expect(path.posix).toBe(path.default)
    expect(path.default.posix).toBe(path.default)
  })

  it('stream/promises pipeline and finished settle as promises', async () => {
    const { pipeline, finished } = await import('../polyfills/stream-promises.js')
    const seen: string[] = []
    const source = pageStream.Readable.from(['a', 'b'])
    const sink = new pageStream.Writable({ write (chunk: unknown, _encoding, callback) { seen.push(String(chunk)); callback() } })
    await pipeline(source, sink)
    expect(seen).toEqual(['a', 'b'])
    // Already finished: readable-stream 3 alone would wait forever for an event.
    await expect(finished(sink)).resolves.toBeUndefined()
  })
})

describe('package-backed wrappers', () => {
  it('path keeps path-browserify\'s answers and refuses win32 by name', async () => {
    const path = await import('../polyfills/path.js')
    expect(path.join('/orivon/app', 'a', '..', 'b')).toBe('/orivon/app/b')
    expect(path.default.basename('/x/y.txt', '.txt')).toBe('y')
    const { win32 } = path.default as unknown as { win32: () => unknown }
    expect(refusalOf(() => win32())).toMatchObject({ name: 'OrivonShimError', api: 'path.win32' })
  })

  it('crypto keeps crypto-browserify\'s hashes and adds the platform\'s Web Crypto members', async () => {
    const crypto = await import('../polyfills/crypto.js')
    expect(crypto.createHash('sha1').update('abc').digest('hex')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(crypto.default.createHash).toBe(crypto.createHash)
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/)
    expect(crypto.default.webcrypto).toBe(globalThis.crypto)
    const { generateKeyPairSync } = crypto.default as unknown as { generateKeyPairSync: () => unknown }
    expect(refusalOf(() => generateKeyPairSync())).toMatchObject({ name: 'OrivonShimError', api: 'crypto.generateKeyPairSync' })
  })

  it('zlib round-trips gzip and refuses brotli by name', async () => {
    const zlib = await import('../polyfills/zlib.js')
    // A string, not a Buffer: under vitest the package runs on Node's own
    // Buffer, which does not recognise the page's.
    expect(String(zlib.gunzipSync(zlib.gzipSync('hello')))).toBe('hello')
    const { brotliCompressSync } = zlib.default as unknown as { brotliCompressSync: () => unknown }
    expect(refusalOf(() => brotliCompressSync())).toMatchObject({ name: 'OrivonShimError', api: 'zlib.brotliCompressSync' })
  })

  it('buffer is the package\'s Buffer, plus the platform\'s atob/btoa/Blob', async () => {
    const buffer = await import('../polyfills/buffer.js')
    expect(buffer.Buffer).toBe(PageBuffer)
    expect(buffer.default.Buffer).toBe(PageBuffer)
    expect(buffer.atob('aGk=')).toBe('hi')
    const { transcode } = buffer.default as unknown as { transcode: () => unknown }
    expect(refusalOf(() => transcode())).toMatchObject({ name: 'OrivonShimError', api: 'buffer.transcode' })
  })
})
