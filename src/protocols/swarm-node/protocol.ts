// What the shell says about the Swarm node, on top of what every local node
// says (../local-node/protocol.ts).

import type { NodeIdentity } from '../local-node/kind.js'
import type { LocalNodeState } from '../local-node/protocol.js'

export const SWARM_NODE_IDENTITY: NodeIdentity = { name: 'swarm-node', noun: 'Swarm node' }

/** What main tells the verifier host about the node (the wiring phase carries it over the host's own port). */
export type SwarmNodeState = LocalNodeState

export interface SwarmNodeWanted { readonly type: 'swarm-node-wanted' }
export interface SwarmNodeNotice { readonly type: 'swarm-node', readonly state: SwarmNodeState['state'], readonly reason?: string }
