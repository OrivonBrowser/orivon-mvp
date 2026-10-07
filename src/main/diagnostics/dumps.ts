// Native crash dumps (minidumps) Crashpad leaves on this computer: which belongs to which crash record, which
// are old enough to delete, and which fit in a report. Nothing here uploads anything: `crashReporter` runs with
// uploads off, and a dump leaves only when the person ticks the box on a report. Pure; dump-files.ts reads the disk.

import { stampMs } from './crash-records.js'
import type { CrashRecord, RunMarker } from './crash-records.js'

export interface DumpFile {
  readonly path: string
  /** When the file was written, milliseconds since the epoch: the moment of the crash, give or take the handler's own time. */
  readonly mtimeMs: number
  readonly bytes: number
}

export const DUMP_MATCH_MS = 60_000
export const DUMPS_KEPT = 10
export const DUMP_MAX_AGE_MS = 30 * 24 * 3600 * 1000
/** What a report may carry: the server refuses more. */
export const DUMP_MAX_BYTES = 5 * 1024 * 1024

/** The dump written within a minute of `crashAtMs`, the closest one when several are. None written before `notBeforeMs` counts, which keeps an earlier run's dump from being taken for this one's. */
export function dumpFor (crashAtMs: number, dumps: readonly DumpFile[], notBeforeMs = Number.NEGATIVE_INFINITY): DumpFile | undefined {
  let best: DumpFile | undefined
  for (const dump of dumps) {
    if (dump.mtimeMs < notBeforeMs) continue
    const distance = Math.abs(dump.mtimeMs - crashAtMs)
    if (distance > DUMP_MATCH_MS) continue
    if (best === undefined || distance < Math.abs(best.mtimeMs - crashAtMs)) best = dump
  }
  return best
}

/** When the newest dump this run wrote and no other record of the run owns, which is the one a run that ended without an orderly quit may call its own. */
export function uncleanExitDump (marker: RunMarker, records: readonly CrashRecord[], dumps: readonly DumpFile[]): number | undefined {
  const owned = records.filter((record) => record.sessionId === marker.sessionId && record.kind !== 'unclean-exit').map((record) => stampMs(record.at))
  let newest: number | undefined
  for (const dump of dumps) {
    if (dump.mtimeMs < marker.startedAt || owned.some((at) => Math.abs(dump.mtimeMs - at) <= DUMP_MATCH_MS)) continue
    if (newest === undefined || dump.mtimeMs > newest) newest = dump.mtimeMs
  }
  return newest
}

/** Whether a report may carry this dump. An empty file or one over the limit cannot be sent. */
export function dumpFits (dump: DumpFile): boolean {
  return dump.bytes >= 1 && dump.bytes <= DUMP_MAX_BYTES
}

/** The dumps to delete: any older than 30 days, and all but the newest 10 of the rest. */
export function dumpsToDelete (dumps: readonly DumpFile[], nowMs: number): DumpFile[] {
  const byAge = [...dumps].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return byAge.filter((dump, index) => index >= DUMPS_KEPT || nowMs - dump.mtimeMs > DUMP_MAX_AGE_MS)
}
