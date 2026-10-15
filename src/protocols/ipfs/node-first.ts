// A gatherer that reads from a node on this computer, and from public gateways
// only when the person has said so for this load of the site. A node that cannot
// serve makes the load fail with an offer (`GatewaysOffered`) that says why;
// nothing is sent to a gateway before the person accepts it, and a yes is used
// up by the load that takes it. The person's
// standing choice of gateways as IPFS source builds no node-first gatherer.

import type { DataGatherer, MountedSite } from '../resolution/providers.js'
import { GatewaysOffered, ResolutionError } from '../resolution/records.js'
import type { NameRecord } from '../resolution/records.js'

export interface NodeFirst {
  readonly node: DataGatherer
  readonly gateways: DataGatherer
  /** Resolves once the node can serve; rejects with the reason in words when it cannot. */
  readonly ready: (signal: AbortSignal) => Promise<void>
  /** Takes the person's yes for this load of the site this mount is for (`partition`: its origin), using it up; false when there is none. Undefined partition: a request no page started, which never has one. */
  readonly takeConsent: (partition: string | undefined) => boolean
}

function reasonOf (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createNodeFirstGatherer (sources: NodeFirst): DataGatherer {
  const viaGateways = async (name: string, records: readonly NameRecord[], signal: AbortSignal, partition: string | undefined, reason: string): Promise<MountedSite> => {
    const site = await sources.gateways.mount(name, records, signal, partition)
    return { ...site, servedFrom: { kind: 'gateways', reason } }
  }
  return {
    id: 'ipfs',
    supports: (records) => sources.node.supports(records),
    async mount (name: string, records: readonly NameRecord[], signal = new AbortController().signal, partition?: string): Promise<MountedSite> {
      try {
        await sources.ready(signal)
      } catch (error) {
        signal.throwIfAborted()
        const reason = reasonOf(error)
        if (!sources.takeConsent(partition)) throw new GatewaysOffered(`Orivon's IPFS node cannot load this site: ${reason}`)
        return await viaGateways(name, records, signal, partition, reason)
      }
      try {
        return await sources.node.mount(name, records, signal, partition)
      } catch (error) {
        signal.throwIfAborted()
        // Only "could not get it" is cured by another source: a lie, or a name with nothing behind it, is the same everywhere.
        if (!(error instanceof ResolutionError) || error.failure !== 'unavailable') throw error
        const reason = reasonOf(error)
        if (!sources.takeConsent(partition)) throw new GatewaysOffered(`Orivon's IPFS node could not load this site: ${reason}`)
        return await viaGateways(name, records, signal, partition, reason)
      }
    }
  }
}
