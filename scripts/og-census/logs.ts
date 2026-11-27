import type { Log } from '../../src/protocols/og/chain.js'
import type { CutChain, WideFilter } from './rpc.js'

// A log query over a stretch of millions of blocks, asked as ranges the nodes answer: MEV Blocker refuses more than 10,000 blocks, and
// a range that holds many logs is refused as too large, so a narrower one is the safe size for both nodes. A few ranges are asked at
// once; each is asked of both nodes (the chain given is the agreeing one) and the logs come back in chain order.

/** Blocks in one range of a log query. */
export const CHUNK_BLOCKS = 7_500

/** Ranges asked at once. */
export const CONCURRENCY = 3

/** The ranges of at most `size` blocks that cover `from` to `to`, both included, in order. */
export function chunksOf (from: number, to: number, size: number = CHUNK_BLOCKS): [number, number][] {
  const spans: [number, number][] = []
  for (let start = from; start <= to; start += size) spans.push([start, Math.min(start + size - 1, to)])
  return spans
}

/** The log's place on chain, as one sortable pair. */
export const inChainOrder = (a: Log, b: Log): number => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex

export interface ChunkOptions {
  readonly size?: number
  readonly concurrency?: number
  /** Called after each range is read, with how many have been. */
  readonly onChunk?: (done: number) => void
}

/** Every log of a filter, read range by range. A range that fails stops the ones not yet started. */
export async function readChunked (chain: CutChain, filter: WideFilter, options: ChunkOptions = {}): Promise<Log[]> {
  const { size = CHUNK_BLOCKS, concurrency = CONCURRENCY, onChunk } = options
  const spans = chunksOf(filter.fromBlock, filter.toBlock, size)
  const parts: Log[][] = new Array<Log[]>(spans.length)
  let next = 0
  let done = 0
  let failed = false
  await Promise.all(Array.from({ length: Math.min(concurrency, spans.length) }, async () => {
    while (!failed && next < spans.length) {
      const at = next++
      const [fromBlock, toBlock] = spans[at] as [number, number]
      try {
        parts[at] = await chain.getLogs({ ...filter, fromBlock, toBlock })
      } catch (error) {
        failed = true
        throw error
      }
      onChunk?.(++done)
    }
  }))
  return parts.flat().sort(inChainOrder)
}

/** The same chain, a log query of any width read as ranges. */
export const chunkedChain = (chain: CutChain, options: ChunkOptions = {}): CutChain => ({ ...chain, getLogs: (filter) => readChunked(chain, filter, options) })

/** The logs of every key together, by key: each log goes to the list of the key in its second topic. A log of no key given is dropped. */
export function splitByKey (logs: readonly Log[], keys: readonly string[]): Map<string, Log[]> {
  const byKey = new Map<string, Log[]>(keys.map((key) => [key.toLowerCase(), []]))
  for (const log of logs) byKey.get((log.topics[1] ?? '').toLowerCase())?.push(log)
  return byKey
}

/** Whether two reads of the same logs are one: the same logs in the same places, whatever order and case the nodes gave them in. */
export function sameLogs (left: readonly Log[], right: readonly Log[]): boolean {
  const shape = (logs: readonly Log[]): string => JSON.stringify([...logs].sort(inChainOrder).map((log) => [log.blockNumber, log.logIndex, log.transactionHash.toLowerCase(), log.topics.map((topic) => topic.toLowerCase()), log.address.toLowerCase()]))
  return shape(left) === shape(right)
}
