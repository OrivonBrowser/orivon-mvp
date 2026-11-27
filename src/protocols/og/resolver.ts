import { ResolutionError } from '../resolution/records.js'
import type { NameResolver } from '../resolution/providers.js'
import type { Eip1193Provider } from '../ens/resolver.js'
import { ChainError, eip1193Chain } from './chain.js'
import type { Chain } from './chain.js'
import { readCensus } from './census.js'
import type { Census } from './census.js'
import bundled from './census.json'
import { resolveOg } from './lookup.js'
import { ogLabelFromHost } from './name.js'
import { createSession, OgRefusal, OLD_WINDOW } from './tail.js'

export interface OgResolverOptions {
  /** The light client's provider: the state it answers is proven, and so is a log it returns from the newest 8,000 blocks. */
  readonly provider: Eip1193Provider
  /**
   * A provider to the same execution servers that proves nothing, asked only for `eth_getLogs` and `eth_getTransactionByHash` of the
   * history older than the light client proves (about 27 hours): the servers' word, which may hide or invent a log. Without it every
   * read is the light client's and a name changed before that cannot be checked.
   */
  readonly servers?: Eip1193Provider | undefined
  /** What the history of the names up to its checkpoint was: the census bundled beside this file by default. */
  readonly census?: Census
  /**
   * How long one resolution may take before it refuses and keeps what it read, in milliseconds. A site's mount waits 45 s for the
   * name and its content together, so the default leaves most of it for the content.
   */
  readonly budgetMs?: number
  /** The clock, for a test. */
  readonly now?: () => number
}

/** What a resolution may spend on the recent history of a name: a reload continues from the windows already read. */
export const DEFAULT_BUDGET_MS = 30_000

/** The failure of a resolution that could not give a safe answer, in the words the loading screen and the report carry. */
function failureOf (error: unknown, host: string, signal: AbortSignal | undefined): ResolutionError {
  if (error instanceof ResolutionError) return error
  if (error instanceof OgRefusal) return new ResolutionError('unavailable', error.message)
  if (signal?.aborted === true) return new ResolutionError('unavailable', `${host} could not be checked in time. What was checked is kept: reload to continue.`)
  if (error instanceof ChainError) return new ResolutionError('unavailable', error.message)
  return new ResolutionError('unavailable', error instanceof Error ? error.message : String(error))
}

/**
 * The resolver for `.og`: a name's records from the Linagee contracts, read through the provider the verifier host backs with the
 * light client, so every value a record counts with is proven, and so is a log returned from the newest 8,000 blocks. Older history is
 * asked of `servers`, unproven, and the bundled census is the bundle's word (README.md section What it answers says what each can do).
 * A record counts only by the freshness rule of README.md; one that cannot be vouched for in the time the call has makes the call
 * fail, never answers in part.
 */
export function createOgResolver (options: OgResolverOptions): NameResolver {
  const proven = eip1193Chain(options.provider)
  const chain: Chain = options.servers === undefined ? proven : { ...proven, servers: eip1193Chain(options.servers, { maxSpan: OLD_WINDOW }) }
  const session = createSession(options.now === undefined ? {} : { now: options.now })
  const now = options.now ?? Date.now
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  let census: Census | undefined = options.census
  return {
    id: 'og',
    namespaces: ['.og'],
    async resolve (host, signal) {
      const label = ogLabelFromHost(host)
      try {
        signal?.throwIfAborted()
        census ??= readCensus(bundled)
        return await resolveOg(chain, label, { session, census, signal, deadlineAt: now() + budgetMs })
      } catch (error) {
        throw failureOf(error, host, signal)
      }
    }
  }
}
