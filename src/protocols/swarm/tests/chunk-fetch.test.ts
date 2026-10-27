import { describe, expect, it } from 'vitest'
import { BlockCache } from '../../gateways/cache.js'
import { GatewayPool } from '../../gateways/gateways.js'
import type { Fetch } from '../../gateways/gateways.js'
import { allowlisted } from '../../verifier-host/egress.js'
import type { Refusal } from '../../resolution/providers.js'
import { bytesToHex } from 'viem'
import { ChunkSource, QUARANTINE_MS, fetchVerifiedSoc, lookUpSoc } from '../chunk-fetch.js'
import type { ChunkDeps, SubtreeLeaf } from '../chunk-fetch.js'
import { DEFAULT_LIMITS } from '../limits.js'
import { buildFile, legacyUpdate, makeChunk, signFeedUpdate, spanBytes } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { A, B, TEST_KEY, TOPIC, bytes, fakeSwarm, asWebFetch } from './swarm.test-helpers.js'

const signal = new AbortController().signal

function setup (endpoints: readonly string[] = [A, B]) {
  const store = new Map<string, Uint8Array>()
  const one = buildFile(bytes('first'), store).ref
  const two = buildFile(bytes('second'), store).ref
  const swarm = fakeSwarm(store)
  const deps: ChunkDeps = { fetch: swarm.fetch, pool: new GatewayPool(endpoints, 6), limits: DEFAULT_LIMITS }
  const refusals: Refusal[] = []
  return { store, one, two, swarm, deps, refusals, onRefusal: (r: Refusal) => { refusals.push(r) } }
}

