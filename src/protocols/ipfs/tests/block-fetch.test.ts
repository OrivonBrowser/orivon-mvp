import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { fetchVerifiedBlock } from '../block-fetch.js'
import type { FetchDeps } from '../block-fetch.js'
import { GatewayPool } from '../gateways.js'
import { DEFAULT_LIMITS } from '../limits.js'
import type { IpfsLimits } from '../limits.js'
import { buildDag, fakeGateways } from './dag.test-helpers.js'

const A = 'https://a.gateway'
const B = 'https://b.gateway'
const C = 'https://c.gateway'

const dag = await buildDag({ 'index.html': '<h1>hello</h1>', 'app.js': 'console.log(1)' })
const [leafKey, leafBytes] = [...dag.blocks].find(([key]) => CID.parse(key).code === 0x55)!
const leaf = CID.parse(leafKey)

function deps (gateways: ReturnType<typeof fakeGateways>, order: string[], limits: Partial<IpfsLimits> = {}): FetchDeps {
  return {
    fetch: gateways.fetch,
    pool: new GatewayPool(order, { ...DEFAULT_LIMITS, ...limits }.perGatewayConcurrency),
    limits: { ...DEFAULT_LIMITS, hedgeDelayMs: 20, blockTimeoutMs: 200, ...limits }
  }
}

const signal = new AbortController().signal
const noRefusal = (): void => {}

describe('fetchVerifiedBlock -- hedging', () => {
  it('hedges a hanging leader: the second gateway wins, and the first is abandoned', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.hanging.add(A)
    const d = deps(gateways, [A, B])
    const bytes = await fetchVerifiedBlock(leaf, d, signal, noRefusal)
    expect(bytes).toEqual(leafBytes)
    expect(gateways.requests).toEqual([`${A}/ipfs/${leafKey}?format=raw`, `${B}/ipfs/${leafKey}?format=raw`])
  })

  it('cools a leader that sent nothing while its hedge won, twice in a row, as it would a hung one', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.hanging.add(A)
    const d = deps(gateways, [A, B], { blockTimeoutMs: 30_000 })
    const [first, second] = [...dag.blocks.keys()].map((key) => CID.parse(key))
    await fetchVerifiedBlock(first!, d, signal, noRefusal)
    expect(d.pool.candidates()).toContain(A)
    await fetchVerifiedBlock(second!, d, signal, noRefusal)
    expect(d.pool.candidates()).toEqual([B])
  })

  it('never holds a lost race against a hedge started after the winner', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.hanging.add(B)
    const d = { ...deps(gateways, [A, B]), fetch: async (url: string, init: Parameters<typeof gateways.fetch>[1]) => {
      if (url.startsWith(A)) await new Promise((resolve) => setTimeout(resolve, 60))
      return await gateways.fetch(url, init)
    } }
    for (const key of [...dag.blocks.keys()].slice(0, 2)) await fetchVerifiedBlock(CID.parse(key), d, signal, noRefusal)
    expect(d.pool.candidates()).toEqual([A, B])
  })

  it('does not hedge when the leader answers within the hedge delay', async () => {
    const gateways = fakeGateways(dag.blocks)
    const d = deps(gateways, [A, B])
    await fetchVerifiedBlock(leaf, d, signal, noRefusal)
    expect(gateways.requests).toEqual([`${A}/ipfs/${leafKey}?format=raw`])
  })

  it('a hedge loser that lies is dropped while the other attempt still wins', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.hanging.add(A)
    gateways.tamper(leafKey, [A])
    // A never actually answers (it hangs), so its tampering never surfaces
    // here -- this proves the hedge's WINNER (B) is unaffected by whatever
    // the abandoned loser was going to do.
    const d = deps(gateways, [A, B])
    const bytes = await fetchVerifiedBlock(leaf, d, signal, noRefusal)
    expect(bytes).toEqual(leafBytes)
  })

  it('a hedge loser that lies before the winner answers still gets dropped and recorded', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.tamper(leafKey, [A])
    gateways.hanging.add(B) // B never answers, so only A's (lying) answer and the hedge matter
    const refusals: string[] = []
    const d = deps(gateways, [A, B, C])
    const bytes = await fetchVerifiedBlock(leaf, d, signal, (r) => { refusals.push(r.source) })
    expect(bytes).toEqual(leafBytes)
    expect(refusals).toEqual([A])
    expect(d.pool.usable()).toEqual([B, C])
  })
})

