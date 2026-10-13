import { defineProtocol } from '../protocol.js'
import type { Protocol } from '../protocol.js'
import { createIpfsAddressResolvers } from './address-resolver.js'
import { IPFS } from './descriptor.js'
import { createIpfsGatherer } from './gatherer.js'
import type { IpfsGathererOptions } from './gatherer.js'
import type { DataGatherer } from '../resolution/providers.js'

/** IPFS as a protocol: `ipfs://` and `ipns://` addresses, and the gatherer that loads any record naming IPFS content, `.eth` names' included. */
export function ipfsProtocol (options: IpfsGathererOptions): Protocol {
  return ipfsProtocolOf(createIpfsGatherer(options))
}

/** The same protocol over a gatherer chosen by the caller, such as one that reads from a node first (node-first.ts). */
export function ipfsProtocolOf (gatherer: DataGatherer): Protocol {
  return defineProtocol(IPFS, { resolvers: createIpfsAddressResolvers(), gatherers: [gatherer] })
}
