// The ENS resolver for `.eth`: a name's contenthash through the Universal
// Resolver, over an EIP-1193 provider this file never trusts or builds. The
// verifier host injects one backed by the light client, so every answer is
// proven, and a CCIP-Read request function that decides where offchain
// lookups may go.

import { BaseError, ContractFunctionRevertedError, createPublicClient, custom, decodeFunctionResult, encodeFunctionData, hexToBytes, parseAbi, toHex } from 'viem'
import type { Address, Hex } from 'viem'
import { namehash, packetToBytes } from 'viem/ens'
import { ResolutionError } from '../resolution/records.js'
import type { NameRecord, ResolutionFailure } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import { decodeContenthash } from './contenthash.js'
import { ensNameFromHost } from './name.js'

/** ENS's Universal Resolver on mainnet, the address viem's chain definition ships. */
export const UNIVERSAL_RESOLVER: Address = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'

/** Tells the Universal Resolver that this client runs CCIP-Read batches itself. */
const LOCAL_BATCH_GATEWAY = 'x-batch-gateway:true'

const universalResolverAbi = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes result, address resolver)',
  'error DNSDecodingFailed(bytes dns)',
  'error DNSEncodingFailed(string ens)',
  'error EmptyAddress()',
  'error HttpError(uint16 status, string message)',
  'error InvalidBatchGatewayResponse()',
  'error ResolverError(bytes errorData)',
  'error ResolverNotContract(bytes name, address resolver)',
  'error ResolverNotFound(bytes name)',
  'error ReverseAddressMismatch(string primary, bytes primaryAddress)',
  'error UnsupportedResolverProfile(bytes4 selector)'
])

const contenthashAbi = parseAbi(['function contenthash(bytes32 node) view returns (bytes)'])

/** What the Universal Resolver's reverts mean for a contenthash lookup. */
const REVERT_FAILURES: Readonly<Record<string, ResolutionFailure>> = {
  ResolverNotFound: 'not-found',
  ResolverNotContract: 'not-found',
  UnsupportedResolverProfile: 'not-found',
  DNSEncodingFailed: 'invalid-name',
  // An offchain gateway that failed, or the name's resolver reverting, is
  // not a proven absence: another try may answer.
  HttpError: 'unavailable',
  InvalidBatchGatewayResponse: 'unavailable',
  ResolverError: 'unavailable'
}

export interface Eip1193Provider {
  request: (args: { method: string, params?: unknown }) => Promise<unknown>
}

export interface CcipRequestParameters {
  readonly data: Hex
  readonly sender: Address
  readonly urls: readonly string[]
}

/** Fetches one CCIP-Read answer; the resolver contract then checks it inside a proven call. */
export type CcipRequest = (parameters: CcipRequestParameters, signal: AbortSignal) => Promise<Hex>

/**
 * Offchain queries one resolution may make. A batch gateway answer can name
 * any number, and each would otherwise be a request to a host the resolver
 * contract chose, sent from every browser that loads the name.
 */
export const MAX_CCIP_QUERIES = 8

export interface EnsResolverOptions {
  readonly provider: Eip1193Provider
  readonly ccipRequest: CcipRequest
  readonly universalResolver?: Address
}

function causes (error: unknown): unknown[] {
  const chain: unknown[] = []
  for (let e: unknown = error; e !== undefined && e !== null && chain.length < 16; e = (e as { cause?: unknown }).cause) chain.push(e)
  return chain
}

/** A ResolutionError the provider threw (the verifier host reports "not synced" and failed proofs that way) survives viem's wrapping. */
function failureOf (error: unknown): ResolutionError {
  const own = causes(error).find((e): e is ResolutionError => e instanceof ResolutionError)
  if (own !== undefined) return own
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      const errorName = revert.data?.errorName ?? 'an unknown revert'
      return new ResolutionError(REVERT_FAILURES[errorName] ?? 'unavailable', `the Universal Resolver reverted with ${errorName}`)
    }
    // viem's own message ("An unknown RPC error occurred") names nothing; the deepest cause says what failed.
    const cause = error.walk()
    return new ResolutionError('unavailable', cause instanceof Error && cause !== error ? cause.message : error.shortMessage)
  }
  return new ResolutionError('unavailable', error instanceof Error ? error.message : String(error))
}

/**
 * The newest block the light client has verified. Not `finalized`: that
 * lags the head by about 80 blocks, and public RPCs serve proofs only for
 * recent blocks, so a call there fails whenever finality lags past the
 * RPC's proof window. README.md's Design notes say what that trades away.
 */
async function provenBlock (provider: Eip1193Provider): Promise<bigint> {
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })
  const number = (block as { number?: unknown } | null)?.number
  if (typeof number !== 'string' || !/^0x[0-9a-f]+$/i.test(number)) throw new ResolutionError('unavailable', 'the provider returned no verified block')
  return BigInt(number)
}

/**
 * Every `eth_call` of one resolution runs at `block`. viem sends a CCIP-Read
 * callback at `latest` whatever block the first call named, so without this
 * a gateway's answer would be checked against different state from the
 * block the record claims.
 */
function pinnedTo (provider: Eip1193Provider, block: bigint, signal: AbortSignal): Eip1193Provider {
  const tag = toHex(block)
  return {
    request: async ({ method, params }) => {
      signal.throwIfAborted()
      if (method !== 'eth_call' || !Array.isArray(params)) return await provider.request({ method, params })
      return await provider.request({ method, params: [params[0], tag, ...params.slice(2)] })
    }
  }
}

export function createEnsResolver (options: EnsResolverOptions): NameResolver {
  const universalResolver = options.universalResolver ?? UNIVERSAL_RESOLVER
  return {
    id: 'ens',
    topLevelDomains: ['eth'],
    async resolve (host, signal = new AbortController().signal) {
      const name = ensNameFromHost(host)
      let offchain = false
      let queries = 0
      try {
        signal.throwIfAborted()
        const block = await provenBlock(options.provider)
        const client = createPublicClient({
          // The provider is local; it retries its own upstream requests, and a
          // retry here would only delay a revert viem cannot tell from a fault.
          transport: custom(pinnedTo(options.provider, block, signal), { retryCount: 0 }),
          ccipRead: {
            request: async (parameters) => {
              offchain = true
              signal.throwIfAborted()
              if (++queries > MAX_CCIP_QUERIES) throw new Error(`more than ${String(MAX_CCIP_QUERIES)} offchain queries for one name`)
              return await options.ccipRequest(parameters, signal)
            }
          }
        })
        const [result] = await client.readContract({
          address: universalResolver,
          abi: universalResolverAbi,
          functionName: 'resolveWithGateways',
          args: [
            toHex(packetToBytes(name)),
            encodeFunctionData({ abi: contenthashAbi, functionName: 'contenthash', args: [namehash(name)] }),
            [LOCAL_BATCH_GATEWAY]
          ]
        })
        const bytes = result === '0x' ? new Uint8Array() : hexToBytes(decodeFunctionResult({ abi: contenthashAbi, functionName: 'contenthash', data: result }))
        const pointer = decodeContenthash(bytes)
        if (pointer === undefined) return []
        const record: NameRecord = { type: 'contenthash', pointer, provenance: { via: 'chain', block: Number(block), offchain } }
        return [record]
      } catch (error) {
        throw failureOf(error)
      }
    }
  }
}
