// Helios takes one execution RPC; this gives it several. A JSON-RPC request
// that fails, or answers with an error, is sent to the next endpoint; one that
// is slow is hedged by the next, and one that hangs is given up on. Which
// endpoint answers changes nothing about trust: the light client checks
// every answer against its proofs, and never sends eth_call, so an error is
// never an execution revert worth keeping.

import { Outrun, racePass } from '../../gateways/race.js'
import type { AttemptOutcome } from '../../gateways/race.js'
import { unlessAborted } from '../../resolution/timing.js'
import type { WebFetch } from '../egress.js'
import { RPC_ATTEMPT_TIMEOUT_MS, RPC_HEDGE_MS } from '../pace.js'

export interface FailoverTiming {
  readonly hedgeAfterMs: number
  readonly attemptTimeoutMs: number
}

/** What `note` hears of an endpoint that was asked and did not answer within the time given. */
export const NO_ANSWER = 'did not answer in time'

/** The body is re-sent decoded, so the headers that described how it travelled no longer apply. */
const TRANSPORT_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding'])

/** Why an answer is not one to use, in words that carry nothing the server or the connection said: a status or a code, never a text. */
function answerProblem (response: Response, text: string): string | undefined {
  if (!response.ok) return `answered ${String(response.status)}`
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'answered something that is not JSON-RPC'
  }
  const answers = Array.isArray(parsed) ? parsed : [parsed]
  for (const answer of answers) {
    if (typeof answer !== 'object' || answer === null) return 'answered something that is not JSON-RPC'
    if ('error' in answer) {
      const code = (answer as { error?: { code?: unknown } }).error?.code
      return typeof code === 'number' && Number.isInteger(code) ? `answered a JSON-RPC error (code ${String(code)})` : 'answered a JSON-RPC error'
    }
  }
  return undefined
}

/** What a failed connection says about itself that is safe to show: its code, never its message, which may quote the address. */
export function problemOf (error: unknown): string {
  const named = error as { code?: unknown, name?: unknown, message?: unknown } | null
  if (named?.name === 'TimeoutError' || (typeof named?.message === 'string' && /carried no bytes/.test(named.message))) return NO_ANSWER
  const code = typeof named?.code === 'string' ? named.code : typeof named?.message === 'string' ? /net::(ERR_[A-Z0-9_]+)/.exec(named.message)?.[1] : undefined
  return code !== undefined && /^E[A-Z0-9_]+$/.test(code) ? `could not be reached (${code})` : 'could not be reached'
}

/**
 * A fetch for Helios's one configured execution RPC (`endpoints[0]`) that
 * tries each endpoint in order, through `racePass`: the next is asked at once
 * when one fails, and also when one has not answered within `hedgeAfterMs`
 * (never more than two at a time); the first good answer wins and the others
 * are cancelled. An endpoint is given up on `attemptTimeoutMs` after it was
 * asked, so one that hangs frees room for the next. When every one fails, the
 * last answer is returned, so the light client reports that error rather than
 * a made-up one. `note` hears each endpoint's outcome as it happens: why it
 * failed (a status or a code), or `undefined` once it answers, so a caller can
 * say which server broke. An endpoint cancelled only because an earlier one
 * answered first is not a problem and is not noted.
 */
export function failoverRpc (endpoints: readonly string[], fetch: WebFetch, note: (endpoint: string, problem: string | undefined) => void = () => {}, timing: FailoverTiming = { hedgeAfterMs: RPC_HEDGE_MS, attemptTimeoutMs: RPC_ATTEMPT_TIMEOUT_MS }): WebFetch {
  return async (url, init) => {
    const callerSignal = init?.signal ?? new AbortController().signal
    let last: Response | undefined
    let lastError: unknown
    const failed = (reason: string): AttemptOutcome<Response> => ({ kind: 'failed', retryable: false, reason })

    const attempt = async (endpoint: string, signal: AbortSignal): Promise<AttemptOutcome<Response>> => {
      const timeout = new AbortController()
      const timer = setTimeout(() => { timeout.abort(new DOMException(`no answer within ${String(timing.attemptTimeoutMs)} ms`, 'TimeoutError')) }, timing.attemptTimeoutMs)
      const attemptSignal = AbortSignal.any([signal, timeout.signal])
      // Stops waiting the moment the signal fires, even on a fetch that ignores it; nothing is started once it has fired, so no promise is left to reject unheard.
      const unlessCancelled = async <T>(start: () => Promise<T>): Promise<T> => {
        attemptSignal.throwIfAborted()
        return await unlessAborted(start(), attemptSignal)
      }
      try {
        const response = await unlessCancelled(async () => await fetch(endpoint, { ...init, signal: attemptSignal }))
        // The body is read under the same signal: a server that sends its headers and stalls is as hung as one that sends nothing.
        const text = await unlessCancelled(async () => await response.text())
        const headers = [...response.headers].filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()))
        const answer = new Response(text, { status: response.status, headers })
        // A constructed Response's url is empty, and Helios's HTTP client parses it: without this it stalls for good.
        Object.defineProperty(answer, 'url', { value: url })
        last = answer
        const problem = answerProblem(response, text)
        note(endpoint, problem)
        return problem === undefined ? { kind: 'verified', value: answer } : failed(problem)
      } catch (error) {
        if (callerSignal.aborted) return failed('the request was cancelled')
        if (timeout.signal.aborted) {
          lastError = timeout.signal.reason
          note(endpoint, NO_ANSWER)
          return failed(NO_ANSWER)
        }
        // Cancelled because another endpoint answered while this one, asked first, had not: slow, and worth saying. One cancelled because an earlier one answered is not.
        if (signal.reason instanceof Outrun) {
          note(endpoint, NO_ANSWER)
          return failed(NO_ANSWER)
        }
        if (signal.aborted) return failed('another endpoint answered first')
        lastError = error
        const problem = problemOf(error)
        note(endpoint, problem)
        return failed(problem)
      } finally {
        clearTimeout(timer)
      }
    }

    const result = await racePass(endpoints, attempt, timing.hedgeAfterMs, callerSignal)
    if (result.kind === 'verified') return result.value
    if (result.kind === 'fatal') throw result.error
    if (last !== undefined) return last
    throw lastError instanceof Error ? lastError : new Error('no execution RPC answered')
  }
}
