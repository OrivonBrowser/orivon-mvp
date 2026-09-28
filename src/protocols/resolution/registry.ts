// The canonical fallback rule: resolvers per top-level domain and gatherers,
// each tried in order, the next taking over when one fails.

import { ResolutionError, mostSpecificFailure } from './records.js'
import type { NameRecord, ResolutionFailure } from './records.js'
import type { DataGatherer, MountedSite, NameResolver } from './providers.js'

export interface ResolvedName {
  readonly name: string
  readonly resolver: string
  readonly records: readonly NameRecord[]
}

/** Lowercase, and a fully qualified name's trailing dot dropped. */
function canonicalName (name: string): string {
  const lower = name.toLowerCase()
  return lower.endsWith('.') ? lower.slice(0, -1) : lower
}

/** The last label of a name with at least two, or undefined. */
export function topLevelDomain (name: string): string | undefined {
  const labels = canonicalName(name).split('.')
  if (labels.length < 2) return undefined
  const last = labels[labels.length - 1]
  return last === '' ? undefined : last
}

interface Attempt {
  readonly provider: string
  readonly failure: ResolutionFailure
  readonly message: string
}

function attemptOf (provider: string, error: unknown): Attempt {
  if (error instanceof ResolutionError) return { provider, failure: error.failure, message: error.message }
  // A bug is not an answer: it must never look like one, nor like a proven absence.
  return { provider, failure: 'unavailable', message: error instanceof Error ? error.message : String(error) }
}

function exhausted (what: string, attempts: readonly Attempt[]): ResolutionError {
  const reasons = attempts.map((a) => `${a.provider}: ${a.message}`).join('; ')
  return new ResolutionError(mostSpecificFailure(attempts.map((a) => a.failure)), `${what} (${reasons})`)
}

export class ResolutionRegistry {
  constructor (
    private readonly resolvers: readonly NameResolver[],
    private readonly gatherers: readonly DataGatherer[]
  ) {}

  private resolversFor (name: string): NameResolver[] {
    const tld = topLevelDomain(name)
    if (tld === undefined) return []
    return this.resolvers.filter((r) => r.topLevelDomains.includes(tld))
  }

  /** Whether any resolver claims this name's top-level domain. */
  handles (name: string): boolean {
    return this.resolversFor(name).length > 0
  }

  async resolve (name: string, signal?: AbortSignal): Promise<ResolvedName> {
    const canonical = canonicalName(name)
    const candidates = this.resolversFor(canonical)
    if (candidates.length === 0) throw new ResolutionError('not-found', `no resolver handles ${canonical}`)
    const attempts: Attempt[] = []
    for (const resolver of candidates) {
      try {
        const records = await resolver.resolve(canonical, signal)
        if (records.length > 0) return { name: canonical, resolver: resolver.id, records }
        attempts.push({ provider: resolver.id, failure: 'not-found', message: 'no usable record' })
      } catch (error) {
        attempts.push(attemptOf(resolver.id, error))
      }
    }
    throw exhausted(`${canonical} could not be resolved`, attempts)
  }

  async mount (name: string, records: readonly NameRecord[], signal?: AbortSignal, partition?: string): Promise<MountedSite> {
    const candidates = this.gatherers.filter((g) => g.supports(records))
    if (candidates.length === 0) throw new ResolutionError('unsupported', `no gatherer can load ${name}'s records`)
    const attempts: Attempt[] = []
    for (const gatherer of candidates) {
      try {
        return await gatherer.mount(name, records, signal, partition)
      } catch (error) {
        attempts.push(attemptOf(gatherer.id, error))
      }
    }
    throw exhausted(`${name} could not be loaded`, attempts)
  }
}
