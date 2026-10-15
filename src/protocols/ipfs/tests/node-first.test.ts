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

describe('the node-first gatherer', () => {
  it('mounts from the node once it is ready, and never touches the gateways', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({ node: gatherer('node', calls), gateways: gatherer('gateways', calls), ready: async () => {}, takeConsent: always })
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toEqual({ kind: 'node' })
    expect(calls).toEqual(['node'])
  })

  it('never reads from the gateways, and offers them, when the node cannot serve and the person has not said so', async () => {
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
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toMatchObject({ kind: 'gateways', reason: 'off' })
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

  it('mounts from the gateways, with the reason, when the node cannot serve and the person said so', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({
      node: gatherer('node', calls),
      gateways: gatherer('gateways', calls),
      ready: async () => { throw new Error('a proxy is configured') },
      takeConsent: always
    })
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toEqual({ kind: 'gateways', reason: 'a proxy is configured' })
    expect(calls).toEqual(['gateways'])
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

  it('reads the gateways after the node found nothing, once the person said so', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({
      node: { ...gatherer('node', calls), mount: async () => { calls.push('node'); throw new ResolutionError('unavailable', 'no peer has it') } },
      gateways: gatherer('gateways', calls),
      ready: async () => {},
      takeConsent: always
    })
    expect((await first.mount('a.eth', RECORDS, undefined, SITE)).servedFrom).toEqual({ kind: 'gateways', reason: 'no peer has it' })
    expect(calls).toEqual(['node', 'gateways'])
  })

  it('does not hide a lie or a missing file behind an offer, or behind the gateways', async () => {
    for (const failure of ['unverifiable', 'not-found'] as const) {
      const first = createNodeFirstGatherer({
        node: { ...gatherer('node', []), mount: async () => { throw new ResolutionError(failure, 'bad') } },
        gateways: gatherer('gateways', []),
        ready: async () => {},
        takeConsent: always
      })
      await expect(first.mount('a.eth', RECORDS, undefined, SITE)).rejects.toMatchObject({ failure })
    }
  })

  it('does not fall back for a mount that was abandoned', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const first = createNodeFirstGatherer({
      node: gatherer('node', calls),
      gateways: gatherer('gateways', calls),
      ready: async () => { controller.abort(); throw new Error('aborted') },
      takeConsent: always
    })
    await expect(first.mount('a.eth', RECORDS, controller.signal, SITE)).rejects.toBeDefined()
    expect(calls).toEqual([])
  })

  it('supports what the node gatherer supports', () => {
    const first = createNodeFirstGatherer({ node: { ...gatherer('node', []), supports: () => false }, gateways: gatherer('gateways', []), ready: async () => {}, takeConsent: never })
    expect(first.supports(RECORDS)).toBe(false)
    expect(first.id).toBe('ipfs')
  })
})
