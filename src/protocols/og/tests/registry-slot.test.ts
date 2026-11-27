import { encodeFunctionData, getAddress, parseAbi } from 'viem'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { slotPointer } from '../answer.js'
import { inspectOg, resolveOg } from '../lookup.js'
import { ZERO_WORD } from '../hex.js'
import { keyOf } from '../name.js'
import { IMPLEMENTATION, REGISTRY, TOPICS } from '../pins.js'
import { OgRefusal, createSession } from '../tail.js'
import { censusAt, fakeChain, transactionHashOf } from './world.js'
import type { World, WorldLog } from './world.js'

// The registry's own `content` slot, read through the transactions behind the registry's `Changed` logs: only a direct setContent of the
// value now stored, after the latest change of holder, counts.

const LABEL = 'harbor'
const KEY = keyOf(LABEL)
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const FIRST: Hex = `0x${'12'.repeat(32)}`
const SECOND: Hex = `0x${'34'.repeat(32)}`
const CHECKPOINT = 20_000_000
const abi = parseAbi(['function setContent(bytes32,bytes32)', 'function setAddress(bytes32,address,bool)', 'function transfer(bytes32,address)'])

/** A `Changed` log of the name at `block`; with `input` it is the log of a call with that calldata, and without it a transfer to a burn address. */
const changed = (block: number, input?: string, extra: Partial<WorldLog['call']> = {}): WorldLog => ({
  address: REGISTRY, blockNumber: block, logIndex: 0, topics: [TOPICS.changed, KEY], ...(input === undefined ? {} : { call: { input, ...extra } })
})
const setContent = (block: number, value: Hex): WorldLog => changed(block, encodeFunctionData({ abi, functionName: 'setContent', args: [KEY, value] }))
const setAddress = (block: number): WorldLog => changed(block, encodeFunctionData({ abi, functionName: 'setAddress', args: [KEY, ALICE, true] }))

const worldOf = (logs: WorldLog[], content: Hex = FIRST, head = CHECKPOINT + 1_000): World => ({
  head,
  names: { [LABEL]: { registryOwner: ALICE, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: null, registryContent: content, values: {} } },
  logs,
  implementation: IMPLEMENTATION
})

async function look (logs: WorldLog[], content: Hex = FIRST): Promise<{ made: ReturnType<typeof fakeChain>, session: ReturnType<typeof createSession>, answer: () => Promise<unknown[]> }> {
  const made = fakeChain(worldOf(logs, content))
  const session = createSession()
  return { made, session, answer: async () => (await resolveOg(made.chain, LABEL, { session, census: censusAt(CHECKPOINT) })).map((record) => record.pointer) }
}

describe('the registry content slot, read through the resolver', () => {
  it('counts a value its holder wrote with a direct setContent after taking the name, and answers it as one ipfs record', async () => {
    const { made, session } = await look([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)])
    const found = await inspectOg(made.chain, LABEL, { session, census: censusAt(CHECKPOINT) })
    expect(found.verdict?.registry).toMatchObject({ counts: true, reason: 'passes', value: FIRST })
    expect(found.verdict?.records).toEqual(['registry.content'])
  })

  it('answers the slot as an ipfs record', async () => {
    const { answer } = await look([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)])
    expect(await answer()).toEqual([slotPointer(FIRST)])
  })

  it('does not count what the holder wrote before the name was transferred: the buyer holds a slot the seller wrote', async () => {
    const { answer } = await look([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST), changed(CHECKPOINT + 30)])
    expect(await answer()).toEqual([])
  })

  it("counts the new holder's own write after a transfer, the same value again included", async () => {
    const { answer } = await look([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST), changed(CHECKPOINT + 30), setContent(CHECKPOINT + 40, FIRST)])
    expect(await answer()).toEqual([slotPointer(FIRST)])
  })

  it("keeps counting a value after the holder's other setters, which log Changed and are not a change of holder", async () => {
    const { answer } = await look([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST), setAddress(CHECKPOINT + 30)])
    expect(await answer()).toEqual([slotPointer(FIRST)])
  })

  it('counts the value the latest setContent wrote', async () => {
    const logs = [changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST), setContent(CHECKPOINT + 30, SECOND)]
    expect(await (await look(logs, SECOND)).answer()).toEqual([slotPointer(SECOND)])
  })

  it('does not count a value written through a contract: the transaction is to the contract, so no setter is read, whatever the contract did inside', async () => {
    const through = changed(CHECKPOINT + 20, encodeFunctionData({ abi, functionName: 'setContent', args: [KEY, FIRST] }), { to: `0x${'5a'.repeat(20)}` })
    expect(await (await look([changed(CHECKPOINT + 10), through])).answer()).toEqual([])
  })

  it('does not count a value on a name with no setContent log at all, which is what a value written before the census floor looks like', async () => {
    const { made, session } = await look([changed(CHECKPOINT + 10)])
    const found = await inspectOg(made.chain, LABEL, { session, census: censusAt(CHECKPOINT) })
    expect(found.verdict?.registry).toMatchObject({ counts: false, reason: 'registry-content-no-setContent-log' })
  })

  it('treats a setContent that clears the slot as no record, and a later one as the record', async () => {
    const logs = [changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST), setContent(CHECKPOINT + 30, ZERO_WORD)]
    expect(await (await look(logs, ZERO_WORD)).answer()).toEqual([])
    expect(await (await look([...logs, setContent(CHECKPOINT + 40, SECOND)], SECOND)).answer()).toEqual([slotPointer(SECOND)])
  })
})

