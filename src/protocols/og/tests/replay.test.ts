import { describe, expect, it } from 'vitest'
import { recordsOf } from '../answer.js'
import { censusEntryOf, CENSUS_FORMAT } from '../census.js'
import type { Census, NameEntry } from '../census.js'
import { evaluateFreshness } from '../freshness.js'
import { inspectOg } from '../lookup.js'
import { keyOf } from '../name.js'
import { CENSUS_KEYS, CONTRACT_KEY, IMPLEMENTATION, REGISTRY_CONTENT, UPGRADES } from '../pins.js'
import { readName } from '../state.js'
import { createSession } from '../tail.js'
import { ZERO_WORD } from '../hex.js'
import { fakeChain, FIRST_BLOCK, nameLogs, pinnedUpgradeLogs, worldOf } from './world.js'
import { VECTORS } from './vectors.js'
import type { Vector } from './vectors.js'

// Each vector is a name's state and logs: twelve live on Ethereum mainnet and the rest played on a fork of it for the cases no live
// name shows. The rule must keep exactly the records the vector says, whether the history comes from the node or from the census.

const SPREAD = 300
/** A cut is made after the proxy's last upgrade, the block the pinned list ends at. */
const CUT_BLOCK = 26_401_000

/** A census cut before the first log of any name: nothing is known, so the tail is the name's whole history. */
const before = (vector: Vector): Census => ({ format: CENSUS_FORMAT, block: (vector.first ?? FIRST_BLOCK) - 1_000, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} })

/** A vector's world: a name whose logs lie past the registry slot's floor keeps them there, close together. */
const worldFor = (vector: Vector, head?: number): ReturnType<typeof worldOf> => worldOf(vector, { spread: vector.spread ?? SPREAD, ...(vector.first === undefined ? {} : { first: vector.first }), ...(head === undefined ? {} : { head }) })

/** The records that count, as the vector lists them, without the contract's. */
const expectedKeys = (vector: Vector): string[] => [...vector.records].sort()

/** The census the tool would cut over a world: each name with a content value, as the rule reads its whole history. */
async function cut (world: ReturnType<typeof worldOf>): Promise<Census> {
  const { chain } = fakeChain(world, { maxSpan: Infinity })
  const names: Record<string, NameEntry> = {}
  for (const label of Object.keys(world.names)) {
    const key = keyOf(label)
    const entry = censusEntryOf(key, await readName(chain, key, world.head, CENSUS_KEYS), nameLogs(world, label))
    if (entry !== null) names[label] = entry
  }
  return { format: CENSUS_FORMAT, block: world.head, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names }
}

describe('every vector answers as the freshness rule keeps it, whichever of the history is in the bundle', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: all of it read from the node', async (_id, vector) => {
    const world = worldFor(vector)
    const { chain } = fakeChain(world)
    const found = await inspectOg(chain, vector.label, { session: createSession(), census: before(vector) })
    expect(found.refusal).toBeNull()
    expect((found.verdict?.records ?? []).filter((name) => name !== CONTRACT_KEY).sort()).toEqual(expectedKeys(vector))
  })

  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: all of it in the bundle, nothing read from the node', async (_id, vector) => {
    const world = worldFor(vector, CUT_BLOCK)
    world.logs.push(...pinnedUpgradeLogs())
    const census = await cut(world)
    const { chain, asked } = fakeChain(world)
    const found = await inspectOg(chain, vector.label, { session: createSession(), census })
    expect(found.refusal).toBeNull()
    expect((found.verdict?.records ?? []).filter((name) => name !== CONTRACT_KEY).sort()).toEqual(expectedKeys(vector))
    expect(asked.logs).toEqual([])
  })

  it('has twenty-eight names, twelve of them live ones', () => {
    expect(VECTORS).toHaveLength(28)
    expect(VECTORS.filter((vector) => vector.id.endsWith('-mainnet'))).toHaveLength(12)
  })
})

describe('the rule gives each key of each vector the reason the vector says', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s', async (_id, vector) => {
    const world = worldFor(vector)
    const key = keyOf(vector.label)
    const reads = await readName(fakeChain(world).chain, key, world.head, CENSUS_KEYS)
    const verdict = evaluateFreshness(key, reads, nameLogs(world, vector.label))
    for (const [name, reason] of Object.entries(vector.reasons)) expect(verdict.keys[name]?.reason, name).toBe(reason)
    if (vector.registry !== undefined) expect({ counts: verdict.registry.counts, reason: verdict.registry.reason }, 'the registry slot').toEqual(vector.registry)
    expect(verdict.records.filter((name) => name !== CONTRACT_KEY).sort()).toEqual(expectedKeys(vector))
  })

  it("has an entry in the census only for a name with a content value, in a text key or in the registry's slot", async () => {
    const withEntry: string[] = []
    for (const vector of VECTORS) {
      const world = worldFor(vector)
      const key = keyOf(vector.label)
      const reads = await readName(fakeChain(world).chain, key, world.head, CENSUS_KEYS)
      if (censusEntryOf(key, reads, nameLogs(world, vector.label)) !== null) withEntry.push(vector.label)
    }
    const holdsValue = (vector: Vector): boolean => Object.keys(vector.state.values).some((name) => CENSUS_KEYS.includes(name)) || (vector.state.registryContent ?? ZERO_WORD) !== ZERO_WORD
    expect(withEntry.sort()).toEqual(VECTORS.filter(holdsValue).map((vector) => vector.label).sort())
  })
})

describe('the records a vector answers', () => {
  it('are the content records that count, in the order of the keys, then the registry slot', async () => {
    for (const vector of VECTORS.filter((one) => one.records.length > 0)) {
      const world = worldFor(vector)
      const { chain } = fakeChain(world)
      const found = await inspectOg(chain, vector.label, { session: createSession(), census: before(vector) })
      const counted = Object.fromEntries((found.verdict?.records ?? []).map((name) => [name, name === REGISTRY_CONTENT ? found.reads.registryContent : found.reads.values[name]]))
      const records = recordsOf(counted, found.block)
      for (const record of records) expect(record.provenance).toEqual({ via: 'chain', block: world.head, offchain: false })
    }
  })
})
