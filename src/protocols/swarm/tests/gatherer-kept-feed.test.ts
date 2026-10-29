import { describe, expect, it, vi } from 'vitest'
import { concat } from 'viem'
import { BlockCache } from '../../gateways/cache.js'
import type { BlockMemory } from '../../gateways/cache.js'
import type { MountedSite } from '../../resolution/providers.js'
import type { NameRecord } from '../../resolution/records.js'
import { NodeUnavailable } from '../../verifier-host/node-link.js'
import { feedUpdateAddress } from '../chunk.js'
import { createSwarmGatherer } from '../gatherer.js'
import type { SwarmGathererOptions } from '../gatherer.js'
import { referenceCid } from '../reference.js'
import { buildFeedManifest, buildSite, legacyUpdate, ownerOf, signFeedUpdate } from '../../../../test/apps/swarm-gateway/encode.mjs'
import type { FeedId, FeedIndexStore, KeptFeedUpdates, KeptUpdate } from '../feed.js'
import { A, B, TEST_KEY, TOPIC, fakeSwarm, text } from './swarm.test-helpers.js'

const PARTITION = 'https://one.example'
const OWNER = ownerOf(TEST_KEY)
const OTHER_KEY = `0x${'33'.repeat(32)}` as const
const FEED: FeedId = { owner: OWNER, topic: TOPIC }
const REFUSAL = new NodeUnavailable('Swarm content loads only from the Swarm node Orivon runs on this computer, and it is off: Swarm is switched off', 'Swarm is switched off')

function recordFor (reference: string): NameRecord {
  return { type: 'contenthash', pointer: { kind: 'swarm', cid: referenceCid(reference) }, provenance: { via: 'chain', block: 100, offchain: false } }
}

function memoryFeeds (initial: Record<string, bigint> = {}): FeedIndexStore & { saved: Map<string, bigint> } {
  const saved = new Map(Object.entries(initial))
  return {
    saved,
    highest: (owner, topic) => saved.get(`${owner}/${topic}`),
    record: (owner, topic, index) => { if ((saved.get(`${owner}/${topic}`) ?? -1n) < index) saved.set(`${owner}/${topic}`, index) }
  }
}

/** What the host's disk keeps for feed updates, in memory: one row for each partition and feed. */
function keptRows (): KeptFeedUpdates & { rows: Map<string, KeptUpdate>, forgotten: string[] } {
  const rows = new Map<string, KeptUpdate>()
  const forgotten: string[] = []
  const key = (partition: string, feed: FeedId): string => `${partition}\n${feed.owner}/${feed.topic}`
  return {
    rows,
    forgotten,
    recallUpdate: async (partition, feed) => rows.get(key(partition, feed)),
    rememberUpdate: (partition, feed, index, chunk) => { rows.set(key(partition, feed), { index, chunk }) },
    forgetUpdate: (partition, feed, index) => {
      forgotten.push(`${key(partition, feed)}@${String(index)}`)
      if (rows.get(key(partition, feed))?.index === index) rows.delete(key(partition, feed))
    }
  }
}

/** Memory whose disk holds `chunks`, the way the host's store does: nothing in the cache at first, everything behind it. */
function diskHolding (chunks: ReadonlyMap<string, Uint8Array>): BlockMemory {
  const cache = new BlockCache()
  return {
    remember: (partition, key, block) => { cache.remember(partition, key, block) },
    recall: (partition, key) => cache.recall(partition, key),
    recallKept: async (_partition, key) => chunks.get(key),
    share: (partition, key, start) => cache.share(partition, key, start)
  }
}

/** A feed of `updates` updates, update i naming a site whose page says `update i`. */
async function feedSite (updates: number) {
  const store = new Map<string, Uint8Array>()
  const feedRoot = buildFeedManifest({ owner: OWNER, topic: TOPIC }, store)
  const roots: string[] = []
  const socs: Array<{ address: string, chunk: Uint8Array }> = []
  for (let index = 0; index < updates; index++) {
    const root = buildSite({ 'index.html': `update ${String(index)}` }, store)
    roots.push(root)
    const signed = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index, wrapped: legacyUpdate(root, BigInt(index)) })
    store.set(signed.address, signed.chunk)
    socs.push({ address: signed.address, chunk: signed.chunk })
  }
  return { store, feedRoot, roots, socs }
}

interface Setup {
  readonly store: Map<string, Uint8Array>
  /** The chunks the disk holds; the whole store unless the test narrows it. */
  readonly onDisk?: ReadonlyMap<string, Uint8Array>
  readonly beforeMount?: SwarmGathererOptions['beforeMount']
  readonly feeds?: ReturnType<typeof memoryFeeds>
  readonly kept?: ReturnType<typeof keptRows>
  readonly options?: Partial<SwarmGathererOptions>
}

