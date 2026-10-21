// What the shell says about the Swarm node, on top of what every local node
// says (../local-node/protocol.ts).

import type { NodeIdentity } from '../local-node/kind.js'
import type { LocalNodeState } from '../local-node/protocol.js'

export const SWARM_NODE_IDENTITY: NodeIdentity = { name: 'swarm-node', noun: 'Swarm node' }

/** What main tells the verifier host about the node (the wiring phase carries it over the host's own port). */
export type SwarmNodeState = LocalNodeState

/** What the verifier host tells the person when a Swarm mount cannot have its node. */
export const SWARM_NODE_WORDS = { content: 'Swarm content', starting: "Orivon's Swarm node is still finding peers. Try again in a moment." } as const
