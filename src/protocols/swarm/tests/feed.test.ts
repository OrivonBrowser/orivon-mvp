import { describe, expect, it } from 'vitest'
import { GatewayPool } from '../../gateways/gateways.js'
import type { Fetch } from '../../gateways/gateways.js'
import type { Refusal } from '../../resolution/providers.js'
import type { ChunkDeps } from '../chunk-fetch.js'
import { feedOf, resolveFeed } from '../feed.js'
import type { FeedId, FeedIndexStore } from '../feed.js'
import { DEFAULT_LIMITS } from '../limits.js'
import { referenceCid } from '../reference.js'
import { cacAddress } from '../chunk.js'
import { buildFile, feedSocAddress, legacyUpdate, makeChunk, ownerOf, signFeedUpdate, spanBytes } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { A, B, TEST_KEY, TOPIC, bytes, fakeSwarm } from './swarm.test-helpers.js'
import { bytesToHex, concat } from 'viem'

const signal = new AbortController().signal
const OWNER = ownerOf(TEST_KEY)
const FEED: FeedId = { owner: OWNER, topic: TOPIC }

function memoryStore (initial: Record<string, bigint> = {}): FeedIndexStore & { saved: Map<string, bigint> } {
  const saved = new Map(Object.entries(initial))
  return {
    saved,
    highest: (owner, topic) => saved.get(`${owner}/${topic}`),
    record: (owner, topic, index) => {
      const current = saved.get(`${owner}/${topic}`)
      if (current === undefined || index > current) saved.set(`${owner}/${topic}`, index)
    }
  }
}

/** A feed with updates 0..last, update i naming the file `site i`. */
async function feedWith (last: number, chunks = new Map<string, Uint8Array>()) {
  const targets: string[] = []
  for (let index = 0; index <= last; index++) {
    const target = buildFile(bytes(`site ${String(index)}`), chunks).ref
    targets.push(target)
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index, wrapped: legacyUpdate(target, BigInt(index)) })
    chunks.set(update.address, update.chunk)
  }
  const swarm = fakeSwarm(chunks)
  const deps = (limits = DEFAULT_LIMITS): ChunkDeps => ({ fetch: swarm.fetch, pool: new GatewayPool([A, B], 6), limits })
  /** Distinct chunks asked for: a miss is asked of every endpoint, and is still one probe. */
  const probesMade = (): number => new Set(swarm.requests.filter((url) => url.includes('/chunks/')).map((url) => url.split('/').pop())).size
  return { chunks, swarm, targets, deps, probesMade }
}

const refusals: Refusal[] = []
const noteRefusal = (r: Refusal): void => { refusals.push(r) }

