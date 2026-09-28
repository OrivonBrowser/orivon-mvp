import { describe, expect, it } from 'vitest'
import { ResolutionError } from '../records.js'
import type { NameRecord } from '../records.js'
import type { DataGatherer, MountedSite, NameResolver } from '../providers.js'
import { ResolutionRegistry, topLevelDomain } from '../registry.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function record (cid = CID): NameRecord {
  return { type: 'contenthash', pointer: { kind: 'ipfs', cid }, provenance: { via: 'chain', block: 1, offchain: false } }
}

function resolver (id: string, tlds: string[], answer: () => Promise<NameRecord[]>): NameResolver & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    topLevelDomains: tlds,
    calls,
    async resolve (name) {
      calls.push(name)
      return await answer()
    }
  }
}

function site (gathererId: string): MountedSite {
  return {
    gatherer: gathererId,
    root: { kind: 'ipfs', cid: CID },
    pointers: [],
    open: async () => { throw new Error('not used') },
    ddoc: () => ({ status: 'met', refusals: [] })
  }
}

function gatherer (id: string, supports: boolean, mount: () => Promise<MountedSite>): DataGatherer & { mounts: number } {
  const g = {
    id,
    mounts: 0,
    supports: () => supports,
    async mount () {
      g.mounts++
      return await mount()
    }
  }
  return g
}

describe('topLevelDomain', () => {
  it('is the last label, lowercased, with a trailing dot ignored', () => {
    expect(topLevelDomain('Vitalik.ETH')).toBe('eth')
    expect(topLevelDomain('app.ens.eth.')).toBe('eth')
  })

  it('is undefined for a single label or an empty name', () => {
    expect(topLevelDomain('localhost')).toBeUndefined()
    expect(topLevelDomain('')).toBeUndefined()
  })
})

describe('ResolutionRegistry.handles', () => {
  it('is true only for a top-level domain some resolver declares', () => {
    const registry = new ResolutionRegistry([resolver('ens', ['eth'], async () => [record()])], [])
    expect(registry.handles('vitalik.eth')).toBe(true)
    expect(registry.handles('example.com')).toBe(false)
    expect(registry.handles('eth')).toBe(false)
  })
})

describe('ResolutionRegistry.resolve', () => {
  it('asks the resolvers for that top-level domain in the order given, and returns the first answer', async () => {
    const first = resolver('first', ['eth'], async () => [record('first')])
    const second = resolver('second', ['eth'], async () => [record('second')])
    const registry = new ResolutionRegistry([first, second], [])
    const resolved = await registry.resolve('vitalik.eth')
    expect(resolved.resolver).toBe('first')
    expect(resolved.records).toEqual([record('first')])
    expect(second.calls).toEqual([])
  })

  it('falls back to the next resolver when one fails, and says which answered', async () => {
    const failing = resolver('failing', ['eth'], async () => { throw new ResolutionError('unavailable', 'rpc down') })
    const second = resolver('second', ['eth'], async () => [record()])
    const resolved = await new ResolutionRegistry([failing, second], []).resolve('vitalik.eth')
    expect(resolved.resolver).toBe('second')
    expect(failing.calls).toEqual(['vitalik.eth'])
  })

  it('never asks a resolver for a top-level domain it does not declare', async () => {
    const dns = resolver('other', ['crypto'], async () => [record()])
    const ens = resolver('ens', ['eth'], async () => [record()])
    await new ResolutionRegistry([dns, ens], []).resolve('vitalik.eth')
    expect(dns.calls).toEqual([])
  })

  it('refuses a name no resolver handles, as not found', async () => {
    await expect(new ResolutionRegistry([], []).resolve('example.com')).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('when every resolver fails, reports the most specific failure and every reason', async () => {
    const down = resolver('a', ['eth'], async () => { throw new ResolutionError('unavailable', 'rpc down') })
    const syncing = resolver('b', ['eth'], async () => { throw new ResolutionError('not-synced', 'light client syncing') })
    const error = await new ResolutionRegistry([down, syncing], []).resolve('vitalik.eth').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ResolutionError)
    expect((error as ResolutionError).failure).toBe('not-synced')
    expect((error as ResolutionError).message).toContain('a: rpc down')
    expect((error as ResolutionError).message).toContain('b: light client syncing')
  })

  it('treats an error that is not a ResolutionError as unavailable, never as a result', async () => {
    const broken = resolver('broken', ['eth'], async () => { throw new TypeError('bug') })
    await expect(new ResolutionRegistry([broken], []).resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('treats an empty record list as not found, and falls back past it', async () => {
    const empty = resolver('empty', ['eth'], async () => [])
    const second = resolver('second', ['eth'], async () => [record()])
    expect((await new ResolutionRegistry([empty, second], []).resolve('vitalik.eth')).resolver).toBe('second')
    await expect(new ResolutionRegistry([empty], []).resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('passes the name on lowercased and without a trailing dot', async () => {
    const ens = resolver('ens', ['eth'], async () => [record()])
    await new ResolutionRegistry([ens], []).resolve('Vitalik.ETH.')
    expect(ens.calls).toEqual(['vitalik.eth'])
  })
})

describe('ResolutionRegistry.mount', () => {
  it('uses the first gatherer, in order, that supports the records', async () => {
    const unsupported = gatherer('arweave', false, async () => site('arweave'))
    const ipfs = gatherer('ipfs', true, async () => site('ipfs'))
    const later = gatherer('later', true, async () => site('later'))
    const mounted = await new ResolutionRegistry([], [unsupported, ipfs, later]).mount('vitalik.eth', [record()])
    expect(mounted.gatherer).toBe('ipfs')
    expect(unsupported.mounts).toBe(0)
    expect(later.mounts).toBe(0)
  })

  it('falls back to the next supporting gatherer when one fails', async () => {
    const failing = gatherer('first', true, async () => { throw new ResolutionError('unavailable', 'every gateway down') })
    const second = gatherer('second', true, async () => site('second'))
    const mounted = await new ResolutionRegistry([], [failing, second]).mount('vitalik.eth', [record()])
    expect(mounted.gatherer).toBe('second')
  })

  it('is unsupported when no gatherer supports the records', async () => {
    const none = gatherer('ipfs', false, async () => site('ipfs'))
    await expect(new ResolutionRegistry([], [none]).mount('vitalik.eth', [record()])).rejects.toMatchObject({ failure: 'unsupported' })
  })

  it('when every supporting gatherer fails, reports the most specific failure', async () => {
    const down = gatherer('a', true, async () => { throw new ResolutionError('unavailable', 'gateway down') })
    const tampered = gatherer('b', true, async () => { throw new ResolutionError('unverifiable', 'block hash mismatch') })
    await expect(new ResolutionRegistry([], [down, tampered]).mount('vitalik.eth', [record()])).rejects.toMatchObject({ failure: 'unverifiable' })
  })
})
