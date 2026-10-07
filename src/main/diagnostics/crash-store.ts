// The files under `<userData>/diagnostics/` that hold crash facts: the crash records and the run marker.
// Every write is synchronous and atomic (a temporary file renamed into place), because a fatal error
// writes its record on the way out of the process, and a half-written file would lose the older ones too.
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { parseMarker, parseRecords, pruneRecords, withRecord, withReported } from './crash-records.js'
import type { CrashRecord, RunMarker } from './crash-records.js'

/** Writes `text` to `path` whole or not at all, making the folder first: the diagnostics folder may not exist yet. */
export function writeDiagnosticsFile (path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, text)
}

export function readFileOr (path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export class CrashStore {
  private records: CrashRecord[]
  private readonly path: string

  constructor (dir: string, nowMs: number) {
    this.path = join(dir, 'crashes.json')
    this.records = pruneRecords(parseRecords(readFileOr(this.path) ?? ''), nowMs)
  }

  list (): readonly CrashRecord[] {
    return this.records
  }

  get (id: string): CrashRecord | undefined {
    return this.records.find((record) => record.id === id)
  }

  /** Adds a record and writes the file before returning. */
  add (record: CrashRecord, nowMs: number): void {
    this.records = withRecord(this.records, record, nowMs)
    this.save()
  }

  markReported (id: string, reportId: string | undefined): void {
    this.records = withReported(this.records, id, reportId)
    this.save()
  }

  private save (): void {
    try {
      writeDiagnosticsFile(this.path, JSON.stringify(this.records))
    } catch {
      // The record stays in memory for this run; a full disk must not become a second failure.
    }
  }
}

export class RunMarkerFile {
  private readonly path: string

  constructor (dir: string) {
    this.path = join(dir, 'running.json')
  }

  read (): RunMarker | undefined {
    const text = readFileOr(this.path)
    return text === undefined ? undefined : parseMarker(text)
  }

  write (marker: RunMarker): void {
    try {
      writeDiagnosticsFile(this.path, JSON.stringify(marker))
    } catch {
      // Without it a crash goes unnoticed at the next start; nothing worse.
    }
  }

  clear (): void {
    rmSync(this.path, { force: true })
  }
}
