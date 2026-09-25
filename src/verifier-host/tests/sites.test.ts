import { describe, expect, it } from 'vitest'
import type { NameRecord } from '../../resolution/records.js'
import type { DataGatherer, MountedSite, NameResolver } from '../../resolution/providers.js'
import { ResolutionRegistry } from '../../resolution/registry.js'
import { FAILURE_TTL_MS, MAX_CONCURRENT_MOUNTS, MAX_SITES, Sites, SITE_TTL_MS } from '../sites.js'

const P = 'https://top.example'
const record: NameRecord = { type: 'contenthash', pointer: { kind: 'ipfs', cid: 'bafkqaaa' }, provenance: { via: 'fixture' } }
const site: MountedSite = { gatherer: 'stub', root: { kind: 'ipfs', cid: 'bafkqaaa' }, pointers: [], open: async () => { throw new Error('unused') }, ddoc: () => ({ status: 'met', refusals: [] }) }

function registry (resolve: () => Promise<NameRecord[]>): { registry: ResolutionRegistry, calls: { n: number } } {
  const calls = { n: 0 }
  const resolver: NameResolver = { id: 'stub', topLevelDomains: ['eth'], resolve: async () => { calls.n++; return await resolve() } }
  const gatherer: DataGatherer = { id: 'stub', supports: () => true, mount: async () => site }
  return { registry: new ResolutionRegistry([resolver], [gatherer]), calls }
}

describe('Sites', () => {
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

  it('gives up on a mount that takes too long, as unavailable', async () => {
    const { registry: r } = registry(async () => await new Promise<NameRecord[]>(() => {}))
    await expect(new Sites(r, Date.now, 50).get('slow.eth', P)).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringMatching(/within 0.05 s/) })
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
})
