import { describe, expect, it } from 'vitest'
import { CENSUS_FORMAT, censusEntryOf, readCensus } from '../../src/protocols/og/census.js'
import type { Census, NameEntry } from '../../src/protocols/og/census.js'
import { ZERO_WORD, sameAddress } from '../../src/protocols/og/hex.js'
import { keyOf } from '../../src/protocols/og/name.js'
import { CENSUS_KEYS, IMPLEMENTATION, REGISTRY, UPGRADES } from '../../src/protocols/og/pins.js'
import { readName } from '../../src/protocols/og/state.js'
import { fakeChain, nameLogs, pinnedUpgradeLogs, worldOf } from '../../src/protocols/og/tests/world.js'
import type { World } from '../../src/protocols/og/tests/world.js'
import { VECTORS } from '../../src/protocols/og/tests/vectors.js'
import type { Vector } from '../../src/protocols/og/tests/vectors.js'
import { NodesDisagree } from '../og-census/agree.js'
import { censusText, cutCensus, labelOfKey, sharedFinalized, slotLabels } from '../og-census/cut.js'
import { validateShared } from '../og-census/validate.js'
import { fakeCutChain, fakeNode, instantClock } from './og-census.test-helpers.js'
import { chunkedChain } from '../og-census/logs.js'
import { agreeingChain } from '../og-census/agree.js'
import { nodeChain } from '../og-census/rpc.js'

/** A cut is made after the proxy's last upgrade, the block the pinned list ends at. */
const CUT_BLOCK = 26_401_000
const SPREAD = 300

const worldFor = (vector: Vector, head: number): World => {
  const world = worldOf(vector, { spread: vector.spread ?? SPREAD, ...(vector.first === undefined ? {} : { first: vector.first }), head })
  world.logs.push(...pinnedUpgradeLogs())
  return world
}

/** The census the resolver's own rule makes of a world, each name read whole with no node in between: what the tool must give. */
async function reference (world: World, block: number): Promise<Census> {
  const { chain } = fakeChain(world, { maxSpan: Infinity })
  const names: Record<string, NameEntry> = {}
  for (const label of Object.keys(world.names)) {
    const key = keyOf(label)
    const entry = censusEntryOf(key, await readName(chain, key, block, CENSUS_KEYS), nameLogs(world, label))
    if (entry !== null) names[label] = entry
  }
  return { format: CENSUS_FORMAT, block, blockHash: `0x${block.toString(16).padStart(64, '0')}`, implementation: IMPLEMENTATION, upgrades: UPGRADES.map((upgrade) => ({ block: upgrade.block, logIndex: upgrade.logIndex, implementation: upgrade.implementation.toLowerCase() })), names }
}

describe('the label a registry key stands for', () => {
  it.each([
    ['0x6169616765', null],
    [keyOf('aiagent'), 'aiagent'],
    [keyOf('a1-b2'), 'a1-b2']
  ])('%s is %s', (key, label) => {
    expect(labelOfKey(key)).toBe(label)
  })

  it.each([
    ['empty', `0x${'0'.repeat(64)}`],
    ['not UTF-8', `0xff${'0'.repeat(62)}`],
    ['upper case, so not the one spelling', keyOf('Alice')],
    ['with a dot, so a sub-name the registry has none of', keyOf('www.alice')],
    ['not ASCII, which no host the browser gives is', keyOf('café')],
    ['over 32 bytes cannot be a key, and a label with a zero inside is not one name', `0x61${'00'}62${'0'.repeat(58)}`]
  ])('has none for a key that is %s', (_why, key) => {
    expect(labelOfKey(key)).toBeNull()
  })

  it('reads the key in either case', () => {
    expect(labelOfKey(keyOf('aiagent').toUpperCase().replace('0X', '0x'))).toBe('aiagent')
  })
})

