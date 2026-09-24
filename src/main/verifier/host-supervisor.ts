// Keeps the verifier host running: forks it, hands it its config, answers
// for it while it is down, and restarts it with backoff after it exits.

import type { FromHost, HostConfig, HostReplies, HostRequest, LightClientState } from '../../verifier-host/protocol.js'

/** The slice of Electron's UtilityProcess this file uses. */
export interface HostProcess {
  postMessage: (message: unknown) => void
  on: ((event: 'message', listener: (message: unknown) => void) => unknown) & ((event: 'exit', listener: (code: number) => void) => unknown)
  kill: () => boolean
}

export interface SupervisorEvents {
  listening: (fingerprint: string) => void
  down: (reason: string) => void
  status: (status: LightClientState) => void
  checkpoint: (root: string, timestamp: number) => void
  ipnsSequence: (key: string, sequence: string) => void
}

export interface SupervisorDeps {
  readonly fork: () => HostProcess
  readonly config: () => HostConfig
  readonly events: SupervisorEvents
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly now?: () => number
}

export const REQUEST_TIMEOUT_MS = 5_000
const FIRST_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
/** Up this long, and the next crash is treated as a first one. */
const STABLE_AFTER_MS = 60_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class HostSupervisor {
  private child: HostProcess | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private backoff = FIRST_BACKOFF_MS
  private startedAt = 0
  private stopped = false
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly now: () => number

  constructor (private readonly deps: SupervisorDeps) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.now = deps.now ?? Date.now
  }

  start (): void {
    if (this.stopped || this.child !== undefined) return
    const child = this.deps.fork()
    this.child = child
    this.startedAt = this.now()
    child.on('message', (message) => { this.receive(message as FromHost) })
    child.on('exit', (code) => { this.exited(child, `the verifier host exited with code ${String(code)}`) })
    child.postMessage({ type: 'start', config: this.deps.config() })
  }

  stop (): void {
    this.stopped = true
    this.child?.kill()
  }

  /** Rejects when the host is down, exits first, or does not answer in time: a reply that never comes is the failure to expect. */
  async request<K extends HostRequest['kind']> (request: Extract<HostRequest, { kind: K }>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HostReplies[K]> {
    const child = this.child
    if (child === undefined) throw new Error('the verifier host is not running')
    const id = this.nextId++
    return await new Promise<HostReplies[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.setTimer(() => {
        if (this.pending.delete(id)) reject(new Error(`the verifier host did not answer ${request.kind} within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      child.postMessage({ type: 'request', id, request })
    })
  }

  private receive (message: FromHost): void {
    const { events } = this.deps
    switch (message.type) {
      case 'listening': events.listening(message.fingerprint); break
      case 'failed': events.down(`the verifier host could not ${message.stage === 'listen' ? 'listen on its port' : 'start'}: ${message.message}`); break
      case 'status': events.status(message.status); break
      case 'checkpoint': events.checkpoint(message.root, message.timestamp); break
      case 'ipns-sequence': events.ipnsSequence(message.key, message.sequence); break
      case 'reply': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.message))
      }
    }
  }

  private exited (child: HostProcess, reason: string): void {
    if (this.child !== child) return
    this.child = undefined
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new Error(reason))
    }
    this.deps.events.down(reason)
    if (this.stopped) return
    if (this.now() - this.startedAt >= STABLE_AFTER_MS) this.backoff = FIRST_BACKOFF_MS
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.setTimer(() => { this.start() }, delay)
  }
}
