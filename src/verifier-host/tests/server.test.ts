import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import { ResolutionError } from '../../resolution/records.js'
import type { NameRecord } from '../../resolution/records.js'
import type { DataGatherer, GatheredFile, MountedSite, NameResolver } from '../../resolution/providers.js'
import { ResolutionRegistry } from '../../resolution/registry.js'
import { createRunCertificate } from '../certificate.js'
import { MAX_BUFFERED_BYTES, createEthServer } from '../server.js'
import { Sites } from '../sites.js'

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const BIG = MAX_BUFFERED_BYTES + 1024

interface StubFile { bytes: Buffer, failAfter?: number, failure?: ResolutionError }
const FILES: Record<string, StubFile> = {
  '/index.html': { bytes: Buffer.from('<h1>home</h1>') },
  '/docs/index.html': { bytes: Buffer.from('<h1>docs</h1>') },
  '/app.js': { bytes: Buffer.from('run()') },
  '/bad.js': { bytes: Buffer.from('x'.repeat(100)), failAfter: 10, failure: new ResolutionError('unverifiable', 'block does not hash to its CID') },
  '/big.bin': { bytes: Buffer.alloc(BIG, 7), failAfter: 1024 * 1024, failure: new ResolutionError('unverifiable', 'tampered') }
}

function open (path: string, range?: { start: number, end: number }): GatheredFile {
  const served = path.endsWith('/') ? `${path}index.html` : FILES[path] === undefined && FILES[`${path}/index.html`] !== undefined ? `${path}/index.html` : path
  const file = FILES[served]
  if (file === undefined) throw new ResolutionError('not-found', `${path} is not in this site`)
  const bytes = range === undefined ? file.bytes : file.bytes.subarray(range.start, range.end + 1)
  return {
    servedPath: served,
    size: file.bytes.length,
    body: (async function * () {
      const chunk = 64 * 1024
      for (let at = 0; at < bytes.length; at += chunk) {
        if (file.failAfter !== undefined && at >= file.failAfter) throw file.failure
        yield bytes.subarray(at, at + chunk)
      }
      if (file.failAfter !== undefined && file.failAfter < bytes.length) throw file.failure
    })()
  }
}

/** A large file whose body notes when its generator is released, and the signal its open was given. */
const STREAM_BYTES = 64 * 1024 * 1024
const stream = { released: false, signal: undefined as AbortSignal | undefined }
function streamed (signal: AbortSignal | undefined): GatheredFile {
  stream.signal = signal
  return {
    servedPath: '/stream.bin',
    size: STREAM_BYTES,
    body: (async function * () {
      try {
        for (let at = 0; at < STREAM_BYTES; at += 64 * 1024) yield Buffer.alloc(64 * 1024, 1)
      } finally {
        stream.released = true
      }
    })()
  }
}

const opened: string[] = []
const site: MountedSite = {
  gatherer: 'stub',
  root: { kind: 'ipfs', cid: ROOT },
  pointers: [],
  open: async (p, r, signal) => {
    opened.push(p)
    return p === '/stream.bin' ? streamed(signal) : open(p, r)
  },
  ddoc: () => ({ status: 'met', refusals: [] })
}
const record: NameRecord = { type: 'contenthash', pointer: { kind: 'ipfs', cid: ROOT }, provenance: { via: 'fixture' } }
const resolver: NameResolver = {
  id: 'stub',
  topLevelDomains: ['eth'],
  resolve: async (name) => {
    if (name === 'syncing.eth') throw new ResolutionError('not-synced', 'light client syncing')
    if (name === 'site.eth') return [record]
    throw new ResolutionError('not-found', 'no such name')
  }
}
const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => site }

const certificate = createRunCertificate()
let server: Server
let port: number

beforeAll(async () => {
  server = createEthServer(new Sites(new ResolutionRegistry([resolver], [gatherer])), certificate)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => { server.close() })

interface Reply { status: number, headers: Record<string, string | string[] | undefined>, body: Buffer, error?: string }

async function get (path: string, options: { host?: string, servername?: string, method?: string, headers?: Record<string, string> } = {}): Promise<Reply> {
  const host = options.host ?? 'site.eth'
  return await new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', servername: options.servername ?? host, rejectUnauthorized: false, headers: { host, ...options.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
      res.on('error', (e) => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), error: e.message }) })
      res.on('aborted', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), error: 'aborted' }) })
    })
    req.on('error', (e) => { resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }) })
    req.end()
  })
}

