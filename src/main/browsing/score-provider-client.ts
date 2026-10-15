// Asks the Web3 Score provider the person chose for a page's judged level, by hash bucket
// (docs/architecture/web3-score-provider.md). The address is resolved by the address bar's own
// parser, so every protocol Orivon opens is a protocol a provider can live on.
import { createHash } from 'node:crypto'
import { MAX_SCORE_FILE_BYTES, SCORE_STANDARD, findEvaluation, parseDescriptor } from '../../trust/score-provider.js'
import { isSettled, verdictToShow } from '../../trust/score-provider.js'
import type { ProviderDescriptor, ProviderVerdict } from '../../trust/score-provider.js'
import { DIRECT_ROUTE } from '../../protocols/route-pace.js'
import type { RoutePace } from '../../protocols/route-pace.js'
import { StallClock } from '../../protocols/gateways/stall.js'
import { directLookupSession, lookupSessionFor } from '../route/lookup-session.js'
import { mainRoutePace } from '../route/main-pace.js'
import { servedByVerifier } from '../../loader/fetch/verifier-origin.js'
import { ownFetch, ownRequestsTunnelled } from '../route/own-requests.js'
import { fetchThroughRoute } from '../route/routed-fetch.js'
import { readCapped } from './favicon-fetch.js'
import { parseOmniboxInput } from './omnibox.js'

export type FetchedJson =
  | { readonly kind: 'ok', readonly body: unknown }
  | { readonly kind: 'missing' }
  /** `transient`: the fetch did not get an answer (nothing arrived in time, the connection broke, the server was unwell), so asking again may. */
  | { readonly kind: 'failed', readonly reason: string, readonly transient?: true, readonly route?: RoutePace }

export interface ScoreProviderDeps {
  /** The `web3.scoreProvider` setting, read on every lookup so a change applies at once. */
  readonly providerAddress: () => string
  readonly isDevEthName: (host: string) => boolean
  /** `origin` is the app the lookup is made for, when it is one: a routed app's lookup goes through its route. */
  readonly fetchJson: (url: string, origin?: string) => Promise<FetchedJson>
  readonly now?: () => number
  /** How long a fetched file is kept before it is asked for again; ten minutes unless a test build says otherwise. */
  readonly answerKeptMs?: number | undefined
  /** Waits `ms`; a test supplies its own. */
  readonly sleep?: (ms: number) => Promise<void>
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
/** What a failure that came for want of an answer on a slow route is kept for: long enough that the shield's asks, which come every few seconds while it waits, get the answer the lookup ended with. */
const SLOW_FAILURE_KEPT_MS = 10_000
/** How many pages' last settled verdicts are remembered. */
const SETTLED_KEPT = 256
/**
 * The waits below are written for a direct connection and stretched by the route the lookup travels (../../protocols/route-pace.ts).
 * A fetch of a provider's file waits this long for a first byte.
 */
const FETCH_FIRST_BYTE_MS = 30_000
/** The same for a provider the verifier serves: its answer waits on the verifier's proof of the name and then on reading the file, which together take the better part of a minute even directly. */
const VERIFIED_FIRST_BYTE_MS = 90_000
/** A file that failed for want of an answer is asked again after this, and again after twice that, while the route's patience lasts. */
const RETRY_PAUSE_MS = 2_000
/** The most times one file is asked for, and the longest all the asking may take, before the lookup says it could not be reached. */
const MAX_ASKS = 4
const PATIENCE_MS = 90_000
/** How soon a shield whose provider could not be reached asks again. */
const UNREACHABLE_RETRY_MS = 30_000
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
  const sleep = deps.sleep ?? (async (ms: number): Promise<void> => { await new Promise<void>((resolve) => { setTimeout(resolve, ms) }) })
  const kept = new Map<string, { readonly at: number, readonly answer: Promise<FetchedJson>, settledAt?: number }>()
  // The last verdict the provider settled per page, which an ask it cannot answer does not withdraw (verdictToShow).
  // Unlike `kept` it does not expire: it is replaced by the next answer the provider does give.
  const settled = new Map<string, ProviderVerdict>()
  // A lookup begun before `forget` must not write its verdict back afterwards.
  let generation = 0

  function remember (key: string, verdict: ProviderVerdict, askedIn: number): ProviderVerdict {
    if (!isSettled(verdict) || askedIn !== generation) return verdict
    settled.delete(key)
    settled.set(key, verdict)
    if (settled.size > SETTLED_KEPT) settled.delete(settled.keys().next().value as string)
    return verdict
  }

  /**
   * `deps.fetchJson`, asked again while it fails for want of an answer and the route it travelled has patience left: a
   * slow route (a tunnel still coming up, a name still being proved) answers late, not never. The route is the one the
   * failed answer names, since only the fetch knows which way it left.
   */
  async function patientFetch (url: string, origin: string | undefined): Promise<FetchedJson> {
    const began = now()
    for (let asked = 1; ; asked++) {
      const answer = await deps.fetchJson(url, origin)
      if (answer.kind !== 'failed' || answer.transient !== true || asked >= MAX_ASKS) return answer
      const route = answer.route ?? DIRECT_ROUTE
      const pause = route.wait(RETRY_PAUSE_MS) * asked
      if (now() - began + pause > route.firstWait(PATIENCE_MS)) return answer
      await sleep(pause)
    }
  }

