// Keeps the Swarm node's utility process running (process-supervisor.ts). The
// node only reports; nothing asks it anything.

import type { FromNode, SwarmNodeConfig } from '../../protocols/swarm-node/protocol.js'
import { isFromNode } from './host-messages.js'
import { ProcessSupervisor } from './process-supervisor.js'
import type { ProcessDeps, ProcessEvents } from './process-supervisor.js'

export interface SwarmNodeEvents extends ProcessEvents {
  listening: () => void
  peers: (count: number) => void
  ready: (peers: number) => void
}

export type SwarmNodeSupervisorDeps = ProcessDeps<SwarmNodeConfig, SwarmNodeEvents>

export class SwarmNodeSupervisor extends ProcessSupervisor<SwarmNodeConfig, FromNode, SwarmNodeEvents> {
  constructor (deps: SwarmNodeSupervisorDeps) {
    super(deps, { noun: 'Swarm node', log: '[swarm-node]' })
  }

  protected accepts (message: unknown): message is FromNode {
    return isFromNode(message)
  }

  protected receive (message: FromNode): void {
    const { events } = this.deps
    switch (message.type) {
      case 'listening': events.listening(); break
      case 'peers': events.peers(message.count); break
      case 'ready': events.ready(message.peers); break
      case 'failed':
        // A node that cannot run would otherwise live on, doing nothing.
        this.failure = `the Swarm node could not run (${message.stage}): ${message.message}`
        events.down(this.failure)
        this.child?.kill()
        break
    }
  }
}
