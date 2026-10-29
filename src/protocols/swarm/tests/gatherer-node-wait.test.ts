import { describe, expect, it } from 'vitest'
import { concat } from 'viem'
import { BlockCache } from '../../gateways/cache.js'
import type { BlockMemory } from '../../gateways/cache.js'
import type { MountedSite } from '../../resolution/providers.js'
import type { NameRecord } from '../../resolution/records.js'
import { NodeUnavailable } from '../../verifier-host/node-link.js'
import { createSwarmGatherer } from '../gatherer.js'
import type { SwarmGathererOptions } from '../gatherer.js'
import { referenceCid } from '../reference.js'
import { buildFeedManifest, buildFile, buildSite, legacyUpdate, ownerOf, signFeedUpdate } from '../../../../test/apps/swarm-gateway/encode.mjs'
import type { FeedIndexStore } from '../feed.js'
import { A, B, TEST_KEY, TOPIC, fakeSwarm, text } from './swarm.test-helpers.js'

const PARTITION = 'https://one.example'
const SITE = { 'index.html': '<h1>home</h1>', 'style.css': 'body{}' }
const BIG = Uint8Array.from({ length: 4096 * 5 + 300 }, (_, i) => 97 + (i % 26))
const REFUSAL = new NodeUnavailable('Swarm content loads only from the Swarm node Orivon runs on this computer, and it is off: Swarm is switched off', 'Swarm is switched off')

function recordFor (reference: string): NameRecord {
  return { type: 'contenthash', pointer: { kind: 'swarm', cid: referenceCid(reference) }, provenance: { via: 'chain', block: 100, offchain: false } }
}

const noFeeds: FeedIndexStore = { highest: () => undefined, record: () => {} }

/** Memory that keeps `kept` the way the host's store does: the cache finds nothing at first, and `recallKept` is the store. */
function storeBehind (kept: ReadonlyMap<string, Uint8Array>): BlockMemory {
  const cache = new BlockCache()
  return {
    remember: (partition, key, block) => { cache.remember(partition, key, block) },
    recall: (partition, key) => cache.recall(partition, key),
    recallKept: async (_partition, key) => kept.get(key),
    share: (partition, key, start) => cache.share(partition, key, start)
  }
}

function deferred () {
  let resolve!: () => void
  const promise = new Promise<void>((resolveWith) => { resolve = resolveWith })
  return { promise, resolve }
}

/** What a promise has done after a short while: the mount is not stuck for ever, only waiting. */
async function outcome (promise: Promise<unknown>): Promise<'pending' | 'done' | 'failed'> {
  return await Promise.race([
    promise.then(() => 'done' as const, () => 'failed' as const),
    new Promise<'pending'>((resolve) => { setTimeout(() => { resolve('pending') }, 30) })
  ])
}

const sleep = async (ms: number): Promise<void> => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) }

/** A gatherer over `store` (what the endpoints hold) whose memory keeps `kept`. */
function harness (store: Map<string, Uint8Array>, kept: ReadonlyMap<string, Uint8Array>, beforeMount: SwarmGathererOptions['beforeMount'], options: Partial<SwarmGathererOptions> = {}) {
  const swarm = fakeSwarm(store)
  const gatherer = createSwarmGatherer({ fetch: swarm.fetch, endpoints: [A, B], feedIndexes: noFeeds, memory: storeBehind(kept), ...(beforeMount !== undefined && { beforeMount }), ...options })
  return { swarm, gatherer }
}

async function readBytes (site: MountedSite, path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const file = await site.open(path, undefined, signal)
  const parts: Uint8Array[] = []
  for await (const part of file.body) parts.push(part)
  return concat(parts)
}

const read = async (site: MountedSite, path: string): Promise<string> => text(await readBytes(site, path))

/** The address of the chunk holding exactly `content`. */
function addressOf (store: ReadonlyMap<string, Uint8Array>, content: string): string {
  return [...store.keys()].find((address) => text(store.get(address)!.subarray(8)) === content)!
}

