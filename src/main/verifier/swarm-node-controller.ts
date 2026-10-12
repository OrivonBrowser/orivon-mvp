// When the Swarm node runs, and what it is doing: it starts when a Swarm
// mount asks for it (`ensure`), sleeps when the verifier host sleeps or after
// ten minutes with no ask, and restarts with the supervisor's backoff when it
// fails. No `electron` import: the process, the artifact, the proxy check and
// the clock come in (swarm-node-subsystem.ts gives them).

import type { SwarmNodeConfig, SwarmNodeState } from '../../protocols/swarm-node/protocol.js'
import { HostLifecycle } from './host-lifecycle.js'
import type { HostProcess } from './process-supervisor.js'
import type { ArtifactStatus } from './swarm-node-artifact.js'
import { SwarmNodeSupervisor } from './swarm-node-supervisor.js'

/** Within the 30 s a mount may take, how long `ensure` waits for the node to find its peers. */
export const READY_WAIT_MS = 20_000

export const PROXY_REASON = "a proxy is configured, and the Swarm node's connections would go around it"

export interface ControllerDeps {
  readonly fork: () => HostProcess
  /** Checks the node's files against the pinned hashes. */
  readonly artifact: () => Promise<ArtifactStatus>
  /** Whether the default session has a proxy in front of it. */
  readonly proxyConfigured: () => Promise<boolean>
  /** Why the node must not start, in words (a hermetic test run), or undefined. */
  readonly disabled?: () => string | undefined
  readonly apiPort: () => number
  readonly dataDir: () => string
  readonly componentName: string
  readonly readyWaitMs?: number
  /** Resolves after `ms`; the default is a timer that never keeps the process alive. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly now?: () => number
}

function sleepFor (ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref() })
}

export class SwarmNodeController {
  private current: SwarmNodeState = { state: 'off' }
  private readonly listeners = new Set<() => void>()
  private readonly supervisor: SwarmNodeSupervisor
  private readonly lifecycle: HostLifecycle

  constructor (private readonly deps: ControllerDeps) {
    this.supervisor = new SwarmNodeSupervisor({
      fork: deps.fork,
      config: async () => await this.configure(),
      events: {
        starting: () => { this.set({ state: 'starting' }) },
        idle: () => { this.set({ state: 'off' }) },
        listening: () => {},
        peers: (count) => { this.set(this.current.state === 'ready' ? { state: 'ready', peers: count } : { state: 'starting', peers: count }) },
        ready: (peers) => { this.set({ state: 'ready', peers }) },
        down: (reason) => {
          console.error(`[swarm-node] ${reason}`)
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
   * A Swarm mount needs the node: starts it if it is not running, restarts the
   * ten-minute idle wait, and waits until it is ready, has failed or is off,
   * or `readyWaitMs` pass (then it is still starting).
   */
  async ensure (): Promise<SwarmNodeState> {
    if (this.current.state === 'off' || this.current.state === 'failed') {
      const checked = await this.check()
      if ('reason' in checked) {
        this.set({ state: 'off', reason: checked.reason })
        return this.current
      }
    }
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

  /** Whether the node may start now: the directory its files are in, or why not. */
  private async check (): Promise<{ directory: string } | { reason: string }> {
    const disabled = this.deps.disabled?.()
    if (disabled !== undefined) return { reason: disabled }
    const artifact = await this.deps.artifact()
    if (!artifact.ok) return { reason: artifact.reason }
    if (await this.deps.proxyConfigured().catch(() => true)) return { reason: PROXY_REASON }
    return { directory: artifact.directory }
  }

  /** Re-checked at every start, a restart included: the files may have changed and a proxy may have been set. */
  private async configure (): Promise<SwarmNodeConfig> {
    const checked = await this.check()
    if ('reason' in checked) throw new Error(checked.reason)
    return { apiPort: this.deps.apiPort(), dataDir: this.deps.dataDir(), componentDir: checked.directory, componentName: this.deps.componentName }
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
