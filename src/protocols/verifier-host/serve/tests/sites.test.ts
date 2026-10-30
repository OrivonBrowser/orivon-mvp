import { describe, expect, it, vi } from 'vitest'
import { GatewaysOffered, ResolutionError } from '../../../resolution/records.js'
import type { NameRecord } from '../../../resolution/records.js'
import type { DataGatherer, MountedSite, NameResolver } from '../../../resolution/providers.js'
import { ProtocolRegistry } from '../../../registry.js'
import { defineProtocol } from '../../../protocol.js'
import { ENS } from '../../../ens/descriptor.js'
import { FAILURE_TTL_MS, MAX_CONCURRENT_MOUNTS, MAX_SITES, Sites, SITE_TTL_MS, STALE_SERVE_MS } from '../sites.js'

const P = 'https://top.example'
const record: NameRecord = { type: 'contenthash', pointer: { kind: 'ipfs', cid: 'bafkqaaa' }, provenance: { via: 'fixture' } }
const site: MountedSite = { gatherer: 'stub', root: { kind: 'ipfs', cid: 'bafkqaaa' }, pointers: [], open: async () => { throw new Error('unused') }, ddoc: () => ({ status: 'met', refusals: [] }) }

function registry (resolve: () => Promise<NameRecord[]>): { registry: ProtocolRegistry, calls: { n: number } } {
  const calls = { n: 0 }
  const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => { calls.n++; return await resolve() } }
  const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => site }
  return { registry: new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] })]), calls }
}

