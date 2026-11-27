import type { Log } from '../../src/protocols/og/chain.js'
import { inChainOrder } from './logs.js'
import type { CutChain } from './rpc.js'

// Two nodes as one chain. Every read is made of both and compared; the answer is the one they share, and two answers that differ
// stop the cut, naming the read: a public node can leave out a log that exists, and an answer from one node alone proves nothing.

/** Two nodes answered the same read differently. Not a `ChainError`: nothing in the cut may take it for the contract's own failure. */
export class NodesDisagree extends Error {
  override readonly name = 'NodesDisagree'
}

const HEXADECIMAL = /^0x[0-9a-fA-F]*$/

/** An answer as text, where a hexadecimal string reads the same in either case (a node may spell an address checksummed or not). */
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' && HEXADECIMAL.test(item) ? item.toLowerCase() : typeof item === 'bigint' ? item.toString() : item)

/** Logs in chain order, so two nodes that order a block's logs differently still agree. */
const inOrder = (logs: readonly Log[]): Log[] => [...logs].sort(inChainOrder)

/**
 * @param names what to call each node in a failure
 */
export function agreeingChain (first: CutChain, second: CutChain, names: readonly [string, string]): CutChain {
  async function both<T> (read: (node: CutChain) => Promise<T>, what: () => string, order: (answer: T) => unknown = (answer) => answer): Promise<T> {
    const [one, two] = await Promise.all([read(first), read(second)])
    if (canonical(order(one)) !== canonical(order(two))) throw new NodesDisagree(`${names[0]} and ${names[1]} disagree about ${what()}`)
    return one
  }
  const asked = (method: string, ...args: unknown[]): (() => string) => () => `${method}(${canonical(args).slice(1, -1).slice(0, 300)})`
  return {
    latest: () => Promise.reject(new Error('a census is cut at one block, never at the newest')),
    getBlock: (ref) => both((node) => node.getBlock(ref), asked('getBlock', ref)),
    call: (to, data, block) => both((node) => node.call(to, data, block), asked('call', to, data, block)),
    getLogs: (filter) => both((node) => node.getLogs(filter), asked('getLogs', filter), inOrder),
    getStorageAt: (address, slot, block) => both((node) => node.getStorageAt(address, slot, block), asked('getStorageAt', address, slot, block)),
    getTransaction: (hash) => both((node) => node.getTransaction(hash), asked('getTransaction', hash))
  }
}
