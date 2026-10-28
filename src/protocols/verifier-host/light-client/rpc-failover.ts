// Helios takes one execution RPC; this gives it several. A JSON-RPC request
// that fails, or answers with an error, is sent to the next endpoint. Which
// endpoint answers changes nothing about trust: the light client checks
// every answer against its proofs, and never sends eth_call, so an error is
// never an execution revert worth keeping.

import type { WebFetch } from '../egress.js'

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
  if (named?.name === 'TimeoutError' || (typeof named?.message === 'string' && /carried no bytes/.test(named.message))) return 'did not answer in time'
  const code = typeof named?.code === 'string' ? named.code : typeof named?.message === 'string' ? /net::(ERR_[A-Z0-9_]+)/.exec(named.message)?.[1] : undefined
  return code !== undefined && /^E[A-Z0-9_]+$/.test(code) ? `could not be reached (${code})` : 'could not be reached'
}

/**
 * A fetch for Helios's one configured execution RPC (`endpoints[0]`) that
 * tries each endpoint in order. When every one fails, the last answer is
 * returned, so the light client reports that error rather than a made-up one.
 * `note` hears each endpoint's outcome as it happens: why it failed (a status or a
 * code), or `undefined` once it answers, so a caller can say which server broke.
 */
export function failoverRpc (endpoints: readonly string[], fetch: WebFetch, note: (endpoint: string, problem: string | undefined) => void = () => {}): WebFetch {
  return async (url, init) => {
    let last: Response | undefined
    let lastError: unknown
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, init)
        const text = await response.text()
        const headers = [...response.headers].filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()))
        last = new Response(text, { status: response.status, headers })
        // A constructed Response's url is empty, and Helios's HTTP client parses it: without this it stalls for good.
        Object.defineProperty(last, 'url', { value: url })
        const problem = answerProblem(response, text)
        note(endpoint, problem)
        if (problem === undefined) return last
      } catch (error) {
        lastError = error
        note(endpoint, problemOf(error))
      }
    }
    if (last !== undefined) return last
    throw lastError instanceof Error ? lastError : new Error('no execution RPC answered')
  }
}
