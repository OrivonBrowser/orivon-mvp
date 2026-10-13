// The Swarm node on this computer, as the rest of the shell reaches it
// (local-node-subsystem.ts is the shared part): which kind it is, and when a
// test build serves Swarm from its own endpoints. Without the node Swarm stays
// off with a reason and nothing else changes.

import { SWARM_NODE_IDENTITY } from '../../protocols/swarm-node/protocol.js'
import type { SwarmNodeState } from '../../protocols/swarm-node/protocol.js'
import manifest from '../../../resources/swarm-node/swarm-node.json'
import { createLocalNodeSubsystem } from './local-node-subsystem.js'
import type { LocalNodeManifest } from './local-node-artifact.js'
import { ethTestSeam } from './test-seam.js'

const MANIFEST: LocalNodeManifest = manifest

export const swarmNode = createLocalNodeSubsystem({
  kind: SWARM_NODE_IDENTITY,
  manifest: MANIFEST,
  disabled: () => ethTestSeam() === undefined ? undefined : 'a test build serves Swarm from its own endpoints'
})

export function swarmNodeState (): SwarmNodeState {
  return swarmNode.state()
}

/** The Bee API endpoint the Swarm protocol reads from. */
export function swarmNodeEndpoint (): string {
  return swarmNode.endpoint()
}