  // One fetch per URL while it is in flight or kept: the shield asks several times a second while a page loads.
  async function cachedFetch (url: string, origin: string | undefined): Promise<FetchedJson> {
    const time = now()
    for (const [key, entry] of kept) if (time - (entry.settledAt ?? entry.at) >= answerKeptMs) kept.delete(key)
    // A routed app's answer is its own: what its route could reach says nothing about a direct fetch, nor the reverse.
    const key = `${origin ?? ''} ${url}`
    let entry = kept.get(key)
    if (entry === undefined) {
      // An answer is kept from when it arrived, not from when it was asked: a fetch that waited a minute for a tunnel is not stale on arrival.
      const made: { at: number, answer: Promise<FetchedJson>, settledAt?: number } = { at: time, answer: patientFetch(url, origin).then((answered) => { made.settledAt = now(); return answered }) }
      entry = made
      kept.set(key, entry)
    }
    const answer = await entry.answer
    // A failure on a slow route says little about the next ask, since the route may have come up: it is kept only long enough
    // for the asks that are waiting on this one to be answered with it, never for a minute.
    const keptFor = answer.kind === 'failed' && answer.transient === true && answer.route?.slow() === true ? SLOW_FAILURE_KEPT_MS : FAILURE_KEPT_MS
    if (answer.kind === 'failed' && now() - (entry.settledAt ?? entry.at) >= keptFor && kept.get(key) === entry) {
      kept.delete(key)
      return await cachedFetch(url, origin)
    }
    return answer
  }

  /** Could not be reached; `retryMs` says when asking again is worth it, only if the fetch did not get an answer, and later on a slower route. */
  function unreachable (address: string, failed: Extract<FetchedJson, { kind: 'failed' }>): ProviderVerdict {
    return { status: 'unreachable', address, reason: failed.reason, ...(failed.transient === true && { retryMs: (failed.route ?? DIRECT_ROUTE).wait(UNREACHABLE_RETRY_MS) }) }
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
    if (fetched.kind === 'failed') return { kind: 'unreachable', verdict: unreachable(address, fetched) }
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
    if (file.kind === 'failed') return unreachable(address, file)
    const found = findEvaluation(file.body, 'website', bucket, id)
    if (found.kind === 'malformed') return { status: 'unreachable', address, reason: `${bucketUrl}: ${found.reason}.` }
    return found.kind === 'none' ? { status: 'no-score', provider } : { status: 'judged', provider, evaluation: found.evaluation }
  }

  return {
    forget: () => { generation += 1; settled.clear() },
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
      const askedIn = generation
      const answer = lookup(address, id, origin).then((verdict) => remember(key, verdict, askedIn))
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
  // A lookup through the tunnel is given the tunnel's time, and may wait for it to come up; one that leaves the ordinary way is not.
  // A provider the verifier serves (a .eth name, an ipfs:// address) is read by the verifier host, which leaves by the tunnel too while the whole browser is on it.
  const pace = mainRoutePace(routed !== undefined || (ownRequestsTunnelled() && (origin === undefined || servedByVerifier(url))))
  const firstByte = servedByVerifier(url) ? VERIFIED_FIRST_BYTE_MS : FETCH_FIRST_BYTE_MS
  const clock = new StallClock({ firstByteMs: pace.firstWait(firstByte), stallMs: pace.stallMs(), capMs: pace.firstWait(firstByte) + pace.transferMs(MAX_SCORE_FILE_BYTES) })
  const began = Date.now()
  try {
    const init = { credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: clock.signal } as const
    // With no route and the whole browser on the tunnel, the default session is the tunnel's: a site set to off is asked about on the system's proxy.
    // A lookup about no origin (an install, an update check) follows the default, as Orivon's own requests do: through the tunnel while it is on.
    const direct = routed === undefined && origin !== undefined ? directLookupSession() : undefined
    const ordinary = async (target: string, options?: RequestInit): Promise<Response> => direct !== undefined ? await direct.fetch(target, options) : await net.fetch(target, options)
    const response = routed !== undefined ? await fetchThroughRoute(net, routed, url, init.signal) : origin === undefined ? await ownFetch(ordinary)(url, init) : await ordinary(url, init)
    clock.progress()
    if (response.status === 404) return { kind: 'missing' }
    if (!response.ok) {
      // A server that is unwell, or the verifier's own answer that a name could not be read yet, may answer when asked again.
      const unwell = response.status >= 500 || response.status === 429 || response.status === 408
      return { kind: 'failed', reason: `${url} answered ${String(response.status)}.`, route: pace, ...(unwell && { transient: true as const }) }
    }
    pace.observeFirstByte(Date.now() - began)
    const bytes = await readCapped(response.body, MAX_SCORE_FILE_BYTES, () => { clock.progress() })
    if (bytes === null) return { kind: 'failed', reason: `${url} is larger than 1 MiB.` }
    return { kind: 'ok', body: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'failed', reason: `${url} is not JSON.` }
    const why = clock.reason === 'first-byte' ? `did not answer within ${String(Math.round(pace.firstWait(firstByte) / 1000))} seconds` : clock.reason !== undefined ? 'stopped answering' : 'could not be reached'
    return { kind: 'failed', reason: `${url} ${why}.`, transient: true, route: pace }
  } finally {
    clock.finish()
  }
}
