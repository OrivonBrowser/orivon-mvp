// Keeps a utility process running: forks it, hands it its config, restarts it
// with backoff after it exits, and puts it to sleep on request. What the
// process says, and what a caller may ask of it, is the subclass's
// (host-supervisor.ts for the verifier host, local-node-supervisor.ts for a
// local node).

/** The slice of Electron's UtilityProcess this file uses. */
export interface HostProcess {
  postMessage: (message: unknown) => void
  on: ((event: 'message', listener: (message: unknown) => void) => unknown) & ((event: 'exit', listener: (code: number) => void) => unknown)
  kill: () => boolean
  /** The operating system's id of the process, once it has started. */
  readonly pid?: number | undefined
}

/** A running process, for what shows its memory and how long it has been up. */
export interface ProcessInfo {
  readonly pid: number | undefined
  /** When it was forked, in ms since the epoch. */
  readonly startedAt: number
}

export interface ProcessEvents {
  /** The process is being forked, the first time and after every restart. */
  starting?: () => void
  /** The process was put to sleep by `idle()`: not a failure, and nothing restarts it. */
  idle?: () => void
  /** `restarting`: the supervisor will fork it again on its backoff. */
  down: (reason: string, restarting: boolean) => void
}

export interface ProcessDeps<Config, Events extends ProcessEvents> {
  readonly fork: () => HostProcess
  /** A promise so a restart can re-check things that answer asynchronously
   * (proxy-check.ts, at minimum) on every start, not only the first. */
  readonly config: () => Config | Promise<Config>
  readonly events: Events
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly now?: () => number
}

/** How the process is named in what is logged and what a pending request is rejected with. */
export interface ProcessNames {
  /** `the verifier host`: reads after "the ". */
  readonly noun: string
  /** `[verifier]`. */
  readonly log: string
}

/** What a config function throws when the process must not run until it is asked for again (a proxy is set, a file is bad): the supervisor reports it once and does not restart on its backoff. */
export class RefusedToStart extends Error {}

const FIRST_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
/** Up this long, and the next crash is treated as a first one. */
const STABLE_AFTER_MS = 60_000

export abstract class ProcessSupervisor<Config, Message extends { readonly type: string }, Events extends ProcessEvents = ProcessEvents> {
  protected child: HostProcess | undefined
  /** Resolves once the (possibly async) config for the CURRENT `child` has
   * either posted or failed to -- `request()` awaits this first, so a
   * request made right after `start()` cannot race ahead of the 'start'
   * message it depends on and reach the host, or this class's own
   * bookkeeping, before the host even knows it is starting. */
  protected starting: Promise<void> | undefined
  private backoff = FIRST_BACKOFF_MS
  private startedAt = 0
  private stopped = false
  /** The child `idle()` has told to exit and that has not yet: a fresh one waits for it, so two never share the port. */
  private leaving: HostProcess | undefined
  private readonly goneWaiters: Array<() => void> = []
  private startAfterLeaving = false
  /** Counts the restarts `idle()` cancels: a restart timer started under an older number does nothing. */
  private generation = 0
  private restartPending = false
  /** Why the running process said it could not serve, kept as the reason for its exit. */
  private failure: string | undefined
  /** Whether `failure` was already reported: the exit that follows it then says nothing more. */
  private failureReported = false
  /** Whether the exit that follows `failure` restarts the process on its backoff. */
  private restartAfterFailure = true
  protected readonly setTimer: (callback: () => void, ms: number) => unknown
  protected readonly now: () => number

  protected constructor (protected readonly deps: ProcessDeps<Config, Events>, private readonly names: ProcessNames) {
    this.setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.now = deps.now ?? Date.now
  }

  /** Whether `message` is one the process may post. A message is checked structurally, never merely cast, before anything acts on it. */
  protected abstract accepts (message: unknown): message is Message
  protected abstract receive (message: Message): void
  /** The process is gone or asleep: whatever was waiting on it is answered with `reason`. */
  protected abandon (_reason: string): void {}

