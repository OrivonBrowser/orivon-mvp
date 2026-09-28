// The canonical fallback rule across every registered protocol: a host's
// namespace picks its resolvers, and every gatherer may load the records,
// each tried in order, the next taking over when one fails.

import { ProtocolAddresses } from './address.js'
import type { Protocol } from './protocol.js'
import { ResolutionError, mostSpecificFailure } from './resolution/records.js'
import type { NameRecord, ResolutionFailure } from './resolution/records.js'
import type { DataGatherer, MountedSite, NameResolver, Namespace } from './resolution/providers.js'

export interface ResolvedName {
  readonly name: string
  readonly resolver: string
  readonly records: readonly NameRecord[]
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

export class ProtocolRegistry {
  readonly addresses: ProtocolAddresses
  private readonly resolvers: readonly NameResolver[]
  private readonly gatherers: readonly DataGatherer[]

  /** Resolvers and gatherers are tried in the order their protocols are given. */
  constructor (protocols: readonly Protocol[]) {
    this.addresses = new ProtocolAddresses(protocols.map((p) => p.descriptor))
    this.resolvers = protocols.flatMap((p) => p.resolvers)
    this.gatherers = protocols.flatMap((p) => p.gatherers)
  }

  private resolversFor (namespace: Namespace): NameResolver[] {
    return this.resolvers.filter((r) => r.namespaces.includes(namespace))
  }

  /** Whether any resolver answers the namespace this host is in. */
  handles (host: string): boolean {
    const served = this.addresses.servedName(host)
    return served !== undefined && this.resolversFor(served.namespace).length > 0
  }

  /** A scheme's one spelling of `name`, from the first resolver of that scheme that defines one. Throws a ResolutionError. */
  canonicalName (scheme: string, name: string): string {
    const candidates = this.resolversFor(`${scheme}:`)
    if (candidates.length === 0) throw new ResolutionError('not-found', `no protocol serves ${scheme}://`)
    const canonical = candidates.find((r) => r.canonicalName !== undefined)?.canonicalName
    return canonical === undefined ? name.toLowerCase() : canonical(name)
  }

  async resolve (host: string, signal?: AbortSignal): Promise<ResolvedName> {
    const served = this.addresses.servedName(host)
    const candidates = served === undefined ? [] : this.resolversFor(served.namespace)
    if (served === undefined || candidates.length === 0) throw new ResolutionError('not-found', `no resolver handles ${host}`)
    const attempts: Attempt[] = []
    for (const resolver of candidates) {
      try {
        const records = await resolver.resolve(served.name, signal)
        if (records.length > 0) return { name: served.name, resolver: resolver.id, records }
        attempts.push({ provider: resolver.id, failure: 'not-found', message: 'no usable record' })
      } catch (error) {
        attempts.push(attemptOf(resolver.id, error))
      }
    }
    throw exhausted(`${served.name} could not be resolved`, attempts)
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
