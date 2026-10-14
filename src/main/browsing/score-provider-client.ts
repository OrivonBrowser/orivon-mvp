// Asks the Web3 Score provider the person chose for a page's judged level, by hash bucket
// (docs/architecture/web3-score-provider.md). The address is resolved by the address bar's own
// parser, so every protocol Orivon opens is a protocol a provider can live on.
import { createHash } from 'node:crypto'
import { MAX_SCORE_FILE_BYTES, SCORE_STANDARD, findEvaluation, parseDescriptor } from '../../trust/score-provider.js'
import { isSettled, verdictToShow } from '../../trust/score-provider.js'
import type { ProviderDescriptor, ProviderVerdict } from '../../trust/score-provider.js'
import { directLookupSession, lookupSessionFor } from '../route/lookup-session.js'
import { ownFetch } from '../route/own-requests.js'
import { fetchThroughRoute } from '../route/routed-fetch.js'
import { readCapped } from './favicon-fetch.js'
import { parseOmniboxInput } from './omnibox.js'

export type FetchedJson =
  | { readonly kind: 'ok', readonly body: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed', readonly reason: string }

export interface ScoreProviderDeps {
  /** The `web3.scoreProvider` setting, read on every lookup so a change applies at once. */
  readonly providerAddress: () => string
  readonly isDevEthName: (host: string) => boolean
  /** `origin` is the app the lookup is made for, when it is one: a routed app's lookup goes through its route. */
  readonly fetchJson: (url: string, origin?: string) => Promise<FetchedJson>
  readonly now?: () => number
  /** How long a fetched file is kept before it is asked for again; ten minutes unless a test build says otherwise. */
  readonly answerKeptMs?: number | undefined
}

export interface ScoreProviderClient {
  /** The verdict on a website identifier (`sha256:…` or `cid:…`), `undefined` for a page with none.
   * Past `waitMs` it answers `pending` and the lookup carries on, kept for the next ask. `origin` is the app asked
   * about, so a routed app's lookup leaves through its route. Never throws. */
  readonly verdictFor: (id: string | undefined, waitMs?: number, origin?: string) => Promise<ProviderVerdict>
  /** The chosen provider's own name; its address when its description cannot be read; undefined with none chosen. Never throws. */
  readonly providerName: (origin?: string) => Promise<string | undefined>
  /** Forgets the verdicts kept for pages, so none is shown when the provider cannot be asked. */
  readonly forget: () => void
}

const ANSWER_KEPT_MS = 10 * 60_000
const FAILURE_KEPT_MS = 60_000
/** How many pages' last settled verdicts are remembered. */
const SETTLED_KEPT = 256
/** Past the verifier's own 25 s for proving a name: an IPFS-served provider's first answer waits on that proof. */
const FETCH_TIMEOUT_MS = 30_000
/** The folder a web3-score-manager build puts the provider's files in, under the site that publishes them. */
const PUBLISHED_FOLDER = 'score'

/** The provider's base address with any trailing `/`, query and fragment removed, or undefined
 * when the text names nothing the address bar would open over http(s). */
export function providerBase (address: string, isDevEthName: (host: string) => boolean): string | undefined {
  const parsed = parseOmniboxInput(address, isDevEthName)
  if (parsed.kind !== 'url') return undefined
  const url = new URL(parsed.url)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function bucketOf (id: string, hexChars: number): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, hexChars)
}

