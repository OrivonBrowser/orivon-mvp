// Keeps the verifier host running (process-supervisor.ts) and answers for it
// while it is down: a request is a message with an id, a reply the host's
// answer to it.

import type { FromHost, HostConfig, HostReplies, HostRequest, LightClientState } from '../../protocols/verifier-host/protocol.js'
import { isFromHost, isHostReplyValue } from './host-messages.js'
import { ProcessSupervisor } from './process-supervisor.js'
import type { HostProcess, ProcessDeps, ProcessEvents } from './process-supervisor.js'

export type { HostProcess }

export interface SupervisorEvents extends ProcessEvents {
  listening: (fingerprint: string) => void
  status: (status: LightClientState) => void
  checkpoint: (root: string, timestamp: number) => void
  ipnsSequence: (key: string, sequence: string) => void
  swarmFeedIndex: (feed: string, index: string) => void
  /** A Swarm mount needs the node. */
  swarmNodeWanted?: () => void
}

export type SupervisorDeps = ProcessDeps<HostConfig, SupervisorEvents>

export const REQUEST_TIMEOUT_MS = 5_000

interface Pending {
  kind: HostRequest['kind']
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class HostSupervisor extends ProcessSupervisor<HostConfig, FromHost, SupervisorEvents> {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor (deps: SupervisorDeps) {
    super(deps, { noun: 'verifier host', log: '[verifier]' })
  }

  protected accepts (message: unknown): message is FromHost {
    // The host runs every untrusted parser this app has.
    return isFromHost(message)
  }

  protected override abandon (reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new Error(reason))
    }
  }

  /** Rejects when the host is down, exits first, or does not answer in time: a reply that never comes is the failure to expect. */
  async request<K extends HostRequest['kind']> (request: Extract<HostRequest, { kind: K }>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HostReplies[K]> {
    if (this.starting !== undefined) await this.starting
    const child = this.child
    if (child === undefined) throw new Error('the verifier host is not running')
    const id = this.nextId++
    return await new Promise<HostReplies[K]>((resolve, reject) => {
      this.pending.set(id, { kind: request.kind, resolve: resolve as (value: unknown) => void, reject })
      this.setTimer(() => {
        if (this.pending.delete(id)) reject(new Error(`the verifier host did not answer ${request.kind} within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      child.postMessage({ type: 'request', id, request })
    })
  }

  protected receive (message: FromHost): void {
    const { events } = this.deps
    switch (message.type) {
      case 'listening': events.listening(message.fingerprint); break
      case 'failed':
        // A host that cannot serve would otherwise live on, syncing a light client nothing can use.
        this.fail(`the verifier host could not ${message.stage === 'listen' ? 'listen on its port' : 'start'}: ${message.message}`, true)
        break
      case 'status': events.status(message.status); break
      case 'checkpoint': events.checkpoint(message.root, message.timestamp); break
      case 'ipns-sequence': events.ipnsSequence(message.key, message.sequence); break
      case 'swarm-node-wanted': events.swarmNodeWanted?.(); break
      case 'swarm-feed-index': events.swarmFeedIndex(message.feed, message.index); break
      case 'reply': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        if (!message.ok) { pending.reject(new Error(message.message)); break }
        // The id alone says which request this answers; only its own kind's
        // shape is accepted, so a reply cannot hand a `provenance` waiter
        // something only `mount` or `status` could truthfully answer.
        if (!isHostReplyValue(pending.kind, message.value)) {
          console.error(`[verifier] dropped a malformed ${pending.kind} reply from the host`)
          pending.reject(new Error(`the verifier host answered ${pending.kind} with something that is not one`))
          break
        }
        pending.resolve(message.value)
      }
    }
  }
}
