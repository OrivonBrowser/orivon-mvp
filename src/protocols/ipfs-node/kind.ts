// Orivon's IPFS node as a kind of local node: its arguments, its data
// directory and its health-check readiness, which are all the shared host
// needs from it.

import type { NodeKind } from '../local-node/kind.js'
import { nodeArguments, prepareDataDir } from './config.js'
import { IPFS_NODE_IDENTITY } from './protocol.js'
import { watchReadiness } from './readiness.js'

export const IPFS_NODE: NodeKind = {
  ...IPFS_NODE_IDENTITY,
  arguments: nodeArguments,
  prepare: async (dataDir) => { await prepareDataDir(dataDir) },
  watchReadiness
}
