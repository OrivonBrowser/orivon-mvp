// When the Swarm node runs, and what it is doing: it starts when a Swarm mount
// asks for it (`ensure`), sleeps when the verifier host sleeps or after ten
// minutes with no ask, and restarts with the supervisor's backoff when it
// crashes. A start that cannot succeed (a proxy, files that are missing or are
// not the pinned ones, an API port that is taken) is refused once and stays
// down until it is asked for again. No `electron` import: the process, the
// artifact, the proxy check and the clock come in (swarm-node-subsystem.ts).

import type { PinnedFile, SwarmNodeConfig, SwarmNodeState } from '../../protocols/swarm-node/protocol.js'
import { HostLifecycle } from './host-lifecycle.js'
import { RefusedToStart } from './process-supervisor.js'
import type { HostProcess } from './process-supervisor.js'
import type { ArtifactStatus } from './swarm-node-artifact.js'
import { SwarmNodeSupervisor } from './swarm-node-supervisor.js'

/** Within the 30 s a mount may take, how long `ensure` waits for the node to find its peers. */
export const READY_WAIT_MS = 20_000
/** A refusal is answered from memory for this long before the files and the proxy are looked at again. */
export const REFUSAL_MEMORY_MS = 10_000

export const PROXY_REASON = "a proxy is configured, and the Swarm node's connections would go around it"

export interface ControllerDeps {
  readonly fork: () => HostProcess
  /** Checks the node's files against the pinned hashes (reads about 14 MB). */
  readonly artifact: () => Promise<ArtifactStatus>
  /** The files the node is made of, as pinned: handed to the process, which checks the bytes it runs. */
  readonly files: readonly PinnedFile[]
  /** Whether the default session has a proxy in front of it. */
  readonly proxyConfigured: () => Promise<boolean>
  /** Why the node must not start, in words (a hermetic test run), or undefined. */
  readonly disabled?: () => string | undefined
  readonly apiPort: () => number
  /** The node could not bind its API port: choose another for the next start, and let whoever fixed the old one in place know. */
  readonly apiPortTaken?: () => void
  readonly dataDir: () => string
  readonly componentName: string
  readonly readyWaitMs?: number
  /** Resolves after `ms`; the default is a timer that never keeps the process alive. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly now?: () => number
}

type Verdict = { readonly directory: string } | { readonly reason: string }

function sleepFor (ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref() })
}

export class SwarmNodeController {
  private current: SwarmNodeState = { state: 'off' }
  private readonly listeners = new Set<() => void>()
  private readonly supervisor: SwarmNodeSupervisor
  private readonly lifecycle: HostLifecycle
  private readonly now: () => number
  /** Until when a refusal is answered without looking again. */
  private refusedUntil = 0
  /** The one check in flight: asks that arrive meanwhile share it. */
  private checking: Promise<Verdict> | undefined
  /** The directory a check just approved, for the start it was made for: one check per start. */
  private approved: string | undefined
  /** A refusal made by `configure`, which `down` then need not turn into a failure. */
  private refusal: string | undefined
  private portWasTaken = false

  constructor (private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now
    this.supervisor = new SwarmNodeSupervisor({
      fork: deps.fork,
      config: async () => await this.configure(),
      events: {
        starting: () => { this.set({ state: 'starting' }) },
        idle: () => { this.set({ state: 'off' }) },
        failed: (stage) => {
          this.portWasTaken = stage === 'port'
          if (stage === 'port') deps.apiPortTaken?.()
        },
        listening: () => {},
        peers: (count) => { this.set(this.current.state === 'ready' ? { state: 'ready', peers: count } : { state: 'starting', peers: count }) },
        ready: (peers) => { this.set({ state: 'ready', peers }) },
        down: (reason, restarting) => {
          if (this.refusal !== undefined) { this.refusal = undefined; return }
          console.error(`[swarm-node] ${reason}`)
          // A node that will not be forked again, other than because its port was taken (its next start is then fresh), is not tried again until the memory of it fades.
          if (!restarting && !this.portWasTaken) this.refusedUntil = this.now() + REFUSAL_MEMORY_MS
          this.portWasTaken = false
          this.set({ state: 'failed', reason })
        }
      },
      ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      ...(deps.now === undefined ? {} : { now: deps.now })
    })
    this.lifecycle = new HostLifecycle({
      start: () => { this.supervisor.start() },
      idle: () => { this.supervisor.idle() },
      tabShowsVerifiedOrigin: () => false,
      checkpointAgeSeconds: () => undefined,
      startDelayMs: () => 0,
      ...(deps.now === undefined ? {} : { now: deps.now })
    })
  }