describe('ChunkSource.get', () => {
  it('returns a chunk once its address has been recomputed from the bytes', async () => {
    const { deps, one, store } = setup()
    expect(await new ChunkSource(deps).get(one, signal, () => {})).toEqual(store.get(one))
  })

  it('refuses a malformed address before asking anyone', async () => {
    const { deps, swarm } = setup()
    await expect(new ChunkSource(deps).get('not-an-address', signal, () => {})).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(swarm.requests).toEqual([])
  })

  it('takes the chunk from the next endpoint when the first sends bytes that fail the address, and does not ask the liar again', async () => {
    const { deps, store, one, two, swarm, refusals, onRefusal } = setup()
    swarm.tamper(one, [A])
    const source = new ChunkSource(deps)
    expect(await source.get(one, signal, onRefusal)).toEqual(store.get(one))
    expect(refusals).toEqual([{ source: A, resource: one }])
    swarm.requests.length = 0
    await source.get(two, signal, () => {})
    expect(swarm.requests.every((url) => url.startsWith(B))).toBe(true)
  })

  it('is unverifiable, from a faulty source, when every endpoint sends a forgery', async () => {
    const { deps, one, swarm, onRefusal, refusals } = setup()
    swarm.tamper(one)
    await expect(new ChunkSource(deps).get(one, signal, onRefusal)).rejects.toMatchObject({ failure: 'unverifiable', sourceFault: true })
    expect(refusals.map((r) => r.source).sort()).toEqual([A, B])
  })

  it('is unavailable when no endpoint has the chunk', async () => {
    const { deps, one, swarm } = setup()
    swarm.empty.add(A).add(B)
    await expect(new ChunkSource(deps).get(one, signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('refuses a body longer than a chunk can be', async () => {
    const { deps, store } = setup()
    const huge = makeChunk(spanBytes(100), new Uint8Array(5000))
    store.set('ab'.repeat(32), huge)
    await expect(new ChunkSource(deps).get('ab'.repeat(32), signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('keeps a chunk per partition and asks again for another partition', async () => {
    const { deps, one, swarm } = setup()
    const memory = new BlockCache()
    await new ChunkSource(deps, memory, 'https://one.example').get(one, signal, () => {})
    await new ChunkSource(deps, memory, 'https://one.example').get(one, signal, () => {})
    expect(swarm.requests).toHaveLength(1)
    await new ChunkSource(deps, memory, 'https://two.example').get(one, signal, () => {})
    expect(swarm.requests).toHaveLength(2)
  })

  it('shares one request between callers asking for the same chunk at once', async () => {
    const { deps, one, swarm } = setup()
    const source = new ChunkSource(deps, new BlockCache(), 'https://one.example')
    await Promise.all([source.get(one, signal, () => {}), source.get(one, signal, () => {})])
    expect(swarm.requests).toHaveLength(1)
  })
})

/** A file of `count` leaves, the last `tail` bytes long, under one intermediate chunk: the store, that chunk, and its leaves. */
function subtree (count: number, tail = 4096) {
  const store = new Map<string, Uint8Array>()
  const content = Uint8Array.from({ length: (count - 1) * 4096 + tail }, (_, i) => (i * 7 + (i >> 12)) & 255)
  const parent = buildFile(content, store).ref
  const refs = store.get(parent)!.subarray(8)
  const leaves: SubtreeLeaf[] = Array.from({ length: count }, (_, i) => ({ address: bytesToHex(refs.subarray(i * 32, (i + 1) * 32)).slice(2), size: i < count - 1 ? 4096 : tail, offset: i * 4096 }))
  const swarm = fakeSwarm(store)
  const pool = new GatewayPool([A], 6)
  const logged: string[] = []
  return { store, parent, leaves, swarm, pool, logged, source: new ChunkSource({ fetch: swarm.fetch, pool, limits: DEFAULT_LIMITS, log: (line) => { logged.push(line) } }, new BlockCache(), 'https://one.example') }
}

describe('ChunkSource.leaves', () => {
  it('takes a subtree\'s leaves in one /bytes request, each the chunk its parent lists', async () => {
    const { store, parent, leaves, swarm, source, logged } = subtree(10, 100)
    const chunks = await Promise.all(source.leaves(parent, leaves, signal, () => {}))
    expect(chunks).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
    expect(logged).toEqual([])
  })

  it('asks for only the leaves it was given, and uses only those from a source that sends the whole subtree', async () => {
    for (const route of ['ranges', 'whole'] as const) {
      const { store, parent, leaves, swarm, source } = subtree(10)
      swarm.bytesRoute = route
      const some = leaves.slice(3, 7)
      expect(await Promise.all(source.leaves(parent, some, signal, () => {}))).toEqual(some.map((leaf) => store.get(leaf.address)))
      expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
    }
  })

  it('asks nothing for leaves it keeps, and only from the first leaf it does not', async () => {
    const { store, parent, leaves, swarm, source } = subtree(6)
    await Promise.all([source.get(leaves[0]!.address, signal, () => {}), source.get(leaves[1]!.address, signal, () => {})])
    swarm.requests.length = 0
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
    swarm.requests.length = 0
    await Promise.all(source.leaves(parent, leaves, signal, () => {}))
    expect(swarm.requests).toEqual([])
  })

  it('never uses a leaf the answer holds wrong: it and every leaf after it are fetched alone and checked', async () => {
    const { store, parent, leaves, swarm, source, pool, logged } = subtree(5)
    swarm.tamperedBytes.add(parent)
    const refusals: Refusal[] = []
    expect(await Promise.all(source.leaves(parent, leaves, signal, (r) => { refusals.push(r) }))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`, ...leaves.slice(1).map((leaf) => `${A}/chunks/${leaf.address}`)])
    expect(refusals).toEqual([])
    expect(pool.candidates()).toEqual([A])
    expect(logged).toEqual(['swarm: a bulk read gave 1 of 5 leaves (a leaf that failed its address); the rest are read one by one'])
  })

  it('fetches every leaf alone from a source without the route, and does not cool it for that', async () => {
    const { store, parent, leaves, swarm, source, pool, logged } = subtree(4)
    swarm.bytesRoute = 'none'
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`, ...leaves.map((leaf) => `${A}/chunks/${leaf.address}`)])
    expect(pool.candidates()).toEqual([A])
    expect(logged).toEqual([`swarm: a bulk read gave 0 of 4 leaves (${A} answered 404); the rest are read one by one`])
  })

  it('fetches alone the leaves past where a source\'s answer ended', async () => {
    const { store, parent, leaves, swarm } = subtree(5)
    const cut: Fetch = async (url, init) => {
      const response = await swarm.fetch(url, init)
      return url.includes('/bytes/') ? new Response((await response.arrayBuffer()).slice(0, 2 * 4096 + 10), { status: 206, headers: { 'content-range': `bytes 0-${String(5 * 4096 - 1)}/${String(5 * 4096)}` } }) : response
    }
    const source = new ChunkSource({ fetch: cut, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS })
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`, ...leaves.slice(2).map((leaf) => `${A}/chunks/${leaf.address}`)])
  })
})

describe('an endpoint that refuses one chunk by redirect', () => {
  it('serves the next chunk as before: a redirect is not a strike against the endpoint', async () => {
    const { store, one, two, swarm } = setup()
    const fetch = allowlisted([A, B], asWebFetch(swarm.fetch), 'the Swarm gatherer')
    const deps: ChunkDeps = { fetch: async (url, init) => await fetch(url, init), pool: new GatewayPool([A, B], 6), limits: DEFAULT_LIMITS }
    swarm.redirect(one, [A])
    const source = new ChunkSource(deps)
    expect(await source.get(one, signal, () => {})).toEqual(store.get(one))
    expect(swarm.requests).toEqual([`${A}/chunks/${one}`, `${B}/chunks/${one}`])
    swarm.requests.length = 0
    expect(await source.get(two, signal, () => {})).toEqual(store.get(two))
    expect(swarm.requests).toEqual([`${A}/chunks/${two}`])
  })

  it('does not cool the endpoint however many chunks it refuses in a row', async () => {
    const store = new Map<string, Uint8Array>()
    const refs = Array.from({ length: 6 }, (_, i) => buildFile(bytes(`chunk ${String(i)}`), store).ref)
    const swarm = fakeSwarm(store)
    const fetch = allowlisted([A, B], asWebFetch(swarm.fetch), 'the Swarm gatherer')
    const pool = new GatewayPool([A, B], 6)
    const source = new ChunkSource({ fetch: async (url, init) => await fetch(url, init), pool, limits: DEFAULT_LIMITS })
    for (const ref of refs) swarm.redirect(ref, [A])
    for (const ref of refs) await source.get(ref, signal, () => {})
    expect(pool.candidates()).toContain(A)
    expect(swarm.requests.filter((url) => url.startsWith(A))).toHaveLength(6)
  })

  it('is unavailable, not unverifiable, when every endpoint redirects it', async () => {
    const { store, one, swarm } = setup()
    expect(store.has(one)).toBe(true)
    const fetch = allowlisted([A, B], asWebFetch(swarm.fetch), 'the Swarm gatherer')
    swarm.redirect(one)
    const source = new ChunkSource({ fetch: async (url, init) => await fetch(url, init), pool: new GatewayPool([A, B], 6), limits: DEFAULT_LIMITS })
    await expect(source.get(one, signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
  })
})

describe('an endpoint that sent one bad answer', () => {
  it('is quarantined for a while and asked again after it, instead of being dropped for the session', async () => {
    const store = new Map<string, Uint8Array>()
    const one = buildFile(bytes('first'), store).ref
    const swarm = fakeSwarm(store)
    let t = 0
    let truncating = true
    const fetch: Fetch = async (url, init) => truncating ? new Response(new Uint8Array(3)) : await swarm.fetch(url, init)
    const pool = new GatewayPool([A], 6, () => t)
    const source = new ChunkSource({ fetch, pool, limits: DEFAULT_LIMITS })
    const refusals: Refusal[] = []
    await expect(source.get(one, signal, (r) => { refusals.push(r) })).rejects.toMatchObject({ failure: 'unverifiable' })
    expect(refusals).toEqual([{ source: A, resource: one }])
    expect(pool.usable()).toEqual([A])
    expect(pool.candidates()).toEqual([])
    truncating = false
    t += QUARANTINE_MS + 1
    expect(pool.candidates()).toEqual([A])
    expect(await source.get(one, signal, () => {})).toEqual(store.get(one))
  })
})

describe('lookUpSoc', () => {
  it('is undefined only when every endpoint said 404', async () => {
    const { deps } = setup()
    expect(await lookUpSoc('ab'.repeat(32), deps, signal, () => {})).toBeUndefined()
  })

  it('is unavailable when an endpoint was unreachable, however the others answered', async () => {
    const { swarm } = setup()
    const fetch: Fetch = async (url, init) => { if (url.startsWith(B)) throw new Error('connection refused'); return await swarm.fetch(url, init) }
    const deps: ChunkDeps = { fetch, pool: new GatewayPool([A, B], 6), limits: DEFAULT_LIMITS }
    await expect(lookUpSoc('ab'.repeat(32), deps, signal, () => {})).rejects.toMatchObject({ failure: 'unavailable' })
  })
})

describe('fetchVerifiedSoc', () => {
  it('returns the owner and the wrapped chunk of a signed update', async () => {
    const { store, deps } = setup()
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped: legacyUpdate('cd'.repeat(32)) })
    store.set(update.address, update.chunk)
    const soc = await fetchVerifiedSoc(update.address, deps, signal, () => {})
    expect(soc.owner).toBe(update.owner)
    expect(soc.wrapped).toEqual(legacyUpdate('cd'.repeat(32)))
  })

  it('refuses an update whose bytes changed on the way, taking it from another endpoint', async () => {
    const { store, deps, swarm, refusals, onRefusal } = setup()
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped: legacyUpdate('cd'.repeat(32)) })
    store.set(update.address, update.chunk)
    swarm.tamper(update.address, [A])
    expect((await fetchVerifiedSoc(update.address, deps, signal, onRefusal)).owner).toBe(update.owner)
    expect(refusals).toEqual([{ source: A, resource: update.address }])
  })
})
