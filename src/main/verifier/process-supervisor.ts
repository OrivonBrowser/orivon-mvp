// Keeps a utility process running: forks it, hands it its config, restarts it
// with backoff after it exits, and puts it to sleep on request. What the
// process says, and what a caller may ask of it, is the subclass's
// (host-supervisor.ts for the verifier host, swarm-node-supervisor.ts for the
// Swarm node).

/** The slice of Electron's UtilityProcess this file uses. */
export interface HostProcess {
  postMessage: (message: unknown) => void
  on: ((event: 'message', listener: (message: unknown) => void) => unknown) & ((event: 'exit', listener: (code: number) => void) => unknown)
  kill: () => boolean
}

export interface ProcessEvents {
  /** The process is being forked, the first time and after every restart. */
  starting?: () => void
  /** The process was put to sleep by `idle()`: not a failure, and nothing restarts it. */
  idle?: () => void
  down: (reason: string) => void
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
  private startAfterLeaving = false
  /** Counts the restarts `idle()` cancels: a restart timer started under an older number does nothing. */
  private generation = 0
  private restartPending = false
  /** Why the running process said it could not serve, kept as the reason for its exit. */
  protected failure: string | undefined
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
        // pending, clears `failure` and schedules the restart.
        this.failure = `the ${this.names.noun}'s configuration could not be prepared: ${error instanceof Error ? error.message : String(error)}`
        this.deps.events.down(this.failure)
        child.kill()
      }
    )
  }

  stop (): void {
    this.stopped = true
    this.child?.kill()
  }

  /** Puts the process to sleep: it exits, nothing counts as a crash, no restart follows, and a later `start()`
   * forks a fresh one with the backoff reset. `stop()` stays the permanent end. */
  idle (): void {
    if (this.stopped) return
    const child = this.child
    if (child === undefined && !this.restartPending) return
    this.generation += 1
    this.restartPending = false
    this.backoff = FIRST_BACKOFF_MS
    this.failure = undefined
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
      if (this.startAfterLeaving) {
        this.startAfterLeaving = false
        this.start()
      }
      return
    }
    if (this.child !== child) return
    this.child = undefined
    const reason = this.failure ?? exit
    this.failure = undefined
    this.abandon(reason)
    this.deps.events.down(reason)
    if (this.stopped) return
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
