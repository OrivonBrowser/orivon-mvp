// A CPU profile of the main process's start, asked for with ORIVON_STARTUP_PROFILE=<file>: V8's sampling profiler runs from
// the first statement of start.ts until the start-up line prints (or the cap), and the profile is written to that file in
// Chrome DevTools' `.cpuprofile` format. Pure: the inspector, the file system and the clock are passed in
// (startup-profile-runner.ts), so the start/stop logic runs under plain vitest.

/** The environment variable that asks for a profile; its value is the file to write. */
export const STARTUP_PROFILE_ENV = 'ORIVON_STARTUP_PROFILE'

/** The profile stops this long after it began if the start-up line has not printed: a start that never completes is the one to read. */
export const STARTUP_PROFILE_CAP_MS = 20_000

/** Finer than V8's 1000 us, so a function of a few ms is not missed in a stretch of a few hundred. A profiled start is slower than an unprofiled one. */
export const STARTUP_PROFILE_INTERVAL_US = 250

export const STARTUP_PROFILE_TAG = '[orivon][startup-profile]'

/** The file asked for, or null when the variable is unset or blank. */
export function startupProfilePath (env: Readonly<Record<string, string | undefined>>): string | null {
  const value = env[STARTUP_PROFILE_ENV]?.trim() ?? ''
  return value === '' ? null : value
}

/** The part of `node:inspector`'s Session this uses. The real one answers the callback in the same tick; a stand-in may answer later. */
export interface ProfilerLink {
  readonly connect: () => void
  readonly disconnect: () => void
  readonly post: (method: string, params: Record<string, unknown> | undefined, callback: (error: Error | null, result?: { readonly profile?: V8Profile }) => void) => void
}

/** What V8 returns from `Profiler.stop`, which is what a `.cpuprofile` file holds. */
export interface V8Profile {
  readonly startTime: number
  readonly endTime: number
  readonly nodes: readonly unknown[]
  readonly samples: readonly number[]
  readonly timeDeltas: readonly number[]
}

/** Where the profile's first moment lies on the clock the start-up line uses, so a window of marks maps onto it. */
export interface ProfileAnchor {
  readonly startMs: number
  readonly base: 'process-creation' | 'performance-origin'
}

export interface StartupProfileHost {
  /** The link to the inspector; throws when this process has none. */
  readonly open: () => ProfilerLink
  /** Writes the file whole or not at all. */
  readonly write: (path: string, text: string) => void
  readonly log: (line: string, level: 'log' | 'warn') => void
  /** Runs `run` after `ms`, without keeping the process alive. */
  readonly later: (run: () => void, ms: number) => void
  /** Now, in ms since the system created the process (the start-up line's own clock). */
  readonly anchor: () => ProfileAnchor
}

export interface StartupProfile {
  /** Starts profiling for `path`. Does nothing after the first call. */
  readonly start: (path: string) => void
  /** Stops, writes the file and logs one line; `reason` is for that line. Does nothing unless profiling is under way. */
  readonly stop: (reason: string) => void
  readonly isActive: () => boolean
}

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'done'

export function createStartupProfile (host: StartupProfileHost): StartupProfile {
  let phase: Phase = 'idle'
  let link: ProfilerLink | undefined
  let file = ''
  let anchor: ProfileAnchor | undefined
  let stopWhenRunning: string | undefined

  const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

  function close (): void {
    phase = 'done'
    try { link?.disconnect() } catch { /* nothing left to release */ }
  }

  // A failure is one line and the end of the profile; it never reaches the start.
  function fail (what: string, error: unknown): void {
    if (phase === 'done') return
    close()
    try { host.log(`${STARTUP_PROFILE_TAG} ${what} failed, no profile written: ${messageOf(error)}`, 'warn') } catch { /* a log that fails is no reason to stop the start */ }
  }

  /** One protocol call whose answer carries on at `next`. A thrown call and an error answer are the same failure. */
  function call (method: string, params: Record<string, unknown> | undefined, next: (result?: { readonly profile?: V8Profile }) => void): void {
    try {
      link?.post(method, params, (error, result) => {
        if (error !== null) { fail(method, error); return }
        try { next(result) } catch (thrown) { fail(method, thrown) }
      })
    } catch (thrown) {
      fail(method, thrown)
    }
  }

  function begun (): void {
    anchor = host.anchor()
    phase = 'running'
    host.later(() => { stop('the cap of the profile was reached before the start-up line') }, STARTUP_PROFILE_CAP_MS)
    if (stopWhenRunning !== undefined) stop(stopWhenRunning)
  }

  function start (path: string): void {
    if (phase !== 'idle') return
    phase = 'starting'
    file = path
    try {
      link = host.open()
      link.connect()
    } catch (error) {
      fail('opening the inspector', error)
      return
    }
    call('Profiler.enable', undefined, () => {
      call('Profiler.setSamplingInterval', { interval: STARTUP_PROFILE_INTERVAL_US }, () => {
        call('Profiler.start', undefined, begun)
      })
    })
  }

  function stop (reason: string): void {
    if (phase === 'starting') { stopWhenRunning ??= reason; return }
    if (phase !== 'running') return
    phase = 'stopping'
    call('Profiler.stop', undefined, (result) => {
      const profile = result?.profile
      if (profile === undefined) { fail('Profiler.stop', new Error('the inspector returned no profile')); return }
      try {
        // `orivon` is ours: DevTools and every other reader of the format ignore a key they do not know.
        host.write(file, JSON.stringify({ ...profile, orivon: { schema: 1, startMs: anchor?.startMs ?? null, base: anchor?.base ?? null, stoppedBecause: reason } }))
      } catch (error) {
        fail('writing the profile', error)
        return
      }
      close()
      host.log(`${STARTUP_PROFILE_TAG} wrote ${file}: ${String(Math.round((profile.endTime - profile.startTime) / 1000))} ms of the start, stopped because ${reason}`, 'log')
    })
  }

  return { start, stop, isActive: () => phase === 'starting' || phase === 'running' }
}
