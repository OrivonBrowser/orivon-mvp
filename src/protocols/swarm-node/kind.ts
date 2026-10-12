// The Swarm node as a kind of local node: its arguments, its YAML and its
// peer-count readiness, which are all the shared host needs from it.

import type { NodeKind } from '../local-node/kind.js'
import { nodeArguments, prepareDataDir } from './config.js'
import { peerCountOfLog, watchReadiness } from './readiness.js'
import { SWARM_NODE_IDENTITY } from './protocol.js'

export const SWARM_NODE: NodeKind = {
  ...SWARM_NODE_IDENTITY,
  arguments: () => nodeArguments(),
  prepare: prepareDataDir,
  watchReadiness: (deps) => {
    let logPeers: number | undefined
    const stop = watchReadiness({ ...deps, logPeers: () => logPeers })
    return { stop, onLog: (line) => { logPeers = peerCountOfLog(line) ?? logPeers } }
  }
}
