// The protocols one Ethereum light client proves names for: `.eth` and `.og`, each with its own resolvers.

import { describe, expect, it } from 'vitest'
import { ChainError } from '../../og/chain.js'
import bundledCensus from '../../og/census.json'
import { VECTORS } from '../../og/tests/vectors.js'
import { fakeProvider, worldOf } from '../../og/tests/world.js'
import type { World } from '../../og/tests/world.js'
import { ProtocolRegistry } from '../../registry.js'
import { ResolutionError } from '../../resolution/records.js'
import { createFixtureResolver } from '../fixture-resolver.js'
import type { HostConfig } from '../protocol.js'
import { ethereumNames, offResolver } from '../protocols.js'
import type { HostDeps } from '../service.js'

const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'

function config (fixtures?: Record<string, string>): HostConfig {
  return { ...(fixtures === undefined ? {} : { fixtures }) } as unknown as HostConfig
}

function deps (fixturesAllowed: boolean): HostDeps {
  return { fixturesAllowed } as unknown as HostDeps
}

const provider = { request: async (): Promise<unknown> => { throw new Error('the provider is not asked in this test') } }
const ccipRequest = async (): Promise<`0x${string}`> => { throw new Error('no CCIP-Read in this test') }

describe('the protocols a light client proves names for', () => {
  it('are `.eth` then `.og`, each answering its own namespace only', () => {
    const protocols = ethereumNames(config(), deps(false), { provider, ccipRequest })
    expect(protocols.map((p) => p.descriptor.id)).toEqual(['ens', 'og'])
    expect(protocols.map((p) => p.resolvers.map((r) => [r.id, ...r.namespaces]))).toEqual([[['ens', '.eth']], [['og', '.og']]])
  })

  it('answer every name with the reason when the light client is off, each under its own id', async () => {
    const protocols = ethereumNames(config(), deps(false), { off: 'the light client is off, so no .eth or .og name can be verified' })
    const registry = new ProtocolRegistry(protocols)
    for (const host of ['vitalik.eth', 'linagee.og']) {
      const failure = await registry.resolve(host).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ResolutionError)
      expect((failure as ResolutionError).failure).toBe('unavailable')
      expect((failure as ResolutionError).message).toContain('no .eth or .og name can be verified')
    }
    expect(protocols.map((p) => p.resolvers.map((r) => r.id))).toEqual([['ens'], ['og']])
  })

  it('give a test build\'s fixture names their own protocol, ahead of the light client', async () => {
    const protocols = ethereumNames(config({ 'fixture.eth': `ipfs://${CID}`, 'fixture.og': `ipns://k51qzi5uqu5dgtwmsgn9hnlo4oj2zkg6dealewvsaq9h9gwd454si59i0vpl0s` }), deps(true), { off: 'off' })
    expect(protocols.map((p) => p.resolvers.map((r) => [r.id, ...r.namespaces]))).toEqual([[['fixture', '.eth'], ['ens', '.eth']], [['fixture', '.og'], ['og', '.og']]])
    const registry = new ProtocolRegistry(protocols)
    expect((await registry.resolve('fixture.eth')).records[0]?.pointer).toEqual({ kind: 'ipfs', cid: CID })
    expect((await registry.resolve('fixture.og')).records[0]?.pointer.kind).toBe('ipns-key')
  })

  it('hold no fixture name when the build does not allow them', () => {
    const protocols = ethereumNames(config({ 'fixture.og': `ipfs://${CID}` }), deps(false), { off: 'off' })
    expect(protocols.flatMap((p) => p.resolvers.map((r) => r.id))).toEqual(['ens', 'og'])
  })
})