describe('the .eth loopback server', () => {
  it('serves a verified file with its type, a CID validator and no caching without revalidation', async () => {
    const reply = await get('/')
    expect(reply.status).toBe(200)
    expect(reply.body.toString()).toBe('<h1>home</h1>')
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(reply.headers.etag).toBe(`"${ROOT}"`)
    expect(reply.headers['cache-control']).toBe('no-cache')
    expect(reply.headers['x-content-type-options']).toBe('nosniff')
    expect(reply.headers['content-security-policy']).toBe('treat-as-public-address')
  })

  it('answers a matching validator with 304 before opening anything', async () => {
    opened.length = 0
    expect((await get('/app.js', { headers: { 'if-none-match': `"${ROOT}"` } })).status).toBe(304)
    expect(opened).toEqual([])
  })

  it('serves a request pinned to the current root, and refuses one pinned to another', async () => {
    expect((await get('/app.js', { headers: { 'x-orivon-content-root': ROOT } })).status).toBe(200)
    const moved = await get('/app.js', { headers: { 'x-orivon-content-root': 'bafkqaaa' } })
    expect(moved.status).toBe(409)
    expect(moved.body.toString()).toContain(`now points to ${ROOT}`)
  })

  it('redirects a directory without its slash, as a gateway does', async () => {
    const reply = await get('/docs?x=1')
    expect(reply.status).toBe(301)
    expect(reply.headers.location).toBe('/docs/?x=1')
    expect((await get('/docs/')).body.toString()).toBe('<h1>docs</h1>')
  })

  it('serves a byte range, and refuses an unsatisfiable one', async () => {
    const reply = await get('/app.js', { headers: { range: 'bytes=1-3' } })
    expect(reply.status).toBe(206)
    expect(reply.body.toString()).toBe('un(')
    expect(reply.headers['content-range']).toBe('bytes 1-3/5')
    expect((await get('/app.js', { headers: { range: 'bytes=10-20' } })).status).toBe(416)
  })

  it('answers HEAD with headers only', async () => {
    const reply = await get('/app.js', { method: 'HEAD' })
    expect(reply.status).toBe(200)
    expect(reply.headers['content-length']).toBe('5')
    expect(reply.body.length).toBe(0)
  })

  it('refuses a host that is not .eth, and a Host that differs from the TLS name', async () => {
    expect((await get('/', { host: 'example.com' })).status).toBe(421)
    expect((await get('/', { host: 'site.eth', servername: 'other.eth' })).status).toBe(421)
  })

  it('serves a name on its default port only, since each other port would be another origin', async () => {
    expect((await get('/', { host: 'site.eth:443', servername: 'site.eth' })).status).toBe(200)
    expect((await get('/', { host: 'site.eth:8443', servername: 'site.eth' })).status).toBe(421)
  })

  it('refuses a request target that would read as an authority, and keeps serving', async () => {
    expect((await get('//a%20b/')).status).toBe(400)
    expect((await get('//site.eth/app.js')).status).toBe(400)
    expect((await get('/app.js')).status).toBe(200)
  })

  it('stops a large response when its client leaves, releasing the body and aborting its open', async () => {
    await new Promise<void>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/stream.bin', servername: 'site.eth', rejectUnauthorized: false, headers: { host: 'site.eth' } }, (res) => {
        res.once('data', () => { req.destroy(); resolve() })
      })
      req.on('error', () => {})
      req.end()
    })
    const deadline = Date.now() + 3_000
    while (!stream.released && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stream.released).toBe(true)
    expect(stream.signal?.aborted).toBe(true)
  })

  it('refuses any method but GET and HEAD', async () => {
    expect((await get('/', { method: 'POST' })).status).toBe(405)
  })

  it('shows the not-found page, which can run and load nothing, for a missing path or name', async () => {
    for (const reply of [await get('/missing.js'), await get('/', { host: 'nobody.eth' })]) {
      expect(reply.status).toBe(404)
      expect(reply.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; treat-as-public-address")
      expect(reply.body.toString()).toContain('Nothing here')
    }
  })

  it('asks to retry while the light client is syncing', async () => {
    const reply = await get('/', { host: 'syncing.eth' })
    expect(reply.status).toBe(503)
    expect(reply.headers['retry-after']).toBe('10')
  })

  it('sends none of a small file that fails verification part-way: the error page instead', async () => {
    const reply = await get('/bad.js')
    expect(reply.status).toBe(502)
    expect(reply.body.toString()).not.toContain('xxxx')
    expect(reply.body.toString()).toContain('Cannot verify this site')
  })

  it('cuts a large file that fails verification mid-stream, so it arrives short of its length', async () => {
    const reply = await get('/big.bin')
    expect(reply.status).toBe(200)
    expect(Number(reply.headers['content-length'])).toBe(BIG)
    expect(reply.body.length).toBeLessThan(BIG)
  })
})