  state (): SwarmNodeState {
    return this.current
  }

  /** Called whenever the state changes; returns the unsubscribe. */
  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The node is needed, or is in use: starts it if it is not running, restarts the ten-minute idle wait, and
   * waits until it is ready, has failed or is off, or `readyWaitMs` pass (then it is still starting). A node
   * that is running costs nothing here; one that was refused a moment ago is answered from memory.
   */
  async ensure (): Promise<SwarmNodeState> {
    if (this.current.state === 'starting' || this.current.state === 'ready') {
      this.lifecycle.request()
      return await this.settled()
    }
    if (this.supervisor.restarting || this.now() < this.refusedUntil) return this.current
    const verdict = await this.check()
    if ('reason' in verdict) {
      this.refuse(verdict.reason)
      return this.current
    }
    this.approved = verdict.directory
    this.lifecycle.request()
    return await this.settled()
  }

  /** The verifier host went to sleep, and with it the only thing that reads from the node. */
  verifierIdle (): void {
    this.supervisor.idle()
  }

  stop (): void {
    this.lifecycle.dispose()
    this.supervisor.stop()
  }

  private refuse (reason: string): void {
    this.refusedUntil = this.now() + REFUSAL_MEMORY_MS
    this.set({ state: 'off', reason })
  }

  /** Whether the node may start now: the directory its files are in, or why not. Asked once at a time. The proxy comes first, so nothing is read from disk while one is set. */
  private async check (): Promise<Verdict> {
    this.checking ??= this.look().finally(() => { this.checking = undefined })
    return await this.checking
  }

  private async look (): Promise<Verdict> {
    const disabled = this.deps.disabled?.()
    if (disabled !== undefined) return { reason: disabled }
    if (await this.deps.proxyConfigured().catch(() => true)) return { reason: PROXY_REASON }
    const artifact = await this.deps.artifact()
    return artifact.ok ? { directory: artifact.directory } : { reason: artifact.reason }
  }

  /** The config of a start: the check an ask just made, or, at a restart on the backoff, a new one: the files may have changed and a proxy may have been set. */
  private async configure (): Promise<SwarmNodeConfig> {
    const approved = this.approved
    this.approved = undefined
    const verdict: Verdict = approved === undefined ? await this.check() : { directory: approved }
    if ('reason' in verdict) {
      this.refusal = verdict.reason
      this.refuse(verdict.reason)
      throw new RefusedToStart(verdict.reason)
    }
    return { apiPort: this.deps.apiPort(), dataDir: this.deps.dataDir(), componentDir: verdict.directory, componentName: this.deps.componentName, files: this.deps.files }
  }

  private async settled (): Promise<SwarmNodeState> {
    if (this.current.state !== 'starting') return this.current
    let wake: () => void = () => {}
    const changed = new Promise<void>((resolve) => { wake = resolve })
    const stopListening = this.onChange(() => { if (this.current.state !== 'starting') wake() })
    await Promise.race([changed, (this.deps.sleep ?? sleepFor)(this.deps.readyWaitMs ?? READY_WAIT_MS)])
    stopListening()
    return this.current
  }

  private set (state: SwarmNodeState): void {
    this.current = state
    for (const listener of [...this.listeners]) listener()
  }
}
