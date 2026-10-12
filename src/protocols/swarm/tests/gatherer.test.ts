import { describe, expect, it } from 'vitest'
import { concat } from 'viem'
import type { MountedSite } from '../../resolution/providers.js'
import type { NameRecord } from '../../resolution/records.js'
import { createSwarmGatherer } from '../gatherer.js'
import type { SwarmGathererOptions } from '../gatherer.js'
import { referenceCid } from '../reference.js'
import { buildFeedManifest, buildFile, buildSite, legacyUpdate, ownerOf, signFeedUpdate } from '../../../../test/apps/swarm-gateway/encode.mjs'
import type { FeedIndexStore } from '../feed.js'
import { A, B, TEST_KEY, TOPIC, bytes, fakeSwarm, text } from './swarm.test-helpers.js'

const OWNER = ownerOf(TEST_KEY)

function recordFor (reference: string): NameRecord {
  return { type: 'contenthash', pointer: { kind: 'swarm', cid: referenceCid(reference) }, provenance: { via: 'chain', block: 100, offchain: false } }
}

function memoryFeeds (): FeedIndexStore & { saved: Map<string, bigint> } {
  const saved = new Map<string, bigint>()
  return {
    saved,
    highest: (owner, topic) => saved.get(`${owner}/${topic}`),
    record: (owner, topic, index) => { if ((saved.get(`${owner}/${topic}`) ?? -1n) < index) saved.set(`${owner}/${topic}`, index) }
  }
}

function harness (store = new Map<string, Uint8Array>(), options: Partial<SwarmGathererOptions> = {}) {
  const swarm = fakeSwarm(store)
  const feeds = memoryFeeds()
  const gatherer = createSwarmGatherer({ fetch: swarm.fetch, endpoints: [A, B], feedIndexes: feeds, ...options })
  return { store, swarm, feeds, gatherer }
}

async function read (site: MountedSite, path: string, range?: { start: number, end: number }): Promise<string> {
  const file = await site.open(path, range)
  const parts: Uint8Array[] = []
  for await (const part of file.body) parts.push(part)
  return text(concat(parts))
}

const SITE = {
  'index.html': '<h1>home</h1>',
  'style.css': 'body{}',
  'docs/index.html': '<h1>docs</h1>',
  'docs/guide.html': '<h1>guide</h1>',
  README: 'plain words',
  'data.bin': 'binary-ish'
}

