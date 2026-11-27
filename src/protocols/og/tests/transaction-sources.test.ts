import { encodeFunctionData, parseAbi } from 'viem'
import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { eip1193Chain } from '../chain.js'
import type { Chain, Transaction } from '../chain.js'
import { keyOf } from '../name.js'
import { REGISTRY } from '../pins.js'
import { decodeRegistryCall } from '../registry-calls.js'
import { OgRefusal, createSession, provenFromOf, readTransactions } from '../tail.js'
import { fakeProvider, FIRST_BLOCK, transactionHashOf, worldOf } from './world.js'
import type { World } from './world.js'
import { VECTORS } from './vectors.js'

// A server's answer is its own word. What it says about a transaction must never stand in for the light client's: the two sources keep their
// answers apart, and a server's answer is kept only for the block the log it was asked for claims.

const NAME = VECTORS.find((one) => one.id === 'registry-setter-keeps-record') as (typeof VECTORS)[number]
const HEAD = FIRST_BLOCK + 60_000
const FROM = provenFromOf(HEAD)
/** A block the servers are asked about, and one the light client is. */
const OLD_BLOCK = FROM - 5_000
const NEW_BLOCK = HEAD - 1_000
const KEY = keyOf(NAME.label)
const VALUE = `0x${'cd'.repeat(32)}`
const setContent = encodeFunctionData({ abi: parseAbi(['function setContent(bytes32,bytes32)']), functionName: 'setContent', args: [KEY, VALUE as Hex] })

/** A world whose first log is a change of holder in the light client's stretch: what the transaction behind it really is. */
function realWorld (): { world: World, hash: string } {
  const world = worldOf(NAME, { spread: 100, head: HEAD, first: NEW_BLOCK })
  return { world, hash: transactionHashOf({ blockNumber: NEW_BLOCK, logIndex: 0 }) }
}

interface Setup { chain: Chain, hash: string, lightClient: ReturnType<typeof fakeProvider>, servers: ReturnType<typeof fakeProvider> }

/** A light client that knows the real transfer, and servers that answer `forged` for any hash, after `delayMs`. */
function setup (forged: (hash: string) => Transaction, delayMs = 0): Setup {
  const { world, hash } = realWorld()
  const lightClient = fakeProvider(world)
  const servers = fakeProvider(world, { faults: { transaction: async (asked) => { if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs)); return forged(asked) } } })
  return { chain: { ...eip1193Chain(lightClient), servers: eip1193Chain(servers) }, hash, lightClient, servers }
}

const forging = (blockNumber: number) => (hash: string): Transaction => ({ hash, blockNumber, from: '0x000000000000000000000000000000000000dEaD', to: REGISTRY, input: setContent })
const callOf = (tx: Transaction | undefined): ReturnType<typeof decodeRegistryCall> => tx === undefined ? null : decodeRegistryCall(tx, KEY)

describe('the transactions of the two sources', () => {
  it('are kept apart: what a server said about a hash never answers a read of the light client\'s stretch', async () => {
    const { chain, hash, lightClient } = setup(forging(OLD_BLOCK))
    const session = createSession()
    // The servers' invented log for one name is at an old block and names this hash; the answer matches that block, so it is kept for the servers' own reads.
    const [forged] = await readTransactions(chain, session, [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD })
    expect(callOf(forged)).toMatchObject({ fn: 'setContent' })
    // The real log of another name has the same hash, in the light client's stretch.
    const [read] = await readTransactions(chain, session, [{ hash, blockNumber: NEW_BLOCK }], { head: HEAD, final: HEAD })
    expect(read?.blockNumber).toBe(NEW_BLOCK)
    expect(callOf(read)).toMatchObject({ fn: 'transfer' })
    expect(lightClient.asked.transactions).toEqual([hash])
  })

  it('are kept apart while the servers\' read is still running: the light client\'s read does not wait for it or take its answer', async () => {
    const { chain, hash, lightClient } = setup(forging(NEW_BLOCK), 60)
    const session = createSession()
    const forged = readTransactions(chain, session, [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD }).catch((error: unknown) => error)
    const [read] = await readTransactions(chain, session, [{ hash, blockNumber: NEW_BLOCK }], { head: HEAD, final: HEAD })
    expect(callOf(read)).toMatchObject({ fn: 'transfer' })
    expect(lightClient.asked.transactions).toEqual([hash])
    await forged
  })

  it('keep a server\'s answer only when it names the block the log claims', async () => {
    const { chain, hash, servers } = setup(forging(NEW_BLOCK))
    const session = createSession()
    // The answer is for another block than the old log's: it is not that log's transaction, and a later read of the hash must ask again.
    const [first] = await readTransactions(chain, session, [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD })
    expect(first?.blockNumber).toBe(NEW_BLOCK)
    expect(session.serverTransactions.size).toBe(0)
    await readTransactions(chain, session, [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD })
    expect(servers.asked.transactions).toEqual([hash, hash])
  })

  it('keep a server\'s answer for the next read of an old log that matches it', async () => {
    const { chain, hash, servers } = setup(forging(OLD_BLOCK))
    const session = createSession()
    await readTransactions(chain, session, [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD })
    await readTransactions(chain, session, [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD })
    expect(servers.asked.transactions).toEqual([hash])
    expect(session.serverTransactions.size).toBe(1)
    expect(session.transactions.size).toBe(0)
  })

  it('still refuse, in words, a transaction the node does not know', async () => {
    const { chain, hash } = setup(forging(OLD_BLOCK))
    const unknown = { ...chain, servers: eip1193Chain(fakeProvider(realWorld().world, { faults: { transaction: () => null } })) }
    await expect(readTransactions(unknown, createSession(), [{ hash, blockNumber: OLD_BLOCK }], { head: HEAD, final: HEAD })).rejects.toBeInstanceOf(OgRefusal)
  })
})