describe('the census is cut over a node as the resolver reads the chain', () => {
  it.each(VECTORS.map((vector) => [vector.id, vector] as const))('%s: the file is what the rule makes of the name, whole', async (_id, vector) => {
    const world = worldFor(vector, CUT_BLOCK)
    const { census } = await cutCensus(fakeCutChain(world), { block: CUT_BLOCK })
    expect(census).toEqual(await reference(world, CUT_BLOCK))
    expect(readCensus(JSON.parse(censusText(census)))).toEqual(census)
  })

  it('cuts several names together from one read of their history, and says what it read', async () => {
    const mainnet = VECTORS.filter((vector) => ['aiagent', 'visioned', 'jsunblaze', 'chaosroadsmint', 'ecdn', 'mason'].includes(vector.label))
    const worlds = mainnet.map((vector) => worldFor(vector, CUT_BLOCK))
    const together: World = { head: CUT_BLOCK, names: Object.assign({}, ...worlds.map((world) => world.names)), logs: [...new Map(worlds.flatMap((world) => world.logs).map((log) => [`${String(log.blockNumber)}:${String(log.logIndex)}`, log])).values()], implementation: IMPLEMENTATION }
    const said: string[] = []
    const { census, shared } = await cutCensus(fakeCutChain(together), { block: CUT_BLOCK }, (line) => said.push(line))
    expect(census).toEqual(await reference(together, CUT_BLOCK))
    expect(Object.keys(census.names)).toEqual(['aiagent', 'chaosroadsmint', 'ecdn', 'jsunblaze', 'visioned'])
    expect(shared.keys).toHaveLength(6)
    expect(said.some((line) => /^reading the registry and resolver logs of 6 names together/.test(line))).toBe(true)
    expect(said).toContain('aiagent: registry content counts')
  })

  it('writes the file as two-space JSON with a newline, so a cut at one block is one set of bytes', async () => {
    const world = worldFor(VECTORS.find((vector) => vector.label === 'ogslotaj7l') as Vector, CUT_BLOCK)
    const { census } = await cutCensus(fakeCutChain(world), { block: CUT_BLOCK })
    const text = censusText(census)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`)
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'block', 'blockHash', 'implementation', 'upgrades', 'names'])
  })

  it('has no names, and reads no history, when no name has a content record', async () => {
    const world = worldFor(VECTORS.find((vector) => vector.label === 'ogfreeaj7l') as Vector, CUT_BLOCK)
    const { census, shared } = await cutCensus(fakeCutChain(world), { block: CUT_BLOCK })
    expect(census.names).toEqual({})
    expect(shared.keys).toEqual([])
  })

  it('stops when the nodes disagree about a log', async () => {
    const world = worldFor(VECTORS.find((vector) => vector.label === 'ogslotaj7l') as Vector, CUT_BLOCK)
    const left = world.logs.find((log) => sameAddress(log.address, REGISTRY)) as World['logs'][number]
    const wrong = { ...world, logs: world.logs.filter((log) => log !== left) }
    await expect(cutCensus(fakeCutChain(world, wrong), { block: CUT_BLOCK })).rejects.toBeInstanceOf(NodesDisagree)
  })

  it('stops when the nodes disagree about the block they cut at', async () => {
    const world = worldFor(VECTORS[0] as Vector, CUT_BLOCK)
    const tamper = (method: string, result: unknown): unknown => method === 'eth_getBlockByNumber' ? { ...(result as object), hash: `0x${'ab'.repeat(32)}` } : result
    await expect(cutCensus(fakeCutChain(world, world, tamper), { block: CUT_BLOCK })).rejects.toBeInstanceOf(NodesDisagree)
  })

  it('stops when the proxy runs another implementation, or the block is not there', async () => {
    const world = worldFor(VECTORS[0] as Vector, CUT_BLOCK)
    await expect(cutCensus(fakeCutChain({ ...world, implementation: `0x${'12'.repeat(20)}` }), { block: CUT_BLOCK })).rejects.toThrow('not the implementation this resolver is built for')
    const noBlock = (method: string, result: unknown): unknown => method === 'eth_getBlockByNumber' ? null : result
    await expect(cutCensus(fakeCutChain(world, world, noBlock), { block: CUT_BLOCK })).rejects.toThrow(/disagree about getBlock/)
  })

  it('stops when the proxy logged an upgrade the pin does not list', async () => {
    const world = worldFor(VECTORS[0] as Vector, CUT_BLOCK)
    world.logs.push({ address: '0x6023E55814DC00F094386d4eb7e17Ce49ab1A190', blockNumber: 20_000_000, logIndex: 1, topics: ['0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', `0x${'0'.repeat(24)}${'ab'.repeat(20)}`] })
    await expect(cutCensus(fakeCutChain(world), { block: CUT_BLOCK })).rejects.toThrow('the proxy logged an upgrade at block 20000000 that the pin does not list')
  })

  it('stops, naming the transaction, when a node has none of a name\'s changes', async () => {
    const world = worldFor(VECTORS.find((vector) => vector.label === 'ogslotaj7l') as Vector, CUT_BLOCK)
    const tamper = (method: string, result: unknown): unknown => method === 'eth_getTransactionByHash' ? null : result
    await expect(cutCensus(fakeCutChain(world, world, tamper), { block: CUT_BLOCK })).rejects.toThrow(/disagree about getTransaction|have no transaction/)
    const bothMissing = chunkedChain(agreeingChain(...[1, 2].map((n) => nodeChain(`http://n${String(n)}.invalid`, { fetch: fakeNode(world, tamper), clock: instantClock(), gapMs: 0 })) as [ReturnType<typeof nodeChain>, ReturnType<typeof nodeChain>], ['A', 'B']))
    await expect(cutCensus(bothMissing, { block: CUT_BLOCK })).rejects.toThrow(/the nodes have no transaction 0x[0-9a-f]+, which logged a change of 0x[0-9a-f]+ at block \d+/)
  })
})