describe('the Swarm gatherer', () => {
  it('supports records naming Swarm content, and nothing else', () => {
    const { gatherer } = harness()
    expect(gatherer.supports([recordFor('aa'.repeat(32))])).toBe(true)
    expect(gatherer.supports([{ type: 'contenthash', pointer: { kind: 'ipfs', cid: 'bafy' }, provenance: { via: 'fixture' } }])).toBe(false)
    expect(gatherer.supports([{ type: 'contenthash', pointer: { kind: 'unsupported', protocol: 'arweave' }, provenance: { via: 'fixture' } }])).toBe(false)
  })

  it('throws unavailable in plain words, and asks nobody, when no endpoint is configured', async () => {
    const { gatherer, swarm } = harness(new Map(), { endpoints: [] })
    await expect(gatherer.mount('site.eth', [recordFor('aa'.repeat(32))])).rejects.toMatchObject({
      failure: 'unavailable',
      message: expect.stringContaining('no Swarm node to load from') as unknown
    })
    expect(swarm.requests).toEqual([])
  })

  it('mounts a reference, serves its files, and meets DDOC', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite(SITE, store)
    const { gatherer } = harness(store)
    const site = await gatherer.mount('site.eth', [recordFor(root)])
    expect(site.gatherer).toBe('swarm')
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(root) })
    expect(site.pointers).toHaveLength(1)
    expect(await read(site, '/style.css')).toBe('body{}')
    expect(site.ddoc()).toEqual({ status: 'met', refusals: [] })
  })

  describe('which file a path names', () => {
    it('serves the index document for / and for a path ending in /', async () => {
      const store = new Map<string, Uint8Array>()
      const { gatherer } = harness(store)
      const site = await gatherer.mount('x', [recordFor(buildSite(SITE, store))])
      expect((await site.open('/')).servedPath).toBe('/index.html')
      expect((await site.open('/docs/')).servedPath).toBe('/docs/index.html')
      expect(await read(site, '/docs/')).toBe('<h1>docs</h1>')
    })

    it('serves a directory index for a path with no trailing slash that names no file', async () => {
      const store = new Map<string, Uint8Array>()
      const { gatherer } = harness(store)
      const site = await gatherer.mount('x', [recordFor(buildSite(SITE, store))])
      expect((await site.open('/docs')).servedPath).toBe('/docs/index.html')
    })

    it('uses the index document the site names', async () => {
      const store = new Map<string, Uint8Array>()
      const { gatherer } = harness(store)
      const site = await gatherer.mount('x', [recordFor(buildSite({ 'home.html': 'home page', 'x/home.html': 'sub' }, store, { indexDocument: 'home.html' }))])
      expect(await read(site, '/')).toBe('home page')
      expect(await read(site, '/x/')).toBe('sub')
    })

    it('is not-found for a path that is not there, a directory with no index, and a path that could leave the site', async () => {
      const store = new Map<string, Uint8Array>()
      const { gatherer } = harness(store)
      const site = await gatherer.mount('x', [recordFor(buildSite({ ...SITE, 'bare/file.txt': 'x' }, store))])
      for (const path of ['/missing', '/docs/missing.html', '/bare/', '/bare', '/a/../index.html', '/%2e%2e/x', '/a%2Fb', 'index.html']) {
        await expect(site.open(path), path).rejects.toMatchObject({ failure: 'not-found' })
      }
      expect(site.ddoc().status).toBe('met')
    })

    it('is not-found for / when the site has no file of the index document name', async () => {
      const store = new Map<string, Uint8Array>()
      const { gatherer } = harness(store)
      const site = await gatherer.mount('x', [recordFor(buildSite({ 'a.txt': 'a' }, store))])
      await expect(site.open('/')).rejects.toMatchObject({ failure: 'not-found' })
      expect(await read(site, '/a.txt')).toBe('a')
    })
  })

  describe('the type a file is served as', () => {
    const typed = { README: 'text/plain; charset=utf-8', LICENSE: 'text/plain\r\nx-evil: 1', 'notes': 'text/markdown', 'page.html': 'text/plain', 'path/noext': 'not a type' }

    async function mountTyped () {
      const store = new Map<string, Uint8Array>()
      const files = { 'index.html': '<p>i</p>', README: 'r', LICENSE: 'l', notes: 'n', 'page.html': 'p', 'path/noext': 'q' }
      const { gatherer } = harness(store)
      return await gatherer.mount('x', [recordFor(buildSite(files, store, { contentTypes: typed }))])
    }

    it('takes the declared type for a file whose name has no extension', async () => {
      const site = await mountTyped()
      expect((await site.open('/README')).contentType).toBe('text/plain; charset=utf-8')
      expect((await site.open('/notes')).contentType).toBe('text/markdown')
    })

    it('ignores a declared type for a name with an extension, and one that is not a plain media type', async () => {
      const site = await mountTyped()
      expect((await site.open('/page.html')).contentType).toBeUndefined()
      expect((await site.open('/LICENSE')).contentType).toBeUndefined()
      expect((await site.open('/path/noext')).contentType).toBeUndefined()
    })
  })

  it('serves a range of a multi-chunk file, and says the size of the whole', async () => {
    const store = new Map<string, Uint8Array>()
    const big = Uint8Array.from({ length: 4096 * 5 + 300 }, (_, i) => 97 + (i % 26))
    const { gatherer } = harness(store)
    const site = await gatherer.mount('x', [recordFor(buildSite({ 'index.html': 'i', 'big.txt': big }, store))])
    const file = await site.open('/big.txt', { start: 4090, end: 8200 })
    expect(file.size).toBe(big.length)
    const parts: Uint8Array[] = []
    for await (const part of file.body) parts.push(part)
    expect(concat(parts)).toEqual(big.subarray(4090, 8201))
  })

  it('serves an erasure-coded file and an erasure-coded manifest', async () => {
    const store = new Map<string, Uint8Array>()
    const big = Uint8Array.from({ length: 4096 * 12 + 1 }, (_, i) => 65 + (i % 20))
    const { gatherer } = harness(store)
    const site = await gatherer.mount('x', [recordFor(buildSite({ 'index.html': 'i', 'big.txt': big }, store, { level: 1 }))])
    expect(await read(site, '/big.txt')).toBe(text(big))
  })

  describe('against endpoints that cannot be trusted', () => {
    it('serves the file from another endpoint when one sends a tampered chunk, and reports the refusal', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store)
      const style = [...store.keys()].find((address) => text(store.get(address)!.subarray(8)) === 'body{}')!
      swarm.tamper(style, [A])
      const site = await gatherer.mount('x', [recordFor(root)])
      expect(await read(site, '/style.css')).toBe('body{}')
      expect(site.ddoc()).toEqual({ status: 'met', refusals: [{ source: A, resource: style }] })
    })

    it('fails DDOC naming the path when no endpoint can serve verified bytes', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store)
      const style = [...store.keys()].find((address) => text(store.get(address)!.subarray(8)) === 'body{}')!
      swarm.tamper(style)
      const site = await gatherer.mount('x', [recordFor(root)])
      await expect(read(site, '/style.css')).rejects.toMatchObject({ failure: 'unverifiable', sourceFault: true })
      expect(site.ddoc()).toMatchObject({ status: 'failed', resource: '/style.css' })
    })

    it('does not fail DDOC when nobody answers, or a path is missing', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store)
      const site = await gatherer.mount('x', [recordFor(root)])
      swarm.empty.add(A).add(B)
      await expect(site.open('/style.css')).rejects.toMatchObject({ failure: 'unavailable' })
      expect(site.ddoc().status).toBe('met')
    })

    it('refuses a root that is not a manifest, naming what it is not', async () => {
      const store = new Map<string, Uint8Array>()
      const plain = buildFile(bytes('just a file, no manifest in it, long enough to be read as a header'.repeat(3)), store).ref
      await expect(harness(store).gatherer.mount('x', [recordFor(plain)])).rejects.toMatchObject({ failure: 'unsupported' })
    })
  })

  describe('through a feed', () => {
    async function feedSite (updates: number) {
      const store = new Map<string, Uint8Array>()
      const feedRoot = buildFeedManifest({ owner: OWNER, topic: TOPIC }, store)
      const roots: string[] = []
      for (let index = 0; index < updates; index++) {
        const root = buildSite({ 'index.html': `update ${String(index)}` }, store)
        roots.push(root)
        const signed = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index, wrapped: legacyUpdate(root, BigInt(index)) })
        store.set(signed.address, signed.chunk)
      }
      return { store, feedRoot, roots }
    }

    it('mounts what the newest update names, recording the signed hop and the floor', async () => {
      const { store, feedRoot, roots } = await feedSite(3)
      const { gatherer, feeds } = harness(store)
      const site = await gatherer.mount('swarm.eth', [recordFor(feedRoot)])
      expect(await read(site, '/')).toBe('update 2')
      expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[2]!) })
      expect(site.pointers.map((p) => p.step)).toEqual(['contenthash', 'swarm-feed'])
      expect(site.pointers[1]).toEqual({ step: 'swarm-feed', owner: OWNER, topic: TOPIC, index: 2n, target: referenceCid(roots[2]!) })
      expect(feeds.saved.get(`${OWNER}/${TOPIC}`)).toBe(2n)
    })

    it('shows a newer update on the next mount, and never an older one after it', async () => {
      const { store, feedRoot, roots } = await feedSite(2)
      const { gatherer, feeds } = harness(store)
      expect((await gatherer.mount('x', [recordFor(feedRoot)])).root.cid).toBe(referenceCid(roots[1]!))
      const root = buildSite({ 'index.html': 'update 2' }, store)
      const signed = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 2, wrapped: legacyUpdate(root) })
      store.set(signed.address, signed.chunk)
      expect((await gatherer.mount('x', [recordFor(feedRoot)])).root.cid).toBe(referenceCid(root))
      store.delete(signed.address)
      await expect(gatherer.mount('x', [recordFor(feedRoot)])).rejects.toMatchObject({ failure: 'unavailable' })
      expect(feeds.saved.get(`${OWNER}/${TOPIC}`)).toBe(2n)
    })

    it('stops a feed that points at a feed that points back', async () => {
      const store = new Map<string, Uint8Array>()
      const feedRoot = buildFeedManifest({ owner: OWNER, topic: TOPIC }, store)
      const signed = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped: legacyUpdate(feedRoot) })
      store.set(signed.address, signed.chunk)
      await expect(harness(store).gatherer.mount('x', [recordFor(feedRoot)])).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/feeds between/) })
    })

    it('names an epoch feed as unsupported', async () => {
      const store = new Map<string, Uint8Array>()
      const feedRoot = buildFeedManifest({ owner: OWNER, topic: TOPIC, type: 'Epoch' }, store)
      await expect(harness(store).gatherer.mount('x', [recordFor(feedRoot)])).rejects.toMatchObject({ failure: 'unsupported' })
    })
  })

  describe('caching', () => {
    it('keeps nothing between mounts that have no partition', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store)
      await read(await gatherer.mount('x', [recordFor(root)]), '/style.css')
      const first = swarm.requests.length
      await read(await gatherer.mount('x', [recordFor(root)]), '/style.css')
      expect(swarm.requests.length).toBe(2 * first)
    })

    it('keeps chunks per partition', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store)
      await read(await gatherer.mount('x', [recordFor(root)], undefined, 'https://one.example'), '/style.css')
      const first = swarm.requests.length
      await read(await gatherer.mount('x', [recordFor(root)], undefined, 'https://one.example'), '/style.css')
      expect(swarm.requests.length).toBe(first)
      await read(await gatherer.mount('x', [recordFor(root)], undefined, 'https://two.example'), '/style.css')
      expect(swarm.requests.length).toBe(2 * first)
    })
  })
})
