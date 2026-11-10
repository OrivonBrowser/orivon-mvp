// Keeps the verifier host told what each local node is doing: it holds a mount that reads from a node until the node answers.

import type { NodeNotice } from '../../protocols/verifier-host/protocol.js'
import type { LocalNodeSubsystem } from './local-node-subsystem.js'

/** The host's link to its node: what a notice is sent through, and what puts the host to sleep so its next start fixes the new endpoint. */
export interface NodeHost {
  send: (notice: NodeNotice) => unknown
  idle: () => void
}

/** What `node` is doing now, as the host is told it. */
export function noticeOf (name: string, node: Pick<LocalNodeSubsystem, 'state'>): NodeNotice {
  const state = node.state()
  return { type: 'node', node: name, state: state.state, ...(state.state === 'off' && state.reason !== undefined && { reason: state.reason }), ...(state.state === 'failed' && { reason: state.reason }) }
}

export function tellHost (host: NodeHost, name: string, node: Pick<LocalNodeSubsystem, 'state'>): void {
  host.send(noticeOf(name, node))
}

/** Tells `host` of every change of every node, and sleeps it when a node's port is renewed: the host holds the endpoint from its start. */
export function followNodes (nodes: ReadonlyMap<string, LocalNodeSubsystem>, host: NodeHost, changed: () => void): void {
  for (const [name, node] of nodes) {
    node.onChange(() => {
      tellHost(host, name, node)
      changed()
    })
    node.onEndpointChange(() => { host.idle() })
  }
}
