// The one place typed text leaves the machine before Enter: a request to the default engine's suggestion
// address, asked only when every guard in `mayRequest` holds. The request carries no cookie and no referrer,
// refuses a redirect, gives up after 1.5 s, and reads at most 64 KB of the answer.
import { matchRanges } from './suggest.js'
import type { SuggestionRow } from './suggest.js'
import { parseSuggestions } from './suggest-parse.js'
import type { LateSource } from './suggest-sources.js'

export const DEBOUNCE_MS = 150
export const TIMEOUT_MS = 1500
export const MAX_RESPONSE_BYTES = 64 * 1024
const MIN_TEXT = 2
const MAX_TEXT = 200

/** The part of `fetch` this uses: what `net.fetch` and a test's stand-in both provide. */
export type SuggestResponse = Pick<Response, 'ok' | 'headers' | 'body'>
export type FetchImpl = (url: string, init: {
  credentials: 'omit'
  redirect: 'error'
  referrer: ''
  signal: AbortSignal
  headers: Record<string, string>
}) => Promise<SuggestResponse>

/** What the window knows about suggestions for the query being asked. Absent, or with `endpoint` null, nothing is sent. */
export interface SuggestDeps {
  /** `search.suggestions`. */
  readonly enabled: boolean
  /** A private session never asks. */
  readonly isPrivate: boolean
  /** The default engine's suggestion address, `%s` in place of the text; null when it has none. */
  readonly endpoint: string | null
  /** The text is a plain search: not an address, not a keyword search, not a forced `?` search. */
  readonly isPlainSearch: (text: string) => boolean
  /** Where choosing a suggestion goes: the default engine, without a keyword reading. */
  readonly searchUrl: (query: string) => string
  readonly fetch: FetchImpl
  readonly debounceMs?: number
  readonly timeoutMs?: number
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]'

/** The endpoints are fixed in the program, https; a loopback http address exists only for a test build's own seam. */
export function isAllowedEndpoint (template: string): boolean {
  if (!template.includes('%s')) return false
  try {
    const url = new URL(template.split('%s').join('x'))
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))
  } catch { return false }
}

/** Every reason to send nothing, in one place. */
export function mayRequest (text: string, deps: SuggestDeps | undefined): deps is SuggestDeps & { endpoint: string } {
  if (deps === undefined || !deps.enabled || deps.isPrivate || deps.endpoint === null) return false
  const trimmed = text.trim()
  if (trimmed.length < MIN_TEXT || trimmed.length > MAX_TEXT) return false
  return isAllowedEndpoint(deps.endpoint) && deps.isPlainSearch(trimmed)
}

async function readCapped (response: SuggestResponse): Promise<string | null> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null
  const reader = response.body?.getReader()
  if (reader === undefined) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** The engine's suggestions for `text`, or none when anything fails: no network, a slow answer, an error status. */
export async function fetchSuggestions (endpoint: string, text: string, fetchImpl: FetchImpl, signal: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<string[]> {
  const url = endpoint.split('%s').join(encodeURIComponent(text.trim()))
  try {
    const response = await fetchImpl(url, {
      credentials: 'omit',
      redirect: 'error',
      referrer: '',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      headers: { accept: 'application/json' }
    })
    if (!response.ok) return []
    const body = await readCapped(response)
    return body === null ? [] : parseSuggestions(body, text)
  } catch {
    return []
  }
}

/** Resolves false when `signal` aborts first. */
function wait (ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true) }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The rows a suggestion answer becomes: a search row each, the typed part marked so the page can dim it. */
export function suggestionRows (text: string, suggestions: readonly string[], searchUrl: (query: string) => string): SuggestionRow[] {
  const typed = text.trim().toLowerCase()
  return suggestions.map((title) => ({
    kind: 'search' as const,
    title,
    address: '',
    url: searchUrl(title),
    favicon: null,
    match: title.toLowerCase().startsWith(typed) ? [[0, typed.length] as [number, number]] : matchRanges(text, title)
  }))
}

export const engineSuggestions: LateSource = async (text, ctx, signal) => {
  const deps = ctx.suggest
  if (!mayRequest(text, deps)) return []
  if (!await wait(deps.debounceMs ?? DEBOUNCE_MS, signal)) return []
  const found = await fetchSuggestions(deps.endpoint, text, deps.fetch, signal, deps.timeoutMs)
  return signal.aborted ? [] : suggestionRows(text, found, deps.searchUrl)
}
