// When a local node runs, and what it is doing: it starts when something that
// reads from it asks for it (`ensure`), sleeps when the verifier host sleeps or after ten
// minutes with no ask, and restarts with the supervisor's backoff when it
// crashes. A start that cannot succeed (a proxy, files that are missing or are
// not the pinned ones, an API port that is taken) is refused once and stays
// down until it is asked for again. No `electron` import: the process, the
// artifact, the proxy check and the clock come in (local-node-launch.ts).

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { NodeIdentity } from '../../protocols/local-node/kind.js'
import type { LocalNodeConfig, LocalNodeState, PinnedFile, RouteEndpoint } from '../../protocols/local-node/protocol.js'
import { HostLifecycle } from './host-lifecycle.js'
import { RefusedToStart } from './process-supervisor.js'
import type { HostProcess, ProcessInfo } from './process-supervisor.js'
import type { ArtifactStatus } from './local-node-artifact.js'
import { LocalNodeSupervisor } from './local-node-supervisor.js'

/** Within the 30 s a mount may take, how long `ensure` waits for the node to find its peers. */
export const READY_WAIT_MS = 20_000
/** A refusal is answered from memory for this long before the files and the proxy are looked at again. */
export const REFUSAL_MEMORY_MS = 10_000

export function proxyReason (identity: NodeIdentity): string {
  return `a proxy is configured, and the ${identity.noun}'s connections would go around it`
}

/** The tunnel that carries a node while the whole browser is on the tunnel. */
export interface NodeRoute {
  /** Whether the node must run through the tunnel now. Asked at each start and again before anything is trusted, so a node never starts direct while this is true. */
  readonly required: () => boolean
  /** Where the tunnel is now, starting it if need be; rejects, in words, when it cannot carry the node. */
  readonly endpoint: () => Promise<RouteEndpoint>
  /** Called when an address `endpoint` handed out stops being the tunnel's. Returns the unsubscribe. */
  readonly onMoved: (listener: () => void) => () => void
}

function tunnelReason (identity: NodeIdentity, error: unknown): string {
  const why = (error instanceof Error ? error.message : 'it is not available').replace(/\.$/, '')
  return `all of Orivon's traffic goes through the tunnel, and it cannot carry the ${identity.noun} now: ${why}`
}

export interface ControllerDeps {
  /** Which kind of node this runs. */
  readonly kind: NodeIdentity
  readonly fork: () => HostProcess
  /** Checks the node's files against the pinned hashes (reads every pinned file). */
  readonly artifact: () => Promise<ArtifactStatus>
  /** The files the node is made of, as pinned: handed to the process, which checks the bytes it runs. */
  readonly files: readonly PinnedFile[]
  /** Whether a proxy applies that would not carry the node's connections. Not asked while the node runs through the tunnel: the tunnel is then its only way out. */
  readonly proxyConfigured: () => Promise<boolean>
  /** The tunnel the node runs through while the whole browser is on it. Absent: the node always runs directly. */
  readonly route?: NodeRoute
  /** Why the node must not start, in words (a hermetic test run), or undefined. */
  readonly disabled?: () => string | undefined
  readonly apiPort: () => number
  /** The node could not bind its API port: choose another for the next start, and let whoever fixed the old one in place know. */
  readonly apiPortTaken?: () => void
  readonly dataDir: () => string
  /** The DNS-over-HTTPS endpoints the node resolves names with first. */
  readonly dohEndpoints?: readonly string[]
  /** What the person chose that the kind turns into arguments, read at each start so a change reaches the next one. */
  readonly options?: () => Readonly<Record<string, string>>
  readonly componentName: string
  /** Removes a file, none being no error: for `forget`, which a test replaces. */
  readonly remove?: (path: string) => Promise<void>
  readonly readyWaitMs?: number
  /** Resolves after `ms`; the default is a timer that never keeps the process alive. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly now?: () => number
}

/** `routed`: the check was made for a node that runs through the tunnel, which skips the question of a proxy. */
type Verdict = { readonly directory: string, readonly routed: boolean } | { readonly reason: string }

function sleepFor (ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref() })
}

export class LocalNodeController {
  private current: LocalNodeState = { state: 'off' }
  private readonly listeners = new Set<() => void>()
  private readonly supervisor: LocalNodeSupervisor
  private readonly lifecycle: HostLifecycle
  private readonly now: () => number
  /** Until when a refusal is answered without looking again. */
  private refusedUntil = 0
  /** The one check in flight: asks that arrive meanwhile share it. */
  private checking: Promise<Verdict> | undefined
  /** What a check just approved, for the start it was made for: one check per start. */
  private approved: Extract<Verdict, { directory: string }> | undefined
  /** A refusal made by `configure`, which `down` then need not turn into a failure. */
  private refusal: string | undefined
  private portWasTaken = false
  private readonly stopWatchingRoute: (() => void) | undefined
  /** Counts the starts of the process, so an answer to a route ask goes only to the process that asked. */
  private starts = 0
  /** The one ask of the tunnel in flight: every ask that arrives meanwhile is answered from it. */
  private endpointAsk: Promise<RouteEndpoint> | undefined

