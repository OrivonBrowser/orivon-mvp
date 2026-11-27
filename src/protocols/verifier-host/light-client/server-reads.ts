import { retryAfterMs } from '../../gateways/gateway-health.js'
import type { Eip1193Provider } from '../../ens/resolver.js'
import type { WebFetch } from '../egress.js'

// What the light client cannot prove, asked of the servers it uses: the logs and transactions of blocks older than the 8,191 it
// knows. The request goes through the same failover (`rpc-failover.ts`: hedging, cooldowns, the servers' own order) and the same
// egress as the light client's, to the same servers, and nothing here names one of them: an error says a status or a code and the
// words of the server's own answer with every configured address masked. What comes back is the servers' word and proves nothing.

/** The only methods a read of the servers may make: history, which a provider that proves cannot give. State is always the light client's. */
export const SERVER_READ_METHODS: ReadonlySet<string> = new Set(['eth_getLogs', 'eth_getTransactionByHash'])

/**
 * How long one read may take, hedging and the second pass included: under the 28 seconds of a call's 30 that a scan may use, so a read
 * that hangs ends inside the call that asked it. A request of the archive part of a server answers in seconds or not at all.
 */
export const SERVER_READ_TIMEOUT_MS = 25_000

/** EIP-1193's code for a provider that cannot reach its chain. */
const DISCONNECTED = 4900
/** EIP-1193's code for a method the provider does not give. */
const UNSUPPORTED_METHOD = 4200
/** JSON-RPC's code for an internal error. */
const INTERNAL = -32603

/**
 * What a server said, as an EIP-1193 provider error: the JSON-RPC `code` of its answer, or its HTTP status when it sent none (a rate
 * limit is 429 whatever its body says), and for a rate limit how long it asked to wait.
 */
export class ServerReadError extends Error {
  override readonly name = 'ServerReadError'
  readonly retryAfterMs: number | undefined
  readonly data: unknown
  constructor (readonly code: number, message: string, retryAfterMs?: number, data?: unknown) {
    super(message)
    this.retryAfterMs = retryAfterMs
    this.data = data
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * A provider that sends `eth_getLogs` and `eth_getTransactionByHash` to the execution servers and answers whatever they say.
 * @param execution the failover over the servers now in use: a function, since a start that finds one server on another chain replaces it
 * @param url the name the light client's execution lane goes by: the failover sends each request to its own servers whatever the url
 * @param clean the words of an error as they may be shown: the lane names read as servers, and no configured address left in them
 */
export function serverReads (execution: () => WebFetch, url: string, clean: (text: string) => string = (text) => text): Eip1193Provider {
  let id = 0
  return {
    request: async ({ method, params }) => {
      if (!SERVER_READ_METHODS.has(method)) throw new ServerReadError(UNSUPPORTED_METHOD, `${method} is not read from the execution servers`)
      let response: Response
      let text: string
      try {
        response = await execution()(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
          signal: AbortSignal.timeout(SERVER_READ_TIMEOUT_MS)
        })
        text = await response.text()
      } catch (error) {
        throw new ServerReadError(DISCONNECTED, clean(error instanceof Error ? error.message : 'the execution servers could not be reached'))
      }
      let answer: unknown
      try {
        answer = JSON.parse(text)
      } catch {
        answer = undefined
      }
      const wait = response.status === 429 || response.status === 503 ? retryAfterMs(response.headers.get('retry-after'), Date.now()) : undefined
      const failure = isObject(answer) ? answer['error'] : undefined
      if (isObject(failure)) {
        const code = failure['code']
        const said = typeof failure['message'] === 'string' ? clean(failure['message']) : 'the execution servers refused the request'
        // A 429 is a rate limit whatever code its body carries, and so is a 503 that says how long to wait.
        const limited = response.status === 429 || (response.status === 503 && wait !== undefined)
        throw new ServerReadError(limited ? 429 : typeof code === 'number' && Number.isInteger(code) ? code : response.status, said, wait, failure['data'])
      }
      if (!response.ok) throw new ServerReadError(response.status, `the execution servers answered ${String(response.status)}`, wait)
      if (!isObject(answer) || !('result' in answer)) throw new ServerReadError(INTERNAL, 'the execution servers answered something that is not JSON-RPC')
      return answer['result']
    }
  }
}
