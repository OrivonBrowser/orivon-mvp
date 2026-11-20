// The marks of one start: named moments, in whole milliseconds since the operating system created the process, and
// the record a start prints once and a problem report carries. Pure: the clock is passed in (startup-marks-runner.ts).
//
// The line, which a probe reads from a packaged build's output or `logs/current.log`: `[orivon][startup] ` and one
// JSON object on the same line, printed once, when the first window is shown and its first tab has loaded, or after
// the cap with what exists (`complete` false). Keys, in this order:
//   schema (1), base (`process-creation` or `performance-origin`), complete, firstRun, electron, app, packaged,
//   marks (every name of STARTUP_MARKS, in order, a whole number or null when not reached),
//   hooks (`{name, phase, ms}` for each subsystem hook that ran, in order).
// A mark reached after the line is in the record a report carries, not in the line. Names and numbers only.

export const STARTUP_LINE_PREFIX = '[orivon][startup] '

/** The moments recorded, in the order a normal start reaches them. */
export const STARTUP_MARKS = [
  'entry', // start.ts began, its imports evaluated
  'launched', // the single-instance lock is taken and the profile chosen
  'bootStart', // index.js and everything it imports were evaluated: boot() began
  'beforeReadyDone', // every subsystem's beforeReady hook ran
  'appReady', // Electron's app is ready
  'extensionsSeedStart', // the bundled extensions are about to be installed into a new profile (a first start only)
  'extensionsSeeded', // they were installed
  'afterReadyDone', // every subsystem's afterReady hook ran
  'storesLoaded', // settings, bookmarks, session and the other shell stores were read
  'firstWindowStart', // the first window's options were chosen and createShellWindow is called
  'firstWindowCreated', // createShellWindow returned: the window, its chrome view and its first tab exist
  'chromeLoaded', // the first window's chrome page finished loading
  'chromeReadyToShow', // the first window's chrome page painted (ready-to-show)
  'windowShown', // the first window was shown
  'firstTabLoaded' // the first window's front tab stopped loading
] as const

export type StartupMark = typeof STARTUP_MARKS[number]

export type HookPhase = 'beforeReady' | 'afterReady'

export interface HookTiming {
  readonly name: string
  readonly phase: HookPhase
  readonly ms: number
}

/** What does not change during a start. */
export interface StartupFacts {
  /** A new profile began from the default profile (`default-profile/`). */
  readonly firstRun: boolean
  readonly electron: string
  readonly app: string
  readonly packaged: boolean
}

export interface StartupRecord extends StartupFacts {
  readonly schema: 1
  /** What the milliseconds count from: the operating system's creation time of the process, or when that is unavailable the first reading of the performance clock. */
  readonly base: 'process-creation' | 'performance-origin'
  /** The first window is shown and its first tab has loaded. */
  readonly complete: boolean
  readonly marks: Readonly<Record<StartupMark, number | null>>
  readonly hooks: readonly HookTiming[]
}

export interface StartupClock {
  /** The monotonic clock, in milliseconds (`performance.now()`). */
  readonly perfNow: () => number
  /** The wall clock, in milliseconds since the epoch (`Date.now()`). */
  readonly wallNow: () => number
  /** When the system created the process, in milliseconds since the epoch, or null when it cannot say. */
  readonly createdAt: number | null
}

export interface StartupMarks {
  /** Records `name` now. The first call for a name counts; a later one is ignored, so code that runs for every window may mark without asking which one it is. */
  readonly mark: (name: StartupMark) => void
  readonly hook: (timing: HookTiming) => void
  readonly setFacts: (facts: StartupFacts) => void
  readonly isComplete: () => boolean
  readonly record: () => StartupRecord
}

/** A creation time further ahead of the wall clock, or further behind it, than this is a reading gone wrong, not a slow start. */
const MAX_PLAUSIBLE_AGE_MS = 10 * 60_000

export function createStartupMarks (clock: StartupClock): StartupMarks {
  const perfAtStart = clock.perfNow()
  const age = clock.createdAt === null ? Number.NaN : clock.wallNow() - clock.createdAt
  const fromCreation = age >= 0 && age <= MAX_PLAUSIBLE_AGE_MS
  const elapsed = (): number => Math.round(fromCreation ? age + (clock.perfNow() - perfAtStart) : clock.perfNow())

  const reached = new Map<StartupMark, number>()
  const hooks: HookTiming[] = []
  let facts: StartupFacts = { firstRun: false, electron: '', app: '', packaged: false }

  const isComplete = (): boolean => reached.has('windowShown') && reached.has('firstTabLoaded')
  return {
    mark: (name) => { if (!reached.has(name)) reached.set(name, elapsed()) },
    hook: ({ name, phase, ms }) => { hooks.push({ name, phase, ms: Math.round(ms) }) },
    setFacts: (next) => { facts = next },
    isComplete,
    record: () => ({
      schema: 1,
      base: fromCreation ? 'process-creation' : 'performance-origin',
      complete: isComplete(),
      firstRun: facts.firstRun,
      electron: facts.electron,
      app: facts.app,
      packaged: facts.packaged,
      marks: Object.fromEntries(STARTUP_MARKS.map((name) => [name, reached.get(name) ?? null])) as Record<StartupMark, number | null>,
      hooks: [...hooks]
    })
  }
}

/** The one line a start prints. */
export function startupLine (record: StartupRecord): string {
  return `${STARTUP_LINE_PREFIX}${JSON.stringify(record)}`
}