describe('the transactions the resolver reads to tell a setter from a holder change', () => {
  const read = (made: Awaited<ReturnType<typeof look>>['made']): number => made.asked.transactions.length

  it('reads the newest logs first and stops at the first change of holder, so a long run of setters is not read to its start', async () => {
    const logs = [changed(CHECKPOINT + 10)]
    for (let index = 0; index < 8; index++) logs.push(setContent(CHECKPOINT + 20 + index, index % 2 === 0 ? FIRST : SECOND))
    logs.push(changed(CHECKPOINT + 40))
    const { made, answer } = await look(logs)
    await answer()
    // Ten logs lie after the checkpoint, the newest is the transfer: the first round of four holds it.
    expect(read(made)).toBe(4)
  })

  it('reads on past a round of setters until it finds the call that moved the name', async () => {
    const logs = [changed(CHECKPOINT + 10)]
    for (let index = 0; index < 6; index++) logs.push(setContent(CHECKPOINT + 20 + index, FIRST))
    const { made, answer } = await look(logs)
    expect(await answer()).toEqual([slotPointer(FIRST)])
    // Seven logs: two rounds of four, the second ends at the first of them.
    expect(read(made)).toBe(7)
  })

  it('asks for a transaction once per resolver: a second look at the name reads nothing it has read', async () => {
    const { made, session } = await look([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)])
    const lookup = { session, census: censusAt(CHECKPOINT) }
    await inspectOg(made.chain, LABEL, lookup)
    expect(read(made)).toBe(2)
    expect((await inspectOg(made.chain, LABEL, lookup)).verdict?.registry.counts).toBe(true)
    expect(read(made)).toBe(2)
    expect(session.transactions.size).toBe(2)
  })

  it('asks again for the transactions of blocks within 64 of the head: a reorganisation may have replaced them', async () => {
    const made = fakeChain(worldOf([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)], FIRST, CHECKPOINT + 40))
    const lookup = { session: createSession(), census: censusAt(CHECKPOINT) }
    await inspectOg(made.chain, LABEL, lookup)
    await inspectOg(made.chain, LABEL, lookup)
    expect(made.asked.transactions).toHaveLength(4)
    expect(lookup.session.transactions.size).toBe(0)
  })

  it('refuses rather than answer in part when the node does not know a transaction a log names, and never reads the missing call as a setter', async () => {
    const logs = [changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)]
    const known = new Set(logs.slice(0, 1).map((log) => transactionHashOf(log)))
    const world = worldOf(logs)
    const made = fakeChain(world, { faults: { transaction: async (hash) => known.has(hash.toLowerCase()) ? { hash, blockNumber: CHECKPOINT + 10, from: ALICE, to: REGISTRY, input: '0x' } : null } })
    const lookup = { session: createSession(), census: censusAt(CHECKPOINT) }
    await expect(resolveOg(made.chain, LABEL, lookup)).rejects.toBeInstanceOf(OgRefusal)
    const found = await inspectOg(made.chain, LABEL, lookup)
    expect(found.verdict).toBeNull()
    expect(found.refusal).toBeInstanceOf(OgRefusal)
  })

  it('does not take a transaction mined in another block than its log for the call that logged it', async () => {
    const real = fakeChain(worldOf([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)]))
    const made = fakeChain(worldOf([changed(CHECKPOINT + 10), setContent(CHECKPOINT + 20, FIRST)]), {
      faults: { transaction: async (hash) => { const found = await real.chain.getTransaction(hash); return found === null ? null : { ...found, blockNumber: (found.blockNumber ?? 0) + 1 } } }
    })
    const found = await inspectOg(made.chain, LABEL, { session: createSession(), census: censusAt(CHECKPOINT) })
    expect(found.verdict?.registry.counts).toBe(false)
  })
})
