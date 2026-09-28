import { describe, expect, it } from 'vitest'
import { ResolutionError } from '../resolution/records.js'
import type { NameRecord } from '../resolution/records.js'
import type { DataGatherer, MountedSite, NameResolver, Namespace } from '../resolution/providers.js'
import { defineProtocol } from '../protocol.js'
import { ProtocolRegistry } from '../registry.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function record (cid = CID): NameRecord {
  return { type: 'contenthash', pointer: { kind: 'ipfs', cid }, provenance: { via: 'chain', block: 1, offchain: false } }
}

function resolver (id: string, namespaces: Namespace[], answer: () => Promise<NameRecord[]>, canonicalName?: (name: string) => string): NameResolver & { calls: string[] } {
  const calls: string[] = []
  return {
    id,
    namespaces,
    calls,
    ...(canonicalName === undefined ? {} : { canonicalName }),
    async resolve (name) {
      calls.push(name)
      return await answer()
    }
  }
}

/** One protocol declaring exactly the namespaces its resolvers answer, `.eth` when there are none. */
function registryOf (resolvers: NameResolver[], gatherers: DataGatherer[] = []): ProtocolRegistry {
  const namespaces = [...new Set(resolvers.flatMap((r) => r.namespaces))]
  const topLevelDomains = namespaces.filter((n) => n.startsWith('.')).map((n) => n.slice(1))
  const schemes = namespaces.filter((n) => n.endsWith(':')).map((n) => n.slice(0, -1))
  const descriptor = namespaces.length === 0 ? { id: 'test', schemes: [], topLevelDomains: ['eth'] } : { id: 'test', schemes, topLevelDomains }
  return new ProtocolRegistry([defineProtocol(descriptor, { resolvers, gatherers })])
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

describe('ProtocolRegistry.handles', () => {
  it('is true only for a name in a namespace some resolver declares', () => {
    const registry = registryOf([resolver('ens', ['.eth'], async () => [record()])])
    expect(registry.handles('vitalik.eth')).toBe(true)
    expect(registry.handles('example.com')).toBe(false)
    expect(registry.handles('eth')).toBe(false)
  })
})

describe('ProtocolRegistry.resolve', () => {
  it('asks the resolvers for that namespace in the order given, and returns the first answer', async () => {
    const first = resolver('first', ['.eth'], async () => [record('first')])
    const second = resolver('second', ['.eth'], async () => [record('second')])
    const registry = registryOf([first, second], [])
    const resolved = await registry.resolve('vitalik.eth')
    expect(resolved.resolver).toBe('first')
    expect(resolved.records).toEqual([record('first')])
    expect(second.calls).toEqual([])
  })

  it('falls back to the next resolver when one fails, and says which answered', async () => {
    const failing = resolver('failing', ['.eth'], async () => { throw new ResolutionError('unavailable', 'rpc down') })
    const second = resolver('second', ['.eth'], async () => [record()])
    const resolved = await registryOf([failing, second], []).resolve('vitalik.eth')
    expect(resolved.resolver).toBe('second')
    expect(failing.calls).toEqual(['vitalik.eth'])
  })

  it('never asks a resolver for a namespace it does not declare', async () => {
    const dns = resolver('other', ['.crypto'], async () => [record()])
    const ens = resolver('ens', ['.eth'], async () => [record()])
    await registryOf([dns, ens], []).resolve('vitalik.eth')
    expect(dns.calls).toEqual([])
  })

  it('refuses a name no resolver handles, as not found', async () => {
    await expect(registryOf([], []).resolve('example.com')).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('when every resolver fails, reports the most specific failure and every reason', async () => {
    const down = resolver('a', ['.eth'], async () => { throw new ResolutionError('unavailable', 'rpc down') })
    const syncing = resolver('b', ['.eth'], async () => { throw new ResolutionError('not-synced', 'light client syncing') })
    const error = await registryOf([down, syncing], []).resolve('vitalik.eth').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ResolutionError)
    expect((error as ResolutionError).failure).toBe('not-synced')
    expect((error as ResolutionError).message).toContain('a: rpc down')
    expect((error as ResolutionError).message).toContain('b: light client syncing')
  })

  it('treats an error that is not a ResolutionError as unavailable, never as a result', async () => {
    const broken = resolver('broken', ['.eth'], async () => { throw new TypeError('bug') })
    await expect(registryOf([broken], []).resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('treats an empty record list as not found, and falls back past it', async () => {
    const empty = resolver('empty', ['.eth'], async () => [])
    const second = resolver('second', ['.eth'], async () => [record()])
    expect((await registryOf([empty, second], []).resolve('vitalik.eth')).resolver).toBe('second')
    await expect(registryOf([empty], []).resolve('vitalik.eth')).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('passes the name on lowercased', async () => {
    const ens = resolver('ens', ['.eth'], async () => [record()])
    await registryOf([ens], []).resolve('Vitalik.ETH')
    expect(ens.calls).toEqual(['vitalik.eth'])
  })

  it('refuses a host with a trailing dot, which the resolver rules never route to the verifier', async () => {
    const ens = resolver('ens', ['.eth'], async () => [record()])
    await expect(registryOf([ens], []).resolve('vitalik.eth.')).rejects.toMatchObject({ failure: 'not-found' })
    expect(ens.calls).toEqual([])
  })
})

describe('ProtocolRegistry.mount', () => {
  it('uses the first gatherer, in order, that supports the records', async () => {
    const unsupported = gatherer('arweave', false, async () => site('arweave'))
    const ipfs = gatherer('ipfs', true, async () => site('ipfs'))
    const later = gatherer('later', true, async () => site('later'))
    const mounted = await registryOf([], [unsupported, ipfs, later]).mount('vitalik.eth', [record()])
    expect(mounted.gatherer).toBe('ipfs')
    expect(unsupported.mounts).toBe(0)
    expect(later.mounts).toBe(0)
  })

  it('falls back to the next supporting gatherer when one fails', async () => {
    const failing = gatherer('first', true, async () => { throw new ResolutionError('unavailable', 'every gateway down') })
    const second = gatherer('second', true, async () => site('second'))
    const mounted = await registryOf([], [failing, second]).mount('vitalik.eth', [record()])
    expect(mounted.gatherer).toBe('second')
  })

  it('is unsupported when no gatherer supports the records', async () => {
    const none = gatherer('ipfs', false, async () => site('ipfs'))
    await expect(registryOf([], [none]).mount('vitalik.eth', [record()])).rejects.toMatchObject({ failure: 'unsupported' })
  })

  it('when every supporting gatherer fails, reports the most specific failure', async () => {
    const down = gatherer('a', true, async () => { throw new ResolutionError('unavailable', 'gateway down') })
    const tampered = gatherer('b', true, async () => { throw new ResolutionError('unverifiable', 'block hash mismatch') })
    await expect(registryOf([], [down, tampered]).mount('vitalik.eth', [record()])).rejects.toMatchObject({ failure: 'unverifiable' })
  })
})

describe('ProtocolRegistry, for an address scheme', () => {
  it('routes <label>.<scheme>.orivon to that scheme\'s resolvers, with the name decoded from the label', async () => {
    const ipns = resolver('ipns', ['ipns:'], async () => [record()])
    const registry = registryOf([ipns])
    const resolved = await registry.resolve('en-wikipedia--on--ipfs-org.ipns.orivon')
    expect(resolved).toMatchObject({ name: 'en.wikipedia-on-ipfs.org', resolver: 'ipns' })
    expect(registry.handles('x.ipns.orivon')).toBe(true)
    expect(registry.handles('x.ipfs.orivon')).toBe(false)
  })

  it('tries resolvers in the order their protocols were given', async () => {
    const first = resolver('first', ['ipfs:'], async () => { throw new ResolutionError('unavailable', 'down') })
    const second = resolver('second', ['ipfs:'], async () => [record()])
    const registry = new ProtocolRegistry([
      defineProtocol({ id: 'a', schemes: ['ipfs'], topLevelDomains: [] }, { resolvers: [first] }),
      defineProtocol({ id: 'b', schemes: ['ipfs'], topLevelDomains: [] }, { resolvers: [second] })
    ])
    expect((await registry.resolve(`${CID}.ipfs.orivon`)).resolver).toBe('second')
  })

  it('canonicalises a written name through the first resolver that can, and lowercases otherwise', () => {
    const plain = resolver('plain', ['foo:'], async () => [])
    const upper = resolver('upper', ['foo:'], async () => [], (name) => name.toUpperCase())
    expect(registryOf([plain, upper]).canonicalName('foo', 'Abc')).toBe('ABC')
    expect(registryOf([plain]).canonicalName('foo', 'Abc')).toBe('abc')
    expect(() => registryOf([plain]).canonicalName('bar', 'abc')).toThrow(ResolutionError)
  })
})