describe('a Swarm mount and the node it reads from', () => {
  it('opens a site whose chunks are all kept while the node never answers, and asks no endpoint', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite({ ...SITE, 'big.bin': BIG }, store)
    const asked: AbortSignal[] = []
    const { gatherer, swarm } = harness(store, store, async (signal) => { asked.push(signal); await new Promise<void>(() => {}) })
    const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
    expect(await read(site, '/')).toBe('<h1>home</h1>')
    expect(await read(site, '/style.css')).toBe('body{}')
    expect(await readBytes(site, '/big.bin')).toEqual(BIG)
    expect(asked).toHaveLength(1)
    expect(swarm.requests).toEqual([])
  })

  it('waits for the node where a chunk is not kept, and then fetches only that chunk', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite(SITE, store)
    const style = addressOf(store, 'body{}')
    const kept = new Map(store)
    kept.delete(style)
    const node = deferred()
    const { gatherer, swarm } = harness(store, kept, async () => { await node.promise })
    const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
    expect(await read(site, '/')).toBe('<h1>home</h1>')
    const reading = read(site, '/style.css')
    expect(await outcome(reading)).toBe('pending')
    expect(swarm.requests).toEqual([])
    node.resolve()
    expect(await reading).toBe('body{}')
    expect(swarm.requests).toEqual([`${A}/chunks/${style}`])
  })

  it('waits for the node before the first request of a mount that kept nothing', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite(SITE, store)
    const node = deferred()
    const { gatherer, swarm } = harness(store, new Map(), async () => { await node.promise })
    const mounting = gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
    expect(await outcome(mounting)).toBe('pending')
    expect(swarm.requests).toEqual([])
    node.resolve()
    expect(await read(await mounting, '/style.css')).toBe('body{}')
  })

  it('does not count the wait against a request: a wait longer than the timeout still fetches', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite({ ...SITE, 'big.bin': BIG }, store)
    const whole = new Map<string, Uint8Array>()
    buildFile(BIG, whole)
    const kept = new Map(store)
    for (const address of whole.keys()) kept.delete(address)
    const { gatherer, swarm } = harness(store, kept, async () => { await sleep(150) }, { limits: { chunkTimeoutMs: 40 } })
    const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
    expect(swarm.requests).toEqual([])
    expect(await readBytes(site, '/big.bin')).toEqual(BIG)
    expect(swarm.requests.some((url) => url.includes('/bytes/'))).toBe(true)

    const nothing = harness(store, new Map(), async () => { await sleep(150) }, { limits: { chunkTimeoutMs: 40 } })
    expect(await read(await nothing.gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION), '/style.css')).toBe('body{}')
  })

  it('lets a read stop waiting for the node without ending the wait the others share', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite(SITE, store)
    const kept = new Map(store)
    kept.delete(addressOf(store, 'body{}'))
    const node = deferred()
    const { gatherer } = harness(store, kept, async () => { await node.promise })
    const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
    const leaving = new AbortController()
    const gone = readBytes(site, '/style.css', leaving.signal)
    const staying = read(site, '/style.css')
    leaving.abort(new Error('the page was closed'))
    await expect(gone).rejects.toThrow('the page was closed')
    node.resolve()
    expect(await staying).toBe('body{}')
  })

  describe('through a feed', () => {
    it('waits for the node before it looks up the feed, though every chunk of the site is kept', async () => {
      const store = new Map<string, Uint8Array>()
      const owner = ownerOf(TEST_KEY)
      const feedRoot = buildFeedManifest({ owner, topic: TOPIC }, store)
      const updates = new Set<string>()
      let newest = ''
      for (let index = 0; index < 2; index++) {
        newest = buildSite({ 'index.html': `update ${String(index)}` }, store)
        const signed = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index, wrapped: legacyUpdate(newest, BigInt(index)) })
        store.set(signed.address, signed.chunk)
        updates.add(signed.address)
      }
      const kept = new Map(store)
      for (const address of updates) kept.delete(address)
      const node = deferred()
      const { gatherer, swarm } = harness(store, kept, async () => { await node.promise })
      const mounting = gatherer.mount('site.eth', [recordFor(feedRoot)], undefined, PARTITION)
      expect(await outcome(mounting)).toBe('pending')
      expect(swarm.requests).toEqual([])
      node.resolve()
      const site = await mounting
      expect(site.pointers.map((pointer) => pointer.step)).toEqual(['contenthash', 'swarm-feed'])
      expect(await read(site, '/')).toBe('update 1')
    })
  })

  describe('when the node will not serve', () => {
    it('fails a mount that needs the network with the node\'s own words, and asks no endpoint', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store, new Map(), async () => { throw REFUSAL })
      await expect(gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)).rejects.toMatchObject({ failure: 'unavailable', message: REFUSAL.message })
      expect(swarm.requests).toEqual([])
    })

    it('fails a read of a file it does not hold with the node\'s own words, and serves the files it does', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite({ ...SITE, 'big.bin': BIG }, store)
      const kept = new Map(store)
      kept.delete(addressOf(store, 'body{}'))
      const { gatherer, swarm } = harness(store, kept, async () => { throw REFUSAL })
      const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
      expect(await read(site, '/')).toBe('<h1>home</h1>')
      await expect(read(site, '/style.css')).rejects.toMatchObject({ failure: 'unavailable', message: REFUSAL.message })
      expect(swarm.requests).toEqual([])
    })

    it('opens a site served entirely from what is kept, and leaves no rejection unhandled', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite({ ...SITE, 'big.bin': BIG }, store)
      const unhandled: unknown[] = []
      const listen = (reason: unknown): void => { unhandled.push(reason) }
      process.on('unhandledRejection', listen)
      try {
        const { gatherer, swarm } = harness(store, store, async () => { throw REFUSAL })
        const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
        expect(await read(site, '/')).toBe('<h1>home</h1>')
        expect(await readBytes(site, '/big.bin')).toEqual(BIG)
        await sleep(30)
        expect(swarm.requests).toEqual([])
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', listen)
      }
    })

    it('asks the node again for a file read after it refused, since its answer was to the earlier ask', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const kept = new Map(store)
      kept.delete(addressOf(store, 'body{}'))
      let asks = 0
      const { gatherer } = harness(store, kept, async () => { asks++; if (asks === 1) throw REFUSAL })
      const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
      expect(await read(site, '/')).toBe('<h1>home</h1>')
      expect(await read(site, '/style.css')).toBe('body{}')
      expect(asks).toBe(2)
    })

    it('holds every mount for the node when the person has switched Swarm off, kept chunks or not', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const { gatherer, swarm } = harness(store, store, async () => { throw REFUSAL }, { holdMounts: true })
      await expect(gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)).rejects.toMatchObject({ failure: 'unavailable', message: REFUSAL.message })

      const node = deferred()
      const held = harness(store, store, async () => { await node.promise }, { holdMounts: true })
      const mounting = held.gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
      expect(await outcome(mounting)).toBe('pending')
      node.resolve()
      expect(await read(await mounting, '/')).toBe('<h1>home</h1>')
      expect(swarm.requests).toEqual([])
      expect(held.swarm.requests).toEqual([])
    })
  })

  describe('what the mount reports', () => {
    it('says it did not wait for the node when all it needed was kept, and how long it waited when it did', async () => {
      const store = new Map<string, Uint8Array>()
      const root = buildSite(SITE, store)
      const lines: string[] = []
      const log = (line: string): void => { lines.push(line) }
      await harness(store, store, async () => { await new Promise<void>(() => {}) }, { log }).gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/a site mounted in \d+ ms \(did not wait for the node, 0 feeds followed/)

      lines.length = 0
      const { gatherer } = harness(store, new Map(), async () => { await sleep(40) }, { log })
      await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
      expect(lines[0]).toMatch(/a site mounted in \d+ ms \(waited [1-9]\d* ms for the node, 0 feeds followed/)
      for (const line of lines) {
        expect(line).not.toContain(root)
        expect(line).not.toContain('site.eth')
        expect(line).not.toContain(PARTITION)
      }
    })
  })
})

describe('the Swarm gatherer without a node to start', () => {
  it('mounts and reads as before when no beforeMount is given', async () => {
    const store = new Map<string, Uint8Array>()
    const root = buildSite(SITE, store)
    const { gatherer, swarm } = harness(store, new Map(), undefined)
    const site = await gatherer.mount('site.eth', [recordFor(root)], undefined, PARTITION)
    expect(await read(site, '/style.css')).toBe('body{}')
    expect(swarm.requests.length).toBeGreaterThan(0)
  })
})
