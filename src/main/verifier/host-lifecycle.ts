// When the verifier host runs: it starts when something needs it (a request to a host it serves, an address typed
// that names one) and sleeps once nothing has for a while. Once at launch it also starts for one run when the
// stored checkpoint has aged, because the checkpoint is refreshed only while the light client syncs. No `electron`
// import: the host, the tabs and the clock come in.

/** The host sleeps once no tab shows a verifier-served origin and nothing has asked for it this long. */
export const IDLE_STOP_MS = 10 * 60_000
/** How often a running host is checked against the idle wait. */
export const IDLE_CHECK_MS = 60_000
/** The quiet time after launch before the checkpoint is looked at. */
export const REFRESH_DELAY_MS = 2 * 60_000
/** A newest checkpoint older than this is renewed at launch; the light client refuses one older than fourteen days. */
export const REFRESH_WHEN_OLDER_THAN_SECONDS = 7 * 24 * 60 * 60

export interface LifecycleDeps {
  /** Starts the host if it is not running. Idempotent. */
  start: () => void
  /** Puts a running host to sleep. */
  idle: () => void
  /** Whether any tab shows an origin the verifier serves. */
  tabShowsVerifiedOrigin: () => boolean
  /** The age of the newest checkpoint the light client could start from; undefined while the light client is off or no checkpoint can start it. */
  checkpointAgeSeconds: () => number | undefined
  /** Holds a start back this long (test builds only); zero otherwise. */
  startDelayMs: () => number
  /** A private session renews no checkpoint at launch: it would reach the network for a file thrown away at its end. */
  privateSession?: boolean
  now?: () => number
}

export class HostLifecycle {
  private lastUse = 0
  private watching: ReturnType<typeof setInterval> | undefined
  private delayedStart = false
  private launchTimer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number

  constructor (private readonly deps: LifecycleDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Something needs the host: starts it when it is not running, and restarts the idle wait. */
  request (): void {
    this.lastUse = this.now()
    this.watch()
    if (this.delayedStart) return
    const delay = this.deps.startDelayMs()
    if (delay <= 0) {
      this.deps.start()
      return
    }
    this.delayedStart = true
    setTimeout(() => {
      this.delayedStart = false
      this.deps.start()
    }, delay).unref()
  }

  /** After the quiet delay, starts the host for one run if the checkpoint is old enough to need renewing. */
  refreshAtLaunch (): void {
    if (this.deps.privateSession === true) return
    this.launchTimer = setTimeout(() => {
      this.launchTimer = undefined
      const age = this.deps.checkpointAgeSeconds()
      if (age !== undefined && age > REFRESH_WHEN_OLDER_THAN_SECONDS) this.request()
    }, REFRESH_DELAY_MS)
    this.launchTimer.unref()
  }

  dispose (): void {
    if (this.watching !== undefined) clearInterval(this.watching)
    if (this.launchTimer !== undefined) clearTimeout(this.launchTimer)
    this.watching = undefined
    this.launchTimer = undefined
  }

  private watch (): void {
    if (this.watching !== undefined) return
    this.watching = setInterval(() => { this.check() }, IDLE_CHECK_MS)
    this.watching.unref()
  }

  private check (): void {
    if (this.deps.tabShowsVerifiedOrigin()) {
      this.lastUse = this.now()
      return
    }
    if (this.now() - this.lastUse < IDLE_STOP_MS) return
    if (this.watching !== undefined) clearInterval(this.watching)
    this.watching = undefined
    this.deps.idle()
  }
}
