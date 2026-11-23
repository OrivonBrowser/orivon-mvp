// Work no first window needs, run once the start has ended (the window is filled and a second launch may be answered) and not
// before. A step that runs before the window delays it directly, and on Windows a few calls of the system cost tens of
// milliseconds each on the main thread, the one the window's own first paint waits on. DESIGN.md says what belongs here.

/** Past the first tab's load (0.2 to 0.5 s after the window shows on the Windows starts measured), and short enough that nobody meets what waits. */
export const AFTER_START_DELAY_MS = 3000

export interface AfterStartTask {
  /** Named in the log line of a failure. */
  readonly name: string
  readonly run: () => void | Promise<void>
}

/** Starts `run` once, `delayMs` from now. The default lets the process end without waiting for it. */
export type Schedule = (run: () => void, delayMs: number) => void

const unrefTimer: Schedule = (run, delayMs) => { setTimeout(run, delayMs).unref() }

/**
 * Runs the tasks one after the other, each in a turn of the event loop of its own so a message or a key that arrived meanwhile is
 * served between two of them. A task that throws is logged and does not stop the rest. Never rejects.
 */
export async function runAfterStart (tasks: readonly AfterStartTask[]): Promise<void> {
  for (const task of tasks) {
    try {
      await task.run()
    } catch (error) {
      console.error(`[startup] the ${task.name} step after the start failed:`, error)
    }
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
}

/** Called where the start has ended: the tasks run `AFTER_START_DELAY_MS` later, or never when the process ends first. */
export function afterStart (tasks: readonly AfterStartTask[], schedule: Schedule = unrefTimer): void {
  // orivon:floating-ok -- runAfterStart catches everything a task can throw
  schedule(() => { void runAfterStart(tasks) }, AFTER_START_DELAY_MS)
}
