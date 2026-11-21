// The end of a start, from the moment the first window exists: wait for it to show, run the subsystems' slow tail
// (`afterWindow`), open the gate on web pages (./web-ready.ts), fill the first window, and only then answer a second
// launch. One place for the order, because each step's reason is the one before it; DESIGN.md says why the window comes first.
import type { SubsystemFailure } from '../registry.js'
import type { StartupMark } from './startup-marks.js'

export interface EndOfStart {
  /** Every subsystem's `afterWindow` hook (`runAfterWindow`): the route's first read of the system's settings, loading the person's extensions. */
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

/**
 * Runs the end of a start. `shown` settles when the first window is on screen, or gone: a window closed before it was
 * shown still lets the tail run, because the process may stay resident (macOS) and the next window needs the extensions.
 */
export async function endStart (shown: Promise<void>, steps: EndOfStart): Promise<void> {
  let stopped = false
  try {
    await shown
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
