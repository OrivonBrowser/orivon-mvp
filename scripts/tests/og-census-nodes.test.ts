import { describe, expect, it } from 'vitest'
import { NodesDisagree, agreeingChain, canonical } from '../og-census/agree.js'
import { createPacer, nodeChain, rpcProvider } from '../og-census/rpc.js'
import type { CutChain } from '../og-census/rpc.js'
import { instantClock } from './og-census.test-helpers.js'

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

describe('a node takes its requests at a pace of its own', () => {
  it('lets the first go at once and holds each next one to the gap after the one before', async () => {
    const clock = instantClock()
    const pace = createPacer(200, clock)
    await pace()
    await pace()
    await pace()
    expect(clock.sleeps).toEqual([200, 200])
  })

  it('does not wait for a request that comes after the gap has passed', async () => {
    const clock = instantClock()
    const pace = createPacer(200, clock)
    await pace()
    await clock.sleep(500)
    await pace()
    expect(clock.sleeps).toEqual([500])
  })
})

describe('a busy node is asked again, and any other failure stops the cut', () => {
  const options = (fetch: typeof globalThis.fetch, extra: object = {}) => ({ fetch, clock: instantClock(), random: () => 0.5, gapMs: 0, ...extra })

  it('asks again after 1 to 2 seconds when the answer is 429, a server error or not JSON, and counts them', async () => {
    const answers = [() => reply({}, 429), () => reply({}, 503), () => new Response('<html>'), () => reply({ result: '0x1' })]
    const counters = { sent: 0, busy: 0 }
    const clock = instantClock()
    const provider = rpcProvider('http://node.invalid', { ...options(() => Promise.resolve((answers.shift() as () => Response)())), clock, counters })
    expect(await provider.request({ method: 'eth_blockNumber' })).toBe('0x1')
    expect(counters).toEqual({ sent: 4, busy: 3 })
    expect(clock.sleeps).toEqual([1500, 1500, 1500])
  })

  it('asks again for a node that fails to answer at all and for the codes a loaded node answers with', async () => {
    const answers = [() => { throw new TypeError('fetch failed') }, () => reply({ error: { code: -32005, message: 'limit exceeded' } }), () => reply({ error: { code: -32603, message: 'internal error' } }), () => reply({ result: 'ok' })]
    const provider = rpcProvider('http://node.invalid', options(() => Promise.resolve((answers.shift() as () => Response)())))
    expect(await provider.request({ method: 'eth_blockNumber' })).toBe('ok')
    expect(answers).toHaveLength(0)
  })

  it('stops, naming the node and the call, when it stays busy through every request', async () => {
    const counters = { sent: 0, busy: 0 }
    const provider = rpcProvider('http://node.invalid', options(() => Promise.resolve(reply({}, 429)), { attempts: 5, counters }))
    await expect(provider.request({ method: 'eth_getLogs' })).rejects.toThrow('http://node.invalid stayed busy through 5 requests of eth_getLogs: http 429')
    expect(counters).toEqual({ sent: 5, busy: 5 })
  })

  it('does not ask again for a refusal that is not about load: an error of the call, or a 4xx other than 429', async () => {
    const counters = { sent: 0, busy: 0 }
    const refused = rpcProvider('http://node.invalid', options(() => Promise.resolve(reply({ error: { code: -32602, message: 'invalid argument', data: '0x1' } })), { counters }))
    await expect(refused.request({ method: 'eth_call' })).rejects.toMatchObject({ message: 'invalid argument', code: -32602, data: '0x1' })
    const forbidden = rpcProvider('http://node.invalid', options(() => Promise.resolve(reply({}, 403)), { counters }))
    await expect(forbidden.request({ method: 'eth_call' })).rejects.toThrow('answered http 403')
    expect(counters).toEqual({ sent: 2, busy: 0 })
  })
})

