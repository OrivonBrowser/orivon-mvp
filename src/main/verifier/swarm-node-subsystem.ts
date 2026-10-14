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

/** Whether the person lets the node run. Set once the settings are read; until then it is on, the setting's default. */
let allowedByPerson: () => boolean = () => true

export function configureSwarmNode (options: { enabled: () => boolean }): void {
  allowedByPerson = options.enabled
}

/** Why a Swarm address says Swarm is off, and where the person turns it on. */
export const SWARM_SWITCHED_OFF = 'Swarm is switched off. Switch it on in Settings under Web3, or from Available networks in the toolbar'

export const swarmNode = createLocalNodeSubsystem({
  kind: SWARM_NODE_IDENTITY,
  manifest: MANIFEST,
  disabled: () => ethTestSeam() !== undefined ? 'a test build serves Swarm from its own endpoints' : allowedByPerson() ? undefined : SWARM_SWITCHED_OFF
})

/** The person switched the node on or off: applied at once. */
export function swarmSettingChanged (): void {
  swarmNode.reconsider()
}

export function swarmNodeState (): SwarmNodeState {
  return swarmNode.state()
}

/** The Bee API endpoint the Swarm protocol reads from. */
export function swarmNodeEndpoint (): string {
  return swarmNode.endpoint()
}
