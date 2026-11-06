// Helios takes one execution RPC; this gives it several. A JSON-RPC request
// that fails, or answers with an error, is sent to the next endpoint; one that
// is slow is hedged by the next, and one that hangs is given up on when
// another is left to ask. An endpoint that failed is asked after the others
// until its cooldown ends. Which endpoint answers changes nothing about trust:
// the light client checks every answer against its proofs, and never sends
// eth_call, so an error is never an execution revert worth keeping.

import { GatewayHealth, retryAfterMs } from '../../gateways/gateway-health.js'
import type { GatewayOutcome } from '../../gateways/gateway-health.js'
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

/** Heard when an endpoint goes from being asked in order to being asked last: why, in words that follow "an execution server", and for how long. */
export type CoolingNote = (endpoint: string, why: string, forMs: number) => void

/** Why an outcome that sets an endpoint aside did so. `ok` and `miss` never do. */
const COOLING_WHY: Partial<Record<GatewayOutcome['kind'], string>> = {
  timeout: NO_ANSWER,
  unreachable: 'could not be reached',
  'rate-limited': 'was rate limited',
  'server-error': 'answered with server errors'
}

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

/** What an answer that is no good says of its server, for the endpoint's health: a rate limit, an outage, or a plain miss that cools nothing. */
function badAnswer (response: Response): GatewayOutcome {
  const retryAfter = response.headers.get('retry-after')
  if (response.status === 429 || (response.status === 503 && retryAfter !== null)) return { kind: 'rate-limited', retryAfterMs: retryAfterMs(retryAfter, Date.now()) }
  return response.status >= 500 ? { kind: 'server-error' } : { kind: 'miss' }
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
 * tries the endpoints through `racePass`: the next is asked at once when one
 * fails, and also when one has not answered within `hedgeAfterMs` (never more
 * than two at a time); the first good answer wins and the others are
 * cancelled. An endpoint is given up on `attemptTimeoutMs` after it was
 * asked only when another is still to be asked in its place; the last ones
 * asked are waited on, bounded by the caller's signal. When every one fails,
 * the last answer to arrive is returned, so the light client reports that
 * error rather than a made-up one.
 *
 * Each endpoint keeps a `GatewayHealth` for as long as this fetch lives, and
 * a request asks the endpoints that are not cooling first, in the order
 * given, then the cooling ones (never dropped: all may be cooling). `cooled`
 * hears an endpoint the moment it starts cooling, once per cooldown. `note`
 * hears each endpoint's outcome as it happens: why it failed (a status or a
 * code), or `undefined` once it answers, so a caller can say which server
 * broke. An endpoint cancelled only because an earlier one answered first is
 * not a problem and is not noted; nor is one cancelled after it had begun to
 * answer.
 */
export function failoverRpc (endpoints: readonly string[], fetch: WebFetch, note: (endpoint: string, problem: string | undefined) => void = () => {}, timing: FailoverTiming = { hedgeAfterMs: RPC_HEDGE_MS, attemptTimeoutMs: RPC_ATTEMPT_TIMEOUT_MS }, cooled?: CoolingNote): WebFetch {
  const now = (): number => Date.now()
  const health = new Map(endpoints.map((endpoint) => [endpoint, new GatewayHealth(now)]))
  const record = (endpoint: string, outcome: GatewayOutcome): void => {
    const own = health.get(endpoint)!
    const wasCooling = own.cooling()
    own.note(outcome)
    const why = COOLING_WHY[outcome.kind]
    if (!wasCooling && own.cooling() && why !== undefined) cooled?.(endpoint, why, own.readyAt() - now())
  }

  return async (url, init) => {
    const callerSignal = init?.signal ?? new AbortController().signal
    const order = [...endpoints.filter((endpoint) => !health.get(endpoint)!.cooling()), ...endpoints.filter((endpoint) => health.get(endpoint)!.cooling())]
    let started = 0
    let last: Response | undefined
    let lastError: unknown
    const failed = (reason: string): AttemptOutcome<Response> => ({ kind: 'failed', retryable: false, reason })

    const attempt = async (endpoint: string, signal: AbortSignal): Promise<AttemptOutcome<Response>> => {
      started++
      const askedAt = now()
      let headersArrived = false
      const timeout = new AbortController()
      // Giving up pays only when another endpoint can take its place; the last ones asked are waited on, and the caller's signal bounds them.
      const timer = setTimeout(() => { if (started < order.length) timeout.abort(new DOMException('no answer in time', 'TimeoutError')) }, timing.attemptTimeoutMs)
      const attemptSignal = AbortSignal.any([signal, timeout.signal])
      const noAnswer = (): AttemptOutcome<Response> => {
        record(endpoint, { kind: 'timeout' })
        note(endpoint, NO_ANSWER)
        return failed(NO_ANSWER)
      }
      try {
        // Stops waiting the moment the signal fires, even on a fetch that ignores it; nothing is started once it has fired, so no promise is left to reject unheard.
        attemptSignal.throwIfAborted()
        const pending = fetch(endpoint, { ...init, signal: attemptSignal })
        let response: Response
        try {
          response = await unlessAborted(pending, attemptSignal)
        } catch (error) {
          // A fetch that ignores its signal may still deliver a response later, which nothing reads: its connection is let go.
          pending.then((late) => { late.body?.cancel().catch(() => {}) }, () => {})
          throw error
        }
        headersArrived = true
        // The body is read under the same signal: a server that sends its headers and stalls is as hung as one that sends nothing.
        attemptSignal.throwIfAborted()
        const text = await unlessAborted(response.text(), attemptSignal)
        const headers = [...response.headers].filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()))
        const answer = new Response(text, { status: response.status, headers })
        // A constructed Response's url is empty, and Helios's HTTP client parses it: without this it stalls for good.
        Object.defineProperty(answer, 'url', { value: url })
        last = answer
        const problem = answerProblem(response, text)
        record(endpoint, problem === undefined ? { kind: 'ok', latencyMs: now() - askedAt } : badAnswer(response))
        note(endpoint, problem)
        return problem === undefined ? { kind: 'verified', value: answer } : failed(problem)
      } catch (error) {
        if (callerSignal.aborted) return failed('the request was cancelled')
        if (timeout.signal.aborted) return noAnswer()
        // Cancelled because another endpoint answered while this one, asked first, had said nothing: slow, and worth saying. One that had begun to answer, or that an earlier one outran, is no problem.
        if (signal.reason instanceof Outrun && !headersArrived) return noAnswer()
        if (signal.aborted) return failed('another endpoint answered first')
        lastError = error
        const problem = problemOf(error)
        if (problem === NO_ANSWER) return noAnswer()
        record(endpoint, { kind: 'unreachable' })
        note(endpoint, problem)
        return failed(problem)
      } finally {
        clearTimeout(timer)
      }
    }

    const result = await racePass(order, attempt, timing.hedgeAfterMs, callerSignal)
    if (result.kind === 'verified') return result.value
    if (result.kind === 'fatal') throw result.error
    if (last !== undefined) return last
    throw lastError instanceof Error ? lastError : new Error('no execution RPC answered')
  }
}
