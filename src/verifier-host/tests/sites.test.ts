import { describe, expect, it } from 'vitest'
import type { NameRecord } from '../../resolution/records.js'
import type { DataGatherer, MountedSite, NameResolver } from '../../resolution/providers.js'
import { ResolutionRegistry } from '../../resolution/registry.js'
import { Sites, SITE_TTL_MS } from '../sites.js'

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
    await sites.get('a.eth')
    await sites.get('a.eth')
    expect(calls.n).toBe(1)
    clock.now = SITE_TTL_MS + 1
    await sites.get('a.eth')
    expect(calls.n).toBe(2)
  })

  it('gives up on a mount that takes too long, as unavailable', async () => {
    const { registry: r } = registry(async () => await new Promise<NameRecord[]>(() => {}))
    await expect(new Sites(r, Date.now, 50).get('slow.eth')).rejects.toMatchObject({ failure: 'unavailable', message: expect.stringMatching(/within 0.05 s/) })
  })

  it('has nothing current for a host it never mounted, or one whose mount failed', async () => {
    const { registry: r } = registry(async () => { throw new Error('down') })
    const sites = new Sites(r)
    expect(await sites.current('a.eth')).toBeUndefined()
    await sites.get('a.eth').catch(() => {})
    expect(await sites.current('a.eth')).toBeUndefined()
  })
})
