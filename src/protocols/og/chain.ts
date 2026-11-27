import { hexToBytes } from 'viem'
import type { Address, Hex } from 'viem'
import { ResolutionError } from '../resolution/records.js'
import type { Eip1193Provider } from '../ens/resolver.js'

// The reads the resolver makes of Ethereum, over an EIP-1193 provider this file never trusts or builds: the verifier host
// injects one backed by the light client, so state is proven at the block it names, and so is a log returned from the newest 8,000 blocks
// (that a block holds no log, at any age, is the server's word). A call that reverts is the contract's answer; a node that
// cannot be asked is a ChainError, and a provider's own ResolutionError (not synced, a failed proof) passes through untouched.
// A second provider, `servers`, reads the history the light client cannot prove: the same calls, over a wider range, from servers that
// may hide or invent a log (README.md section What it answers says what that can and cannot change).

/**
 * `unavailable`: the node cannot answer now. `limit`: the range is too wide or too many results. `rateLimited`: too many requests, to be
 * asked again after a wait. `invalid`: refused as malformed or unsupported. `reverted`: the call reverted. `badAnswer`: the answer had
 * the wrong shape.
 */
export type ChainFailure = 'unavailable' | 'limit' | 'rateLimited' | 'invalid' | 'reverted' | 'badAnswer'

export class ChainError extends Error {
  override readonly name = 'ChainError'
  /** For a rate limit: how long the server asked to wait, when it said. */
  readonly retryAfterMs: number | undefined
  constructor (readonly reason: ChainFailure, message: string, options: { cause?: unknown, retryAfterMs?: number | undefined } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.retryAfterMs = options.retryAfterMs
  }
}

/** A log as the node gave it. `topics` and `address` keep the node's spelling: compare them lower-cased. */
export interface Log {
  readonly address: string
  readonly topics: readonly string[]
  readonly data: Hex
  readonly blockNumber: number
  readonly transactionHash: string
  readonly logIndex: number
  readonly removed: boolean
}

/** A transaction as a node knows it: `to` is null for a creation, `blockNumber` is null for one not yet mined. */
export interface Transaction {
  readonly hash: string
  readonly blockNumber: number | null
  readonly from: string
  readonly to: string | null
  readonly input: Hex
}

export interface LogFilter {
  readonly fromBlock: number
  readonly toBlock: number
  readonly address?: Address | readonly Address[]
  readonly topics?: readonly (string | null)[]
}

export interface Block {
  readonly number: number
  readonly hash: string
}

/** The widest block range one getLogs may cover, counting both ends, through the light client. */
export const MAX_LOG_SPAN = 1024

/** The reads of the resolver, every one made at a block it names. */
export interface Chain {
  /** The same reads of old history, made of servers that prove nothing: its `getLogs` and `getTransaction` only. Absent when the host gives none. */
  readonly servers?: Chain
  /** The newest block the provider has verified. */
  latest: () => Promise<Block>
  /** A read-only call at `block`: the answer, or the revert's data. */
  call: (to: Address, data: Hex, block: number) => Promise<{ readonly data: Hex | null, readonly revert: Hex | null }>
  getLogs: (filter: LogFilter) => Promise<Log[]>
  /** The slot's value, at most 32 bytes. */
  getStorageAt: (address: Address, slot: Hex, block: number) => Promise<Hex>
  /** Null for a hash the node does not know. */
  getTransaction: (hash: string) => Promise<Transaction | null>
}

const QUANTITY = /^0x[0-9a-fA-F]+$/
const BYTES = /^0x(?:[0-9a-fA-F]{2})*$/

function quantityHex (value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new ChainError('invalid', 'a block number that is not a natural number')
  return `0x${value.toString(16)}`
}

function toNumber (value: unknown): number {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new ChainError('badAnswer', 'a quantity that is not hexadecimal')
  const number = Number(BigInt(value))
  if (!Number.isSafeInteger(number)) throw new ChainError('badAnswer', 'a number past what can be held')
  return number
}

function toBytes (value: unknown): Hex {
  if (typeof value !== 'string' || !BYTES.test(value)) throw new ChainError('badAnswer', 'bytes that are not hexadecimal')
  return value.toLowerCase() as Hex
}

/** A server's rate limit, in the words it uses: HTTP 429, a JSON-RPC rate limit, or a CDN's block (error 1015). Tested before a range, since "too many requests" is not "too many results". */
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b|\b1015\b/i

/** EIP-1193 and JSON-RPC error codes, as a node reports them. A ResolutionError (the light client's own failure) is not mapped. */
function fromProviderError (error: unknown, fn: string): unknown {
  if (error instanceof ChainError || error instanceof ResolutionError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error ? Number((error as { code: unknown }).code) : NaN
  const message = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? 'the provider refused')
  const asked = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs
  const waited = typeof asked === 'number' && Number.isFinite(asked) ? Math.max(0, asked) : undefined
  // A 503 that says how long to wait is a rate limit, as the failover reads it; one that says nothing is a server that is not there.
  if (code === 429 || (code === 503 && waited !== undefined) || RATE_LIMITED.test(message)) return new ChainError('rateLimited', message, { cause: error, retryAfterMs: waited })
  // 35 is what a node that caps the range of a query answers with.
  if (code === -32005 || code === 35 || (fn === 'getLogs' && /range|limit|too many|exceed/i.test(message))) return new ChainError('limit', message, { cause: error })
  if (code === 4200 || code === -32601 || code === -32602 || code === -32000) return new ChainError('invalid', message, { cause: error })
  return new ChainError('unavailable', message, { cause: error })
}

