import { DEPLOY_BLOCKS, PROXY, REGISTRY } from '../../src/protocols/og/pins.js'
import type { SharedLogs, Say } from './cut.js'
import { CHUNK_BLOCKS, sameLogs } from './logs.js'
import type { CutChain } from './rpc.js'

// The check on the one read that serves every name: a sample of its ranges is read again name by name, with the filter one name alone
// would be read with, and the two must be the same logs. The sample holds every range that has a log of a name and some that have none.

/** Ranges to read besides those with a log. */
const EXTRA_RANGES = 60

/** The index of the range a block is in, counted from the registry's first block. */
const rangeOf = (blockNumber: number): number => Math.floor((blockNumber - DEPLOY_BLOCKS.registry) / CHUNK_BLOCKS)

/**
 * The ranges to check: every one in `mustHave`, then others drawn by a fixed generator until `extra` more are chosen (or all are),
 * in order. The same inputs always give the same sample.
 */
export function sampleRanges (total: number, mustHave: ReadonlySet<number>, extra: number = EXTRA_RANGES, seed = 12345): number[] {
  const sample = new Set(mustHave)
  const goal = Math.min(total, mustHave.size + extra)
  let state = seed
  while (sample.size < goal) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    sample.add(state % total)
  }
  return [...sample].sort((a, b) => a - b)
}

/** @returns how many name-and-range reads differed from the shared read */
export async function validateShared (chain: CutChain, shared: SharedLogs, block: number, say: Say): Promise<number> {
  const withLogs = new Set<number>()
  for (const logs of shared.logs.values()) for (const log of logs) withLogs.add(rangeOf(log.blockNumber))
  const total = rangeOf(block) + 1
  const ranges = sampleRanges(total, withLogs)
  say(`validating: ${String(ranges.length)} ranges (${String(withLogs.size)} with a log of a name), ${String(shared.keys.length)} names each`)
  let different = 0
  for (const index of ranges) {
    const fromBlock = DEPLOY_BLOCKS.registry + index * CHUNK_BLOCKS
    const toBlock = Math.min(fromBlock + CHUNK_BLOCKS - 1, block)
    for (const key of shared.keys) {
      const alone = await chain.getLogs({ address: [REGISTRY, PROXY], topics: [null, key], fromBlock, toBlock })
      const together = (shared.logs.get(key.toLowerCase()) ?? []).filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
      if (!sameLogs(alone, together)) {
        different++
        say(`MISMATCH ${key} blocks ${String(fromBlock)}-${String(toBlock)}: ${String(alone.length)} logs read alone, ${String(together.length)} read together`)
      }
    }
  }
  say(different === 0 ? 'validation: the shared read equals the per-name read on every sampled range' : `validation: ${String(different)} differences`)
  return different
}