describe('Sites', () => {
  it('mounts again for a page load the person starts once the site holds a newer version, and keeps serving the one it has to every other request', async () => {
    let newer = false
    const mounted: MountedSite[] = []
    const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => [record] }
    const gatherer: DataGatherer = {
      id: 'stub',
      supports: () => true,
      mount: async () => {
        const made: MountedSite = { ...site, hasNewer: () => newer }
        mounted.push(made)
        return made
      }
    }
    const sites = new Sites(new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] })]))
    const first = (await sites.get('a.eth', P)).site
    newer = true
    expect((await sites.get('a.eth', P)).site).toBe(first)
    expect((await sites.get('a.eth', P, true)).site).toBe(first)
    expect((await sites.get('a.eth', P, false, false)).site).toBe(first)
    expect(mounted).toHaveLength(1)
    newer = false
    expect((await sites.get('a.eth', P, true, true)).site).toBe(first)
    newer = true
    const second = (await sites.get('a.eth', P, true, true)).site
    expect(second).not.toBe(first)
    expect(mounted).toHaveLength(2)
    newer = false
    expect((await sites.get('a.eth', P, true, true)).site).toBe(second)
    expect(mounted).toHaveLength(2)
  })

  it('mounts a host once while it is fresh, and again once it is stale', async () => {
    const clock = { now: 0 }
    const { registry: r, calls } = registry(async () => [record])
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)
    await sites.get('a.eth', P)
    expect(calls.n).toBe(1)
    clock.now = SITE_TTL_MS + 1
    await sites.get('a.eth', P)
    expect(calls.n).toBe(2)
  })

  it('tells the observer which gatherer is chosen, and a throwing observer does not fail the mount', async () => {
    const { registry: r } = registry(async () => [record])
    const seen: string[] = []
    const sites = new Sites(r, Date.now, 50, (host, gatherer) => { seen.push(`${host} ${gatherer}`); throw new Error('observer bug') })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await sites.get('a.eth', P)).site).toBe(site)
    expect(seen).toEqual(['a.eth stub'])
    errors.mockRestore()
  })

  it('tells the observer before the gatherer has mounted anything, so a mount that never settles still reports', async () => {
    const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => [record] }
    const gatherer: DataGatherer = { id: 'slow', supports: () => true, mount: async () => await new Promise<MountedSite>(() => {}) }
    const r = new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] })])
    const seen: string[] = []
    const sites = new Sites(r, Date.now, 50, (host, chosen) => { seen.push(`${host} ${chosen}`) })
    await expect(sites.get('a.eth', P)).rejects.toMatchObject({ failure: 'unavailable' })
    expect(seen).toEqual(['a.eth slow'])
  })

  it('tells the observer of each gatherer tried, in order, when one fails and the next takes over', async () => {
    const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => [record] }
    const failing: DataGatherer = { id: 'first', supports: () => true, mount: async () => { throw new ResolutionError('unavailable', 'down') } }
    const working: DataGatherer = { id: 'second', supports: () => true, mount: async () => site }
    const r = new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [failing, working] })])
    const seen: string[] = []
    await new Sites(r, Date.now, 50, (host, chosen) => { seen.push(`${host} ${chosen}`) }).get('a.eth', P)
    expect(seen).toEqual(['a.eth first', 'a.eth second'])
  })

  it('tells the observer nothing for a name whose records no gatherer can load, or that does not resolve', async () => {
    const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async (name) => name === 'none.eth' ? [] : [record] }
    const picky: DataGatherer = { id: 'picky', supports: () => false, mount: async () => site }
    const r = new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [picky] })])
    const seen: string[] = []
    const sites = new Sites(r, Date.now, 50, (host, chosen) => { seen.push(`${host} ${chosen}`) })
    await expect(sites.get('a.eth', P)).rejects.toMatchObject({ failure: 'unsupported' })
    await expect(sites.get('none.eth', P)).rejects.toMatchObject({ failure: 'not-found' })
    expect(seen).toEqual([])
  })

  it('gives up on a mount that takes too long, as unavailable', async () => {
    const { registry: r } = registry(async () => await new Promise<NameRecord[]>(() => {}))
    await expect(new Sites(r, Date.now, 50).get('slow.eth', P)).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringMatching(/within 0.05 s/) })
  })

  it('reads the wait for a mount when the mount starts, so a route that has grown more patient is waited on for longer', async () => {
    const { registry: r } = registry(async () => await new Promise<NameRecord[]>(() => {}))
    let wait = 30
    const sites = new Sites(r, Date.now, () => wait)
    await expect(sites.get('slow.eth', P)).rejects.toMatchObject({ message: expect.stringMatching(/within 0.03 s/) })
    wait = 60
    await expect(sites.get('slow.eth', 'https://other')).rejects.toMatchObject({ message: expect.stringMatching(/within 0.06 s/) })
  })

  it('has nothing current for a host it never mounted, or one whose mount failed', async () => {
    const { registry: r } = registry(async () => { throw new Error('down') })
    const sites = new Sites(r)
    expect(await sites.current('a.eth', P)).toBeUndefined()
    await sites.get('a.eth', P).catch(() => {})
    expect(await sites.current('a.eth', P)).toBeUndefined()
  })

  it('keeps at most its cap of names, dropping the least recently used first', async () => {
    const { registry: r } = registry(async () => [record])
    const sites = new Sites(r)
    await sites.get('first.eth', P)
    for (let i = 0; i < MAX_SITES; i++) {
      await sites.get(`n${String(i)}.eth`, P)
      if (i === 0) await sites.get('first.eth', P)
    }
    expect(await sites.current('first.eth', P)).toBeDefined()
    expect(await sites.current('n0.eth', P)).toBeUndefined()
    expect(await sites.current(`n${String(MAX_SITES - 1)}.eth`, P)).toBeDefined()
  })

  it('forgets a failure once it has expired, rather than keeping it', async () => {
    const clock = { now: 0 }
    const { registry: r, calls } = registry(async () => { throw new Error('down') })
    const sites = new Sites(r, () => clock.now)
    await sites.get('gone.eth', P).catch(() => {})
    clock.now = FAILURE_TTL_MS + 1
    await sites.get('other.eth', P).catch(() => {})
    expect((sites as unknown as { entries: Map<string, unknown> }).entries.has('gone.eth')).toBe(false)
    expect(calls.n).toBe(2)
  })

  it('remembers a failure for a request that is not a person\'s own, and tries again for one that is', async () => {
    const clock = { now: 0 }
    let up = false
    const { registry: r, calls } = registry(async () => { if (!up) throw new Error('down'); return [record] })
    const sites = new Sites(r, () => clock.now)
    await expect(sites.get('flaky.eth', P)).rejects.toMatchObject({ failure: 'unavailable' })
    await expect(sites.get('flaky.eth', P)).rejects.toMatchObject({ failure: 'unavailable' })
    expect(calls.n).toBe(1)
    up = true
    await expect(sites.get('flaky.eth', P)).rejects.toMatchObject({ failure: 'unavailable' })
    expect(calls.n).toBe(1)
    expect((await sites.get('flaky.eth', P, true)).site).toBe(site)
    expect(calls.n).toBe(2)
    expect((await sites.get('flaky.eth', P)).site).toBe(site)
    expect(calls.n).toBe(2)
  })

  it('joins a mount that is still running for a person\'s own request, never restarts it', async () => {
    let release: () => void = () => {}
    const { registry: r, calls } = registry(async () => { await new Promise<void>((resolve) => { release = resolve }); return [record] })
    const sites = new Sites(r)
    const first = sites.get('slow.eth', P)
    const again = sites.get('slow.eth', P, true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    release()
    await Promise.all([first, again])
    expect(calls.n).toBe(1)
  })

  it('proves only a few names at once, and the rest wait their turn', async () => {
    let running = 0
    let peak = 0
    const { registry: r } = registry(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      return [record]
    })
    const sites = new Sites(r)
    await Promise.all(Array.from({ length: MAX_CONCURRENT_MOUNTS * 3 }, async (_, i) => await sites.get(`c${String(i)}.eth`, P)))
    expect(peak).toBe(MAX_CONCURRENT_MOUNTS)
  })

  it('mounts a name once per partition, and never answers one partition from another', async () => {
    const { registry: r, calls } = registry(async () => [record])
    const sites = new Sites(r)
    await sites.get('a.eth', 'https://one.example')
    expect(await sites.current('a.eth', 'https://two.example')).toBeUndefined()
    await sites.get('a.eth', 'https://two.example')
    await sites.get('a.eth', 'https://one.example')
    expect(calls.n).toBe(2)
  })

  it('mounts a request with no partition every time, and keeps none of those mounts', async () => {
    const { registry: r, calls } = registry(async () => [record])
    const sites = new Sites(r)
    await sites.get('kept.eth', P)
    for (let i = 0; i < MAX_SITES + 5; i++) await sites.get('loose.eth', undefined)
    expect(calls.n).toBe(MAX_SITES + 6)
    expect(await sites.current('kept.eth', P)).toBeDefined()
  })
})