describe('resolveFeed, over /chunks alone', () => {
  for (const last of [0, 1, 2, 3, 6, 7, 13, 40, 64]) {
    it(`finds update ${String(last)} of a feed from a source that has no /feeds route`, async () => {
      const { deps, targets, swarm, probesMade } = await feedWith(last)
      const store = memoryStore()
      const resolved = await resolveFeed(FEED, deps(), store, signal, noteRefusal)
      expect(resolved.root).toBe(targets[last])
      expect(resolved.step).toEqual({ step: 'swarm-feed', owner: OWNER, topic: TOPIC, index: BigInt(last), target: referenceCid(targets[last]!) })
      expect(store.saved.get(`${OWNER}/${TOPIC}`)).toBe(BigInt(last))
      expect(probesMade()).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(last + 2)) + 2)
      expect(swarm.requests.some((url) => url.includes('/feeds/'))).toBe(true)
    })
  }

  it('reads a legacy update whose payload is padded with zeros to 4096 bytes', async () => {
    const chunks = new Map<string, Uint8Array>()
    const target = buildFile(bytes('padded'), chunks).ref
    const plain = legacyUpdate(target)
    const wrapped = concat([plain, new Uint8Array(4096 - (plain.length - 8))])
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped })
    chunks.set(update.address, update.chunk)
    const swarm = fakeSwarm(chunks)
    const deps: ChunkDeps = { fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }
    expect((await resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).root).toBe(target)
  })

  it('refuses a legacy update with a non-zero byte past its 40 bytes', async () => {
    const chunks = new Map<string, Uint8Array>()
    const plain = legacyUpdate(buildFile(bytes('dirty'), chunks).ref)
    const wrapped = concat([plain, new Uint8Array(4096 - (plain.length - 8))])
    wrapped[8 + 100] = 1
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped })
    chunks.set(update.address, update.chunk)
    const deps: ChunkDeps = { fetch: fakeSwarm(chunks).fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }
    await expect(resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure: 'unverifiable' })
  })

  it('starts at the highest index seen before, never below it', async () => {
    const { deps, targets, probesMade } = await feedWith(20)
    const store = memoryStore({ [`${OWNER}/${TOPIC}`]: 12n })
    expect((await resolveFeed(FEED, deps(), store, signal, noteRefusal)).root).toBe(targets[20])
    expect(probesMade()).toBeLessThanOrEqual(8)
  })

  it('does not serve an older update than the floor when the source holds only the older ones', async () => {
    const { deps, chunks } = await feedWith(5)
    const store = memoryStore({ [`${OWNER}/${TOPIC}`]: 9n })
    await expect(resolveFeed(FEED, deps(), store, signal, noteRefusal)).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringMatching(/update 9.*seen before/) })
    expect(chunks.size).toBeGreaterThan(0)
    expect(store.saved.get(`${OWNER}/${TOPIC}`)).toBe(9n)
  })

  it('is unavailable for a feed nobody has an update of', async () => {
    const swarm = fakeSwarm(new Map())
    const deps: ChunkDeps = { fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }
    await expect(resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('stops probing at the limit rather than walk forever', async () => {
    const { deps } = await feedWith(40)
    await expect(resolveFeed(FEED, deps({ ...DEFAULT_LIMITS, maxFeedProbes: 4 }), memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure: 'unverifiable', message: expect.stringMatching(/4 probes/) })
  })
})

describe('resolveFeed, with a /feeds answer as a first guess', () => {
  it('verifies the guess and probes only one index past it, beside the floor and the index after it', async () => {
    const { deps, targets, swarm, probesMade } = await feedWith(40)
    swarm.feedHints.set(A, (40).toString(16).padStart(16, '0'))
    const resolved = await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)
    expect(resolved.root).toBe(targets[40])
    expect(probesMade()).toBe(4)
  })

  it('keeps walking when the guess is behind', async () => {
    const { deps, targets, swarm } = await feedWith(40)
    swarm.feedHints.set(A, (30).toString(16).padStart(16, '0'))
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[40])
  })

  it('ignores a guess ahead of the feed, since it must be verified like any other index', async () => {
    const { deps, targets, swarm } = await feedWith(10)
    swarm.feedHints.set(A, (5000).toString(16).padStart(16, '0'))
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[10])
  })

  it('finds the newest update when the earliest ones are gone from the network', async () => {
    const { deps, targets, swarm, chunks } = await feedWith(20)
    chunks.delete(feedSocAddress(OWNER, TOPIC, 0n))
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[20])
    chunks.delete(feedSocAddress(OWNER, TOPIC, 1n))
    await expect(resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
    swarm.feedHints.set(A, (20).toString(16).padStart(16, '0'))
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[20])
  })

  it('searches below a guess that has no update rather than walking past it again', async () => {
    const { deps, targets, swarm, probesMade } = await feedWith(30)
    swarm.feedHints.set(A, (33).toString(16).padStart(16, '0'))
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[30])
    expect(probesMade()).toBeLessThanOrEqual(8)
  })

  it('ignores a guess that is not hex, and one below the floor', async () => {
    const { deps, targets, swarm } = await feedWith(10)
    swarm.feedHints.set(A, 'not hex')
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[10])
    swarm.feedHints.set(A, '0000000000000001')
    expect((await resolveFeed(FEED, deps(), memoryStore({ [`${OWNER}/${TOPIC}`]: 7n }), signal, noteRefusal)).root).toBe(targets[10])
  })
})

