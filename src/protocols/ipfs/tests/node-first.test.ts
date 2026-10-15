import { describe, expect, it } from 'vitest'
import type { DataGatherer, MountedSite } from '../../resolution/providers.js'
import { GatewaysOffered, ResolutionError } from '../../resolution/records.js'
import type { NameRecord } from '../../resolution/records.js'
import { createNodeFirstGatherer } from '../node-first.js'

const RECORDS: NameRecord[] = [{ type: 'contenthash', pointer: { kind: 'ipfs', cid: 'bafy' }, provenance: { via: 'address' } }]

function gatherer (label: string, calls: string[]): DataGatherer {
  return {
    id: 'ipfs',
    supports: () => true,
    mount: async (): Promise<MountedSite> => {
      calls.push(label)
      return { gatherer: 'ipfs', servedFrom: { kind: label === 'node' ? 'node' : 'gateways' }, root: { kind: 'ipfs', cid: 'bafy' }, pointers: [], open: async () => { throw new Error('not used') }, ddoc: () => ({ status: 'met', refusals: [] }) }
    }
  }
}

const SITE = 'https://a.eth'
const never = (): boolean => false
const always = (): boolean => true

const YES_REASON = 'you loaded this page through them after your node could not serve it'

describe('the node-first gatherer', () => {
  it('mounts from the node once it is ready, and never touches the gateways', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({ node: gatherer('node', calls), gateways: gatherer('gateways', calls), ready: async () => {}, takeConsent: never })
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toEqual({ kind: 'node' })
    expect(calls).toEqual(['node'])
  })

  it('never reads from the gateways, and offers them with the reason, when the node cannot serve and the person has not said so', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({
      node: gatherer('node', calls),
      gateways: gatherer('gateways', calls),
      ready: async () => { throw new Error('a proxy is configured') },
      takeConsent: never
    })
    const failure = await first.mount('a.eth', RECORDS, undefined, SITE).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GatewaysOffered)
    expect((failure as GatewaysOffered).message).toContain('a proxy is configured')
    expect(calls).toEqual([])
  })

  it('reads the gateways at once, and says why, when the person said yes for this load', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({
      node: gatherer('node', calls),
      gateways: gatherer('gateways', calls),
      ready: async () => { throw new Error('the node is off') },
      takeConsent: always
    })
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toEqual({ kind: 'gateways', reason: YES_REASON })
    expect(calls).toEqual(['gateways'])
  })

  it('asks the yes of the site the mount is for, and of no other', async () => {
    const asked: Array<string | undefined> = []
    const first = createNodeFirstGatherer({
      node: gatherer('node', []),
      gateways: gatherer('gateways', []),
      ready: async () => { throw new Error('off') },
      takeConsent: (partition) => { asked.push(partition); return partition === SITE }
    })
    await expect(first.mount('b.eth', RECORDS, undefined, 'https://other.eth')).rejects.toBeInstanceOf(GatewaysOffered)
    await expect(first.mount('b.eth', RECORDS)).rejects.toBeInstanceOf(GatewaysOffered)
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toMatchObject({ kind: 'gateways' })
    expect(asked).toEqual(['https://other.eth', undefined, SITE])
  })

  it('uses a yes up: the next mount of the same site offers the gateways again', async () => {
    let yes = true
    const first = createNodeFirstGatherer({
      node: gatherer('node', []),
      gateways: gatherer('gateways', []),
      ready: async () => { throw new Error('off') },
      takeConsent: () => { const had = yes; yes = false; return had }
    })
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toMatchObject({ kind: 'gateways' })
    await expect(first.mount('a.eth', RECORDS, undefined, SITE)).rejects.toBeInstanceOf(GatewaysOffered)
  })

  it('offers the gateways when the node is ready but could not find the content', async () => {
    const first = createNodeFirstGatherer({
      node: { ...gatherer('node', []), mount: async () => { throw new ResolutionError('unavailable', 'no peer has it') } },
      gateways: gatherer('gateways', []),
      ready: async () => {},
      takeConsent: never
    })
    const failure = await first.mount('a.eth', RECORDS, undefined, SITE).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GatewaysOffered)
    expect((failure as Error).message).toContain('no peer has it')
  })

  it('offers the gateways when the mount\'s time runs out while the node is still looking', async () => {
    const controller = new AbortController()
    const first = createNodeFirstGatherer({
      node: { ...gatherer('node', []), mount: async (_name, _records, signal) => await new Promise<never>((_resolve, reject) => { signal?.addEventListener('abort', () => { reject(new Error('aborted')) }) }) },
      gateways: gatherer('gateways', []),
      ready: async () => {},
      takeConsent: never
    })
    const pending = first.mount('a.eth', RECORDS, controller.signal, SITE).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    expect(await pending).toBeInstanceOf(GatewaysOffered)
  })

  it('does not hide a lie or a missing file behind an offer', async () => {
    for (const failure of ['unverifiable', 'not-found'] as const) {
      const first = createNodeFirstGatherer({
        node: { ...gatherer('node', []), mount: async () => { throw new ResolutionError(failure, 'bad') } },
        gateways: gatherer('gateways', []),
        ready: async () => {},
        takeConsent: never
      })
      await expect(first.mount('a.eth', RECORDS, undefined, SITE)).rejects.toMatchObject({ failure })
    }
  })

  it('supports what the node gatherer supports', () => {
    const first = createNodeFirstGatherer({ node: { ...gatherer('node', []), supports: () => false }, gateways: gatherer('gateways', []), ready: async () => {}, takeConsent: never })
    expect(first.supports(RECORDS)).toBe(false)
    expect(first.id).toBe('ipfs')
  })
})
