import { describe, expect, it, vi } from 'vitest'
import { BlockCache } from '../../gateways/cache.js'
import type { BlockMemory } from '../../gateways/cache.js'
import { GatewayPool } from '../../gateways/gateways.js'
import type { Fetch } from '../../gateways/gateways.js'
import { allowlisted } from '../../verifier-host/egress.js'
import type { Refusal } from '../../resolution/providers.js'
import { bytesToHex } from 'viem'
import { ChunkSource, QUARANTINE_MS, fetchVerifiedSoc, lookUpSoc } from '../chunk-fetch.js'
import type { ChunkDeps, SubtreeLeaf } from '../chunk-fetch.js'
import { checkHere } from '../chunk-check.js'
import type { ChunkChecker } from '../chunk-check.js'
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

  it('asks nothing for a read already abandoned', async () => {
    const { deps, one, swarm } = setup()
    const gone = new AbortController()
    gone.abort()
    await expect(new ChunkSource(deps, new BlockCache(), 'https://one.example').get(one, gone.signal, () => {})).rejects.toBeDefined()
    expect(swarm.requests).toEqual([])
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

  it('uses only the leaves it was given from the whole subtree the source sends', async () => {
    const { store, parent, leaves, swarm, source } = subtree(10)
    const some = leaves.slice(3, 7)
    expect(await Promise.all(source.leaves(parent, some, signal, () => {}))).toEqual(some.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
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
    swarm.bytesRoute = false
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`, ...leaves.map((leaf) => `${A}/chunks/${leaf.address}`)])
    expect(pool.candidates()).toEqual([A])
    expect(logged).toEqual([`swarm: a bulk read gave 0 of 4 leaves (${A} answered 404); the rest are read one by one`])
  })

  it('sends one /bytes request for two reads of one subtree at once, and joins a leaf another read is already fetching', async () => {
    const { store, parent, leaves, swarm, source } = subtree(6)
    const alone = source.get(leaves[2]!.address, signal, () => {})
    const [first, second] = [source.leaves(parent, leaves, signal, () => {}), source.leaves(parent, leaves, signal, () => {})]
    expect(await Promise.all([...first, ...second, alone])).toEqual([...leaves, ...leaves, leaves[2]!].map((leaf) => store.get(leaf.address)))
    expect([...swarm.requests].sort()).toEqual([`${A}/bytes/${parent}`, `${A}/chunks/${leaves[2]!.address}`])
  })

  it('asks nothing for a read already abandoned', async () => {
    const { parent, leaves, swarm, source } = subtree(4)
    const gone = new AbortController()
    gone.abort()
    const answers = source.leaves(parent, leaves, gone.signal, () => {})
    for (const answer of answers) await expect(answer).rejects.toBeDefined()
    expect(swarm.requests).toEqual([])
  })

  it('keeps its /bytes request for a read that joined its leaves when the read that started it leaves', async () => {
    const { store, parent, leaves, swarm } = subtree(6)
    const fetch: Fetch = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (init.signal.aborted) throw init.signal.reason
      return await swarm.fetch(url, init)
    }
    const source = new ChunkSource({ fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }, new BlockCache(), 'https://one.example')
    const gone = new AbortController()
    const first = source.leaves(parent, leaves, gone.signal, () => {})
    const second = source.leaves(parent, leaves, signal, () => {})
    gone.abort()
    for (const answer of first) await expect(answer).rejects.toBeDefined()
    expect(await Promise.all(second)).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
  })

  it('abandons its /bytes request once no read wants the leaves it has still to give', async () => {
    const { parent, leaves, swarm } = subtree(6)
    let bulk: AbortSignal | undefined
    const fetch: Fetch = async (url, init) => {
      if (!url.includes('/bytes/')) return await swarm.fetch(url, init)
      bulk = init.signal
      return await new Promise<Response>((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(init.signal.reason) }) })
    }
    const source = new ChunkSource({ fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }, new BlockCache(), 'https://one.example')
    const gone = new AbortController()
    const answers = source.leaves(parent, leaves, gone.signal, () => {})
    await vi.waitFor(() => { expect(bulk).toBeDefined() })
    gone.abort()
    for (const answer of answers) await expect(answer).rejects.toBeDefined()
    await vi.waitFor(() => { expect(bulk?.aborted).toBe(true) })
    expect(swarm.requests).toEqual([])
  })

  it('counts a leaf kept twice once, so the cache never thinks itself fuller than it is', () => {
    const memory = new BlockCache()
    const block = new Uint8Array(4096)
    for (let i = 0; i < 20_000; i++) memory.remember('https://one.example', 'ab'.repeat(32), block)
    memory.remember('https://one.example', 'cd'.repeat(32), block)
    expect(memory.recall('https://one.example', 'ab'.repeat(32))).toBe(block)
  })

  it('fetches alone the leaves past where a source\'s answer ended', async () => {
    const { store, parent, leaves, swarm } = subtree(5)
    const cut: Fetch = async (url, init) => {
      const response = await swarm.fetch(url, init)
      return url.includes('/bytes/') ? new Response((await response.arrayBuffer()).slice(0, 2 * 4096 + 10)) : response
    }
    const source = new ChunkSource({ fetch: cut, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS })
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`, ...leaves.slice(2).map((leaf) => `${A}/chunks/${leaf.address}`)])
  })
})

