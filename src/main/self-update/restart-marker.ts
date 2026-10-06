// The one-shot note an update leaves for the browser that starts after it: bring the windows and tabs back, whatever
// the start-up setting says. Written just before the restart and removed by the next start, whether or not it is used.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'restore-after-update'
/** An installer may take a while before it starts the new copy; a note older than this belongs to an install that never finished. */
export const MARKER_MAX_AGE_MS = 15 * 60_000

export function writeRestartMarker (dir: string, now: number = Date.now()): void {
  writeFileSync(join(dir, FILE), String(now), 'utf8')
}

export function clearRestartMarker (dir: string): void {
  rmSync(join(dir, FILE), { force: true })
}

/** Whether this start follows an update, removing the note either way. */
export function takeRestartMarker (dir: string, now: number = Date.now()): boolean {
  let written: number
  try {
    written = Number(readFileSync(join(dir, FILE), 'utf8').trim())
  } catch {
    return false
  }
  clearRestartMarker(dir)
  return Number.isFinite(written) && written <= now && now - written <= MARKER_MAX_AGE_MS
}
