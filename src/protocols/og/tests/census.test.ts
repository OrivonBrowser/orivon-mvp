import { encodeFunctionData, getAddress, parseAbi } from 'viem'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { slotPointer } from '../answer.js'
import { CENSUS_FORMAT, mergedLogs, readCensus } from '../census.js'
import type { Census, NameEntry } from '../census.js'
import { addressTopic } from '../freshness.js'
import { ZERO_ADDRESS, ZERO_WORD, hashOf } from '../hex.js'
import { resolveOg } from '../lookup.js'
import { keyOf } from '../name.js'
import { IMPLEMENTATION, PROXY, REGISTRY, TOPICS, UPGRADES } from '../pins.js'
import { createSession } from '../tail.js'
import bundled from '../census.json'
import { fakeChain } from './world.js'
import type { NameState, World, WorldLog } from './world.js'

const address = (n: number): string => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
const ALICE = address(0xa11ce)
const BOB = address(0xb0b)
const CHECKPOINT = 20_000_000
const HEAD = CHECKPOINT + 3_000
const KEY = keyOf('sitename')
const V1 = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const V2 = 'ipfs://bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4'

const changed = (blockNumber: number, logIndex = 0): WorldLog => ({ address: REGISTRY, blockNumber, logIndex, topics: [TOPICS.changed, KEY] })
const written = (value: string, blockNumber: number, logIndex = 0): WorldLog => ({ address: PROXY, blockNumber, logIndex, topics: [TOPICS.setTextRecord, KEY, hashOf('content.ipfs'), hashOf(value)] })
const controlled = (controller: string, blockNumber: number, logIndex = 0): WorldLog => ({ address: PROXY, blockNumber, logIndex, topics: [TOPICS.newController, KEY, addressTopic(controller)] })

const entry = (overrides: Partial<NameEntry> = {}, value = V1, at = CHECKPOINT - 100): NameEntry => ({
  holder: ALICE, wrapped: false, id: null, holderChange: { block: CHECKPOINT - 500, logIndex: 0 }, newController: null, registry: null,
  keys: { 'content.ipfs': { valueHash: hashOf(value), log: { block: at, logIndex: 0, valueHash: hashOf(value) }, counts: true, reason: 'passes' } },
  ...overrides
})
const census = (names: Record<string, NameEntry> = {}): Census => ({ format: CENSUS_FORMAT, block: CHECKPOINT, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names })

const cidOf = (value: string): { kind: 'ipfs', cid: string } => ({ kind: 'ipfs', cid: value.replace('ipfs://', '') })

/** The name `sitename` as the chain has it now, with the logs after the checkpoint that the node would return: the pointers that count. */
async function answer (options: { now?: Partial<NameState>, tail?: WorldLog[], census: Census }): Promise<unknown[]> {
  const state: NameState = { registryOwner: ALICE, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: ZERO_ADDRESS, values: { 'content.ipfs': V2 }, ...options.now }
  const world: World = { head: HEAD, names: { sitename: state }, logs: options.tail ?? [], implementation: IMPLEMENTATION }
  return (await resolveOg(fakeChain(world).chain, 'sitename', { session: createSession(), census: options.census })).map((record) => record.pointer)
}