export function createScoreProviderClient (deps: ScoreProviderDeps): ScoreProviderClient {
  const now = deps.now ?? Date.now
  const answerKeptMs = deps.answerKeptMs ?? ANSWER_KEPT_MS
  const kept = new Map<string, { readonly at: number, readonly answer: Promise<FetchedJson> }>()
  // The last verdict the provider settled per page, which an ask it cannot answer does not withdraw (verdictToShow).
  // Unlike `kept` it does not expire: it is replaced by the next answer the provider does give.
  const settled = new Map<string, ProviderVerdict>()

  function remember (key: string, verdict: ProviderVerdict): ProviderVerdict {
    if (!isSettled(verdict)) return verdict
    settled.delete(key)
    settled.set(key, verdict)
    if (settled.size > SETTLED_KEPT) settled.delete(settled.keys().next().value as string)
    return verdict
  }

  // One fetch per URL while it is in flight or kept: the shield asks several times a second while a page loads.
  async function cachedFetch (url: string, origin: string | undefined): Promise<FetchedJson> {
    const time = now()
    for (const [key, entry] of kept) if (time - entry.at >= answerKeptMs) kept.delete(key)
    // A routed app's answer is its own: what its route could reach says nothing about a direct fetch, nor the reverse.
    const key = `${origin ?? ''} ${url}`
    let entry = kept.get(key)
    if (entry === undefined) {
      entry = { at: time, answer: deps.fetchJson(url, origin) }
      kept.set(key, entry)
    }
    const answer = await entry.answer
    if (answer.kind === 'failed' && now() - entry.at >= FAILURE_KEPT_MS && kept.get(key) === entry) {
      kept.delete(key)
      return await cachedFetch(url, origin)
    }
    return answer
  }

  type Described =
    | { readonly kind: 'unreachable', readonly verdict: ProviderVerdict }
    | { readonly kind: 'described', readonly base: string, readonly descriptor: ProviderDescriptor }

  async function describe (address: string, origin?: string): Promise<Described> {
    const typed = providerBase(address, deps.isDevEthName)
    if (typed === undefined) return { kind: 'unreachable', verdict: { status: 'unreachable', address, reason: 'It is not an address Orivon can open.' } }
    const descriptorUrl = `${typed}/provider.json`
    let base = typed
    let fetched = await cachedFetch(descriptorUrl, origin)
    // A person types the name a provider is known by; web3-score-manager publishes its files in `score/` under it.
    if (fetched.kind === 'missing' && !typed.endsWith(`/${PUBLISHED_FOLDER}`)) {
      const inFolder = await cachedFetch(`${typed}/${PUBLISHED_FOLDER}/provider.json`, origin)
      if (inFolder.kind !== 'missing') {
        base = `${typed}/${PUBLISHED_FOLDER}`
        fetched = inFolder
      }
    }
    if (fetched.kind === 'missing') return { kind: 'unreachable', verdict: { status: 'unreachable', address, reason: `${descriptorUrl} does not exist.` } }
    if (fetched.kind === 'failed') return { kind: 'unreachable', verdict: { status: 'unreachable', address, reason: fetched.reason } }
    const descriptor = parseDescriptor(fetched.body)
    if (descriptor === undefined) return { kind: 'unreachable', verdict: { status: 'unreachable', address, reason: `${descriptorUrl} is not an ${SCORE_STANDARD} provider description.` } }
    return { kind: 'described', base, descriptor }
  }

  async function lookup (address: string, id: string, origin: string | undefined): Promise<ProviderVerdict> {
    const described = await describe(address, origin)
    if (described.kind === 'unreachable') return described.verdict
    const { base, descriptor } = described
    const provider = { name: descriptor.name, address }
    const bucket = bucketOf(id, descriptor.bucketHexChars)
    const bucketUrl = `${base}/website/${bucket}.json`
    const file = await cachedFetch(bucketUrl, origin)
    if (file.kind === 'missing') return { status: 'no-score', provider }
    if (file.kind === 'failed') return { status: 'unreachable', address, reason: file.reason }
    const found = findEvaluation(file.body, 'website', bucket, id)
    if (found.kind === 'malformed') return { status: 'unreachable', address, reason: `${bucketUrl}: ${found.reason}.` }
    return found.kind === 'none' ? { status: 'no-score', provider } : { status: 'judged', provider, evaluation: found.evaluation }
  }

  return {
    forget: () => { settled.clear() },
    async providerName (origin) {
      const address = deps.providerAddress().trim()
      if (address === '') return undefined
      try {
        const described = await describe(address, origin)
        return described.kind === 'described' ? described.descriptor.name : address
      } catch {
        return address
      }
    },
    async verdictFor (id, waitMs, origin) {
      const address = deps.providerAddress().trim()
      if (address === '') return { status: 'off' }
      if (id === undefined) return { status: 'not-assessable', address }
      const key = `${origin ?? ''} ${address} ${id}`
      const answer = lookup(address, id, origin).then((verdict) => remember(key, verdict))
      if (waitMs === undefined) return verdictToShow(await answer, settled.get(key))
      let timer: ReturnType<typeof setTimeout> | undefined
      const pending = new Promise<ProviderVerdict>((resolve) => { timer = setTimeout(() => { resolve({ status: 'pending', address }) }, waitMs) })
      try {
        return verdictToShow(await Promise.race([answer, pending]), settled.get(key))
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

// net.fetch, not Node's fetch: only Chromium's stack honours the resolver rules that send `.eth`
// and `*.orivon` to the verifier. Imported dynamically, as favicon-fetch.ts's header explains. Redirects
// are followed because an `ipfs://` address is first served at a path that redirects to its own origin.
export async function netFetchJson (url: string, origin?: string): Promise<FetchedJson> {
  const { net } = await import('electron')
  // A routed app's lookup leaves through its route's session; when that cannot be had, it does not leave at all.
  let routed: Awaited<ReturnType<typeof lookupSessionFor>>
  try {
    routed = origin === undefined ? undefined : await lookupSessionFor(origin)
  } catch {
    return { kind: 'failed', reason: `${url} could not be reached through this app's route.` }
  }
  try {
    const init = { credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } as const
    // With no route and the whole browser on the tunnel, the default session is the tunnel's: a site set to off is asked about on the system's proxy.
    // A lookup about no origin (an install, an update check) follows the default, as Orivon's own requests do: through the tunnel while it is on.
    const direct = routed === undefined && origin !== undefined ? directLookupSession() : undefined
    const ordinary = async (target: string, options?: RequestInit): Promise<Response> => direct !== undefined ? await direct.fetch(target, options) : await net.fetch(target, options)
    const response = routed !== undefined ? await fetchThroughRoute(net, routed, url, init.signal) : origin === undefined ? await ownFetch(ordinary)(url, init) : await ordinary(url, init)
    if (response.status === 404) return { kind: 'missing' }
    if (!response.ok) return { kind: 'failed', reason: `${url} answered ${String(response.status)}.` }
    const bytes = await readCapped(response.body, MAX_SCORE_FILE_BYTES)
    if (bytes === null) return { kind: 'failed', reason: `${url} is larger than 1 MiB.` }
    return { kind: 'ok', body: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'is not JSON' : error instanceof Error && error.name === 'TimeoutError' ? `did not answer within ${String(FETCH_TIMEOUT_MS / 1000)} seconds` : 'could not be reached'
    return { kind: 'failed', reason: `${url} ${reason}.` }
  }
}