describe('what a node answers is read as the chain it speaks of', () => {
  it('reads a block, a log of any width and a transaction, and refuses an answer that is no log', async () => {
    const log = { address: '0x5564886ca2C518d1964E5FCea4f423b41Db9F561', topics: ['0xaa'], data: '0x', blockNumber: '0x64', transactionHash: '0xab', logIndex: '0x2', removed: false }
    const asked: unknown[] = []
    const node = nodeChain('http://node.invalid', {
      clock: instantClock(),
      gapMs: 0,
      fetch: (_url, init) => {
        const { method, params } = JSON.parse(String(init?.body)) as { method: string, params: unknown[] }
        asked.push([method, params])
        const result = method === 'eth_getBlockByNumber' ? { number: '0x10', hash: '0xh', parentHash: '0xp', timestamp: '0x5' } : method === 'eth_getLogs' ? [log] : null
        return Promise.resolve(reply({ result }))
      }
    })
    expect(await node.getBlock('finalized')).toEqual({ number: 16, hash: '0xh', parentHash: '0xp', timestamp: 5 })
    expect(await node.getBlock(26_505_416)).not.toBeNull()
    expect(await node.getLogs({ fromBlock: 1, toBlock: 4_000_000, address: log.address as `0x${string}`, topics: [null, ['0x01', '0x02']] })).toEqual([{ ...log, blockNumber: 100, logIndex: 2 }])
    expect(asked[0]).toEqual(['eth_getBlockByNumber', ['finalized', false]])
    expect(asked[1]).toEqual(['eth_getBlockByNumber', ['0x19470c8', false]])
    expect(asked[2]).toEqual(['eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x3d0900', address: log.address, topics: [null, ['0x01', '0x02']] }]])
    expect(await node.getTransaction('0xab')).toBeNull()
  })

  it('has no block for a number the node does not know', async () => {
    const node = nodeChain('http://node.invalid', { clock: instantClock(), gapMs: 0, fetch: () => Promise.resolve(reply({ result: null })) })
    expect(await node.getBlock(5)).toBeNull()
  })

  it('fails on logs that are not a list', async () => {
    const node = nodeChain('http://node.invalid', { clock: instantClock(), gapMs: 0, fetch: () => Promise.resolve(reply({ result: { logs: [] } })) })
    await expect(node.getLogs({ fromBlock: 1, toBlock: 2 })).rejects.toThrow('the logs are not a list')
  })
})

describe('two nodes are one chain only while they say the same', () => {
  const log = (blockNumber: number, logIndex: number, address = '0xAbC') => ({ address, topics: ['0xAA', '0x01'], data: '0x' as const, blockNumber, transactionHash: '0xFF', logIndex, removed: false })
  const node = (over: Partial<CutChain>): CutChain => ({ latest: () => Promise.reject(new Error('unused')), call: () => Promise.reject(new Error('unused')), getLogs: () => Promise.resolve([]), getStorageAt: () => Promise.resolve('0x'), getTransaction: () => Promise.resolve(null), getBlock: () => Promise.resolve(null), ...over })

  it('answers what the first node answered when the second says the same in other order and case', async () => {
    const first = [log(5, 1), log(5, 2)]
    const chain = agreeingChain(node({ getLogs: () => Promise.resolve(first) }), node({ getLogs: () => Promise.resolve([log(5, 2, '0xabc'), { ...log(5, 1, '0xabc'), topics: ['0xaa', '0x01'] }]) }), ['A', 'B'])
    expect(await chain.getLogs({ fromBlock: 1, toBlock: 9 })).toBe(first)
  })

  it('stops naming both nodes and the read when a log is missing from one', async () => {
    const chain = agreeingChain(node({ getLogs: () => Promise.resolve([log(5, 1), log(6, 1)]) }), node({ getLogs: () => Promise.resolve([log(5, 1)]) }), ['https://one', 'https://two'])
    const failure = await chain.getLogs({ fromBlock: 1, toBlock: 9 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NodesDisagree)
    expect((failure as Error).message).toMatch(/^https:\/\/one and https:\/\/two disagree about getLogs\(\{"fromBlock":1,"toBlock":9\}\)/)
  })

  it.each([
    ['a block', { getBlock: (ref: number | 'finalized') => Promise.resolve({ number: Number(ref), hash: '0xa', parentHash: '0xb', timestamp: 1 }) }, { getBlock: (ref: number | 'finalized') => Promise.resolve({ number: Number(ref), hash: '0xc', parentHash: '0xb', timestamp: 1 }) }, (chain: CutChain) => chain.getBlock(7)],
    ['a storage slot', { getStorageAt: () => Promise.resolve('0x01' as const) }, { getStorageAt: () => Promise.resolve('0x02' as const) }, (chain: CutChain) => chain.getStorageAt('0x5564886ca2C518d1964E5FCea4f423b41Db9F561', '0x00', 1)],
    ['a transaction', { getTransaction: () => Promise.resolve(null) }, { getTransaction: () => Promise.resolve({ hash: '0x1', blockNumber: 1, from: '0x2', to: '0x3', input: '0x' as const }) }, (chain: CutChain) => chain.getTransaction('0x1')]
  ] as const)('stops when the nodes differ about %s', async (_what, one, two, read) => {
    await expect(read(agreeingChain(node(one), node(two), ['A', 'B']))).rejects.toBeInstanceOf(NodesDisagree)
  })

  it('reads a hexadecimal string the same in either case, and nothing else', () => {
    expect(canonical({ a: '0xAbC' })).toBe(canonical({ a: '0xabc' }))
    expect(canonical({ a: 'AbC' })).not.toBe(canonical({ a: 'abc' }))
  })

  it('has no newest block: a census is cut at one', async () => {
    await expect(agreeingChain(node({}), node({}), ['A', 'B']).latest()).rejects.toThrow('never at the newest')
  })
})