/** A registry whose resolve behaviour can be swapped mid-test, for the
 * stale-while-revalidate scenarios below (success, then failure, then
 * success again, all against the SAME name). */
function switchableRegistry (): { registry: ProtocolRegistry, resolve: { current: () => Promise<NameRecord[]> }, calls: { n: number } } {
  const calls = { n: 0 }
  const resolve = { current: async () => [record] }
  const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => { calls.n++; return await resolve.current() } }
  const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => site }
  return { registry: new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] })]), resolve, calls }
}

describe('Sites.latest: whether a name moved', () => {
  it('asks the name although a fresh record is kept, and keeps the answer for the requests that follow', async () => {
    const clock = { now: 0 }
    const { registry: r, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)
    expect(calls.n).toBe(1)

    clock.now = 1
    const proven = await sites.latest('a.eth', P)
    expect(calls.n).toBe(2)
    expect(proven.mountedAt).toBe(1)
    expect(await sites.get('a.eth', P)).toBe(proven)
    expect(calls.n).toBe(2)
  })

  it('waits for the name past the fresh window, where a page load is served what is kept', async () => {
    const clock = { now: 0 }
    const { registry: r, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)

    clock.now = SITE_TTL_MS + 1
    expect((await sites.latest('a.eth', P)).mountedAt).toBe(SITE_TTL_MS + 1)
    expect(calls.n).toBe(2)
  })

  it('joins a re-prove already running, and starts none of its own', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)

    clock.now = SITE_TTL_MS + 1
    let answer!: () => void
    resolve.current = async () => await new Promise<NameRecord[]>((resolve) => { answer = () => { resolve([record]) } })
    await sites.get('a.eth', P)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const asked = sites.latest('a.eth', P)
    await new Promise((resolve) => setTimeout(resolve, 0))
    answer()
    expect((await asked).mountedAt).toBe(SITE_TTL_MS + 1)
    expect(calls.n).toBe(2)
  })

  it('mounts a name nothing holds, and keeps it', async () => {
    const { registry: r, calls } = switchableRegistry()
    const sites = new Sites(r)
    const proven = await sites.latest('a.eth', P)
    expect(await sites.get('a.eth', P)).toBe(proven)
    expect(calls.n).toBe(1)
  })

  it('fails when the name cannot be proven, and leaves what is kept to serve', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    const kept = await sites.get('a.eth', P)

    clock.now = 1
    resolve.current = async () => { throw new Error('down') }
    await expect(sites.latest('a.eth', P)).rejects.toThrow('down')
    expect(await sites.get('a.eth', P)).toBe(kept)
  })
})