describe('the names whose registry slot holds a value, and the block both nodes call finalized', () => {
  it('finds the names with a value in the slot among those the registry logged since the floor', async () => {
    const world = worldFor(VECTORS.find((vector) => vector.label === 'ogslotaj7l') as Vector, CUT_BLOCK)
    const said: string[] = []
    expect(await slotLabels(fakeCutChain(world), CUT_BLOCK, (line) => said.push(line))).toEqual(['ogslotaj7l'])
    expect(said[0]).toMatch(/registry Changed logs from block 26400000, on 1 names this resolver can answer, 1 with a value in the registry's content slot/)
  })

  it('takes the lower of the two finalized blocks, and refuses a node that has none', async () => {
    const chain = (head: number | null) => ({ getBlock: () => Promise.resolve(head === null ? null : { number: head, hash: '0x', parentHash: '0x', timestamp: 1 }) }) as never
    expect(await sharedFinalized([chain(120), chain(100)])).toBe(100)
    await expect(sharedFinalized([chain(120), chain(null)])).rejects.toThrow('a node has no finalized block')
  })
})

describe('the shared read of every name is checked against the read of each', () => {
  const vector = VECTORS.find((one) => one.label === 'ogtxslaj7l') as Vector

  it('finds no difference in an honest read', async () => {
    const world = worldFor(vector, CUT_BLOCK)
    const chain = fakeCutChain(world)
    const { shared } = await cutCensus(chain, { block: CUT_BLOCK })
    const said: string[] = []
    expect(await validateShared(chain, shared, CUT_BLOCK, (line) => said.push(line))).toBe(0)
    expect(said.at(-1)).toBe('validation: the shared read equals the per-name read on every sampled range')
  })

  it('names a name and a range when the shared read left out a log', async () => {
    const chain = fakeCutChain(worldFor(vector, CUT_BLOCK))
    const { shared } = await cutCensus(chain, { block: CUT_BLOCK })
    const [key] = shared.keys
    const cut = { keys: shared.keys, logs: new Map([[(key as string).toLowerCase(), (shared.logs.get((key as string).toLowerCase()) ?? []).slice(1)]]) }
    const said: string[] = []
    expect(await validateShared(chain, cut, CUT_BLOCK, (line) => said.push(line))).toBe(1)
    expect(said.some((line) => line.startsWith(`MISMATCH ${key as string} blocks `))).toBe(true)
    expect(said.at(-1)).toBe('validation: 1 differences')
  })
})

describe('what the census pins', () => {
  it('lists the pinned upgrades and implementation, whatever the names', async () => {
    const { census } = await cutCensus(fakeCutChain(worldFor(VECTORS[0] as Vector, CUT_BLOCK)), { block: CUT_BLOCK })
    expect(census.implementation).toBe(IMPLEMENTATION)
    expect(census.upgrades.map((upgrade) => upgrade.implementation)).toEqual(UPGRADES.map((upgrade) => upgrade.implementation.toLowerCase()))
    expect(census.blockHash).toBe(`0x${CUT_BLOCK.toString(16).padStart(64, '0')}`)
    expect(ZERO_WORD).toHaveLength(66)
  })
})
