import { ChainError, eip1193Chain } from '../chain.js'
import type { Chain } from '../chain.js'
import type { resolveOg } from '../lookup.js'
import { OLD_WINDOW } from '../tail.js'
import { censusAt, fakeProvider, FIRST_BLOCK, worldOf } from './world.js'
import type { Faults, World } from './world.js'
import { VECTORS } from './vectors.js'

// What the tests of old history share: a light client that proves only the newest blocks and servers that answer any, over one world.
// A fake light client refuses any block older than the 8,191 it holds with the words Helios uses, so a read that should have gone to the
// servers fails.

export type Records = Awaited<ReturnType<typeof resolveOg>>

export const NAME = VECTORS.find((one) => one.id === 'unwrapped-passes') as (typeof VECTORS)[number]
export const CHECKPOINT = FIRST_BLOCK - 1_000
export const HEAD = FIRST_BLOCK + 60_000
export const RING = 8_191
export const PASSING = [{ kind: 'ipfs', cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }]
export const pointers = (records: Records): unknown[] => records.map((record) => record.pointer)

export const outsideRing = (world: World, block: number): ChainError | undefined => block < world.head - RING ? new ChainError('invalid', `block ${String(block)} is outside EIP-2935 ring buffer range`) : undefined

/** A light client that proves only the newest blocks, and servers that answer any, over one world. */
export function twoProviders (world: World, options: { span?: number, serverFaults?: Faults, servers?: boolean, serversWorld?: World } = {}): { chain: Chain, proven: ReturnType<typeof fakeProvider>, servers: ReturnType<typeof fakeProvider> } {
  const proven = fakeProvider(world, { faults: { logs: (filter) => outsideRing(world, filter.fromBlock), transactionAt: (block) => outsideRing(world, block) } })
  const servers = fakeProvider(options.serversWorld ?? world, { maxSpan: options.span ?? 10_000, faults: options.serverFaults ?? {} })
  const chain: Chain = { ...eip1193Chain(proven), ...(options.servers === false ? {} : { servers: eip1193Chain(servers, { maxSpan: OLD_WINDOW }) }) }
  return { chain, proven, servers }
}

export const old = (): World => worldOf(NAME, { spread: 300, head: HEAD })
export const census = (): ReturnType<typeof censusAt> => censusAt(CHECKPOINT)
