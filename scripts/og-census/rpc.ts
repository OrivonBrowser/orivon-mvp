import type { Eip1193Provider } from '../../src/protocols/ens/resolver.js'
import { eip1193Chain } from '../../src/protocols/og/chain.js'
import type { Block, Chain, Log, LogFilter } from '../../src/protocols/og/chain.js'

// One public JSON-RPC node, as the chain the census is cut through. Unlike the resolver's, its log query may span any number of
// blocks (the caller cuts the range up), and a node that is busy is asked again after a short pause, each node taking its requests
// at a pace of its own: free nodes answer 429 above a few requests a second.

/** A topic position of a log filter: one topic, a list of topics any of which matches, or any. */
export type Topic = string | readonly string[] | null

export interface WideFilter extends Omit<LogFilter, 'topics'> {
  readonly topics?: readonly Topic[]
}

export interface CutBlock extends Block {
  readonly parentHash: string
  readonly timestamp: number
}

/** The reads of a cut: the resolver's own (`Chain`), a log query of any width and a block by number or as the node finalized it. */
export interface CutChain extends Chain {
  getLogs: (filter: WideFilter) => Promise<Log[]>
  getBlock: (ref: number | 'finalized') => Promise<CutBlock | null>
}

export interface Clock {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }) }

/** Requests a node is asked, and how many of them it answered busy. */
export interface Counters {
  sent: number
  busy: number
}

export interface NodeOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly clock?: Clock
  /** In [0, 1): spreads the pause before a request is asked again. */
  readonly random?: () => number
  /** The least time between one request of this node and the next. */
  readonly gapMs?: number
  /** How many times a request is asked, busy answers included, before the cut stops. */
  readonly attempts?: number
  readonly counters?: Counters
}

export const GAP_MS = 200
export const ATTEMPTS = 40
const TIMEOUT_MS = 90_000
/** JSON-RPC codes a node answers when it is loaded: limit exceeded, internal error. */
const BUSY_CODES: ReadonlySet<number> = new Set([-32005, -32603])

class Busy extends Error {}

/** One node's turn-taking: a request goes at least `gapMs` after the one before it, an asked-again request included. */
export function createPacer (gapMs: number, clock: Clock = realClock): () => Promise<void> {
  let next = 0
  return async () => {
    const at = Math.max(clock.now(), next)
    next = at + gapMs
    if (at > clock.now()) await clock.sleep(at - clock.now())
  }
}

/** The result of one JSON-RPC request, or a `Busy` for an answer worth asking again. */
async function ask (send: typeof globalThis.fetch, url: string, method: string, params: unknown): Promise<unknown> {
  let response: Response
  try {
    response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    throw new Busy(error instanceof Error ? error.message : String(error))
  }
  if (response.status === 429 || response.status >= 500) throw new Busy(`http ${String(response.status)}`)
  if (!response.ok) throw new Error(`${url} answered http ${String(response.status)}`)
  let body: { result?: unknown, error?: { code?: number, message?: string, data?: unknown } }
  try {
    body = JSON.parse(await response.text())
  } catch {
    throw new Busy('an answer that is not JSON')
  }
  if (body.error !== undefined) {
    const failure = Object.assign(new Error(String(body.error.message)), { code: body.error.code, data: body.error.data })
    throw BUSY_CODES.has(Number(body.error.code)) ? new Busy(failure.message) : failure
  }
  return body.result
}

/** An EIP-1193 provider over one node's URL. */
export function rpcProvider (url: string, options: NodeOptions = {}): Eip1193Provider {
  const { fetch: send = globalThis.fetch, clock = realClock, random = Math.random, gapMs = GAP_MS, attempts = ATTEMPTS, counters } = options
  const pace = createPacer(gapMs, clock)
  return {
    request: async ({ method, params }) => {
      for (let attempt = 1; ; attempt++) {
        await pace()
        if (counters !== undefined) counters.sent++
        try {
          return await ask(send, url, method, params ?? [])
        } catch (error) {
          if (!(error instanceof Busy)) throw error
          if (counters !== undefined) counters.busy++
          if (attempt >= attempts) throw new Error(`${url} stayed busy through ${String(attempts)} requests of ${method}: ${error.message}`)
          await clock.sleep(1000 + random() * 1000)
        }
      }
    }
  }
}

const QUANTITY = /^0x[0-9a-fA-F]+$/

function numberOf (value: unknown, what: string): number {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new Error(`${what} is not a hexadecimal quantity`)
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw new Error(`${what} is past what can be held`)
  return number
}

const quantity = (value: number): string => `0x${value.toString(16)}`

function logOf (raw: unknown): Log {
  const log = raw as Record<string, unknown> | null
  if (typeof log !== 'object' || log === null || !Array.isArray(log['topics']) || typeof log['address'] !== 'string' || typeof log['data'] !== 'string') throw new Error('a log that is not a log')
  return {
    address: log['address'],
    topics: (log['topics'] as unknown[]).map(String),
    data: log['data'] as Log['data'],
    blockNumber: numberOf(log['blockNumber'], 'a log\'s block'),
    transactionHash: String(log['transactionHash']),
    logIndex: numberOf(log['logIndex'], 'a log\'s index'),
    removed: log['removed'] === true
  }
}

function blockOf (raw: unknown): CutBlock | null {
  if (raw === null || raw === undefined) return null
  const block = raw as Record<string, unknown>
  return { number: numberOf(block['number'], 'a block\'s number'), hash: String(block['hash']), parentHash: String(block['parentHash']), timestamp: numberOf(block['timestamp'], 'a block\'s time') }
}

/** The reads of the cut over one node. */
export function nodeChain (url: string, options: NodeOptions = {}): CutChain {
  const provider = rpcProvider(url, options)
  return {
    ...eip1193Chain(provider),
    getBlock: async (ref) => blockOf(await provider.request({ method: 'eth_getBlockByNumber', params: [ref === 'finalized' ? ref : quantity(ref), false] })),
    getLogs: async (filter) => {
      const raw = await provider.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: quantity(filter.fromBlock), toBlock: quantity(filter.toBlock), ...(filter.address === undefined ? {} : { address: filter.address }), ...(filter.topics === undefined ? {} : { topics: filter.topics }) }]
      })
      if (!Array.isArray(raw)) throw new Error('the logs are not a list')
      return raw.map(logOf)
    }
  }
}
