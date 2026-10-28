// Where the host reads Swarm and IPFS from, and what the popover calls each node's endpoint. A test build names fixtures of its own.

import { ethTestSeam } from './test-seam.js'
import type { EthTestSeam } from './test-seam.js'
import { swarmNodeEndpoint } from './swarm-node-subsystem.js'
import { ipfsNodeEndpoint } from './ipfs-node-subsystem.js'

/** The Bee-API origins Swarm reads from: the node Orivon runs, unless a test build names its own. */
export function swarmEndpoints (seam: EthTestSeam | undefined): readonly string[] {
  return seam === undefined ? [swarmNodeEndpoint()] : seam.swarmEndpoints ?? []
}

/** The nodes' own endpoints, by the name the popover gives them: only an ordinary build runs them (a test build's endpoints are fixtures and keep their own address). */
export function nodeEndpointNames (): Readonly<Record<string, string>> {
  if (ethTestSeam() !== undefined) return {}
  return { [ipfsNodeEndpoint()]: "Orivon's IPFS node", [swarmNodeEndpoint()]: "Orivon's Swarm node" }
}

/** Whether IPFS is read from the node Orivon runs: the person's choice; a test build serves IPFS from its own endpoints, or from a fixture standing in for the node when it names one. */
export function ipfsReadFromNode (seam: EthTestSeam | undefined, choice: 'node' | 'gateways'): boolean {
  return seam === undefined ? choice === 'node' : seam.ipfsNode !== undefined
}
