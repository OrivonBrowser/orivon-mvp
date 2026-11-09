// The record of which origins the carry has handled, in a file of the profile, so that a carry never runs twice for an
// origin. Pure except for the two functions that read and write the file.

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import type { CarryReport } from './report.js'

export const MARKER_FILE = 'carried-app-storage.json'
const VERSION = 1

/** How many starts one origin gets: a carry that could not reach a page is tried again, since a carry never overwrites what the website session holds. */
export const MAX_ATTEMPTS = 3

export interface CarryRow {
  /** `carried`: it ran to the end, whatever it left behind (the report names that). `failed`: it could not run, and `reason` says why. */
  readonly status: 'carried' | 'failed'
  readonly at: string
  readonly attempts: number
  readonly reason?: string
  readonly report?: CarryReport
}

/** The rows by origin, as the URL parser spells it. */
export type CarryMarker = Readonly<Record<string, CarryRow>>

export function parseMarker (text: string): CarryMarker {
  try {
    const parsed = JSON.parse(text) as { version?: unknown, origins?: unknown }
    if (parsed.version !== VERSION || typeof parsed.origins !== 'object' || parsed.origins === null) return {}
    const rows: Record<string, CarryRow> = {}
    for (const [origin, row] of Object.entries(parsed.origins)) {
      const candidate = row as Partial<CarryRow> | null
      if (candidate === null || typeof candidate !== 'object') continue
      if ((candidate.status !== 'carried' && candidate.status !== 'failed') || typeof candidate.at !== 'string' || typeof candidate.attempts !== 'number') continue
      rows[origin] = candidate as CarryRow
    }
    return rows
  } catch {
    // A file that cannot be read says nothing was recorded: carrying again is safe, since it never overwrites.
    return {}
  }
}

export function serializeMarker (marker: CarryMarker): string {
  return JSON.stringify({ version: VERSION, origins: marker }, null, 2)
}

/** Whether the carry still has to run for `origin`: it has no row, or its last tries could not reach a page and are not used up. */
export function needsCarry (marker: CarryMarker, origin: string): boolean {
  const row = marker[origin]
  return row === undefined || (row.status === 'failed' && row.attempts < MAX_ATTEMPTS)
}

/** `marker` with the outcome of one more try for `origin`. */
export function withOutcome (marker: CarryMarker, origin: string, outcome: { readonly status: 'carried' | 'failed', readonly reason?: string, readonly report: CarryReport }, now: Date): CarryMarker {
  const attempts = (marker[origin]?.attempts ?? 0) + 1
  const row: CarryRow = outcome.reason === undefined
    ? { status: outcome.status, at: now.toISOString(), attempts, report: outcome.report }
    : { status: outcome.status, at: now.toISOString(), attempts, reason: outcome.reason, report: outcome.report }
  return { ...marker, [origin]: row }
}

export function readMarker (path: string): CarryMarker {
  try {
    return parseMarker(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function writeMarker (path: string, marker: CarryMarker): void {
  writeFileAtomic(path, serializeMarker(marker))
}
