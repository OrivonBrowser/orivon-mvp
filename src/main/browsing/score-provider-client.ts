// Asks the Web3 Score provider the person chose for a page's judged level, by hash bucket
// (docs/architecture/web3-score-provider.md). The address is resolved by the address bar's own
// parser, so every protocol Orivon opens is a protocol a provider can live on.
import { createHash } from 'node:crypto'
import { MAX_SCORE_FILE_BYTES, SCORE_STANDARD, findEvaluation, parseDescriptor } from '../../trust/score-provider.js'
import type { ProviderDescriptor, ProviderVerdict } from '../../trust/score-provider.js'
import { readCapped } from './favicon.js'
import { parseOmniboxInput } from './omnibox.js'

export type FetchedJson =
  | { readonly kind: 'ok', readonly body: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed', readonly reason: string }

export interface ScoreProviderDeps {
  /** The `web3.scoreProvider` setting, read on every lookup so a change applies at once. */
  readonly providerAddress: () => string
  readonly isDevEthName: (host: string) => boolean
  readonly fetchJson: (url: string) => Promise<FetchedJson>
  readonly now?: () => number
}

export interface ScoreProviderClient {
  /** The verdict on a website identifier (`sha256:…` or `cid:…`), `undefined` for a page with none.
   * Past `waitMs` it answers `pending` and the lookup carries on, kept for the next ask. Never throws. */
  readonly verdictFor: (id: string | undefined, waitMs?: number) => Promise<ProviderVerdict>
  /** The chosen provider's own name; its address when its description cannot be read; undefined with none chosen. Never throws. */
  readonly providerName: () => Promise<string | undefined>
}

const ANSWER_KEPT_MS = 10 * 60_000
const FAILURE_KEPT_MS = 60_000
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
  const kept = new Map<string, { readonly at: number, readonly answer: Promise<FetchedJson> }>()

  // One fetch per URL while it is in flight or kept: the shield asks several times a second while a page loads.
  async function cachedFetch (url: string): Promise<FetchedJson> {
    const time = now()
    for (const [key, entry] of kept) if (time - entry.at >= ANSWER_KEPT_MS) kept.delete(key)
    let entry = kept.get(url)
    if (entry === undefined) {
      entry = { at: time, answer: deps.fetchJson(url) }
      kept.set(url, entry)
    }
    const answer = await entry.answer
    if (answer.kind === 'failed' && now() - entry.at >= FAILURE_KEPT_MS && kept.get(url) === entry) {
      kept.delete(url)
      return await cachedFetch(url)
    }
    return answer
  }

  type Described =
    | { readonly kind: 'unreachable', readonly verdict: ProviderVerdict }
    | { readonly kind: 'described', readonly base: string, readonly descriptor: ProviderDescriptor }

  async function describe (address: string): Promise<Described> {
    const typed = providerBase(address, deps.isDevEthName)
    if (typed === undefined) return { kind: 'unreachable', verdict: { status: 'unreachable', address, reason: 'It is not an address Orivon can open.' } }
    const descriptorUrl = `${typed}/provider.json`
    let base = typed
    let fetched = await cachedFetch(descriptorUrl)
    // A person types the name a provider is known by; web3-score-manager publishes its files in `score/` under it.
    if (fetched.kind === 'missing' && !typed.endsWith(`/${PUBLISHED_FOLDER}`)) {
      const inFolder = await cachedFetch(`${typed}/${PUBLISHED_FOLDER}/provider.json`)
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

  async function lookup (address: string, id: string): Promise<ProviderVerdict> {
    const described = await describe(address)
    if (described.kind === 'unreachable') return described.verdict
    const { base, descriptor } = described
    const provider = { name: descriptor.name, address }
    const bucket = bucketOf(id, descriptor.bucketHexChars)
    const bucketUrl = `${base}/website/${bucket}.json`
    const file = await cachedFetch(bucketUrl)
    if (file.kind === 'missing') return { status: 'no-score', provider }
    if (file.kind === 'failed') return { status: 'unreachable', address, reason: file.reason }
    const found = findEvaluation(file.body, 'website', bucket, id)
    if (found.kind === 'malformed') return { status: 'unreachable', address, reason: `${bucketUrl}: ${found.reason}.` }
    return found.kind === 'none' ? { status: 'no-score', provider } : { status: 'judged', provider, evaluation: found.evaluation }
  }

  return {
    async providerName () {
      const address = deps.providerAddress().trim()
      if (address === '') return undefined
      try {
        const described = await describe(address)
        return described.kind === 'described' ? described.descriptor.name : address
      } catch {
        return address
      }
    },
    async verdictFor (id, waitMs) {
      const address = deps.providerAddress().trim()
      if (address === '') return { status: 'off' }
      if (id === undefined) return { status: 'not-assessable', address }
      const answer = lookup(address, id)
      if (waitMs === undefined) return await answer
      let timer: ReturnType<typeof setTimeout> | undefined
      const pending = new Promise<ProviderVerdict>((resolve) => { timer = setTimeout(() => { resolve({ status: 'pending', address }) }, waitMs) })
      try {
        return await Promise.race([answer, pending])
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

// net.fetch, not Node's fetch: only Chromium's stack honours the resolver rules that send `.eth`
// and `*.orivon` to the verifier. Imported dynamically, as favicon.ts's header explains. Redirects
// are followed because an `ipfs://` address is first served at a path that redirects to its own origin.
export async function netFetchJson (url: string): Promise<FetchedJson> {
  const { net } = await import('electron')
  try {
    const response = await net.fetch(url, { credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
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
