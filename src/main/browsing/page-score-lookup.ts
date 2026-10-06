// What `orivon.trust.websiteScore` answers: the Web3 Score provider the person chose, asked about the content an
// address names, for a page that holds the `trust.score` grant (docs/architecture/web3-score-provider.md, ADR-0058).
// The grant is the broker's check; this is what runs once it holds. Nothing here is shared with the shell's own
// lookups or with another caller, see README.md's Design notes.
import { fail } from '../../broker/errors.js'
import { createTokenBucketLimiter } from '../../broker/transport/token-bucket.js'
import { canonicalCid } from '../../protocols/ipfs/names.js'
import { scoreIdOf } from '../../trust/score-provider.js'
import type { WebsiteScore } from '../../contracts/index.js'
import { createScoreProviderClient } from './score-provider-client.js'
import type { ScoreProviderClient, ScoreProviderDeps } from './score-provider-client.js'

/** Explore asks about some sixty sites on one load. */
export const PAGE_LOOKUP_CAPACITY = 128
const PAGE_LOOKUP_REFILL_PER_SECOND = 2
const MAX_CALLERS = 16
const MAX_ADDRESS_CHARS = 2048
const IPFS_ADDRESS = /^ipfs:\/\/([^/?#\s]+)/i
const BARE_ETH_ADDRESS = /^[^:/?#\s]+\.eth(?:[/?#]|$)/i

export interface PageScoreDeps extends ScoreProviderDeps {
  /** The content CID a `.eth` host names, resolved by the verifier in `partition`; undefined or a throw when it does not resolve. */
  readonly resolveEthContent: (host: string, partition: string) => Promise<string | undefined>
}

export interface PageScoreLookup {
  /** Rejects only `limit`: every other failure answers `level: null`. */
  readonly websiteScore: (callerOrigin: string, address: string) => Promise<WebsiteScore>
}

type Named = { readonly kind: 'cid', readonly cid: string } | { readonly kind: 'eth', readonly host: string }

function ethHostOf (address: string): string | undefined {
  const candidate = /^https:\/\//i.test(address) ? address : BARE_ETH_ADDRESS.test(address) ? `https://${address}` : undefined
  if (candidate === undefined) return undefined
  let host: string
  try {
    host = new URL(candidate).hostname
  } catch {
    return undefined
  }
  // The verifier host refuses a name that is not in ENS normal form, before it asks anyone.
  return host.endsWith('.eth') && host.length > '.eth'.length ? host : undefined
}

function contentNamedBy (address: string): Named | undefined {
  const text = address.trim()
  if (text.length > MAX_ADDRESS_CHARS) return undefined
  const ipfs = IPFS_ADDRESS.exec(text)
  if (ipfs !== null) {
    const cid = canonicalCid(ipfs[1]!)
    return cid === undefined ? undefined : { kind: 'cid', cid }
  }
  const host = ethHostOf(text)
  return host === undefined ? undefined : { kind: 'eth', host }
}

export function createPageScoreLookup (deps: PageScoreDeps): PageScoreLookup {
  const now = deps.now ?? Date.now
  const limiter = createTokenBucketLimiter({ capacity: PAGE_LOOKUP_CAPACITY, refillPerSecond: PAGE_LOOKUP_REFILL_PER_SECOND, now })
  // Least recently used first: a Map keeps insertion order, and a use re-inserts.
  const clients = new Map<string, ScoreProviderClient>()

  function clientFor (caller: string): ScoreProviderClient {
    let client = clients.get(caller)
    if (client === undefined) {
      client = createScoreProviderClient({ providerAddress: deps.providerAddress, isDevEthName: deps.isDevEthName, fetchJson: deps.fetchJson, now })
      if (clients.size >= MAX_CALLERS) clients.delete(clients.keys().next().value!)
    } else {
      clients.delete(caller)
    }
    clients.set(caller, client)
    return client
  }

  async function identifierOf (named: Named, caller: string): Promise<string | undefined> {
    const cid = named.kind === 'cid' ? named.cid : canonicalCid(await deps.resolveEthContent(named.host, caller) ?? '')
    return cid === undefined ? undefined : scoreIdOf({ kind: 'cid', value: cid })
  }

  async function answer (caller: string, address: string): Promise<WebsiteScore> {
    const configured = deps.providerAddress().trim()
    if (configured === '') return { provider: null, level: null }
    const client = clientFor(caller)
    const named = contentNamedBy(address)
    let id: string | undefined
    try {
      id = named === undefined ? undefined : await identifierOf(named, caller)
    } catch {
      id = undefined
    }
    if (id === undefined) return { provider: await client.providerName() ?? configured, level: null }
    const verdict = await client.verdictFor(id)
    switch (verdict.status) {
      case 'judged': {
        const level = verdict.evaluation.trustlessity.level
        return { provider: verdict.provider.name, level: level === 1 || level === 2 || level === 3 || level === 4 ? level : null }
      }
      case 'no-score':
        return { provider: verdict.provider.name, level: null }
      case 'off':
        return { provider: null, level: null }
      default:
        return { provider: verdict.address, level: null }
    }
  }

  return {
    async websiteScore (callerOrigin, address) {
      if (!limiter.tryConsume(callerOrigin)) throw fail('limit', 'this origin is asking for scores too frequently; wait and retry')
      try {
        return await answer(callerOrigin, address)
      } catch {
        return { provider: deps.providerAddress().trim() || null, level: null }
      }
    }
  }
}