  constructor (private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now
    this.supervisor = new LocalNodeSupervisor({
      fork: deps.fork,
      config: async () => await this.configure(),
      events: {
        starting: () => { this.starts += 1; this.set({ state: 'starting' }) },
        idle: () => { this.set({ state: 'off' }) },
        failed: (stage) => {
          this.portWasTaken = stage === 'port'
          if (stage === 'port') deps.apiPortTaken?.()
        },
        listening: () => {},
        peers: (count) => { this.set(this.current.state === 'ready' ? { state: 'ready', peers: count } : { state: 'starting', peers: count }) },
        ready: (peers) => { this.set({ state: 'ready', peers }) },
        routeAsk: (id) => { this.answerRoute(id).catch((error: unknown) => { console.error(`[${deps.kind.name}] answering the node's ask for its route failed:`, error) }) },
        down: (reason, restarting) => {
          if (this.refusal !== undefined) { this.refusal = undefined; return }
          console.error(`[${deps.kind.name}] ${reason}`)
          // A node that will not be forked again, other than because its port was taken (its next start is then fresh), is not tried again until the memory of it fades.
          if (!restarting && !this.portWasTaken) this.refusedUntil = this.now() + REFUSAL_MEMORY_MS
          this.portWasTaken = false
          this.set({ state: 'failed', reason })
        }
      },
      ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
      ...(deps.now === undefined ? {} : { now: deps.now })
    }, deps.kind)
    // The tunnel's process restarted or stopped: the address the node holds is no longer right, and its next connection asks again.
    this.stopWatchingRoute = deps.route?.onMoved(() => {
      this.supervisor.send({ type: 'route-reset' })
      this.recheckRoute().catch((error: unknown) => { console.error(`[${deps.kind.name}] checking the tunnel after it moved failed:`, error) })
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

  state (): LocalNodeState {
    return this.current
  }

  /** The node's process while it runs. */
  processInfo (): ProcessInfo | undefined {
    return this.supervisor.processInfo()
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
  async ensure (): Promise<LocalNodeState> {
    if (this.current.state === 'starting' || this.current.state === 'ready') {
      this.lifecycle.request()
      return await this.settled()
    }
    if (this.supervisor.restarting || this.now() < this.refusedUntil) return this.current
    const verdict = await this.check()
    // The person's switch can have gone off while the files were being read: it is asked again before anything starts.
    const disabled = this.deps.disabled?.()
    if (disabled !== undefined) {
      this.refuse(disabled)
      return this.current
    }
    if ('reason' in verdict) {
      this.refuse(verdict.reason)
      return this.current
    }
    this.approved = verdict
    this.lifecycle.request()
    return await this.settled()
  }

  /**
   * The person's switch for this node changed, or a reason it must not run did: a node that runs while it must not is
   * stopped and the state says why; one that may run again is asked for as usual, with no refusal remembered.
   */
  reconsider (): void {
    this.refusedUntil = 0
    // A check under way started before this change: nobody joins it, and its answer is read against the switch again.
    this.checking = undefined
    const disabled = this.deps.disabled?.()
    if (disabled !== undefined) {
      this.supervisor.idle()
      this.set({ state: 'off', reason: disabled })
    } else if (this.current.state === 'off' && this.current.reason !== undefined) {
      this.set({ state: 'off' })
    }
  }

  /** The verifier host went to sleep, and with it the only thing that reads from the node. */
  verifierIdle (): void {
    this.supervisor.idle()
  }

  /**
   * Stops the node and deletes `files` from its data directory once its process has exited, so what it kept is gone
   * (a process holds its database open). The next ask starts it afresh on an empty store.
   */
  async forget (files: readonly string[]): Promise<void> {
    this.supervisor.idle()
    await this.supervisor.whenGone()
    const remove = this.deps.remove ?? (async (path: string) => { await rm(path, { force: true }) })
    for (const file of files) await remove(join(this.deps.dataDir(), file))
  }

  stop (): void {
    this.stopWatchingRoute?.()
    this.lifecycle.dispose()
    this.supervisor.stop()
  }

  private refuse (reason: string): void {
    this.refusedUntil = this.now() + REFUSAL_MEMORY_MS
    this.set({ state: 'off', reason })
  }

  /** Whether the node may start now: the directory its files are in, or why not. Asked once at a time. The proxy, or the tunnel that replaces the question, comes first, so nothing is read from disk while one is set. */
  private async check (): Promise<Verdict> {
    if (this.checking === undefined) {
      // Only its own entry is cleared: a check that `reconsider` dropped must not clear the one that replaced it.
      const pending: Promise<Verdict> = this.look().finally(() => { if (this.checking === pending) this.checking = undefined })
      this.checking = pending
    }
    return await this.checking
  }

  private async look (): Promise<Verdict> {
    const disabled = this.deps.disabled?.()
    if (disabled !== undefined) return { reason: disabled }
    const routed = this.deps.route?.required() === true
    if (routed) {
      // The tunnel is the node's only way out, so the question of a proxy does not arise; whether the tunnel can carry it does.
      try {
        await this.deps.route?.endpoint()
      } catch (error) {
        return { reason: tunnelReason(this.deps.kind, error) }
      }
    } else if (await this.deps.proxyConfigured().catch(() => true)) {
      return { reason: proxyReason(this.deps.kind) }
    }
    const artifact = await this.deps.artifact()
    return artifact.ok ? { directory: artifact.directory, routed } : { reason: artifact.reason }
  }

  /** The config of a start: the check an ask just made, or, at a restart on the backoff, a new one: the files may have changed and a proxy may have been set. */
  private async configure (): Promise<LocalNodeConfig> {
    const taken = this.approved
    this.approved = undefined
    // A check made for the other path (the tunnel was switched on or off since) says nothing about this one.
    const approved = taken !== undefined && taken.routed === (this.deps.route?.required() === true) ? taken : undefined
    const verdict: Verdict = approved ?? await this.check()
    const disabled = this.deps.disabled?.()
    if (disabled !== undefined) {
      this.refusal = disabled
      this.refuse(disabled)
      throw new RefusedToStart(disabled)
    }
    if ('reason' in verdict) {
      this.refusal = verdict.reason
      this.refuse(verdict.reason)
      throw new RefusedToStart(verdict.reason)
    }
    const options = this.deps.options?.()
    // Read again after every wait above: the setting can have moved, and a node started direct while the tunnel should carry it is the one thing this must not do.
    const routed = this.deps.route?.required() === true
    // The setting moved during the waits above: what was approved is for the other path, so the check is made again.
    if (routed !== verdict.routed) return await this.configure()
    return { ...(routed ? { routed: true as const } : {}), kind: this.deps.kind.name, apiPort: this.deps.apiPort(), dataDir: this.deps.dataDir(), componentDir: verdict.directory, componentName: this.deps.componentName, files: this.deps.files, ...(this.deps.dohEndpoints === undefined ? {} : { dohEndpoints: this.deps.dohEndpoints }), ...(options === undefined ? {} : { options }) }
  }

  /** A node that runs while its tunnel cannot carry it is stopped and says why, so its card never reads as running with nothing to run on. */
  private async recheckRoute (): Promise<void> {
    const route = this.deps.route
    if (route === undefined || !route.required() || (this.current.state !== 'starting' && this.current.state !== 'ready')) return
    try {
      await route.endpoint()
    } catch (error) {
      if (!route.required()) return
      this.supervisor.idle()
      this.refuse(tunnelReason(this.deps.kind, error))
    }
  }

  /** A routed node asks where its tunnel is; it is answered with the address, or with why there is none, and only if it is still the process that asked and the tunnel still carries it. */
  private async answerRoute (id: number): Promise<void> {
    const route = this.deps.route
    const asker = this.starts
    const answer = (message: { readonly endpoint: RouteEndpoint } | { readonly refusal: string }): void => {
      // The process that asked may have been replaced while Nym was starting, and its successor's ids start from the same number.
      if (asker === this.starts) this.supervisor.send({ type: 'route', id, ...message })
    }
    if (route === undefined || !route.required()) {
      answer({ refusal: 'the tunnel is not carrying this node now' })
      return
    }
    try {
      this.endpointAsk ??= route.endpoint().finally(() => { this.endpointAsk = undefined })
      const endpoint = await this.endpointAsk
      if (!route.required()) answer({ refusal: 'the tunnel is not carrying this node now' })
      else answer({ endpoint })
    } catch (error) {
      answer({ refusal: error instanceof Error ? error.message : 'the tunnel is not available' })
    }
  }

  private async settled (): Promise<LocalNodeState> {
    if (this.current.state !== 'starting') return this.current
    let wake: () => void = () => {}
    const changed = new Promise<void>((resolve) => { wake = resolve })
    const stopListening = this.onChange(() => { if (this.current.state !== 'starting') wake() })
    await Promise.race([changed, (this.deps.sleep ?? sleepFor)(this.deps.readyWaitMs ?? READY_WAIT_MS)])
    stopListening()
    return this.current
  }

  private set (state: LocalNodeState): void {
    this.current = state
    for (const listener of [...this.listeners]) listener()
  }
}
