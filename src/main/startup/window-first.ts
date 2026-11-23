// The end of a start, from the moment the first window exists: run the subsystems' slow tail (`afterWindow`) while its
// chrome page loads, open the gate on web pages (./web-ready.ts), fill the first window, and only then answer a second
// launch. The one piece of the tail that blocks the main thread, which serves the chrome page, waits for the window to show
// (`firstWindowShown`). One place for the order, because each step's reason is the one before it; DESIGN.md says why the
// window comes first.
import type { SubsystemFailure } from '../registry.js'
import type { StartupMark } from './startup-marks.js'

export interface EndOfStart {
  /** Every subsystem's `afterWindow` hook (`runAfterWindow`): the route's first read of the system's settings, loading the person's extensions. Runs while the window is still loading its page. */
  readonly afterWindow: () => Promise<readonly SubsystemFailure[]>
  /** Prints what failed. */
  readonly report: (failures: readonly SubsystemFailure[]) => void
  /** Ends the start loudly when a failure is critical, and answers true when it did: the gate then never opens. */
  readonly stopOnCritical: (failures: readonly SubsystemFailure[]) => boolean
  /** Lets web pages load (`openWebContent`) and settles once they may: a test build holds the gate shut past this call, and the first window must not be filled before it opens. */
  readonly openWebContent: () => Promise<void>
  /** What the first window opens beyond its new-tab page: the restored session, the addresses on the command line, What's new, the other windows. Runs once pages of the web may load. */
  readonly fill: () => Promise<void>
  /** Lets a second launch be answered. Called whatever failed above, so one that arrived early is never stranded, except when the start ended the process. */
  readonly started: () => void
  readonly mark: (name: StartupMark) => void
}

let shownSignal: Promise<void> | undefined

/**
 * Settles once the first window is on screen, or gone. A piece of the tail that holds the main thread for long (the
 * synchronous unpacking of the bundled extension into a new profile) awaits it first, because the main thread serves the
 * chrome page the window is waiting to paint. Settles at once where no start is running the tail.
 */
export function firstWindowShown (): Promise<void> {
  return shownSignal ?? Promise.resolve()
}

/**
 * Runs the end of a start. The tail starts at once, while the window loads its page; `shown` settles when the window is
 * on screen, or gone (a window closed before it was shown still lets the tail run, because the process may stay resident
 * on macOS and the next window needs the extensions), and is what `firstWindowShown` answers with.
 */
export async function endStart (shown: Promise<void>, steps: EndOfStart): Promise<void> {
  shownSignal = shown
  let stopped = false
  try {
    const failures = await steps.afterWindow()
    steps.mark('afterWindowDone')
    steps.report(failures)
    stopped = steps.stopOnCritical(failures)
    if (stopped) return
    await steps.openWebContent()
    await steps.fill()
  } finally {
    // A start that ended the process answers no launch queued behind it.
    if (!stopped) steps.started()
  }
}