describe('a `.og` name whose history the light client cannot prove', () => {
  const PASSING = VECTORS.find((one) => one.id === 'unwrapped-passes') as (typeof VECTORS)[number]
  const HEAD = bundledCensus.block + 60_000
  const RING = 8_191
  const records = { kind: 'ipfs', cid: CID }

  /** Written well after the bundled census and long before the newest blocks, so the light client's ring no longer holds it. */
  const written = (): World => worldOf(PASSING, { spread: 300, head: HEAD, first: bundledCensus.block + 2_000 })
  /** A light client that proves only the newest blocks, and says so in the words Helios uses for an older one. */
  const lightClient = (world: World): ReturnType<typeof fakeProvider> => fakeProvider(world, {
    faults: {
      logs: (filter) => filter.fromBlock < world.head - RING ? new ChainError('invalid', `block ${String(filter.fromBlock)} is outside EIP-2935 ring buffer range`) : undefined,
      transactionAt: (block) => block < world.head - RING ? new ChainError('invalid', `block ${String(block)} is outside EIP-2935 ring buffer range`) : undefined
    }
  })
  const resolveOn = async (provider: ReturnType<typeof fakeProvider>, servers?: ReturnType<typeof fakeProvider>): Promise<unknown> => {
    const protocols = ethereumNames(config(), deps(false), { provider, ccipRequest, ...(servers === undefined ? {} : { servers }) })
    return (await new ProtocolRegistry(protocols).resolve(`${PASSING.label}.og`)).records.map((record) => record.pointer)
  }

  it('is answered from the servers `ethereumNames` is given, which the light client\'s own reads never reach', async () => {
    const world = written()
    const proven = lightClient(world)
    const servers = fakeProvider(world, { maxSpan: 10_000 })
    expect(await resolveOn(proven, servers)).toEqual([records])
    expect(servers.asked.logs.length).toBeGreaterThan(0)
    expect(servers.asked.calls).toEqual([])
    expect(servers.asked.storage).toEqual([])
    expect(proven.asked.calls.length).toBeGreaterThan(0)
    for (const filter of proven.asked.logs) expect(filter.fromBlock).toBeGreaterThanOrEqual(HEAD - RING)
  })

  it('is refused in words when `ethereumNames` is given no servers, since nothing else can read the old stretch', async () => {
    await expect(resolveOn(lightClient(written()))).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('is answered as it always was, from the provider alone, when the provider serves the whole range', async () => {
    const world = written()
    const provider = fakeProvider(world)
    expect(await resolveOn(provider)).toEqual([records])
    expect(provider.asked.logs.some((filter) => filter.fromBlock < HEAD - RING)).toBe(true)
  })
})

describe('the resolver that says why a name cannot be proved', () => {
  it('answers `.eth` as `ens` unless it is given another protocol', () => {
    expect(offResolver('why')).toMatchObject({ id: 'ens', namespaces: ['.eth'] })
  })
})

describe('a fixture resolver', () => {
  const names = { 'a.eth': `ipfs://${CID}`, 'b.og': `ipfs://${CID}` }

  it('holds only the names under its namespace', async () => {
    const eth = createFixtureResolver(names, '.eth')
    const og = createFixtureResolver(names, '.og')
    expect(eth.namespaces).toEqual(['.eth'])
    expect(og.namespaces).toEqual(['.og'])
    expect((await og.resolve('b.og'))[0]?.provenance).toEqual({ via: 'fixture' })
    await expect(og.resolve('a.eth')).rejects.toMatchObject({ failure: 'unavailable' })
    await expect(eth.resolve('b.og')).rejects.toMatchObject({ failure: 'unavailable' })
  })

  it('refuses a name under no namespace of a built-in resolver, whichever namespace it is built for', () => {
    expect(() => createFixtureResolver({ 'a.example': `ipfs://${CID}` }, '.og')).toThrow(/not a \.eth or \.og name/)
    expect(() => createFixtureResolver({ 'a.eth': `ipfs://${CID}`, 'a.example': `ipfs://${CID}` }, '.eth')).toThrow(/a\.example/)
  })

  it('refuses a value that points at nothing it can load', () => {
    expect(() => createFixtureResolver({ 'a.og': 'https://example.com' }, '.og')).toThrow(/a\.og/)
  })
})