/** The revert data a node attached to a failed eth_call, wherever the node put it: `null` when the failure is not a revert. */
function revertData (error: unknown): Hex | null {
  const e = error as { data?: unknown, error?: { data?: unknown }, code?: unknown, message?: unknown } | null
  const nested = (e?.data as { data?: unknown, originalError?: { data?: unknown } } | undefined)
  const found = [e?.data, nested?.data, e?.error?.data, nested?.originalError?.data].find((candidate) => typeof candidate === 'string' && BYTES.test(candidate))
  if (typeof found === 'string') return found.toLowerCase() as Hex
  return e?.code === 3 || /execution reverted/i.test(String(e?.message)) ? '0x' : null
}

function logOf (raw: unknown): Log {
  const log = raw as Record<string, unknown> | null
  if (typeof log !== 'object' || log === null || !Array.isArray(log['topics']) || typeof log['address'] !== 'string') throw new ChainError('badAnswer', 'a log that is not a log')
  return {
    address: log['address'],
    topics: (log['topics'] as unknown[]).map(String),
    data: toBytes(log['data'] ?? '0x'),
    blockNumber: toNumber(log['blockNumber']),
    transactionHash: String(log['transactionHash']),
    logIndex: toNumber(log['logIndex']),
    removed: log['removed'] === true
  }
}

function transactionOf (raw: unknown): Transaction | null {
  if (raw === null || raw === undefined) return null
  const tx = raw as Record<string, unknown>
  return {
    hash: String(tx['hash']),
    blockNumber: tx['blockNumber'] === null || tx['blockNumber'] === undefined ? null : toNumber(tx['blockNumber']),
    from: String(tx['from']),
    to: tx['to'] === null || tx['to'] === undefined ? null : String(tx['to']),
    input: toBytes(tx['input'] ?? '0x')
  }
}

/**
 * The Chain over an EIP-1193 provider.
 * @param options.maxSpan the widest range one `getLogs` may cover: `MAX_LOG_SPAN` for the light client, more for servers that take a wider one
 */
export function eip1193Chain (provider: Eip1193Provider, options: { maxSpan?: number } = {}): Chain {
  const maxSpan = options.maxSpan ?? MAX_LOG_SPAN
  async function ask (method: string, params: unknown[], fn: string): Promise<unknown> {
    try {
      return await provider.request({ method, params })
    } catch (error) {
      throw fromProviderError(error, fn)
    }
  }
  return {
    latest: async () => {
      const block = await ask('eth_getBlockByNumber', ['latest', false], 'latest') as { number?: unknown, hash?: unknown } | null
      if (block === null || block === undefined) throw new ChainError('badAnswer', 'the provider returned no verified block')
      return { number: toNumber(block.number), hash: String(block.hash) }
    },
    call: async (to, data, block) => {
      try {
        const result = await provider.request({ method: 'eth_call', params: [{ to, data }, quantityHex(block)] })
        return { data: toBytes(result), revert: null }
      } catch (error) {
        if (error instanceof ResolutionError || error instanceof ChainError) throw error
        const revert = revertData(error)
        if (revert === null) throw fromProviderError(error, 'call')
        return { data: null, revert }
      }
    },
    getLogs: async (filter) => {
      if (filter.toBlock - filter.fromBlock + 1 > maxSpan) throw new ChainError('limit', `a log range of more than ${String(maxSpan)} blocks`)
      const address = filter.address === undefined ? undefined : Array.isArray(filter.address) ? filter.address : [filter.address]
      const logs = await ask('eth_getLogs', [{
        fromBlock: quantityHex(filter.fromBlock),
        toBlock: quantityHex(filter.toBlock),
        ...(address === undefined ? {} : { address }),
        ...(filter.topics === undefined ? {} : { topics: filter.topics })
      }], 'getLogs')
      if (!Array.isArray(logs)) throw new ChainError('badAnswer', 'logs are not a list')
      return logs.map(logOf)
    },
    getStorageAt: async (address, slot, block) => toBytes(await ask('eth_getStorageAt', [address, slot, quantityHex(block)], 'getStorageAt')),
    getTransaction: async (hash) => {
      const found = transactionOf(await ask('eth_getTransactionByHash', [hash], 'getTransaction'))
      // A node that answers another transaction than the one asked is not read.
      if (found !== null && found.hash.toLowerCase() !== hash.toLowerCase()) throw new ChainError('badAnswer', 'the node answered another transaction than the one asked')
      return found
    }
  }
}

/** The bytes of a hexadecimal string, for the callers that read a selector or a word out of one. */
export function bytesOf (hex: Hex): Uint8Array {
  return hexToBytes(hex)
}
