import { describe, expect, it } from 'vitest'
import type { DataGatherer, MountedSite } from '../../resolution/providers.js'
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

describe('the node-first gatherer', () => {
  it('mounts from the node once it is ready, and never touches the gateways', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({ node: gatherer('node', calls), gateways: gatherer('gateways', calls), ready: async () => {} })
    expect((await first.mount('a.eth', RECORDS)).servedFrom).toEqual({ kind: 'node' })
    expect(calls).toEqual(['node'])
  })

  it('mounts from the gateways, with the reason, when the node cannot serve', async () => {
    const calls: string[] = []
    const first = createNodeFirstGatherer({
      node: gatherer('node', calls),
      gateways: gatherer('gateways', calls),
      ready: async () => { throw new Error('a proxy is configured') }
    })
    expect((await first.mount('a.eth', RECORDS)).servedFrom).toEqual({ kind: 'gateways', reason: 'a proxy is configured' })
    expect(calls).toEqual(['gateways'])
  })

  it('does not fall back for a mount that was abandoned', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const first = createNodeFirstGatherer({
      node: gatherer('node', calls),
      gateways: gatherer('gateways', calls),
      ready: async () => { controller.abort(); throw new Error('aborted') }
    })
    await expect(first.mount('a.eth', RECORDS, controller.signal)).rejects.toBeDefined()
    expect(calls).toEqual([])
  })

  it('supports what the node gatherer supports', () => {
    const first = createNodeFirstGatherer({ node: { ...gatherer('node', []), supports: () => false }, gateways: gatherer('gateways', []), ready: async () => {} })
    expect(first.supports(RECORDS)).toBe(false)
    expect(first.id).toBe('ipfs')
  })
})
