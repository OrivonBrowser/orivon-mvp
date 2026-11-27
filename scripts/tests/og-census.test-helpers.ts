import { fakeProvider } from '../../src/protocols/og/tests/world.js'
import type { World } from '../../src/protocols/og/tests/world.js'
import { agreeingChain } from '../og-census/agree.js'
import { chunkedChain } from '../og-census/logs.js'
import { nodeChain } from '../og-census/rpc.js'
import type { Clock, CutChain } from '../og-census/rpc.js'

// A JSON-RPC node over a fake world, for the census tool's tests: the world's own provider, taught what the tool asks of a node and the
// world's provider never is (a block by number or as finalized, a topic that is a list of keys).

type Params = unknown[]

const hex = (value: number): string => `0x${value.toString(16)}`

/** A clock that never waits: `sleeps` holds each pause asked for. */
export function instantClock (): Clock & { readonly sleeps: number[] } {
  let now = 0
  const sleeps: number[] = []
  return { sleeps, now: () => now, sleep: (ms) => { sleeps.push(ms); now += ms; return Promise.resolve() } }
}

/** The `fetch` of a node whose chain is `world`; `tamper` may change an answer, to make a node that is wrong. */
export function fakeNode (world: World, tamper: (method: string, result: unknown) => unknown = (_method, result) => result): typeof globalThis.fetch {
  const provider = fakeProvider(world, { maxSpan: Infinity })
  const logsOf = async (filter: { topics?: unknown[] }): Promise<{ blockNumber: string, logIndex: string }[]> => {
    const topics = filter.topics ?? []
    const listAt = topics.findIndex((topic) => Array.isArray(topic))
    if (listAt < 0) return await provider.request({ method: 'eth_getLogs', params: [filter] }) as never
    const merged = new Map<string, { blockNumber: string, logIndex: string }>()
    for (const one of topics[listAt] as string[]) {
      for (const log of await provider.request({ method: 'eth_getLogs', params: [{ ...filter, topics: topics.map((topic, index) => index === listAt ? one : topic) }] }) as { blockNumber: string, logIndex: string }[]) merged.set(`${log.blockNumber}:${log.logIndex}`, log)
    }
    return [...merged.values()].sort((a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)) || Number(BigInt(a.logIndex)) - Number(BigInt(b.logIndex)))
  }
  const answer = async (method: string, params: Params): Promise<unknown> => {
    if (method === 'eth_getLogs') return await logsOf(params[0] as { topics?: unknown[] })
    if (method === 'eth_getBlockByNumber' && params[0] !== 'latest') {
      const number = params[0] === 'finalized' ? world.head : Number(BigInt(String(params[0])))
      return { number: hex(number), hash: `0x${number.toString(16).padStart(64, '0')}`, parentHash: `0x${(number - 1).toString(16).padStart(64, '0')}`, timestamp: hex(1_700_000_000 + number) }
    }
    return await provider.request({ method, params })
  }
  return async (_url, init) => {
    const { method, params, id } = JSON.parse(String(init?.body)) as { method: string, params: Params, id: number }
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: tamper(method, await answer(method, params)) }))
    } catch (error) {
      const failure = error as { code?: number, message?: string, data?: unknown }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: failure.code ?? -32000, message: failure.message ?? 'failed', data: failure.data } }))
    }
  }
}

/** The chain the tool cuts through, over two fake nodes: each of the worlds given, or both the first. */
export function fakeCutChain (first: World, second: World = first, tamperSecond?: (method: string, result: unknown) => unknown): CutChain {
  const clock = instantClock()
  const nodes = [nodeChain('http://first.invalid', { fetch: fakeNode(first), clock, gapMs: 0 }), nodeChain('http://second.invalid', { fetch: fakeNode(second, tamperSecond), clock, gapMs: 0 })] as const
  return chunkedChain(agreeingChain(nodes[0], nodes[1], ['the first node', 'the second node']))
}
