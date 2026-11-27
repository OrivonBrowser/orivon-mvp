import { describe, expect, it } from 'vitest'
import { ResolutionError } from '../../resolution/records.js'
import type { NameRecord } from '../../resolution/records.js'
import type { Eip1193Provider } from '../../ens/resolver.js'
import { hashOf } from '../hex.js'
import { keyOf } from '../name.js'
import { createOgResolver, DEFAULT_BUDGET_MS } from '../resolver.js'
import { TOPICS } from '../pins.js'
import { censusAt, fakeProvider, FIRST_BLOCK, worldOf } from './world.js'
import type { Faults, World } from './world.js'
import { VECTORS } from './vectors.js'

const vector = (id: string): (typeof VECTORS)[number] => VECTORS.find((one) => one.id === id) as (typeof VECTORS)[number]
const PASSES = vector('unwrapped-passes')
const CHECKPOINT = FIRST_BLOCK - 1_000
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const ARWEAVE = `ar://${'A'.repeat(43)}`
const failure = async (promise: Promise<unknown>): Promise<ResolutionError> => {
  const error = await promise.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(ResolutionError)
  return error as ResolutionError
}

function resolverOver (world: World, options: { faults?: Faults, budgetMs?: number, now?: () => number, provider?: Eip1193Provider } = {}): { resolve: (host: string, signal?: AbortSignal) => Promise<NameRecord[]>, provider: ReturnType<typeof fakeProvider> } {
  const provider = fakeProvider(world, options.faults === undefined ? {} : { faults: options.faults })
  const resolver = createOgResolver({ provider: options.provider ?? provider, census: censusAt(CHECKPOINT), ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }), ...(options.now === undefined ? {} : { now: options.now }) })
  expect(resolver).toMatchObject({ id: 'og', namespaces: ['.og'] })
  return { resolve: async (host, signal) => await resolver.resolve(host, signal), provider }
}

