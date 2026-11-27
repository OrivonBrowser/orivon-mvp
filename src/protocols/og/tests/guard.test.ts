import { describe, expect, it } from 'vitest'
import { ChainError } from '../chain.js'
import type { Census } from '../census.js'
import { implementationIn } from '../guard.js'
import { resolveOg } from '../lookup.js'
import { TOPICS, UPGRADES } from '../pins.js'
import { createSession, OgRefusal } from '../tail.js'
import { censusAt, fakeChain, FIRST_BLOCK, upgradedLog, worldOf } from './world.js'
import type { Faults } from './world.js'
import { VECTORS } from './vectors.js'

const vector = (id: string): (typeof VECTORS)[number] => VECTORS.find((one) => one.id === id) as (typeof VECTORS)[number]
const CHECKPOINT = FIRST_BLOCK - 1_000
const PASSES = vector('unwrapped-passes')
const OTHER_CODE = `0x${'cd'.repeat(20)}`
const IPFS = [{ kind: 'ipfs', cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }]

async function lookup (setup: { implementation?: string, logs?: ReturnType<typeof upgradedLog>[], faults?: Faults, upgrades?: Census['upgrades'] } = {}, which = PASSES): Promise<{ answer: () => ReturnType<typeof resolveOg>, asked: ReturnType<typeof fakeChain>['asked'] }> {
  const world = worldOf(which, { spread: 300 })
  if (setup.implementation !== undefined) world.implementation = setup.implementation
  world.logs.push(...(setup.logs ?? []))
  const made = fakeChain(world, setup.faults === undefined ? {} : { faults: setup.faults })
  const carried: Census = { ...censusAt(CHECKPOINT), upgrades: setup.upgrades ?? censusAt(CHECKPOINT).upgrades }
  return { asked: made.asked, answer: async () => await resolveOg(made.chain, which.label, { session: createSession(), census: carried }) }
}

const pointers = (records: Awaited<ReturnType<typeof resolveOg>>): unknown[] => records.map((record) => record.pointer)

describe('the guard on the resolver contract', () => {
  it('lets a record through when the proxy runs the implementation the bundle was built for and nothing was upgraded since', async () => {
    const { answer } = await lookup()
    expect(pointers(await answer())).toEqual(IPFS)
  })

  it('reads the slot a node may have trimmed of its leading zeros', async () => {
    const { answer } = await lookup({ faults: { trimSlot: true } })
    expect(await answer()).toHaveLength(1)
    expect(implementationIn('0xabcd')).toBe(`0x${'0'.repeat(36)}abcd`)
  })

  it('refuses in words when the implementation slot holds other code, and answers no record', async () => {
    const { answer } = await lookup({ implementation: OTHER_CODE })
    const failure = await answer().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgRefusal)
    expect(failure).toMatchObject({ message: expect.stringMatching(/runs code this resolver was not built for.*Update the \.og resolver/) })
  })

  it('refuses when an Upgraded log of the proxy is in the tail, though the slot holds the right code again', async () => {
    const { answer } = await lookup({ logs: [upgradedLog(FIRST_BLOCK + 100), upgradedLog(FIRST_BLOCK + 200, UPGRADES[3]?.implementation)] })
    await expect(answer()).rejects.toMatchObject({ name: 'OgRefusal', message: expect.stringMatching(/was upgraded after this resolver was built/) })
  })

  it('refuses every record when the census lists upgrades other than the pinned ones, whatever the slot and the tail say', async () => {
    const other = { block: 20_000_000, logIndex: 0, implementation: OTHER_CODE }
    const back = { block: 20_000_002, logIndex: 0, implementation: UPGRADES[3]?.implementation as string }
    const pinned = [...UPGRADES]
    for (const [what, upgrades] of [
      ['a round trip before the checkpoint', [...pinned, other, back]],
      ['one upgrade missing', pinned.slice(1)],
      ['none listed', []],
      ['another implementation in the list', [...pinned.slice(0, 3), { ...pinned[3] as (typeof pinned)[number], implementation: OTHER_CODE }]],
      ['the same upgrades in another place', [...pinned.slice(0, 3), { ...pinned[3] as (typeof pinned)[number], logIndex: 224 }]],
      ['an entry that is not an upgrade', [...pinned.slice(0, 3), { block: 17_161_959, logIndex: 223, implementation: 3 as unknown as string }]]
    ] as const) {
      const { answer } = await lookup({ upgrades: [...upgrades] })
      const failure = await answer().catch((error: unknown) => error)
      expect(failure, what).toBeInstanceOf(OgRefusal)
      expect(failure, what).toMatchObject({ message: expect.stringMatching(/upgrades of the contract that holds \.og records.*not the ones this resolver was built for.*Update the \.og resolver/) })
    }
  })

  it('does not refuse for an upgrade before the checkpoint: the bundle lists those', async () => {
    const { answer } = await lookup({ logs: [upgradedLog(CHECKPOINT - 500), upgradedLog(CHECKPOINT)] })
    expect(await answer()).toHaveLength(1)
  })

  it('does not take a log of another contract with the same topic for an upgrade of the proxy', async () => {
    const stray = { ...upgradedLog(FIRST_BLOCK + 100), address: `0x${'ee'.repeat(20)}` }
    const { answer } = await lookup({ logs: [stray], faults: { anyAddress: true } })
    expect(await answer()).toHaveLength(1)
  })

  it("refuses when a scan fails because the node's answer cannot be read, as a refusal and never as no upgrade", async () => {
    for (const reason of ['badAnswer', 'invalid', 'reverted'] as const) {
      const { answer } = await lookup({ faults: { logs: (filter) => filter.topics?.[0] === TOPICS.upgraded ? new ChainError(reason, 'garbled') : undefined } })
      await expect(answer(), reason).rejects.toBeInstanceOf(OgRefusal)
    }
  })

  it('refuses when the scan of the name fails the same way', async () => {
    const { answer } = await lookup({ faults: { logs: (filter) => filter.topics?.[1] === undefined ? undefined : new ChainError('badAnswer', 'garbled') } })
    await expect(answer()).rejects.toBeInstanceOf(OgRefusal)
  })

  it('throws what the node threw when it cannot be asked at all, so the resolver reports it as unavailable', async () => {
    for (const reason of ['unavailable', 'limit'] as const) {
      const { answer } = await lookup({ faults: { logs: () => new ChainError(reason, 'down') } })
      const failure = await answer().catch((error: unknown) => error)
      expect(failure, reason).toBeInstanceOf(ChainError)
      expect(failure, reason).toMatchObject({ reason })
      expect(failure).not.toBeInstanceOf(OgRefusal)
    }
  })

  it('is not asked for a name with nothing to vouch for, which needs no node call but the read of its state', async () => {
    for (const id of ['unwrapped-no-records-mainnet', 'wrapped-no-records-mainnet', 'free-label', 'non-content-record-only-mainnet']) {
      const { answer, asked } = await lookup({ implementation: OTHER_CODE }, vector(id))
      expect(await answer(), id).toEqual([])
      expect(asked.storage, id).toEqual([])
      expect(asked.logs, id).toEqual([])
    }
  })

  it('keeps a controller that is not the holder out without asking for any history', async () => {
    const { answer, asked } = await lookup({}, vector('wrapped-controller-not-holder'))
    expect(await answer()).toEqual([])
    expect(asked.logs).toEqual([])
  })
})
