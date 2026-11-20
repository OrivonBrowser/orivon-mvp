// This process's one set of start-up marks (startup-marks.ts) on the real clock, and the line it prints.
// Imports nothing from electron and does almost nothing when loaded, so start.ts may import it ahead of the lock.
import { createStartupMarks, startupLine } from './startup-marks.js'
import type { StartupFacts, StartupMark, StartupRecord } from './startup-marks.js'

/** The line waits this long for the first tab, then prints what exists. */
const LINE_CAP_MS = 60_000

const marks = createStartupMarks({
  perfNow: () => performance.now(),
  wallNow: () => Date.now(),
  // Electron adds this to `process`; a plain Node run has none.
  createdAt: typeof process.getCreationTime === 'function' ? process.getCreationTime() : null
})

let printed = false

function printLine (): void {
  if (printed) return
  printed = true
  console.log(startupLine(marks.record()))
}

/** Records a moment of this start (the first call for a name counts) and prints the line when the first window is shown and its first tab has loaded. */
export function markStartup (name: StartupMark): void {
  marks.mark(name)
  if (marks.isComplete()) printLine()
}

/** One subsystem hook's duration, for the record. */
export function noteStartupHook (name: string, phase: 'beforeReady' | 'afterReady', ms: number): void {
  marks.hook({ name, phase, ms })
}

export function describeStartup (facts: StartupFacts): void {
  marks.setFacts(facts)
}

/** Prints the line after the cap if the first tab has not loaded by then: a start that never completes is the one to measure. Never keeps the process alive. */
export function printStartupLineAtCap (): void {
  setTimeout(printLine, LINE_CAP_MS).unref()
}

/** The record as it stands, late marks included: what a problem report carries. */
export function startupRecord (): StartupRecord {
  return marks.record()
}