/** A fetch that answers as `inner` does, except that `hangs` says which requests never answer until they are abandoned. */
function hanging (inner: Fetch, hangs: (url: string) => boolean): Fetch {
  return async (url, init) => {
    if (!hangs(url)) return await inner(url, init)
    return await new Promise<Response>((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
  }
}

describe('resolveFeed, when an endpoint does not answer', () => {
  const fast = { ...DEFAULT_LIMITS, chunkTimeoutMs: 40, hedgeDelayMs: 10 }

  it('is unavailable, never an older update, when the probe past the newest one times out', async () => {
    const { chunks, targets } = await feedWith(4)
    const swarm = fakeSwarm(chunks)
    const atFour = feedSocAddress(OWNER, TOPIC, 4)
    const deps: ChunkDeps = { fetch: hanging(swarm.fetch, (url) => url.endsWith(atFour)), pool: new GatewayPool([A, B], 6), limits: fast }
    const store = memoryStore()
    await expect(resolveFeed(FEED, deps, store, signal, noteRefusal)).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringContaining('whether') })
    expect(store.saved.get(`${OWNER}/${TOPIC}`)).not.toBe(3n)
    expect(targets).toHaveLength(5)
  })

  it('is unavailable when one endpoint says 404 and the other times out', async () => {
    const { chunks } = await feedWith(4)
    const swarm = fakeSwarm(chunks)
    const atFour = feedSocAddress(OWNER, TOPIC, 4)
    const fetch = hanging(swarm.fetch, (url) => url.startsWith(B) && url.endsWith(atFour))
    const withFour: ChunkDeps = { fetch: async (url, init) => url.startsWith(A) && url.endsWith(atFour) ? new Response('not found', { status: 404 }) : await fetch(url, init), pool: new GatewayPool([A, B], 6), limits: fast }
    await expect(resolveFeed(FEED, withFour, memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('is unavailable, never an older update, when the probe past the newest one is answered with a 5xx', async () => {
    const { chunks } = await feedWith(4)
    const swarm = fakeSwarm(chunks)
    const atFour = feedSocAddress(OWNER, TOPIC, 4)
    const deps: ChunkDeps = { fetch: async (url, init) => url.endsWith(atFour) ? new Response('unwell', { status: 500 }) : await swarm.fetch(url, init), pool: new GatewayPool([A], 6), limits: fast }
    await expect(resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
  })
})

describe('the /feeds guess', () => {
  it('waits three seconds at most by default', () => {
    expect(DEFAULT_LIMITS.feedGuessTimeoutMs).toBe(3_000)
  })

  it('is not waited for when the index after the floor has no update', async () => {
    const { chunks, targets } = await feedWith(6)
    const swarm = fakeSwarm(chunks)
    const deps: ChunkDeps = { fetch: hanging(swarm.fetch, (url) => url.includes('/feeds/')), pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }
    const started = Date.now()
    expect((await resolveFeed(FEED, deps, memoryStore({ [`${OWNER}/${TOPIC}`]: 6n }), signal, noteRefusal)).root).toBe(targets[6])
    expect(Date.now() - started).toBeLessThan(DEFAULT_LIMITS.feedGuessTimeoutMs / 2)
  })

  it('does not delay the /chunks probes beyond its own timeout when /feeds hangs, and holds nothing against the endpoint', async () => {
    const { chunks, targets } = await feedWith(6)
    const swarm = fakeSwarm(chunks)
    const pool = new GatewayPool([A], 6)
    const deps: ChunkDeps = { fetch: hanging(swarm.fetch, (url) => url.includes('/feeds/')), pool, limits: { ...DEFAULT_LIMITS, feedGuessTimeoutMs: 60 } }
    const started = Date.now()
    expect((await resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).root).toBe(targets[6])
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(pool.candidates()).toEqual([A])
  })

  it('is not retried and does not cool the endpoint, whatever it answers', async () => {
    for (const status of [404, 501, 500, 503]) {
      const { chunks, targets } = await feedWith(3)
      const swarm = fakeSwarm(chunks)
      const asked: string[] = []
      const pool = new GatewayPool([A], 6)
      const deps: ChunkDeps = { fetch: async (url, init) => { if (!url.includes('/feeds/')) return await swarm.fetch(url, init); asked.push(url); return new Response('no', { status }) }, pool, limits: DEFAULT_LIMITS }
      expect((await resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).root).toBe(targets[3])
      expect(asked).toHaveLength(1)
      expect(pool.candidates()).toEqual([A])
    }
  })
})

describe('resolveFeed, against a source that lies', () => {
  it('refuses an update signed by someone else under the feed owner address, naming the source', async () => {
    const { chunks, deps } = await feedWith(2)
    const forged = await signFeedUpdate({ privateKey: `0x${'22'.repeat(32)}`, topic: TOPIC, index: 3, wrapped: legacyUpdate('ee'.repeat(32)) })
    const { feedSocAddress } = await import('../../../../test/apps/swarm-gateway/encode.mjs')
    chunks.set(feedSocAddress(OWNER, TOPIC, 3), forged.chunk)
    const seen: Refusal[] = []
    await expect(resolveFeed(FEED, deps(), memoryStore(), signal, (r) => seen.push(r))).rejects.toMatchObject({ failure: 'unverifiable', sourceFault: true })
    expect(seen.map((r) => r.source).sort()).toEqual([A, B])
  })

  it('takes the newest update from another source when one tampers with it', async () => {
    const { deps, targets, swarm, chunks } = await feedWith(4)
    const newest = [...chunks.keys()].find((address) => address === Object.keys(Object.fromEntries(chunks)).at(-1))!
    swarm.tamper(newest, [A])
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[4])
  })
})

describe('what an update carries', () => {
  it('reads the legacy payload as a timestamp and a reference', async () => {
    const { deps, targets } = await feedWith(0)
    expect((await resolveFeed(FEED, deps(), memoryStore(), signal, noteRefusal)).root).toBe(targets[0])
  })

  it('takes the wrapped chunk itself for the root when it is not a legacy payload', async () => {
    const chunks = new Map<string, Uint8Array>()
    const content = makeChunk(spanBytes(11), bytes('hello world'))
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped: content })
    chunks.set(update.address, update.chunk)
    const swarm = fakeSwarm(chunks)
    const deps: ChunkDeps = { fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }
    const resolved = await resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)
    expect(resolved.root).toBe(bytesToHex(cacAddress(content)).slice(2))
  })

  it('names an encrypted update as unsupported, and a malformed legacy one as unverifiable', async () => {
    for (const [wrapped, failure] of [
      [makeChunk(spanBytes(72), new Uint8Array(72)), 'unsupported'],
      [makeChunk(spanBytes(40), new Uint8Array(39)), 'unverifiable']
    ] as const) {
      const chunks = new Map<string, Uint8Array>()
      const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped })
      chunks.set(update.address, update.chunk)
      const swarm = fakeSwarm(chunks)
      const deps: ChunkDeps = { fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }
      await expect(resolveFeed(FEED, deps, memoryStore(), signal, noteRefusal)).rejects.toMatchObject({ failure })
    }
  })
})

