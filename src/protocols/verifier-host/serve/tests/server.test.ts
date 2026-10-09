import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:https'
import { ResolutionError } from '../../../resolution/records.js'
import type { NameRecord } from '../../../resolution/records.js'
import type { DataGatherer, GatheredFile, MountedSite, NameResolver } from '../../../resolution/providers.js'
import { ProtocolRegistry } from '../../../registry.js'
import { defineProtocol } from '../../../protocol.js'
import { ENS } from '../../../ens/descriptor.js'
import { IPFS } from '../../../ipfs/descriptor.js'
import { createIpfsAddressResolvers } from '../../../ipfs/address-resolver.js'
import { CID } from 'multiformats/cid'
import { createRunCertificate } from '../certificate.js'
import { DDOC_MISMATCH, EXPECT_LEAF_HEADER, FAILURE_HEADER } from '../../../../loader/fetch/content-root.js'
import { leafOf } from '../../../../loader/leaf-hash.js'
import { MAX_BUFFERED_BYTES, createVerifierServer } from '../server.js'
import { Sites } from '../sites.js'

const ROOT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const BIG = MAX_BUFFERED_BYTES + 1024
const CUT = 200 * 1024

interface StubFile { bytes: Buffer, failAfter?: number, failure?: ResolutionError }
const FILES: Record<string, StubFile> = {
  '/index.html': { bytes: Buffer.from('<h1>home</h1>') },
  '/docs/index.html': { bytes: Buffer.from('<h1>docs</h1>') },
  '/app.js': { bytes: Buffer.from('run()') },
  '/bad.js': { bytes: Buffer.from('x'.repeat(100)), failAfter: 10, failure: new ResolutionError('unverifiable', 'block does not hash to its CID') },
  '/lied.js': { bytes: Buffer.from('x'.repeat(100)), failAfter: 10, failure: new ResolutionError('unverifiable', 'every gateway sent bytes that failed their hash', true) },
  '/big.bin': { bytes: Buffer.alloc(BIG, 7), failAfter: 1024 * 1024, failure: new ResolutionError('unverifiable', 'tampered') },
  '/cut.js': { bytes: Buffer.alloc(CUT, 7), failAfter: 64 * 1024, failure: new ResolutionError('unverifiable', 'tampered') }
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

/** A site whose root is one file: served at `/`, with the type its bytes gave. */
const FILE_ROOT = Buffer.from('<!doctype html><title>x</title>')
function fileRoot (range: { start: number, end: number } | undefined): GatheredFile {
  const bytes = range === undefined ? FILE_ROOT : FILE_ROOT.subarray(range.start, range.end + 1)
  return { servedPath: '/', size: FILE_ROOT.length, contentType: 'text/html; charset=utf-8', body: (async function * () { yield bytes })() }
}

const opened: string[] = []
const partitions: string[] = []
const site: MountedSite = {
  gatherer: 'stub',
  root: { kind: 'ipfs', cid: ROOT },
  pointers: [],
  open: async (p, r, signal) => {
    opened.push(p)
    if (p === '/file-root') return fileRoot(r)
    return p === '/stream.bin' ? streamed(signal) : open(p, r)
  },
  ddoc: () => ({ status: 'met', refusals: [] })
}
const record: NameRecord = { type: 'contenthash', pointer: { kind: 'ipfs', cid: ROOT }, provenance: { via: 'fixture' } }
const resolver: NameResolver = {
  id: 'stub',
  namespaces: ['.eth'],
  resolve: async (name) => {
    if (name === 'syncing.eth') throw new ResolutionError('not-synced', 'light client syncing')
    if (name === 'site.eth' || name === 'part.eth' || name === 'own.eth') return [record]
    throw new ResolutionError('not-found', 'no such name')
  }
}
const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async (_name, _records, _signal, partition) => { partitions.push(partition ?? ''); return site } }

const registry = new ProtocolRegistry([
  defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] }),
  defineProtocol(IPFS, { resolvers: createIpfsAddressResolvers() })
])
const certificate = createRunCertificate()
let server: Server
let port: number