describe('Sites -- stale-while-revalidate', () => {
  it('serves the last good record past SITE_TTL_MS, without waiting on a re-prove', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)
    expect(calls.n).toBe(1)

    clock.now = SITE_TTL_MS + 1
    resolve.current = async () => await new Promise(() => {}) // a re-prove that never settles during this test
    const record2 = await sites.get('a.eth', P)
    expect(record2).toBeDefined() // returned immediately, not hung waiting on the never-settling re-prove
    expect(calls.n).toBe(2) // the re-prove was still started, just not waited on
  })

  it('a successful revalidation replaces the served record and resets the TTL', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)

    clock.now = SITE_TTL_MS + 1
    let resolveRevalidation!: () => void
    resolve.current = async () => await new Promise<NameRecord[]>((resolve) => { resolveRevalidation = () => { resolve([record]) } })
    await sites.get('a.eth', P) // starts the revalidation, serves stale
    resolveRevalidation()
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the revalidation's own .then() run

    clock.now = SITE_TTL_MS + 1 // still within a FRESH window relative to the just-completed revalidation
    resolve.current = async () => { throw new Error('must not be called -- should be fresh again') }
    await sites.get('a.eth', P)
    expect(calls.n).toBe(2) // no third resolve: the revalidated mount is fresh
  })

  it('a burst of stale requests starts exactly one revalidation, not one each', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)

    clock.now = SITE_TTL_MS + 1
    resolve.current = async () => await new Promise(() => {})
    await Promise.all(Array.from({ length: 5 }, async () => await sites.get('a.eth', P)))
    expect(calls.n).toBe(2) // the first mount, plus exactly one revalidation
  })

  it('a failed revalidation keeps the old good record, and paces the next attempt', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    const first = await sites.get('a.eth', P)

    clock.now = SITE_TTL_MS + 1
    resolve.current = async () => { throw new Error('down') }
    const stale = await sites.get('a.eth', P)
    expect(stale).toEqual(first) // the old good record, not a throw
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the failed revalidation's own .then() run
    expect(calls.n).toBe(2)

    // Immediately after: still paced, no second revalidation attempt yet.
    await sites.get('a.eth', P)
    expect(calls.n).toBe(2)

    clock.now = SITE_TTL_MS + 1 + FAILURE_TTL_MS + 1
    resolve.current = async () => [record]
    await sites.get('a.eth', P)
    expect(calls.n).toBe(3)
  })

  it('current() also serves a stale-but-servable record without resolving anything', async () => {
    const clock = { now: 0 }
    const { registry: r, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)
    clock.now = SITE_TTL_MS + 1
    expect(await sites.current('a.eth', P)).toBeDefined()
    expect(calls.n).toBe(1) // current() never itself triggers a re-prove
  })

  it('past STALE_SERVE_MS, a request waits on a fresh mount instead of serving the old one', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve, calls } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)

    clock.now = STALE_SERVE_MS + 1
    resolve.current = async () => [record]
    await sites.get('a.eth', P)
    expect(calls.n).toBe(2) // waited on this mount, not the (now too old) stale one
  })

  it('past STALE_SERVE_MS, current() has nothing to show once the fresh mount fails', async () => {
    const clock = { now: 0 }
    const { registry: r, resolve } = switchableRegistry()
    const sites = new Sites(r, () => clock.now)
    await sites.get('a.eth', P)
    clock.now = STALE_SERVE_MS + 1
    expect(await sites.current('a.eth', P)).toBeUndefined() // get() would not serve it either
    resolve.current = async () => { throw new Error('down') }
    await expect(sites.get('a.eth', P)).rejects.toThrow()
    expect(await sites.current('a.eth', P)).toBeUndefined()
  })

  it('keeps an offer of gateways when the deadline ends a mount, since the gatherer says so the moment it is aborted', async () => {
    const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => [record] }
    const searching: DataGatherer = { id: 'ipfs', supports: () => true, mount: async (_name, _records, signal) => await new Promise<MountedSite>((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new GatewaysOffered('the node did not find it in time')) }) }) }
    const r = new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [searching] })])
    await expect(new Sites(r, Date.now, 50).get('a.eth', P)).rejects.toBeInstanceOf(GatewaysOffered)
  })

  describe('a site loaded by the person\'s yes for one load', () => {
    const byYes: MountedSite = { ...site, servedFrom: { kind: 'gateways', reason: 'the person said yes' } }
    function world () {
      const resolver: NameResolver = { id: 'stub', namespaces: ['.eth'], resolve: async () => [record] }
      const mounts = { n: 0 }
      const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => { mounts.n++; return byYes } }
      const r = new ProtocolRegistry([defineProtocol(ENS, { resolvers: [resolver], gatherers: [gatherer] })])
      return { sites: new Sites(r, Date.now, 50, () => {}, (mounted) => mounted.servedFrom?.reason !== undefined), mounts }
    }

    it('serves the page\'s own files without mounting again, and mounts again for a page load the person starts', async () => {
      const { sites, mounts } = world()
      await sites.get('a.eth', P, true, true)
      await sites.get('a.eth', P)
      await sites.get('a.eth', P, true)
      expect(mounts.n).toBe(1)
      await sites.get('a.eth', P, true, true)
      expect(mounts.n).toBe(2)
    })

    it('does not mount again for the page load of a site the node served', async () => {
      const { registry: r, calls } = registry(async () => [record])
      const sites = new Sites(r, Date.now, 50, () => {}, () => false)
      await sites.get('a.eth', P, true, true)
      await sites.get('a.eth', P, true, true)
      expect(calls.n).toBe(1)
    })
  })
})