  start (): void {
    // A crashed process comes back on its backoff timer only: a caller asking meanwhile must not fork one at once.
    if (this.stopped || this.child !== undefined || this.restartPending) return
    this.deps.events.starting?.()
    if (this.leaving !== undefined) {
      this.startAfterLeaving = true
      return
    }
    const child = this.deps.fork()
    this.child = child
    this.startedAt = this.now()
    child.on('message', (message) => {
      if (this.child !== child) return
      if (!this.accepts(message)) { console.error(`${this.names.log} dropped a malformed message from the ${this.names.noun}:`, message); return }
      // A handler that throws here (a checkpoint the disk refused) would otherwise end the browser.
      try {
        this.receive(message)
      } catch (error) {
        console.error(`${this.names.log} acting on the ${this.names.noun}'s ${message.type} message failed:`, error)
      }
    })
    child.on('exit', (code) => { this.exited(child, `the ${this.names.noun} exited with code ${String(code)}`) })

    const result = this.deps.config()
    // A config answered synchronously posts in the same tick, so `request()`
    // right after `start()` needs no await (`this.starting` stays
    // undefined). Only a genuine Promise takes the deferred path below.
    if (!(result instanceof Promise)) {
      this.starting = undefined // clears whatever a PREVIOUS start() left, on a restart
      child.postMessage({ type: 'start', config: result })
      return
    }
    // Only if `child` is still THE running child once config resolves: a
    // config that takes a moment (an async proxy check) must not post a
    // stale start message to a process that has since been stopped or
    // replaced by a later start().
    this.starting = result.then(
      (config) => { if (this.child === child) child.postMessage({ type: 'start', config }) },
      (error: unknown) => {
        if (this.child !== child) return
        // The same path as a process that reports it cannot serve: `child`
        // stays current until it exits, so `exited()` rejects what is
        // pending, clears `failure` and, unless the config refused outright,
        // schedules the restart.
        if (error instanceof RefusedToStart) this.fail(error.message, false)
        else this.fail(`the ${this.names.noun}'s configuration could not be prepared: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    )
  }

  /**
   * The running process cannot serve: reports `reason` once, and ends it. Its exit restarts it on the backoff
   * when `restart` is true; otherwise it stays down until `start()` is called again.
   */
  protected fail (reason: string, restart: boolean): void {
    this.failure = reason
    this.failureReported = true
    this.restartAfterFailure = restart
    this.deps.events.down(reason, restart)
    this.child?.kill()
  }

  /** Resolves once a process that was put to sleep has exited: what it held open (a database file) is free then. At once when none is leaving. */
  async whenGone (): Promise<void> {
    if (this.leaving === undefined) return
    await new Promise<void>((resolve) => { this.goneWaiters.push(resolve) })
  }

  /** The process that runs now, or undefined while none does (never started, asleep, crashed). */
  processInfo (): ProcessInfo | undefined {
    return this.child === undefined ? undefined : { pid: this.child.pid, startedAt: this.startedAt }
  }

  /** Whether a crashed process waits on its backoff to be forked again. */
  get restarting (): boolean {
    return this.restartPending
  }

  /** Posts `message` to the running process; false when none runs. */
  send (message: unknown): boolean {
    if (this.child === undefined) return false
    this.child.postMessage(message)
    return true
  }

  stop (): void {
    this.stopped = true
    this.child?.kill()
  }

  /** Puts the process to sleep: it exits, nothing counts as a crash, no restart follows, and a later `start()`
   * forks a fresh one with the backoff reset. `stop()` stays the permanent end. */
  idle (): void {
    if (this.stopped) return
    // A start queued behind a child that is still leaving is nobody's now.
    const queued = this.startAfterLeaving
    this.startAfterLeaving = false
    const child = this.child
    if (child === undefined && !this.restartPending && !queued) return
    this.generation += 1
    this.restartPending = false
    this.backoff = FIRST_BACKOFF_MS
    this.failure = undefined
    this.failureReported = false
    this.restartAfterFailure = true
    this.starting = undefined
    this.child = undefined
    this.abandon(`the ${this.names.noun} is idle`)
    this.deps.events.idle?.()
    if (child === undefined) return
    this.leaving = child
    child.kill()
  }

  private exited (child: HostProcess, exit: string): void {
    if (this.leaving === child) {
      this.leaving = undefined
      for (const resolve of this.goneWaiters.splice(0)) resolve()
      if (this.startAfterLeaving) {
        this.startAfterLeaving = false
        this.start()
      }
      return
    }
    if (this.child !== child) return
    this.child = undefined
    const reason = this.failure ?? exit
    const reported = this.failureReported
    const restart = this.restartAfterFailure
    this.failure = undefined
    this.failureReported = false
    this.restartAfterFailure = true
    this.abandon(reason)
    if (!reported) this.deps.events.down(reason, !this.stopped)
    if (this.stopped || !restart) return
    if (this.now() - this.startedAt >= STABLE_AFTER_MS) this.backoff = FIRST_BACKOFF_MS
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    const generation = this.generation
    this.restartPending = true
    this.setTimer(() => {
      if (generation !== this.generation) return
      this.restartPending = false
      this.start()
    }, delay)
  }
}
