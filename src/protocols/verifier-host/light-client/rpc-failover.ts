// Helios takes one execution RPC; this gives it several. A JSON-RPC request
// that fails, or answers with an error, is sent to the next endpoint. Which
// endpoint answers changes nothing about trust: the light client checks
// every answer against its proofs, and never sends eth_call, so an error is
// never an execution revert worth keeping.

import type { WebFetch } from '../egress.js'

/** The body is re-sent decoded, so the headers that described how it travelled no longer apply. */
const TRANSPORT_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding'])

function isErrorAnswer (text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    const answers = Array.isArray(parsed) ? parsed : [parsed]
    return answers.some((answer) => typeof answer !== 'object' || answer === null || 'error' in answer)
  } catch {
    return true
  }
}

/**
 * A fetch for Helios's one configured execution RPC (`endpoints[0]`) that
 * tries each endpoint in order. When every one fails, the last answer is
 * returned, so the light client reports that error rather than a made-up one.
 */
export function failoverRpc (endpoints: readonly string[], fetch: WebFetch): WebFetch {
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
        if (response.ok && !isErrorAnswer(text)) return last
      } catch (error) {
        lastError = error
      }
    }
    if (last !== undefined) return last
    throw lastError instanceof Error ? lastError : new Error('no execution RPC answered')
  }
}
