import { defineProtocol } from '../protocol.js'
import type { Protocol } from '../protocol.js'
import { createSwarmAddressResolvers } from './address-resolver.js'
import { SWARM } from './descriptor.js'
import { createSwarmGatherer } from './gatherer.js'
import type { SwarmGathererOptions } from './gatherer.js'

/** Swarm as a protocol: `bzz://` addresses, and the gatherer that loads any record naming Swarm content, `.eth` names' included. */
export function swarmProtocol (options: SwarmGathererOptions): Protocol {
  return defineProtocol(SWARM, { resolvers: createSwarmAddressResolvers(), gatherers: [createSwarmGatherer(options)] })
}
