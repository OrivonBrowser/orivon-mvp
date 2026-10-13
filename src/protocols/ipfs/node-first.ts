// A gatherer that reads from a node on this computer when the node can serve,
// and otherwise from public gateways, saying so. IPFS never waits on a node
// that will not come: the person who chose the node is told why it was not
// used (Settings and the site-info popover), and nothing else changes.

import type { DataGatherer, MountedSite } from '../resolution/providers.js'
import type { NameRecord } from '../resolution/records.js'

export interface NodeFirst {
  readonly node: DataGatherer
  readonly gateways: DataGatherer
  /** Resolves once the node can serve; rejects with the reason in words when it cannot. */
  readonly ready: (signal: AbortSignal) => Promise<void>
}

function reasonOf (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createNodeFirstGatherer (sources: NodeFirst): DataGatherer {
  return {
    id: 'ipfs',
    supports: (records) => sources.node.supports(records),
    async mount (name: string, records: readonly NameRecord[], signal = new AbortController().signal, partition?: string): Promise<MountedSite> {
      try {
        await sources.ready(signal)
      } catch (error) {
        signal.throwIfAborted()
        const site = await sources.gateways.mount(name, records, signal, partition)
        return { ...site, servedFrom: { kind: 'gateways', reason: reasonOf(error) } }
      }
      return await sources.node.mount(name, records, signal, partition)
    }
  }
}
