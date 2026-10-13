// The kinds of node the one utility-process entry can run, by name. A new
// kind is a line here, and nothing else in this folder names one.

import { IPFS_NODE } from '../ipfs-node/kind.js'
import { SWARM_NODE } from '../swarm-node/kind.js'
import type { NodeKind } from './kind.js'

const KINDS: ReadonlyMap<string, NodeKind> = new Map([SWARM_NODE, IPFS_NODE].map((kind) => [kind.name, kind]))

export function kindNamed (name: string): NodeKind | undefined {
  return KINDS.get(name)
}