describe('createOgResolver', () => {
  it("answers a name's counted records as proven contenthash records at the block every read was made at", async () => {
    const world = worldOf(PASSES, { spread: 300 })
    const { resolve } = resolverOver(world)
    expect(await resolve(`${PASSES.label}.og`)).toEqual([{ type: 'contenthash', pointer: { kind: 'ipfs', cid: CID }, provenance: { via: 'chain', block: world.head, offchain: false } }])
  })

  it('answers no records for a name nobody holds, so the registry reports it as not found', async () => {
    const free = vector('free-label')
    const { resolve } = resolverOver(worldOf(free, { spread: 300 }))
    expect(await resolve(`${free.label}.og`)).toEqual([])
  })

  it('answers no records for a held name with none that count', async () => {
    const left = vector('unwrapped-sellers-leftover')
    const { resolve } = resolverOver(worldOf(left, { spread: 300 }))
    expect(await resolve(`${left.label}.og`)).toEqual([])
  })

  it('refuses a host that is not a .og name, or whose label no one can hold, before asking the node anything', async () => {
    const { resolve, provider } = resolverOver(worldOf(PASSES, { spread: 300 }))
    for (const host of ['alice.eth', 'Alice.og', 'www.alice.og', 'xn--vitlik-6qa.og', `${'a'.repeat(33)}.og`, '.og']) {
      expect((await failure(resolve(host))).failure, host).toBe('invalid-name')
    }
    expect(provider.asked.blocks).toEqual([])
  })

  it('opens the IPFS record of a name that also has an Arweave one, and lists the Arweave record as one this build cannot load', async () => {
    const world = worldOf(PASSES, { spread: 300 })
    world.names[PASSES.label]!.values['content.arw'] = ARWEAVE
    world.logs.push({ address: world.logs[1]!.address, blockNumber: FIRST_BLOCK + 600, logIndex: 1, topics: [TOPICS.setTextRecord, keyOf(PASSES.label), hashOf('content.arw'), hashOf(ARWEAVE)] })
    const { resolve } = resolverOver(world)
    const records = await resolve(`${PASSES.label}.og`)
    expect(records.map((record) => record.pointer)).toEqual([{ kind: 'ipfs', cid: CID }, { kind: 'unsupported', protocol: 'arweave' }])
  })

  it('answers from the census bundled beside it when none is given', async () => {
    const live = vector('unwrapped-passes-mainnet')
    const world = worldOf(live, { head: 26_451_224 + 100 })
    const provider = fakeProvider(world)
    const records = await createOgResolver({ provider }).resolve(`${live.label}.og`)
    expect(records.map((record) => record.pointer)).toEqual([{ kind: 'unsupported', protocol: 'web3' }])
  })

  it('keeps the light client\'s own failures as they are: not synced, a proof that failed', async () => {
    for (const failureKind of ['not-synced', 'unverifiable'] as const) {
      const { resolve } = resolverOver(worldOf(PASSES, { spread: 300 }), { provider: { request: async () => { throw new ResolutionError(failureKind, 'the light client said so') } } })
      expect((await failure(resolve(`${PASSES.label}.og`))).failure).toBe(failureKind)
    }
  })

  it('says unavailable when the node cannot be asked, whatever it threw', async () => {
    const { resolve } = resolverOver(worldOf(PASSES, { spread: 300 }), { provider: { request: async () => { throw new Error('connection reset') } } })
    const error = await failure(resolve(`${PASSES.label}.og`))
    expect(error.failure).toBe('unavailable')
    expect(error.message).toMatch(/connection reset/)
  })

  it('refuses when the resolver contract runs other code, as unavailable and in words', async () => {
    const world = worldOf(PASSES, { spread: 300 })
    world.implementation = `0x${'cd'.repeat(20)}`
    const error = await failure(resolverOver(world).resolve(`${PASSES.label}.og`))
    expect(error.failure).toBe('unavailable')
    expect(error.message).toMatch(/Update the \.og resolver/)
  })

  it('stops with unavailable when the asker leaves', async () => {
    const controller = new AbortController()
    controller.abort(new Error('left'))
    const error = await failure(resolverOver(worldOf(PASSES, { spread: 300 })).resolve(`${PASSES.label}.og`, controller.signal))
    expect(error.failure).toBe('unavailable')
  })
})

describe('the time a resolution may take', () => {
  it('has a default that leaves most of the 45 seconds a mount waits for the content', () => {
    expect(DEFAULT_BUDGET_MS).toBeLessThan(45_000 / 1.25)
  })

  it('refuses in words as unavailable when the recent history cannot be read in time, and a reload continues from the windows already read', async () => {
    let t = 1_000_000
    const world = worldOf(PASSES, { spread: 300, head: FIRST_BLOCK + 150_000 })
    const { resolve, provider } = resolverOver(world, { faults: { logs: () => { t += 1_000; return undefined } }, budgetMs: 30_000, now: () => t })
    let refusals = 0
    let records: NameRecord[] | undefined
    while (records === undefined && refusals < 20) {
      try {
        records = await resolve(`${PASSES.label}.og`)
      } catch (error) {
        expect(error).toBeInstanceOf(ResolutionError)
        expect((error as ResolutionError).failure).toBe('unavailable')
        expect((error as ResolutionError).message).toMatch(/Still checking .* of \d+ stretches of the chain are left.*try again shortly/)
        refusals++
      }
    }
    expect(refusals).toBeGreaterThan(0)
    expect(records?.map((record) => record.pointer)).toEqual([{ kind: 'ipfs', cid: CID }])
    // A window is read once: the repeats are the few windows within 64 blocks of the head, which may still change.
    const asks = provider.asked.logs.map((filter) => JSON.stringify([filter.address, filter.topics, filter.fromBlock, filter.toBlock]))
    expect(asks.length - new Set(asks).size).toBeLessThanOrEqual(2 * refusals + 4)
  })
})