describe('a name in the census, read with the history after the checkpoint', () => {
  it('keeps a record the bundle vouched for when nothing happened since', async () => {
    expect(await answer({ now: { values: { 'content.ipfs': V1 } }, census: census({ sitename: entry() }) })).toEqual([cidOf(V1)])
  })

  it('keeps a value that changed after the checkpoint when its log is in the tail', async () => {
    expect(await answer({ tail: [written(V2, CHECKPOINT + 50)], census: census({ sitename: entry() }) })).toEqual([cidOf(V2)])
  })

  it('fails closed on a value that changed with no log for it in the tail: the node left it out, or the value is not a write', async () => {
    expect(await answer({ census: census({ sitename: entry() }) })).toEqual([])
    expect(await answer({ tail: [written(V1, CHECKPOINT + 50)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('fails closed when the holder now is not the holder the census names and the tail shows no change of holder', async () => {
    expect(await answer({ now: { registryOwner: BOB, values: { 'content.ipfs': V1 } }, census: census({ sitename: entry() }) })).toEqual([])
    expect(await answer({ now: { registryOwner: BOB, values: { 'content.ipfs': V1 } }, tail: [written(V1, CHECKPOINT + 50)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('keeps a record the new holder wrote after a change of holder that the tail shows', async () => {
    const now = { registryOwner: BOB }
    expect(await answer({ now, tail: [changed(CHECKPOINT + 10), written(V2, CHECKPOINT + 20)], census: census({ sitename: entry() }) })).toEqual([cidOf(V2)])
    expect(await answer({ now, tail: [written(V2, CHECKPOINT + 20), changed(CHECKPOINT + 30)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('drops a record the bundle vouched for when a change of the name in the registry comes after it in the tail', async () => {
    const now = { values: { 'content.ipfs': V1 } }
    expect(await answer({ now, tail: [changed(CHECKPOINT + 30)], census: census({ sitename: entry() }) })).toEqual([])
  })

  it('drops a record the bundle vouched for when a new controller is named after it, and takes it back when it is written again', async () => {
    const now = { values: { 'content.ipfs': V1 } }
    expect(await answer({ now, tail: [controlled(ALICE, CHECKPOINT + 30)], census: census({ sitename: entry() }) })).toEqual([])
    expect(await answer({ now, tail: [controlled(ALICE, CHECKPOINT + 30), written(V1, CHECKPOINT + 40)], census: census({ sitename: entry() }) })).toEqual([cidOf(V1)])
  })

  it('fails closed when the census says the name was wrapped and the chain now says it is not', async () => {
    expect(await answer({ now: { values: { 'content.ipfs': V1 } }, census: census({ sitename: entry({ wrapped: true, id: '5' }) }) })).toEqual([])
  })

  it('keeps a record written after the checkpoint on a name the census does not list, since its holder changed before the checkpoint', async () => {
    expect(await answer({ tail: [written(V2, CHECKPOINT + 50)], census: census() })).toEqual([cidOf(V2)])
    expect(await answer({ tail: [written(V2, CHECKPOINT + 50), changed(CHECKPOINT + 60)], census: census() })).toEqual([])
  })

  it('answers nothing for a value on a name the census does not list when no log in the tail wrote it', async () => {
    expect(await answer({ census: census() })).toEqual([])
  })

  it('treats a write and a change in the same block by the order of their logs in it', async () => {
    expect(await answer({ tail: [changed(CHECKPOINT + 5, 3), written(V2, CHECKPOINT + 5, 4)], census: census() })).toEqual([cidOf(V2)])
    expect(await answer({ tail: [written(V2, CHECKPOINT + 5, 3), changed(CHECKPOINT + 5, 4)], census: census() })).toEqual([])
  })
})

describe("a name whose registry slot is in the census", () => {
  const SLOT = `0x${'12'.repeat(32)}`
  const OTHER = `0x${'34'.repeat(32)}`
  const SET = { block: CHECKPOINT - 100, logIndex: 4 }
  const slot = (overrides: Partial<NonNullable<NameEntry['registry']>> = {}): NonNullable<NameEntry['registry']> => ({ value: SLOT, set: SET, counts: true, reason: 'passes', ...overrides })
  const stored = (registry: NameEntry['registry'] = slot()): Census => census({ sitename: entry({ registry, keys: {} }) })
  const now = { values: {}, registryContent: SLOT }
  const abi = parseAbi(['function setContent(bytes32,bytes32)', 'function setAddress(bytes32,address,bool)', 'function setSubRegistrar(bytes32,address)'])
  const calling = (name: 'setContent' | 'setAddress' | 'setSubRegistrar', ...args: unknown[]): { input: Hex } => ({ input: encodeFunctionData({ abi, functionName: name, args: [KEY, ...args] } as never) })
  const setter = (blockNumber: number, call: { input: string }, logIndex = 0): WorldLog => ({ ...changed(blockNumber, logIndex), call })
  const record = (value: string): unknown[] => [slotPointer(value)]

  it('keeps the value the bundle vouched for when nothing happened to the name since', async () => {
    expect(await answer({ now, census: stored() })).toEqual(record(SLOT))
  })

  it('keeps it through a setter of the holder in the tail, which reads as the call it was', async () => {
    const tail = [setter(CHECKPOINT + 10, calling('setAddress', BOB, true)), setter(CHECKPOINT + 20, calling('setSubRegistrar', BOB), 1)]
    expect(await answer({ now, tail, census: stored() })).toEqual(record(SLOT))
  })

  it('takes the new value when the tail shows the holder writing it, and fails closed on a value that has no setContent log', async () => {
    const writes = setter(CHECKPOINT + 10, calling('setContent', OTHER))
    expect(await answer({ now: { ...now, registryContent: OTHER }, tail: [writes], census: stored() })).toEqual(record(OTHER))
    expect(await answer({ now: { ...now, registryContent: OTHER }, census: stored() })).toEqual([])
    expect(await answer({ now: { ...now, registryContent: OTHER }, tail: [writes], census: stored(slot({ set: null, counts: false, reason: 'registry-content-no-setContent-log' })) })).toEqual(record(OTHER))
  })

  it('drops the value when the tail shows a change of holder after it, whether the transfer is read as one or its transaction is not a call to the registry', async () => {
    expect(await answer({ now, tail: [changed(CHECKPOINT + 10)], census: stored() })).toEqual([])
    const throughContract = { ...changed(CHECKPOINT + 10), call: { to: `0x${'ab'.repeat(20)}`, input: calling('setAddress', BOB, true).input } }
    expect(await answer({ now, tail: [throughContract], census: stored() })).toEqual([])
  })

  it('takes the value back when the new holder writes it again after the change', async () => {
    const tail = [changed(CHECKPOINT + 10), setter(CHECKPOINT + 20, calling('setContent', SLOT))]
    expect(await answer({ now: { ...now, registryOwner: BOB }, tail, census: stored() })).toEqual(record(SLOT))
  })

  it('fails closed when the holder is not the one the bundle names and the tail shows no change of holder', async () => {
    expect(await answer({ now: { ...now, registryOwner: BOB }, census: stored() })).toEqual([])
  })

  it('fails closed on a value that is not the one the bundle saw, with no setContent log of the new value in the tail', async () => {
    expect(await answer({ now: { ...now, registryContent: OTHER }, tail: [setter(CHECKPOINT + 10, calling('setAddress', BOB, true))], census: stored() })).toEqual([])
  })

  it('does not count a value whose latest write the census has no log for, and still answers the text records beside it', async () => {
    const bundle = census({ sitename: entry({ registry: slot({ set: null, counts: false, reason: 'registry-content-no-setContent-log' }) }) })
    expect(await answer({ now: { values: { 'content.ipfs': V1 }, registryContent: SLOT }, census: bundle })).toEqual([cidOf(V1)])
  })

  it("answers a text record the bundle vouched for before the slot's record, and one record when both name the same file", async () => {
    const both = census({ sitename: entry({ registry: slot() }) })
    expect(await answer({ now: { values: { 'content.ipfs': V1 }, registryContent: SLOT }, census: both })).toEqual([cidOf(V1), ...record(SLOT)])
    const same = `ipfs://${slotPointer(SLOT)?.cid ?? ''}`
    const matching = census({ sitename: entry({ registry: slot() }, same) })
    expect(await answer({ now: { values: { 'content.ipfs': same }, registryContent: SLOT }, census: matching })).toEqual([cidOf(same)])
  })
})

describe('mergedLogs', () => {
  const empty = { setText: [], newController: [], registryChanged: [], wrapperTransfers: [] }

  it("stands for the census holder's change only while that holder holds the name", () => {
    const reads = { registryOwner: BOB, nameToId: 0n, idToName: null, ownerOf: null, controller: ZERO_ADDRESS, registryContent: ZERO_WORD, values: {} }
    expect(mergedLogs({ key: KEY, reads, entry: entry(), checkpoint: CHECKPOINT, tail: empty }).registryChanged).toEqual([])
    expect(mergedLogs({ key: KEY, reads: { ...reads, registryOwner: ALICE }, entry: entry(), checkpoint: CHECKPOINT, tail: empty }).registryChanged).toHaveLength(1)
  })

  describe('and the registry slot', () => {
    const SLOT = `0x${'12'.repeat(32)}`
    const reads = { registryOwner: ALICE, nameToId: 0n, idToName: null, ownerOf: null, controller: ZERO_ADDRESS, registryContent: SLOT, values: {} }
    const withSlot = entry({ registry: { value: SLOT, set: { block: CHECKPOINT - 100, logIndex: 4 }, counts: true, reason: 'passes' }, keys: {} })

    it('stands for the latest setContent as that call, after the change of holder it stands for', () => {
      const merged = mergedLogs({ key: KEY, reads, entry: withSlot, checkpoint: CHECKPOINT, tail: empty }).registryChanged
      expect(merged).toHaveLength(2)
      expect(merged.find((log) => log.call === undefined)).toMatchObject({ blockNumber: CHECKPOINT - 500, logIndex: 0 })
      expect(merged.find((log) => log.call !== undefined)).toMatchObject({ blockNumber: CHECKPOINT - 100, logIndex: 4, call: { fn: 'setContent', value: SLOT } })
    })

    it("stands for the call even when the holder is another one now: the tail must show that holder's change, which comes after it", () => {
      const merged = mergedLogs({ key: KEY, reads: { ...reads, registryOwner: BOB }, entry: withSlot, checkpoint: CHECKPOINT, tail: empty }).registryChanged
      expect(merged).toHaveLength(1)
      expect(merged[0]).toMatchObject({ call: { fn: 'setContent', value: SLOT } })
    })

    it("stands for no call when the census knows none of the slot's value", () => {
      const unknown = entry({ registry: { value: SLOT, set: null, counts: false, reason: 'registry-content-no-setContent-log' }, keys: {} })
      expect(mergedLogs({ key: KEY, reads, entry: unknown, checkpoint: CHECKPOINT, tail: empty }).registryChanged.filter((log) => log.call !== undefined)).toEqual([])
    })
  })
})

describe('readCensus', () => {
  it('refuses what is not a census of this format, so a broken bundle fails every lookup', () => {
    for (const raw of [null, [], {}, { ...census(), format: 1 }, { ...census(), block: 'x' }, { ...census(), names: [] }, { ...census(), upgrades: {} }, { ...census(), implementation: 3 }]) {
      expect(() => readCensus(raw)).toThrow(/census/)
    }
  })
})

describe('the census this bundle carries', () => {
  it('is a census of the format, cut against the implementation the resolver is built for', () => {
    const carried = readCensus(bundled)
    expect(carried.implementation).toBe(IMPLEMENTATION)
    expect(carried.blockHash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(carried.upgrades.at(-1)?.implementation.toLowerCase()).toBe(IMPLEMENTATION.toLowerCase())
    expect(carried.upgrades.map((upgrade) => ({ ...upgrade, implementation: upgrade.implementation.toLowerCase() }))).toEqual(UPGRADES.map((upgrade) => ({ ...upgrade, implementation: upgrade.implementation.toLowerCase() })))
    expect(carried.block).toBeGreaterThan(26_000_000)
  })

  it('lists names whose label this resolver answers, with the verdict the rule gave each key', () => {
    const carried = readCensus(bundled)
    for (const label of Object.keys(carried.names)) expect(keyOf(label), label).toMatch(/^0x[0-9a-f]{64}$/)
    expect(carried.names['chaosroadsmint']?.keys['contentcontract']).toMatchObject({ counts: true, reason: 'passes' })
    expect(carried.names['ecdn']?.keys['contentcontract']).toMatchObject({ counts: false, reason: 'set-before-the-last-holder-change' })
  })
})
