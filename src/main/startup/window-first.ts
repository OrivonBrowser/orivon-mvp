// The end of a start. The subsystems' slow tail (`afterWindow`) starts where the boot reaches it and is not awaited
// there: the stores, the window and the tail run side by side, the tail ends by opening the gate on web pages
// (./web-ready.ts), and the start ends when the first window is filled, which is when a second launch is answered.
// One place for the order, because each step's reason is the one before it; DESIGN.md says why the window comes first.
import type { SubsystemFailure } from '../registry.js'
import type { StartupMark } from './startup-marks.js'

export interface TailSteps {
  /** Every subsystem's `afterWindow` hook (`runAfterWindow`): the route's first read of the system's settings, loading the person's extensions. */
  readonly afterWindow: () => Promise<readonly SubsystemFailure[]>
  /** Prints what failed. */
  readonly report: (failures: readonly SubsystemFailure[]) => void
  /** Ends the start loudly when a failure is critical, and answers true when it did: the gate then never opens. */
  readonly stopOnCritical: (failures: readonly SubsystemFailure[]) => boolean
  /** Lets web pages load (`openWebContent`) and settles once they may: a test build holds the gate shut past this call. */
  readonly openWebContent: () => Promise<void>
  readonly mark: (name: StartupMark) => void
}

export interface TailOutcome {
  /** A critical failure ended the start: the gate never opened and nothing more is to be done. */
  readonly stopped: boolean
}

/**
 * Starts the tail and returns at once with a promise that settles, and never rejects, once the tail has ended and the gate
 * has opened, or the start was stopped. The end of the start awaits it some hundreds of milliseconds after it is made, so it
 * must not reject meanwhile (`start.ts` ends the process on an unhandled rejection): a throw that no subsystem caught is a
 * critical failure of the start, said and ended like one.
 */
export function startTail (steps: TailSteps): Promise<TailOutcome> {
  const run = async (): Promise<TailOutcome> => {
    try {
      const failures = await steps.afterWindow()
      steps.mark('afterWindowDone')
      steps.report(failures)
      if (steps.stopOnCritical(failures)) return { stopped: true }
      await steps.openWebContent()
      return { stopped: false }
    } catch (error) {
      const failure: SubsystemFailure = { name: 'startup', phase: 'afterWindow', error, critical: true }
      steps.report([failure])
      return { stopped: steps.stopOnCritical([failure]) }
    }
  }
  return run().catch((error: unknown) => {
    console.error('[startup] ending the start failed:', error)
    return { stopped: true }
  })
}

/**
 * Ends the start: waits for the tail and for the first window to exist, fills the window (the restored session, the
 * addresses on the command line, What's new, the other windows), and only then lets a second launch be answered, so it never
 * meets a window with no tabs or opens a second one. A start that failed before its window existed still lets a launch in;
 * one that ended the process answers no launch queued behind it.
 */
export async function endStart (tail: Promise<TailOutcome>, firstWindow: Promise<{ readonly fill: () => Promise<void> }>, started: () => void): Promise<void> {
  let stopped = false
  try {
    const [outcome, window] = await Promise.all([tail, firstWindow])
    stopped = outcome.stopped
    if (stopped) return
    await window.fill()
  } finally {
    if (!stopped) started()
  }
}
