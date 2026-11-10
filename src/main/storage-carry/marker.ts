// The record of which origins the carry has handled, in a file of the profile, so that a carry that finished is not made
// again, and one that failed is made again only while it cannot have overwritten anything the person did afterwards. Pure
// except for the two functions that read and write the file.

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import type { CarryReport } from './report.js'

export const MARKER_FILE = 'carried-app-storage.json'
const VERSION = 1

/** How many starts one origin gets when its carry failed before any page of the app was let through. */
export const MAX_ATTEMPTS = 3

export interface CarryRow {
  /** `carried`: it ran to the end, whatever it left behind (the report names that). `failed`: it could not run, and `reason` says why. */
  readonly status: 'carried' | 'failed'
  readonly at: string
  readonly attempts: number
  readonly reason?: string
  readonly report?: CarryReport
  /** True once a page of the app was let through after the carry failed: the app may have written since, so a later carry would overwrite what the person did. */
  readonly final?: true
  /** True while the row is the one written when the carry began to write and no outcome has replaced it: if it is still there at the next start, the browser stopped in the middle of the carry. */
  readonly unfinished?: true
}

/** The rows by origin, as the URL parser spells it. */
export type CarryMarker = Readonly<Record<string, CarryRow>>

/** The rows `text` holds, or undefined when it is no record this version wrote: the carry then does nothing, since carrying again would replace what the website session has gathered since. */
export function parseMarker (text: string): CarryMarker | undefined {
  try {
    const parsed = JSON.parse(text) as { version?: unknown, origins?: unknown }
    if (parsed.version !== VERSION || typeof parsed.origins !== 'object' || parsed.origins === null || Array.isArray(parsed.origins)) return undefined
    const rows: Record<string, CarryRow> = {}
    for (const [origin, row] of Object.entries(parsed.origins)) {
      const candidate = row as Partial<CarryRow> | null
      if (candidate === null || typeof candidate !== 'object') continue
      if ((candidate.status !== 'carried' && candidate.status !== 'failed') || typeof candidate.at !== 'string' || typeof candidate.attempts !== 'number') continue
      rows[origin] = candidate as CarryRow
    }
    return rows
  } catch {
    return undefined
  }
}

export function serializeMarker (marker: CarryMarker): string {
  return JSON.stringify({ version: VERSION, origins: marker }, null, 2)
}

/**
 * Whether the carry still has to run for `origin`: it has no row, or it failed, no page of the app was let through since, and
 * its tries are not used up. A failed carry that released a page is final, because the app may have written in the website
 * session since and a carry replaces what that session holds.
 */
export function needsCarry (marker: CarryMarker, origin: string): boolean {
  const row = marker[origin]
  return row === undefined || (row.status === 'failed' && row.final !== true && row.attempts < MAX_ATTEMPTS)
}

/** `marker` with the failed row of `origin` marked final; any other row is unchanged. */
export function withFinal (marker: CarryMarker, origin: string): CarryMarker {
  const row = marker[origin]
  if (row === undefined || row.status !== 'failed' || row.final === true) return marker
  return { ...marker, [origin]: { ...row, final: true } }
}

/**
 * `marker` with a failed, unfinished row for `origin`, counting one try. It is written just before the carry first changes the
 * website session, so a carry that takes the browser down in the middle is counted and stops after `MAX_ATTEMPTS` starts;
 * one that stops before any write leaves no row and can be tried again. `withOutcome` replaces the row without counting it again.
 */
export function withWriteStarted (marker: CarryMarker, origin: string, now: Date): CarryMarker {
  const attempts = (marker[origin]?.attempts ?? 0) + 1
  const row: CarryRow = { status: 'failed', at: now.toISOString(), attempts, reason: 'the carry began to write and did not end: the browser stopped in the middle of it', unfinished: true }
  return { ...marker, [origin]: row }
}

/** `marker` with the outcome of one more try for `origin`: the try that `withWriteStarted` counted is not counted twice. */
export function withOutcome (marker: CarryMarker, origin: string, outcome: { readonly status: 'carried' | 'failed', readonly reason?: string, readonly report: CarryReport, readonly final?: boolean }, now: Date): CarryMarker {
  const prior = marker[origin]
  const attempts = prior?.unfinished === true ? prior.attempts : (prior?.attempts ?? 0) + 1
  const base = { status: outcome.status, at: now.toISOString(), attempts }
  const row: CarryRow = {
    ...base,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    report: outcome.report,
    ...(outcome.final === true && outcome.status === 'failed' ? { final: true as const } : {})
  }
  return { ...marker, [origin]: row }
}

/** The record in `path`: empty when there is no file yet, undefined when there is a file that cannot be read. */
export function readMarker (path: string): CarryMarker | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : undefined
  }
  return parseMarker(text)
}

export function writeMarker (path: string, marker: CarryMarker): void {
  writeFileAtomic(path, serializeMarker(marker))
}