/**
 * A memory with a slower store behind its cache, as the verifier host's is: `kept` is what the store holds, and
 * `recallKept` answers a macrotask after it is asked, as the host's does. `asked` is every key looked up there.
 */
function withStore (kept: ReadonlyMap<string, Uint8Array>, held?: { readonly key: string, readonly until: Promise<void> }) {
  const cache = new BlockCache()
  const asked: string[] = []
  const remembered: string[] = []
  const memory: BlockMemory = {
    remember: (partition, key, block) => { remembered.push(key); cache.remember(partition, key, block) },
    recall: (partition, key) => cache.recall(partition, key),
    share: (partition, key, start) => cache.share(partition, key, start),
    recallKept: async (_partition, key) => {
      asked.push(key)
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      if (held?.key === key) await held.until
      return kept.get(key)
    }
  }
  return { memory, asked, remembered }
}

describe('ChunkSource over a memory with a store behind its cache', () => {
  function sourceOver (memory: BlockMemory, swarm: ReturnType<typeof subtree>['swarm']) {
    return new ChunkSource({ fetch: swarm.fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }, memory, 'https://one.example')
  }

  it('takes a chunk the store keeps without asking an endpoint, and one it does not from the endpoint', async () => {
    const { store, leaves, swarm } = subtree(3)
    const kept = new Map([[leaves[0]!.address, store.get(leaves[0]!.address)!]])
    const { memory } = withStore(kept)
    const source = sourceOver(memory, swarm)
    expect(await source.get(leaves[0]!.address, signal, () => {})).toEqual(store.get(leaves[0]!.address))
    expect(swarm.requests).toEqual([])
    expect(await source.get(leaves[1]!.address, signal, () => {})).toEqual(store.get(leaves[1]!.address))
    expect(swarm.requests).toEqual([`${A}/chunks/${leaves[1]!.address}`])
  })

  it('does not look in the store for a read already abandoned', async () => {
    const { leaves, swarm } = subtree(2)
    const { memory, asked } = withStore(new Map())
    const gone = new AbortController()
    gone.abort()
    await expect(sourceOver(memory, swarm).get(leaves[0]!.address, gone.signal, () => {})).rejects.toBeDefined()
    expect(asked).toEqual([])
    expect(swarm.requests).toEqual([])
  })

  it('gives every leaf the store keeps, with the event loop turning between them and no request to an endpoint', async () => {
    const { store, parent, leaves, swarm } = subtree(10, 100)
    const { memory, asked } = withStore(new Map(leaves.map((leaf) => [leaf.address, store.get(leaf.address)!])))
    const order: string[] = []
    setImmediate(() => { order.push('another turn of the loop') })
    const chunks = await Promise.all(sourceOver(memory, swarm).leaves(parent, leaves, signal, () => {}))
    order.push('leaves done')
    expect(chunks).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(order).toEqual(['another turn of the loop', 'leaves done'])
    expect(asked).toEqual(leaves.map((leaf) => leaf.address))
    expect(swarm.requests).toEqual([])
  })

  it('hands over a leaf the store has as soon as it is read, without waiting for the lookup of the others', async () => {
    const { store, parent, leaves, swarm } = subtree(4)
    let open!: () => void
    const until = new Promise<void>((resolve) => { open = resolve })
    const { memory } = withStore(new Map(leaves.map((leaf) => [leaf.address, store.get(leaf.address)!])), { key: leaves[3]!.address, until })
    const answers = sourceOver(memory, swarm).leaves(parent, leaves, signal, () => {})
    expect(await answers[0]).toEqual(store.get(leaves[0]!.address))
    expect(await Promise.race([answers[3], Promise.resolve('still looking')])).toBe('still looking')
    open()
    expect(await answers[3]).toEqual(store.get(leaves[3]!.address))
    expect(swarm.requests).toEqual([])
  })

  it('reads one /bytes request for the leaves the store lacks, and uses the store for the others', async () => {
    const { store, parent, leaves, swarm } = subtree(8)
    const keptLeaves = [leaves[0]!, leaves[1]!, leaves[4]!]
    const { memory, remembered } = withStore(new Map(keptLeaves.map((leaf) => [leaf.address, store.get(leaf.address)!])))
    const chunks = await Promise.all(sourceOver(memory, swarm).leaves(parent, leaves, signal, () => {}))
    expect(chunks).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
    expect(remembered.sort()).toEqual(leaves.filter((leaf) => !keptLeaves.includes(leaf)).map((leaf) => leaf.address).sort())
  })

  it('sends no /bytes request for a single leaf the store lacks, as it sends none without a store', async () => {
    const { store, parent, leaves, swarm } = subtree(4)
    const { memory } = withStore(new Map(leaves.slice(1).map((leaf) => [leaf.address, store.get(leaf.address)!])))
    const chunks = await Promise.all(sourceOver(memory, swarm).leaves(parent, leaves, signal, () => {}))
    expect(chunks).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/chunks/${leaves[0]!.address}`])
  })

  it('fetches every leaf when the store holds none, in the one /bytes request', async () => {
    const { store, parent, leaves, swarm } = subtree(5)
    const { memory } = withStore(new Map())
    const chunks = await Promise.all(sourceOver(memory, swarm).leaves(parent, leaves, signal, () => {}))
    expect(chunks).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`])
  })

  it('asks nothing of the store or an endpoint for a read abandoned before it started, and none of an endpoint for one abandoned while the store was asked', async () => {
    const { store, parent, leaves, swarm } = subtree(4)
    const { memory, asked } = withStore(new Map([[leaves[0]!.address, store.get(leaves[0]!.address)!]]))
    const source = sourceOver(memory, swarm)
    const before = new AbortController()
    before.abort()
    for (const answer of source.leaves(parent, leaves, before.signal, () => {})) await expect(answer).rejects.toBeDefined()
    expect(asked).toEqual([])

    const during = new AbortController()
    const answers = source.leaves(parent, leaves, during.signal, () => {})
    during.abort()
    const settled = await Promise.allSettled(answers)
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'rejected'])
    expect(swarm.requests).toEqual([])
  })

  it('refuses a leaf that is not a chunk address as it does without a store, and serves the rest', async () => {
    const { store, parent, leaves, swarm } = subtree(3)
    const { memory } = withStore(new Map())
    const odd = [leaves[0]!, { ...leaves[1]!, address: 'not an address' }, leaves[2]!]
    const settled = await Promise.allSettled(sourceOver(memory, swarm).leaves(parent, odd, signal, () => {}))
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(settled[0]).toEqual({ status: 'fulfilled', value: store.get(leaves[0]!.address) })
    expect(settled[2]).toEqual({ status: 'fulfilled', value: store.get(leaves[2]!.address) })
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

/** A checker that makes the real check after a delay of `delayOf(call)` ms, remembers each address it was given, in which order they answered, and how many had been asked when the first did. */
function delayedChecker (delayOf: (call: number) => number = () => 0) {
  const asked: string[] = []
  const answered: string[] = []
  const first: { askedBeforeAnswer?: number } = {}
  const checker: ChunkChecker = {
    verify: async (address, chunk, ran) => {
      const call = asked.push(address) - 1
      await new Promise<void>((resolve) => { setTimeout(resolve, delayOf(call)) })
      first.askedBeforeAnswer ??= asked.length
      answered.push(address)
      ran?.(1)
      return checkHere(address, chunk)
    }
  }
  return { checker, asked, answered, first }
}

describe('ChunkSource with a checker of its own', () => {
  function checked (count: number, checker: ChunkChecker) {
    const made = subtree(count)
    const source = new ChunkSource({ fetch: made.swarm.fetch, pool: made.pool, limits: DEFAULT_LIMITS, log: (line) => { made.logged.push(line) }, checker }, new BlockCache(), 'https://one.example')
    return { ...made, source }
  }

  it('has every chunk it fetches checked there, a single chunk and the leaves of a bulk answer alike', async () => {
    const { checker, asked } = delayedChecker()
    const { store, parent, leaves, source } = checked(5, checker)
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(asked).toEqual(leaves.map((leaf) => leaf.address))
    asked.length = 0
    const one = buildFile(bytes('another'), store).ref
    expect(await source.get(one, signal, () => {})).toEqual(store.get(one))
    expect(asked).toEqual([one])
  })

  it('starts the checks of the leaves it has whole together, and answers each leaf in order whichever check ends first', async () => {
    const { checker, answered, first } = delayedChecker((call) => Math.max(0, 6 - call) * 15)
    const { store, parent, leaves, source } = checked(6, checker)
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(first.askedBeforeAnswer).toBe(6)
    expect(answered).toEqual([...leaves].reverse().map((leaf) => leaf.address))
  })

  it('uses the leaves before a wrong one and fetches that leaf and the ones after it alone, however the checks end', async () => {
    const { checker } = delayedChecker((call) => Math.max(0, 6 - call) * 10)
    const { store, parent, leaves, swarm, source, logged } = checked(6, checker)
    swarm.tamperedBytes.add(parent)
    expect(await Promise.all(source.leaves(parent, leaves, signal, () => {}))).toEqual(leaves.map((leaf) => store.get(leaf.address)))
    expect(swarm.requests).toEqual([`${A}/bytes/${parent}`, ...leaves.slice(1).map((leaf) => `${A}/chunks/${leaf.address}`)])
    expect(logged).toEqual(['swarm: a bulk read gave 1 of 6 leaves (a leaf that failed its address); the rest are read one by one'])
  })
})
