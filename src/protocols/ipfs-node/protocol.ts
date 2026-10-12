// What the shell says about Orivon's IPFS node, on top of what every local
// node says (../local-node/protocol.ts), and the one choice the person makes
// about it.

import type { NodeIdentity } from '../local-node/kind.js'
import type { LocalNodeState } from '../local-node/protocol.js'

export const IPFS_NODE_IDENTITY: NodeIdentity = { name: 'ipfs-node', noun: 'IPFS node' }

/** What main tells the verifier host about the node (the wiring phase carries it over the host's own port). */
export type IpfsNodeState = LocalNodeState

/** What the verifier host tells the person when an IPFS mount waits on the node and it does not come. */
export const IPFS_NODE_WORDS = { content: 'IPFS content', starting: "Orivon's IPFS node is still starting. Try again in a moment." } as const

/**
 * How the node finds who holds a block. `auto` asks a lookup service and the IPFS network at the same time and
 * uses the first answer; `light-dht` asks the network only, so no lookup service learns what is looked up.
 */
export type RoutingMode = 'auto' | 'light-dht'

export const ROUTING_OPTION = 'routingMode'

/** The node's options for the person's choice of whether a lookup service may be asked. */
export function routingOptions (lookupService: boolean): Readonly<Record<string, string>> {
  return { [ROUTING_OPTION]: lookupService ? 'auto' : 'light-dht' }
}