describe('feedOf', () => {
  const metadata = { 'swarm-feed-owner': OWNER, 'swarm-feed-topic': TOPIC, 'swarm-feed-type': 'Sequence' }

  it('is nothing for a manifest that names no feed', () => {
    expect(feedOf(undefined)).toBeUndefined()
    expect(feedOf({ 'website-index-document': 'index.html' })).toBeUndefined()
  })

  it('reads the owner and topic, with or without 0x and in any case', () => {
    expect(feedOf(metadata)).toEqual(FEED)
    expect(feedOf({ ...metadata, 'swarm-feed-owner': `0x${OWNER.toUpperCase()}` })).toEqual(FEED)
  })

  it('names epoch feeds as unsupported, and refuses an owner or topic that is not hex', () => {
    expect(() => feedOf({ ...metadata, 'swarm-feed-type': 'Epoch' })).toThrow(expect.objectContaining({ failure: 'unsupported' }))
    expect(() => feedOf({ 'swarm-feed-owner': OWNER, 'swarm-feed-topic': TOPIC })).toThrow(expect.objectContaining({ failure: 'unsupported' }))
    expect(() => feedOf({ ...metadata, 'swarm-feed-owner': 'zz' })).toThrow(expect.objectContaining({ failure: 'unverifiable' }))
    expect(() => feedOf({ 'swarm-feed-owner': OWNER })).toThrow(expect.objectContaining({ failure: 'unverifiable' }))
  })
})