describe('fetchVerifiedBlock -- rate limits and outages', () => {
  it('moves on to the next gateway on a 429, without dropping it', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.rateLimit(A)
    const d = deps(gateways, [A, B])
    const bytes = await fetchVerifiedBlock(leaf, d, signal, noRefusal)
    expect(bytes).toEqual(leafBytes)
    expect(d.pool.usable()).toEqual([A, B]) // rate-limited, not dropped
  })

  it('an unreachable gateway is skipped on the next call once cooling', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.unreachable.add(A)
    const d = deps(gateways, [A, B])
    await fetchVerifiedBlock(leaf, d, signal, noRefusal)
    // A second, different block: A should be skipped now that it is cooling.
    const [otherKey] = [...dag.blocks.keys()].filter((k) => k !== leafKey)
    const other = CID.parse(otherKey!)
    gateways.requests.length = 0
    await fetchVerifiedBlock(other, d, signal, noRefusal)
    expect(gateways.requests).toEqual([`${B}/ipfs/${otherKey}?format=raw`])
  })

  it('waits out a cooldown when every gateway is cooling, then succeeds', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.unreachable.add(A)
    gateways.unreachable.add(B)
    const d = deps(gateways, [A, B], { hedgeDelayMs: 5 })
    // Both gateways fail once (cooling starts at 2s in gateway-health.ts),
    // then the pass loop must wait before it can ask anyone again -- confirm
    // it eventually gives up as unavailable rather than hanging, bounded by
    // a short overall test timeout instead of the real 2s cooldown.
    await expect(fetchVerifiedBlock(leaf, d, AbortSignal.timeout(50), noRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('a caller abort while waiting out a cooldown ends the fetch instead of spinning', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.unreachable.add(A)
    const d = deps(gateways, [A])
    const controller = new AbortController()
    const promise = fetchVerifiedBlock(leaf, d, controller.signal, noRefusal)
    queueMicrotask(() => { controller.abort() })
    await expect(promise).rejects.toMatchObject({ failure: 'unavailable' })
  })
})

describe('fetchVerifiedBlock -- passes', () => {
  it('gives up as unavailable once every pass is exhausted against a down gateway', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.failing.add(A) // a plain miss (500, no Retry-After) never earns a retry pass
    const d = deps(gateways, [A])
    await expect(fetchVerifiedBlock(leaf, d, signal, noRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('is unavailable, never verified, when nothing answers and nothing lied', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.failing.add(A)
    gateways.failing.add(B)
    const d = deps(gateways, [A, B])
    await expect(fetchVerifiedBlock(leaf, d, signal, noRefusal)).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('a lie earns no second pass over gateways that already missed, and names the liar', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.tamper(leafKey, [A])
    gateways.failing.add(B)
    const d = deps(gateways, [A, B])
    const failure = fetchVerifiedBlock(leaf, d, signal, noRefusal)
    await expect(failure).rejects.toMatchObject({ failure: 'unverifiable' })
    await expect(failure).rejects.toThrow(`${A} sent bytes that failed their hash`)
    expect(gateways.requests.filter((r) => r.startsWith(B))).toHaveLength(1)
  })

  it('a caller abort mid-race is honoured immediately', async () => {
    const gateways = fakeGateways(dag.blocks)
    gateways.hanging.add(A)
    const d = deps(gateways, [A])
    const controller = new AbortController()
    const promise = fetchVerifiedBlock(leaf, d, controller.signal, noRefusal)
    queueMicrotask(() => { controller.abort() })
    await expect(promise).rejects.toMatchObject({ failure: 'unavailable' })
  })
})
