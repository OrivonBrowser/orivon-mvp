// Which of the execution servers the person named are Ethereum mainnet. A server on another chain (a testnet's address pasted
// by mistake) would answer every proof request with a block the light client refuses, which reads as a server that lies;
// asking its chain id first turns that into a plain sentence. Pure apart from the fetch it is given.

import type { WebFetch } from '../egress.js'
import { withTimeout } from '../../resolution/timing.js'
import { maskEndpoint } from './endpoint-mask.js'

const CHAIN_ID_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
const DEFAULT_TIMEOUT_MS = 10_000
const HEX = /^0x[0-9a-f]+$/i

export interface ChainCheck {
  /** The servers that said mainnet, or that could not be asked or gave no chain: their own trouble shows when they are used. In the order given. */
  readonly usable: readonly string[]
  readonly wrong: ReadonlyArray<{ readonly endpoint: string, readonly chainId: bigint }>
}

/** The chain a server said it serves, or undefined when it did not say. */
async function chainOf (endpoint: string, fetch: WebFetch, timeoutMs: number): Promise<bigint | undefined> {
  try {
    const answer = withTimeout((async () => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: CHAIN_ID_BODY, signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) return undefined
      const parsed = await response.json() as { result?: unknown }
      return typeof parsed.result === 'string' && HEX.test(parsed.result) ? BigInt(parsed.result) : undefined
    })(), timeoutMs, 'the chain id')
    return await answer
  } catch {
    return undefined
  }
}

export async function checkMainnet (endpoints: readonly string[], fetch: WebFetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChainCheck> {
  const chains = await Promise.all(endpoints.map(async (endpoint) => await chainOf(endpoint, fetch, timeoutMs)))
  const usable: string[] = []
  const wrong: Array<{ endpoint: string, chainId: bigint }> = []
  endpoints.forEach((endpoint, at) => {
    const chainId = chains[at]
    if (chainId === undefined || chainId === 1n) usable.push(endpoint)
    else wrong.push({ endpoint, chainId })
  })
  return { usable, wrong }
}

/** What the person is told of a server on another chain: masked, so the key in its address stays out of sight. */
export function wrongChainText (endpoint: string, chainId: bigint): string {
  return `${maskEndpoint(endpoint)} is not Ethereum mainnet (chain ${chainId.toString()})`
}
