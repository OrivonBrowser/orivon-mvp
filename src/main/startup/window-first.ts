// The end of a start. The subsystems' slow tail (`afterWindow`) starts where the boot reaches it and is not awaited
// there: the stores, the window and the tail run side by side, the tail ends by opening the gate on web pages
// (./web-ready.ts), and the start ends when the first window is filled, which is when a second launch is answered.
// One place for the order, because each step's reason is the one before it; DESIGN.md says why the window comes first.
import type { SubsystemFailure } from '../registry.js'
import type { StartupMark } from './startup-marks.js'

/** A window that has not reported it is shown after this long is not waited for: the signal opens, whatever became of the window. */
export const SHOWN_WAIT_CAP_MS = 5000

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

export interface Tail {
  /** Settles, and never rejects, once the tail has ended and the gate has opened, or the start was stopped. */
  readonly done: Promise<TailOutcome>
  /** The first window is on screen, or is gone, or the start ended without one: lets the steps that wait for it go on (`firstWindowShown`). Safe to call more than once. */
  readonly windowShown: () => void
}

let shownSignal: Promise<void> | undefined

/**
 * Settles once the first window is on screen, or gone, or after SHOWN_WAIT_CAP_MS. A step of the tail that holds the main
 * thread for long (the synchronous unpacking of the bundled extension into a new profile) awaits it first, because the
 * main thread serves the chrome page the window is waiting to paint. Settles at once where no start runs the tail.
 */
export function firstWindowShown (): Promise<void> {
  return shownSignal ?? Promise.resolve()
}

/**
 * Starts the tail and returns at once, with the signal `firstWindowShown` answers with already made: a step of the tail
 * that asks for it finds it pending, never absent. The tail never rejects: a throw that no subsystem caught is a critical
 * failure of the start, said and ended like one, so nothing is left waiting on a promise nobody awaits yet.
 */
export function startTail (steps: TailSteps): Tail {
  let release: () => void = () => {}
  shownSignal = new Promise<void>((resolve) => { release = resolve })
  setTimeout(release, SHOWN_WAIT_CAP_MS).unref()
  const run = async (): Promise<TailOutcome> => {
    try {
      const failures = await steps.afterWindow()
      steps.mark('afterWindowDone')
      steps.report(failures)
      if (steps.stopOnCritical(failures)) {
        release()
        return { stopped: true }
      }
      await steps.openWebContent()
      return { stopped: false }
    } catch (error) {
      const failure: SubsystemFailure = { name: 'startup', phase: 'afterWindow', error, critical: true }
      steps.report([failure])
      release()
      return { stopped: steps.stopOnCritical([failure]) }
    }
  }
  const done = run().catch((error: unknown) => {
    console.error('[startup] ending the start failed:', error)
    release()
    return { stopped: true }
  })
  return { done, windowShown: release }
}

/**
 * Ends the start: waits for the tail and for the first window to exist, fills the window (the restored session, the
 * addresses on the command line, What's new, the other windows), and only then lets a second launch be answered, so it never
 * meets a window with no tabs or opens a second one. A start that failed before its window existed still lets a launch in
 * and opens the signal; one that ended the process answers no launch queued behind it.
 */
export async function endStart (tail: Tail, firstWindow: Promise<{ readonly fill: () => Promise<void> }>, started: () => void): Promise<void> {
  let stopped = false
  try {
    const [outcome, window] = await Promise.all([tail.done, firstWindow])
    stopped = outcome.stopped
    if (stopped) return
    await window.fill()
  } finally {
    tail.windowShown()
    if (!stopped) started()
  }
}