beforeAll(async () => {
  server = createVerifierServer(registry, new Sites(registry), certificate)
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
    expect(reply.headers['content-security-policy']).toBe("treat-as-public-address; frame-ancestors 'self'")
  })

  it('serves a file-valued root with the type it was given, keeping nosniff, whole and by range', async () => {
    const whole = await get('/file-root')
    expect(whole.status).toBe(200)
    expect(whole.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(whole.headers['x-content-type-options']).toBe('nosniff')
    expect(whole.body.toString()).toBe(FILE_ROOT.toString())
    const part = await get('/file-root', { headers: { range: 'bytes=0-4' } })
    expect(part.status).toBe(206)
    expect(part.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(part.body.toString()).toBe('<!doc')
  })

  it('answers a matching validator with 304 before opening anything, carrying the same CSP a full reply would', async () => {
    opened.length = 0
    const reply = await get('/app.js', { headers: { 'if-none-match': `"${ROOT}"` } })
    expect(reply.status).toBe(304)
    expect(opened).toEqual([])
    // A copy cached from before this CSP existed must not keep revalidating under its old headers.
    expect(reply.headers['content-security-policy']).toBe("treat-as-public-address; frame-ancestors 'self'")
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

  it('mounts per top-level page origin, and mounts a request with none afresh every time, keeping nothing', async () => {
    partitions.length = 0
    await get('/app.js', { host: 'part.eth', headers: { 'x-orivon-partition': 'https://news.example' } })
    await get('/app.js', { host: 'part.eth', headers: { 'x-orivon-partition': 'https://news.example' } })
    await get('/app.js', { host: 'part.eth', headers: { 'x-orivon-partition': 'https://tracker.example' } })
    await get('/app.js', { host: 'part.eth', headers: { 'sec-fetch-site': 'cross-site' } })
    await get('/app.js', { host: 'part.eth', headers: { 'sec-fetch-site': 'cross-site' } })
    await get('/app.js', { host: 'part.eth', headers: { 'x-orivon-partition': 'not an origin' } })
    expect(partitions).toEqual(['https://news.example', 'https://tracker.example', '', '', ''])
  })

  it("gives a request no page started, or the name's own worker made, the name's own partition", async () => {
    partitions.length = 0
    await get('/favicon.ico', { host: 'own.eth', headers: { 'sec-fetch-site': 'none' } })
    await get('/sw.js', { host: 'own.eth', headers: { 'sec-fetch-site': 'same-origin' } })
    expect(partitions).toEqual(['https://own.eth'])
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
      expect(reply.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; treat-as-public-address; frame-ancestors 'self'")
      expect(reply.body.toString()).toContain('Nothing here')
    }
  })

  it('names the root it looked in on a missing path, and none on a name that has no content', async () => {
    const missingPath = await get('/missing.js')
    expect(missingPath.status).toBe(404)
    expect(missingPath.headers['x-orivon-content-root']).toBeDefined()
    const missingName = await get('/', { host: 'nobody.eth' })
    expect(missingName.status).toBe(404)
    expect(missingName.headers['x-orivon-content-root']).toBeUndefined()
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

  it('says a failed verification in a header of its own, and never for a name that merely does not resolve or a light client still syncing', async () => {
    expect((await get('/bad.js')).headers['x-orivon-failure']).toBe('unverifiable')
    expect((await get('/', { host: 'syncing.eth' })).headers['x-orivon-failure']).toBeUndefined()
    expect((await get('/missing.js')).headers['x-orivon-failure']).toBeUndefined()
  })

  it('keeps its error page for a source that lied, and does not say the content failed: no gateway delivered the real bytes', async () => {
    const reply = await get('/lied.js')
    expect(reply.status).toBe(502)
    expect(reply.body.toString()).toContain('Cannot verify this site')
    expect(reply.headers['x-orivon-failure']).toBeUndefined()
  })

  it('streams even a small file to an install, which names its root and checks every byte itself, so a slow gateway still reads as progress', async () => {
    expect((await get('/cut.js')).status).toBe(502)
    const install = await get('/cut.js', { headers: { 'x-orivon-content-root': ROOT } })
    expect(install.status).toBe(200)
    expect(Number(install.headers['content-length'])).toBe(CUT)
    expect(install.body.length).toBeLessThan(CUT)
  })

  it('cuts a large file that fails verification mid-stream, so it arrives short of its length', async () => {
    const reply = await get('/big.bin')
    expect(reply.status).toBe(200)
    expect(Number(reply.headers['content-length'])).toBe(BIG)
    expect(reply.body.length).toBeLessThan(BIG)
  })
})

describe('the loopback server, for an address scheme', () => {
  it('redirects a written address to the origin of its canonical spelling, keeping path and query', async () => {
    const v0 = CID.parse(ROOT).toV0().toString()
    const reply = await get(`/${v0}/docs/a.html?x=1`, { host: 'ipfs.orivon' })
    expect(reply.status).toBe(301)
    expect(reply.headers.location).toBe(`https://${ROOT}.ipfs.orivon/docs/a.html?x=1`)
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(reply.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; treat-as-public-address")
    expect((await get(`/${ROOT}`, { host: 'ipfs.orivon' })).headers.location).toBe(`https://${ROOT}.ipfs.orivon/`)
  })

  it('inlines a DNSLink name into one label on the way', async () => {
    const reply = await get('/en.Wikipedia-on-IPFS.org/wiki/', { host: 'ipns.orivon' })
    expect(reply.headers.location).toBe('https://en-wikipedia--on--ipfs-org.ipns.orivon/wiki/')
  })

  it('shows the invalid-name page, naming the address as written, for one that does not parse', async () => {
    const reply = await get('/not-a-cid/', { host: 'ipfs.orivon' })
    expect(reply.status).toBe(400)
    expect(reply.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; treat-as-public-address; frame-ancestors 'self'")
    expect(reply.body.toString()).toContain('ipfs://not-a-cid')
  })

  it('serves a canonical address through the gatherers, and refuses a second spelling of it', async () => {
    const served = await get('/', { host: `${ROOT}.ipfs.orivon` })
    expect(served.status).toBe(200)
    expect(served.body.toString()).toBe('<h1>home</h1>')
    const base36 = CID.parse(ROOT).toString((await import('multiformats/bases/base36')).base36)
    const second = await get('/', { host: `${base36}.ipfs.orivon` })
    expect(second.status).toBe(400)
    expect(second.body.toString()).toContain(`ipfs://${base36}`)
  })

  it('refuses a name too long to be a host before any parser sees it, and says so without echoing it whole', async () => {
    const started = Date.now()
    const reply = await get(`/Q${'z'.repeat(16_000)}/`, { host: 'ipns.orivon' })
    expect(reply.status).toBe(400)
    expect(reply.body.length).toBeLessThan(4_000)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('shows the unsupported page, not a redirect to a host Chromium refuses, for a punycode DNSLink name', async () => {
    const reply = await get('/xn--mnchen-3ya.de/', { host: 'ipns.orivon' })
    expect(reply.status).toBe(501)
    expect(reply.headers.location).toBeUndefined()
  })

  it('refuses a host under the address suffix that no protocol serves', async () => {
    expect((await get('/', { host: `${ROOT}.nope.orivon` })).status).toBe(421)
    expect((await get('/', { host: 'example.com' })).status).toBe(421)
  })

  it('sends a top-level-domain name written under an address scheme straight to its own origin', async () => {
    const reply = await get('/vitalik.eth/p?q=1', { host: 'ipns.orivon' })
    expect(reply.status).toBe(301)
    expect(reply.headers.location).toBe('https://vitalik.eth/p?q=1')
  })
})

describe('the loopback server, for a file whose leaf the caller expects', () => {
  const leafOfFile = async (path: string): Promise<string> => {
    const bytes = FILES[path]!.bytes
    return await leafOf(path, bytes.length, [bytes])
  }

  it('sends the file once its leaf matches, whole and by range', async () => {
    const leaf = await leafOfFile('/app.js')
    const whole = await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: leaf } })
    expect(whole.status).toBe(200)
    expect(whole.body.toString()).toBe('run()')
    const part = await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: leaf, range: 'bytes=1-3' } })
    expect(part.status).toBe(206)
    expect(part.body.toString()).toBe('un(')
    expect(part.headers['content-range']).toBe('bytes 1-3/5')
  })

  it('sends none of a file whose leaf differs, and says it was the declared tree that it failed', async () => {
    const wrong = await leafOfFile('/index.html')
    const reply = await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: wrong } })
    expect(reply.status).toBe(502)
    expect(reply.headers[FAILURE_HEADER]).toBe(DDOC_MISMATCH)
    expect(reply.body.toString()).not.toContain('run()')
    const ranged = await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: wrong, range: 'bytes=0-1' } })
    expect(ranged.status).toBe(502)
    expect(ranged.body.toString()).not.toContain('ru')
  })

  it('hashes the file under the canonical path of the request, so the same bytes at another path do not match', async () => {
    const bytes = FILES['/app.js']!.bytes
    const elsewhere = await leafOf('/other.js', bytes.length, [bytes])
    expect((await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: elsewhere } })).status).toBe(502)
  })

  it('checks a file an install fetches too, however large the install would have let it stream', async () => {
    const leaf = await leafOfFile('/app.js')
    expect((await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: leaf, 'x-orivon-content-root': ROOT } })).status).toBe(200)
    expect((await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: await leafOfFile('/docs/index.html'), 'x-orivon-content-root': ROOT } })).status).toBe(502)
  })

  it('answers HEAD only after the file was checked', async () => {
    const leaf = await leafOfFile('/app.js')
    expect((await get('/app.js', { method: 'HEAD', headers: { [EXPECT_LEAF_HEADER]: leaf } })).status).toBe(200)
    expect((await get('/app.js', { method: 'HEAD', headers: { [EXPECT_LEAF_HEADER]: await leafOfFile('/docs/index.html') } })).status).toBe(502)
  })

  it('refuses a leaf that is no leaf, rather than serving the file unchecked', async () => {
    const reply = await get('/app.js', { headers: { [EXPECT_LEAF_HEADER]: 'not-a-leaf' } })
    expect(reply.status).toBe(400)
    expect(reply.body.toString()).not.toContain('run()')
  })

  it('still gives a file that fails verification part-way the error page, not the declared-tree failure', async () => {
    const reply = await get('/bad.js', { headers: { [EXPECT_LEAF_HEADER]: await leafOfFile('/app.js') } })
    expect(reply.headers[FAILURE_HEADER]).toBe('unverifiable')
  })

  it('does not hold a file against the leaf of a path that does not exist', async () => {
    expect((await get('/missing.js', { headers: { [EXPECT_LEAF_HEADER]: await leafOfFile('/app.js') } })).status).toBe(404)
  })
})
