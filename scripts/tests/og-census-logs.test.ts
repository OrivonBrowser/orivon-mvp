import { describe, expect, it } from 'vitest'
import type { Log } from '../../src/protocols/og/chain.js'
import { CHUNK_BLOCKS, chunkedChain, chunksOf, readChunked, sameLogs, splitByKey } from '../og-census/logs.js'
import type { CutChain, WideFilter } from '../og-census/rpc.js'
import { sampleRanges } from '../og-census/validate.js'

const log = (blockNumber: number, logIndex: number, key = '0x01', transactionHash = '0xab'): Log => ({ address: '0x5564886ca2c518d1964e5fcea4f423b41db9f561', topics: ['0xaa', key], data: '0x', blockNumber, transactionHash, logIndex, removed: false })

describe('a stretch of blocks is read as ranges the nodes answer', () => {
  it('covers it with ranges of the size asked, in order, with no gap and no overlap, the last one short', () => {
    expect(chunksOf(10, 25, 5)).toEqual([[10, 14], [15, 19], [20, 24], [25, 25]])
    expect(chunksOf(1, 7_500).length).toBe(1)
    expect(chunksOf(1, 7_501)).toEqual([[1, 7_500], [7_501, 7_501]])
  })

  it('uses 7,500 blocks, under the 10,000 MEV Blocker allows', () => {
    expect(CHUNK_BLOCKS).toBe(7_500)
    expect(chunksOf(51_807, 26_505_416).every(([from, to]) => to - from + 1 <= 7_500)).toBe(true)
  })

  it('has no range for a stretch that ends before it starts', () => {
    expect(chunksOf(20, 19, 5)).toEqual([])
  })
})

describe('the logs of every range come back in chain order, a few ranges at a time', () => {
  /** A chain over a list of logs that answers each range after a pause, and notes how many ranges are open at once. */
  function chainOf (logs: Log[], failAt?: number): { chain: CutChain, asked: WideFilter[], mostAtOnce: () => number } {
    let open = 0
    let most = 0
    const asked: WideFilter[] = []
    const chain = {
      getLogs: async (filter: WideFilter) => {
        asked.push(filter)
        if (failAt !== undefined && asked.length === failAt) throw new Error('the node is down')
        open++
        most = Math.max(most, open)
        await new Promise((resolve) => { setTimeout(resolve, 2) })
        open--
        return logs.filter((one) => one.blockNumber >= filter.fromBlock && one.blockNumber <= filter.toBlock)
      }
    } as unknown as CutChain
    return { chain, asked, mostAtOnce: () => most }
  }

  it('joins the ranges, sorted by block and index, however the ranges finish', async () => {
    const logs = [log(95, 2), log(5, 1), log(95, 1), log(40, 7), log(60, 0)]
    const { chain } = chainOf(logs)
    const found = await readChunked(chain, { fromBlock: 1, toBlock: 100 }, { size: 10 })
    expect(found.map((one) => [one.blockNumber, one.logIndex])).toEqual([[5, 1], [40, 7], [60, 0], [95, 1], [95, 2]])
  })

  it('keeps the filter and changes only the range, and asks no more than three at once', async () => {
    const { chain, asked, mostAtOnce } = chainOf([])
    await readChunked(chain, { fromBlock: 1, toBlock: 100, address: '0x5564886ca2C518d1964E5FCea4f423b41Db9F561', topics: [null, ['0x01', '0x02']] }, { size: 10 })
    expect(asked).toHaveLength(10)
    expect(asked.every((one) => one.topics?.[1]?.length === 2 && one.address === '0x5564886ca2C518d1964E5FCea4f423b41Db9F561')).toBe(true)
    expect(mostAtOnce()).toBe(3)
  })

  it('stops starting ranges after one fails', async () => {
    const { chain, asked } = chainOf([], 2)
    await expect(readChunked(chain, { fromBlock: 1, toBlock: 1_000 }, { size: 10, concurrency: 2 })).rejects.toThrow('the node is down')
    expect(asked.length).toBeLessThan(10)
  })

  it('reports each range read', async () => {
    const { chain } = chainOf([])
    const done: number[] = []
    await readChunked(chain, { fromBlock: 1, toBlock: 40 }, { size: 10, onChunk: (count) => done.push(count) })
    expect(done).toEqual([1, 2, 3, 4])
  })

  it('makes a chain whose wide query is that read, the rest of it untouched', async () => {
    const { chain } = chainOf([log(5, 1), log(15, 1)])
    const wide = chunkedChain(chain, { size: 10 })
    expect((await wide.getLogs({ fromBlock: 1, toBlock: 20 })).map((one) => one.blockNumber)).toEqual([5, 15])
    expect(wide.getBlock).toBe(chain.getBlock)
  })
})

describe('the logs of several names read together are told apart by key', () => {
  it('gives each key its logs in the order they came, by the key in the second topic whatever its case, and drops a log of no key', () => {
    const logs = [log(1, 1, '0xAA'), log(2, 1, '0xbb'), log(3, 1, '0xaa'), log(4, 1, '0xcc')]
    const byKey = splitByKey(logs, ['0xaa', '0xBB', '0xdd'])
    expect([...byKey.keys()]).toEqual(['0xaa', '0xbb', '0xdd'])
    expect(byKey.get('0xaa')?.map((one) => one.blockNumber)).toEqual([1, 3])
    expect(byKey.get('0xbb')?.map((one) => one.blockNumber)).toEqual([2])
    expect(byKey.get('0xdd')).toEqual([])
  })
})

describe('two reads of the same logs are told apart by what makes a log', () => {
  it('is the same in any order and case', () => {
    expect(sameLogs([log(1, 1), log(2, 1)], [{ ...log(2, 1), address: '0x5564886ca2C518d1964E5FCea4f423b41Db9F561' }, log(1, 1)])).toBe(true)
  })

  it.each([
    ['a missing log', [log(1, 1)], [log(1, 1), log(2, 1)]],
    ['another place', [log(1, 1)], [log(1, 2)]],
    ['another transaction', [log(1, 1)], [log(1, 1, '0x01', '0xcd')]],
    ['another topic', [log(1, 1)], [log(1, 1, '0x02')]]
  ])('differs for %s', (_what, left, right) => {
    expect(sameLogs(left, right)).toBe(false)
  })
})

describe('the ranges that are read name by name to check the shared read', () => {
  it('holds every range with a log and the number asked besides, in order, and is the same each time', () => {
    const must = new Set([3, 900, 17])
    const sample = sampleRanges(1_000, must, 10)
    expect(sample).toHaveLength(13)
    expect(sample).toEqual([...sample].sort((a, b) => a - b))
    expect([3, 17, 900].every((index) => sample.includes(index))).toBe(true)
    expect(sample.every((index) => index >= 0 && index < 1_000)).toBe(true)
    expect(sampleRanges(1_000, must, 10)).toEqual(sample)
  })

  it('is every range when there are fewer than asked for', () => {
    expect(sampleRanges(5, new Set([2]), 60)).toEqual([0, 1, 2, 3, 4])
  })
})
