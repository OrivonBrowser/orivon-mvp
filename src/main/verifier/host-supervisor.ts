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
  /** A promise so a restart can re-check things that answer asynchronously
   * (unproxiedGateways.ts's proxy check, at minimum) on every start, not
   * only the first. */
  readonly config: () => HostConfig | Promise<HostConfig>
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
  /** Resolves once the (possibly async) config for the CURRENT `child` has
   * either posted or failed to -- `request()` awaits this first, so a
   * request made right after `start()` cannot race ahead of the 'start'
   * message it depends on and reach the host, or this class's own
   * bookkeeping, before the host even knows it is starting. */
  private starting: Promise<void> | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private backoff = FIRST_BACKOFF_MS
  private startedAt = 0
  private stopped = false
  /** Why the running host said it could not serve, kept as the reason for its exit. */
  private failure: string | undefined
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

    const result = this.deps.config()
    // A config answered synchronously (every real config today except the
    // proxy check) posts in the same tick, exactly as before this class had
    // to support an async one at all -- no artificial delay, and `request()`
    // right after `start()` needs no await either (`this.starting` stays
    // undefined). Only a genuine Promise takes the deferred path below.
    if (!(result instanceof Promise)) {
      this.starting = undefined // clears whatever a PREVIOUS start() left, on a restart
      child.postMessage({ type: 'start', config: result })
      return
    }
    // Only if `child` is still THE running child once config resolves: a
    // config that takes a moment (an async proxy check) must not post a
    // stale start message to a host that has since been stopped or
    // replaced by a later start().
    this.starting = result.then(
      (config) => { if (this.child === child) child.postMessage({ type: 'start', config }) },
      (error: unknown) => {
        if (this.child !== child) return
        this.failure = `the verifier host's configuration could not be prepared: ${error instanceof Error ? error.message : String(error)}`
        this.deps.events.down(this.failure)
        this.child = undefined
        child.kill()
      }
    )
  }

  stop (): void {
    this.stopped = true
    this.child?.kill()
  }

  /** Rejects when the host is down, exits first, or does not answer in time: a reply that never comes is the failure to expect. */
  async request<K extends HostRequest['kind']> (request: Extract<HostRequest, { kind: K }>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HostReplies[K]> {
    if (this.starting !== undefined) await this.starting
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
      case 'failed':
        // A host that cannot serve would otherwise live on, syncing a light client nothing can use.
        this.failure = `the verifier host could not ${message.stage === 'listen' ? 'listen on its port' : 'start'}: ${message.message}`
        events.down(this.failure)
        this.child?.kill()
        break
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

  private exited (child: HostProcess, exit: string): void {
    if (this.child !== child) return
    this.child = undefined
    const reason = this.failure ?? exit
    this.failure = undefined
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
