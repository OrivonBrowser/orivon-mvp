// This process's one set of start-up marks (startup-marks.ts) on the real clock, and the line it prints.
// Imports nothing from electron and does almost nothing when loaded, so start.ts may import it ahead of the lock.
import { createStartupMarks, startupLine } from './startup-marks.js'
import type { HookPhase, StartupFacts, StartupMark, StartupRecord } from './startup-marks.js'

/** The line waits this long for the first tab, then prints what exists. */
const LINE_CAP_MS = 60_000

const marks = createStartupMarks({
  perfNow: () => performance.now(),
  wallNow: () => Date.now(),
  // Electron adds this to `process`; a plain Node run has none.
  createdAt: typeof process.getCreationTime === 'function' ? process.getCreationTime() : null
})

let printed = false
const lineListeners: Array<() => void> = []

// A listener's failure is its own: the start must not end because a diagnostic did.
function tell (listener: () => void): void {
  try { listener() } catch (error) { console.warn('[orivon][startup] a listener of the start-up line failed:', error) }
}

function printLine (): void {
  if (printed) return
  printed = true
  console.log(startupLine(marks.record()))
  for (const listener of lineListeners.splice(0)) tell(listener)
}

/** Calls `listener` once the line has printed, straight away when it already has. This module knows nothing of what a listener does. */
export function onStartupLine (listener: () => void): void {
  if (printed) tell(listener)
  else lineListeners.push(listener)
}

/** Records a moment of this start (the first call for a name counts) and prints the line once the first window is shown and its chrome page and first tab have loaded, whichever of the three comes last. */
export function markStartup (name: StartupMark): void {
  marks.mark(name)
  if (marks.isComplete()) printLine()
}

/** One subsystem hook's duration, for the record. */
export function noteStartupHook (name: string, phase: HookPhase, ms: number): void {
  marks.hook({ name, phase, ms })
}

export function describeStartup (facts: StartupFacts): void {
  marks.setFacts(facts)
}

/** Prints the line after the cap if the start is not complete by then: a start that never completes is the one to measure. Never keeps the process alive. */
export function printStartupLineAtCap (): void {
  setTimeout(printLine, LINE_CAP_MS).unref()
}

/** The record as it stands, late marks included: what a problem report carries. */
export function startupRecord (): StartupRecord {
  return marks.record()
}
