// Orivon's IPFS node on this computer, as the rest of the shell reaches it
// (local-node-subsystem.ts is the shared part). IPFS is read from it unless
// the person chose public gateways; when it cannot run, the verifier host
// loads IPFS from the gateways and Settings shows the node's reason.

import { DATABASE_FILE } from '../../protocols/ipfs-node/config.js'
import { IPFS_NODE_IDENTITY, routingOptions } from '../../protocols/ipfs-node/protocol.js'
import type { IpfsNodeState } from '../../protocols/ipfs-node/protocol.js'
import manifest from '../../../resources/ipfs-node/ipfs-node.json'
import { createLocalNodeSubsystem } from './local-node-subsystem.js'
import type { LocalNodeManifest } from './local-node-artifact.js'
import { ethTestSeam } from './test-seam.js'

const MANIFEST: LocalNodeManifest = manifest

/** Whether the person lets the node ask a lookup service. Set once the settings are read; until then it is on, the setting's default. */
let lookupServiceAllowed: () => boolean = () => true

export function configureIpfsNode (options: { lookupService: () => boolean }): void {
  lookupServiceAllowed = options.lookupService
}

export const ipfsNode = createLocalNodeSubsystem({
  kind: IPFS_NODE_IDENTITY,
  manifest: MANIFEST,
  disabled: () => ethTestSeam() === undefined ? undefined : 'a test build serves IPFS from its own endpoints',
  options: () => routingOptions(lookupServiceAllowed()),
  // SQLite's journal and write-ahead log sit beside the database.
  kept: [DATABASE_FILE, `${DATABASE_FILE}-journal`, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`]
})

export function ipfsNodeState (): IpfsNodeState {
  return ipfsNode.state()
}

/** The node's trustless-gateway endpoint the IPFS protocol reads from. */
export function ipfsNodeEndpoint (): string {
  return ipfsNode.endpoint()
}