function gathererFor (setup: Setup) {
  const swarm = fakeSwarm(setup.store)
  const feeds = setup.feeds ?? memoryFeeds()
  const kept = setup.kept ?? keptRows()
  const lines: string[] = []
  const gatherer = createSwarmGatherer({
    fetch: swarm.fetch,
    endpoints: [A],
    feedIndexes: feeds,
    memory: diskHolding(setup.onDisk ?? setup.store),
    keptUpdates: kept,
    log: (line) => { lines.push(line) },
    ...(setup.beforeMount !== undefined && { beforeMount: setup.beforeMount }),
    ...setup.options
  })
  return { swarm, feeds, kept, lines, gatherer }
}

async function read (site: MountedSite, path: string): Promise<string> {
  const file = await site.open(path)
  const parts: Uint8Array[] = []
  for await (const part of file.body) parts.push(part)
  return text(concat(parts))
}

const never = async (): Promise<void> => { await new Promise<void>(() => {}) }

const asked = (requests: readonly string[], address: string): number => requests.filter((url) => url.endsWith(`/chunks/${address}`)).length

describe('a Swarm mount through a feed that it kept the last update of', () => {
  it('keeps the update a mount followed from the network, and nothing for a mount with no partition', async () => {
    const { store, feedRoot, socs } = await feedSite(3)
    const first = gathererFor({ store })
    await first.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect([...first.kept.rows.keys()]).toEqual([`${PARTITION}\n${OWNER}/${TOPIC}`])
    expect(first.kept.rows.get(`${PARTITION}\n${OWNER}/${TOPIC}`)).toEqual({ index: 2n, chunk: socs[2]!.chunk })

    const loose = gathererFor({ store })
    await loose.gatherer.mount('swarm.eth', [recordFor(feedRoot)])
    expect(loose.kept.rows.size).toBe(0)
  })

  it('opens a feed site it followed before with no node at all, sending no request', async () => {
    const { store, feedRoot, roots } = await feedSite(3)
    const kept = keptRows()
    await gathererFor({ store, kept }).gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)

    const asks: AbortSignal[] = []
    const again = gathererFor({ store, kept, beforeMount: async (signal) => { asks.push(signal); await never() } })
    const site = await again.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(await read(site, '/')).toBe('update 2')
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[2]!) })
    expect(site.pointers.map((pointer) => pointer.step)).toEqual(['contenthash', 'swarm-feed'])
    expect(site.pointers[1]).toEqual({ step: 'swarm-feed', owner: OWNER, topic: TOPIC, index: 2n, target: referenceCid(roots[2]!) })
    expect(asks).toHaveLength(1)
    expect(again.swarm.requests).toEqual([])
    expect(site.ddoc()).toEqual({ status: 'met', refusals: [] })
    expect(again.lines.find((line) => line.includes('a site mounted'))).toMatch(/did not wait for the node, 1 feeds followed, 1 from a kept update/)
  })

  it('does not use an update kept for another site, or for the same feed under another partition', async () => {
    const { store, feedRoot } = await feedSite(2)
    const kept = keptRows()
    await gathererFor({ store, kept }).gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    const other = gathererFor({ store, kept })
    await other.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, 'https://two.example')
    expect(asked(other.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 1n))).toBe(1)
  })

  it('refuses a kept update with a flipped byte, deletes it, and asks the network', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(2)
    const flipped = socs[1]!.chunk.slice()
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: flipped })
    const mounted = gathererFor({ store, kept })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(kept.forgotten).toEqual([`${PARTITION}\n${OWNER}/${TOPIC}@1`])
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[1]!) })
    expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 1n))).toBe(1)
    expect(kept.rows.get(`${PARTITION}\n${OWNER}/${TOPIC}`)?.chunk).toEqual(socs[1]!.chunk)
  })

  it('refuses a kept update signed by someone other than the feed owner', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(2)
    const stranger = await signFeedUpdate({ privateKey: OTHER_KEY, topic: TOPIC, index: 1, wrapped: legacyUpdate(roots[0]!, 1n) })
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: stranger.chunk })
    const mounted = gathererFor({ store, kept })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(kept.forgotten).toHaveLength(1)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[1]!) })
    expect(kept.rows.get(`${PARTITION}\n${OWNER}/${TOPIC}`)?.chunk).toEqual(socs[1]!.chunk)
  })

  it('refuses a kept update kept under another index than the one it was signed for', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(3)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 2n, chunk: socs[1]!.chunk })
    const site = await gathererFor({ store, kept }).gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(kept.forgotten).toHaveLength(1)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[2]!) })
  })

  it('does not use a kept update below the highest index seen, and asks the network', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(3)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: socs[1]!.chunk })
    const feeds = memoryFeeds({ [`${OWNER}/${TOPIC}`]: 2n })
    const mounted = gathererFor({ store, kept, feeds })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[2]!) })
    expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 2n))).toBe(1)
    expect(kept.forgotten).toEqual([])
    expect(kept.rows.get(`${PARTITION}\n${OWNER}/${TOPIC}`)?.index).toBe(2n)
  })

  it('does not use a kept update that another partition\'s look has been overtaken by while it was checked', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(3)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: socs[1]!.chunk })
    const feeds = memoryFeeds({ [`${OWNER}/${TOPIC}`]: 1n })
    const reads = vi.spyOn(feeds, 'highest')
    reads.mockImplementationOnce(() => 1n).mockImplementation(() => 2n)
    const mounted = gathererFor({ store, kept, feeds })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[2]!) })
    expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 2n))).toBe(1)
    expect(kept.forgotten).toEqual([])
  })

  it('uses a kept update at the highest index seen, and a higher one than the store has recorded raises the store', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(3)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 2n, chunk: socs[2]!.chunk })
    const feeds = memoryFeeds({ [`${OWNER}/${TOPIC}`]: 1n })
    const mounted = gathererFor({ store, kept, feeds, beforeMount: never })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[2]!) })
    expect(mounted.swarm.requests).toEqual([])
    expect(feeds.saved.get(`${OWNER}/${TOPIC}`)).toBe(2n)
  })

  it('keeps the old version for the mount in hand when a check finds a newer one, and opens the newer one from disk at the next mount', async () => {
    const { store, feedRoot, roots, socs } = await feedSite(2)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 0n, chunk: socs[0]!.chunk })
    const feeds = memoryFeeds({ [`${OWNER}/${TOPIC}`]: 0n })
    const mounted = gathererFor({ store, kept, feeds })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[0]!) })
    expect(site.hasNewer?.()).toBe(false)

    await vi.waitFor(() => { expect(site.hasNewer?.()).toBe(true) })
    expect(kept.rows.get(`${PARTITION}\n${OWNER}/${TOPIC}`)).toEqual({ index: 1n, chunk: socs[1]!.chunk })
    expect(feeds.saved.get(`${OWNER}/${TOPIC}`)).toBe(1n)
    expect(site.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[0]!) })
    expect(await read(site, '/')).toBe('update 0')
    expect(mounted.lines.filter((line) => line.includes('used from the next load'))).toHaveLength(1)
    expect(mounted.lines.join('\n')).not.toMatch(/[0-9a-f]{40}/)

    const later = gathererFor({ store, kept, feeds, beforeMount: never })
    const next = await later.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(await read(next, '/')).toBe('update 1')
    expect(next.root).toEqual({ kind: 'swarm', cid: referenceCid(roots[1]!) })
    expect(later.swarm.requests).toEqual([])
  })

  it('says nothing, and marks nothing newer, when the check finds the update it started from', async () => {
    const { store, feedRoot, socs } = await feedSite(2)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: socs[1]!.chunk })
    const mounted = gathererFor({ store, kept, feeds: memoryFeeds({ [`${OWNER}/${TOPIC}`]: 1n }) })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    await vi.waitFor(() => { expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 2n))).toBe(1) })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(site.hasNewer?.()).toBe(false)
    expect(mounted.lines.filter((line) => /newer|check/.test(line))).toEqual([])
  })

  it('runs one check at a time for a feed in a partition, whatever number of mounts used its kept update', async () => {
    const { store, feedRoot, socs } = await feedSite(2)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: socs[1]!.chunk })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const mounted = gathererFor({ store, kept, feeds: memoryFeeds({ [`${OWNER}/${TOPIC}`]: 1n }), beforeMount: async () => { await held } })
    const sites = await Promise.all([1, 2, 3].map(async () => await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)))
    expect(sites).toHaveLength(3)
    release()
    await vi.waitFor(() => { expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 2n))).toBeGreaterThan(0) })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 1n))).toBe(1)
    expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 2n))).toBe(1)
  })

  it('marks every mount that used the old update when the one check finds a newer one', async () => {
    const { store, feedRoot, socs } = await feedSite(2)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 0n, chunk: socs[0]!.chunk })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const mounted = gathererFor({ store, kept, feeds: memoryFeeds({ [`${OWNER}/${TOPIC}`]: 0n }), beforeMount: async () => { await held } })
    const sites = await Promise.all([1, 2].map(async () => await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)))
    release()
    await vi.waitFor(() => { expect(sites.map((site) => site.hasNewer?.())).toEqual([true, true]) })
  })

  it('does not fail, delay or leave a rejection behind when the node never comes: the check gives up with one line', async () => {
    const { store, feedRoot, socs } = await feedSite(2)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: socs[1]!.chunk })
    const mounted = gathererFor({ store, kept, feeds: memoryFeeds({ [`${OWNER}/${TOPIC}`]: 1n }), beforeMount: never, options: { limits: { feedCheckTimeoutMs: 30 } } })
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(await read(site, '/')).toBe('update 1')
    await vi.waitFor(() => { expect(mounted.lines.filter((line) => line.includes('newer version'))).toHaveLength(1) })
    expect(mounted.lines.find((line) => line.includes('newer version'))).toMatch(/failed \(timed out\)/)
    expect(site.hasNewer?.()).toBe(false)
    expect(mounted.swarm.requests).toEqual([])
    expect(kept.rows.get(`${PARTITION}\n${OWNER}/${TOPIC}`)?.index).toBe(1n)
  })

  it('gives the look as much longer as the route is slower, as a mount\'s own wait is', async () => {
    const { store, feedRoot, socs } = await feedSite(2)
    const slowRoute = { id: 'tunnel', scale: () => 20, wait: (ms: number) => ms * 20, firstWait: (ms: number) => ms * 20, stallMs: () => 1000, transferMs: () => 1000, observeFirstByte: () => {}, slow: () => true }
    const outcome = async (route: SwarmGathererOptions['route']) => {
      const kept = keptRows()
      kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 0n, chunk: socs[0]!.chunk })
      const mounted = gathererFor({
        store,
        kept,
        feeds: memoryFeeds({ [`${OWNER}/${TOPIC}`]: 0n }),
        beforeMount: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 80)) },
        options: { limits: { feedCheckTimeoutMs: 30 }, ...(route !== undefined && { route }) }
      })
      const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
      await vi.waitFor(() => { expect(mounted.lines.some((line) => line.includes('newer version'))).toBe(true) })
      return { line: mounted.lines.find((line) => line.includes('newer version')), newer: site.hasNewer?.() }
    }
    expect((await outcome(undefined)).line).toMatch(/failed \(timed out\)/)
    const slow = await outcome(slowRoute)
    expect(slow.line).toMatch(/was found/)
    expect(slow.newer).toBe(true)
  })

  it('does not fail the mount, and logs the reason alone, when the check finds the node without the feed', async () => {
    const { store, feedRoot, socs } = await feedSite(2)
    const kept = keptRows()
    kept.rows.set(`${PARTITION}\n${OWNER}/${TOPIC}`, { index: 1n, chunk: socs[1]!.chunk })
    const mounted = gathererFor({ store, kept, feeds: memoryFeeds({ [`${OWNER}/${TOPIC}`]: 1n }) })
    mounted.swarm.empty.add(A)
    const site = await mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    expect(await read(site, '/')).toBe('update 1')
    await vi.waitFor(() => { expect(mounted.lines.filter((line) => line.includes('newer version'))).toHaveLength(1) })
    const line = mounted.lines.find((entry) => entry.includes('newer version'))!
    expect(line).toMatch(/failed \(unavailable\)/)
    expect(line).not.toMatch(/[0-9a-f]{20}|example/)
    expect(site.hasNewer?.()).toBe(false)
  })

  it('does not open a kept site while Swarm is switched off', async () => {
    const { store, feedRoot } = await feedSite(2)
    const kept = keptRows()
    await gathererFor({ store, kept }).gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    const off = gathererFor({ store, kept, beforeMount: async () => { throw REFUSAL }, options: { holdMounts: true } })
    await expect(off.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)).rejects.toBe(REFUSAL)
    expect(off.swarm.requests).toEqual([])
  })

  it('waits for the node and asks the network when nothing is kept, as a first visit does', async () => {
    const { store, feedRoot, roots } = await feedSite(2)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const mounted = gathererFor({ store, beforeMount: async () => { await held } })
    const mounting = mounted.gatherer.mount('swarm.eth', [recordFor(feedRoot)], undefined, PARTITION)
    const settled = await Promise.race([mounting.then(() => 'done'), new Promise<string>((resolve) => setTimeout(() => { resolve('waiting') }, 30))])
    expect(settled).toBe('waiting')
    expect(mounted.swarm.requests).toEqual([])
    release()
    expect((await mounting).root).toEqual({ kind: 'swarm', cid: referenceCid(roots[1]!) })
    expect(asked(mounted.swarm.requests, feedUpdateAddress(OWNER, TOPIC, 1n))).toBeGreaterThan(0)
  })
})
