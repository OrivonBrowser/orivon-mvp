// The browser's own record of its health, for one run: the log, the crash records, the marker that says whether
// the run ended in an orderly quit, and the native dumps. Composed from the pure modules beside it and given its
// environment (clock, randomness, folders) as arguments, so a start, a fatal error and an unclean exit are all
// tested without Electron; diagnostics-runner.ts is what connects it to the process.
import { errorFacts, idFromBytes, lastRunCrash, stamp, uncleanExitRecord } from './crash-records.js'
import type { CrashKind, CrashRecord } from './crash-records.js'
import { CrashStore, RunMarkerFile } from './crash-store.js'
import { listDumps, pruneDumps } from './dump-files.js'
import { dumpFor, uncleanExitDump } from './dumps.js'
import { LogFile, logHeader, readLogTail, sessionOfLog } from './log-file.js'
import { LOG_RING_LINES, LogRing } from './log-ring.js'
import type { LogLevel } from './log-ring.js'
import { cut, LIMITS } from './report-payload.js'

export interface ServiceEnv {
  /** `<userData>/diagnostics`. */
  readonly dir: string
  /** Where Crashpad writes: `app.getPath('crashDumps')`. */
  readonly crashDumpsDir: string
  readonly isPrivate: boolean
  readonly now: () => number
  readonly randomBytes: (count: number) => Uint8Array
  readonly pid: number
}

/** Whose log a report about a crash carries: this run's (the ring), the previous run's file, or none that is still kept. */
export type LogSource = 'current' | 'previous' | 'none'

/** The one line a report carries in place of a log that is gone, so a reader knows it is not missing by mistake. */
export const LOG_GONE_LINE = '--- the log of that run is no longer kept ---'

export interface NewCrash {
  readonly kind: CrashKind
  readonly process: string
  readonly reason: string
  readonly exitCode: number | null
  readonly message: string
  readonly stack: string
  readonly page?: string
  readonly webContentsId?: number
}

export class DiagnosticsService {
  readonly sessionId: string
  private readonly ring = new LogRing()
  private readonly logFile: LogFile
  private readonly store: CrashStore
  private readonly marker: RunMarkerFile
  private previousCrashId: string | undefined
  private previousLogSession: string | undefined
  private fatal: CrashRecord | undefined

  constructor (private readonly env: ServiceEnv) {
    this.sessionId = idFromBytes(env.randomBytes(8))
    this.logFile = new LogFile(`${env.dir}/logs`, logHeader(this.sessionId))
    this.store = new CrashStore(env.dir, env.now())
    this.marker = new RunMarkerFile(env.dir)
  }

  /** The line sink for the console wrapper. */
  log (level: LogLevel, text: string): void {
    this.logFile.append(this.ring.push(level, text, new Date(this.env.now())))
  }

  /** Whose log a report about `record` carries. Only the previous run's file is kept beside this run's, and it says which run it is. */
  logSourceOf (record?: CrashRecord): LogSource {
    if (record === undefined || record.sessionId === this.sessionId) return 'current'
    return record.sessionId === this.previousLogSession ? 'previous' : 'none'
  }

  /** The lines of that log: the previous run's file keeps its header line, which says which run it is. */
  logLinesFrom (source: LogSource): string[] {
    if (source === 'current') return this.ring.lines()
    return source === 'previous' ? readLogTail(`${this.env.dir}/logs/previous.log`, LOG_RING_LINES) : [LOG_GONE_LINE]
  }

  logLines (record?: CrashRecord): string[] {
    return this.logLinesFrom(this.logSourceOf(record))
  }

  /** Reads what the last run left, records an unclean exit, marks this run as running and clears old dumps. */
  begin (): void {
    const now = this.env.now()
    const previous = this.marker.read()
    const dumpAt = previous === undefined ? undefined : uncleanExitDump(previous, this.store.list(), listDumps(this.env.crashDumpsDir))
    const unclean = uncleanExitRecord(previous, this.store.list(), idFromBytes(this.env.randomBytes(8)), dumpAt)
    if (unclean !== undefined) this.store.add(unclean, now)
    this.previousLogSession = sessionOfLog(`${this.env.dir}/logs/previous.log`)
    this.previousCrashId = lastRunCrash(this.store.list(), previous?.sessionId)?.id
    this.marker.write({ sessionId: this.sessionId, pid: this.env.pid, startedAt: now })
    pruneDumps(this.env.crashDumpsDir, now)
  }

  /** The crash of the previous run that is still worth offering a report for, when there is one. */
  lastRunCrash (): CrashRecord | undefined {
    return this.previousCrashId === undefined ? undefined : this.store.get(this.previousCrashId)
  }

  /** Writes the log's buffered lines now. */
  flush (): void {
    this.logFile.flush()
  }

  /** The browser is quitting in order: the next start finds no marker. */
  end (): void {
    this.logFile.flush()
    this.marker.clear()
  }

  /** Writes a crash record now, on disk before it returns. A private session keeps no page address. */
  record (crash: NewCrash): CrashRecord {
    const record: CrashRecord = {
      id: idFromBytes(this.env.randomBytes(8)),
      sessionId: this.sessionId,
      kind: crash.kind,
      at: stamp(this.env.now()),
      process: cut(crash.process, LIMITS.process) || 'unknown',
      reason: cut(crash.reason, LIMITS.reason),
      exitCode: crash.exitCode,
      message: cut(crash.message, LIMITS.message),
      stack: cut(crash.stack, LIMITS.stack),
      ...(crash.page === undefined || this.env.isPrivate ? {} : { page: cut(crash.page, LIMITS.page) }),
      ...(crash.webContentsId === undefined ? {} : { webContentsId: crash.webContentsId })
    }
    this.store.add(record, this.env.now())
    this.logFile.flush()
    return record
  }

  /** An error that ends the process. Written synchronously, because nothing runs after it; only the first of a run is kept. */
  recordFatal (reason: string, error: unknown): CrashRecord {
    // What throws while the process is already exiting is fallout of the first error, which is the one worth a report.
    if (this.fatal !== undefined) return this.fatal
    const { message, stack } = errorFacts(error)
    this.fatal = this.record({ kind: 'main-error', process: 'main', reason, exitCode: null, message, stack })
    return this.fatal
  }

  crashes (): readonly CrashRecord[] {
    return this.store.list()
  }

  crash (id: string): CrashRecord | undefined {
    return this.store.get(id)
  }

  /** The newest record of a page that died in this run, which the sad-tab card uses to open its report. */
  crashOfPage (webContentsId: number): CrashRecord | undefined {
    return [...this.store.list()].reverse().find((record) => record.sessionId === this.sessionId && record.webContentsId === webContentsId)
  }

  markReported (crashId: string, reportId: string | undefined): void {
    this.store.markReported(crashId, reportId)
  }

  /** The dump written within a minute of this crash, when Crashpad left one. A run that ended without one starts at its `at`, so nothing earlier is its. */
  dumpOf (record: CrashRecord): ReturnType<typeof dumpFor> {
    const at = Date.parse(record.at)
    return dumpFor(at, listDumps(this.env.crashDumpsDir), record.kind === 'unclean-exit' ? at : undefined)
  }
}
