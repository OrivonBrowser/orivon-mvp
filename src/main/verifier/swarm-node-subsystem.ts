// The Swarm node on this computer, as the rest of the shell reaches it: ask
// for it (`ensureSwarmNode`), read what it is doing, and tell it the verifier
// host went to sleep. The process is created the first time something asks, so
// a run that never opens a Swarm address never forks the process. Not critical:
// without it Swarm stays off with a reason and nothing else changes.

import { SWARM_NODE_IDENTITY } from '../../protocols/swarm-node/protocol.js'
import type { SwarmNodeState } from '../../protocols/swarm-node/protocol.js'
import manifest from '../../../resources/swarm-node/swarm-node.json'
import { renewSwarmNodePort, swarmNodePort } from './loopback-port.js'
import type { LocalNodeController } from './local-node-controller.js'
import { createLocalNodeController } from './local-node-launch.js'
import type { LocalNodeManifest } from './local-node-artifact.js'
import { ethTestSeam } from './test-seam.js'
import { swarmNodeView as viewOf } from './status-view.js'
import type { SwarmNodeView } from './status-view.js'

const MANIFEST: LocalNodeManifest = manifest

let controller: LocalNodeController | undefined
const endpointListeners = new Set<() => void>()

function created (): LocalNodeController {
  controller ??= createLocalNodeController({
    kind: SWARM_NODE_IDENTITY,
    manifest: MANIFEST,
    apiPort: swarmNodePort,
    apiPortTaken: () => {
      renewSwarmNodePort()
      for (const listener of [...endpointListeners]) listener()
    },
    disabled: () => ethTestSeam() === undefined ? undefined : 'a test build serves Swarm from its own endpoints'
  })
  return controller
}

/** A Swarm mount needs the node: starts it if need be, and answers once it is ready, has failed, is off, or has been given the time a mount can spare. */
export async function ensureSwarmNode (): Promise<SwarmNodeState> {
  return await created().ensure()
}

/** What the node is doing; off while nothing has asked for it. */
export function swarmNodeState (): SwarmNodeState {
  return controller?.state() ?? { state: 'off' }
}

/**
 * Called when the node's endpoint changed, because its port was taken: whoever fixed the old one in place (the
 * verifier host holds it for as long as it runs) starts afresh. Returns the unsubscribe.
 */
export function onSwarmNodeEndpointChange (listener: () => void): () => void {
  endpointListeners.add(listener)
  return () => { endpointListeners.delete(listener) }
}

/** The Bee API endpoint the Swarm protocol reads from. */
export function swarmNodeEndpoint (): string {
  return `http://127.0.0.1:${String(swarmNodePort())}`
}

/** The verifier host went to sleep: nothing reads from the node, so it sleeps too. */
export function swarmNodeVerifierIdle (): void {
  controller?.verifierIdle()
}

/** Called whenever what swarmNodeView() says may have changed; returns the unsubscribe. */
export function onSwarmNodeChange (listener: () => void): () => void {
  return created().onChange(listener)
}

export function swarmNodeView (): SwarmNodeView {
  return viewOf(swarmNodeState())
}
