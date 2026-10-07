// The browser's own record of its health, for one run: the log, the crash records, the marker that says whether
// the run ended in an orderly quit, and the native dumps. Composed from the pure modules beside it and given its
// environment (clock, randomness, folders) as arguments, so a start, a fatal error and an unclean exit are all
// tested without Electron; diagnostics-runner.ts is what connects it to the process.
import { errorFacts, idFromBytes, lastRunCrash, stamp, uncleanExitRecord } from './crash-records.js'
import type { CrashKind, CrashRecord } from './crash-records.js'
import { CrashStore, RunMarkerFile } from './crash-store.js'
import { listDumps, pruneDumps } from './dump-files.js'
import { dumpFor } from './dumps.js'
import { LogFile, readLogTail } from './log-file.js'
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
  private previousSessionId: string | undefined
  private fatal: CrashRecord | undefined

  constructor (private readonly env: ServiceEnv) {
    this.sessionId = idFromBytes(env.randomBytes(8))
    this.logFile = new LogFile(`${env.dir}/logs`)
    this.store = new CrashStore(env.dir, env.now())
    this.marker = new RunMarkerFile(env.dir)
  }

  /** The line sink for the console wrapper. */
  log (level: LogLevel, text: string): void {
    this.logFile.append(this.ring.push(level, text, new Date(this.env.now())))
  }

  /** The log a report about `record` carries: the previous run's own file when the crash was that run's, since this run's has only begun; this run's otherwise. */
  logLines (record?: CrashRecord): string[] {
    if (record !== undefined && record.sessionId === this.previousSessionId) return readLogTail(`${this.env.dir}/logs/previous.log`, LOG_RING_LINES)
    return this.ring.lines()
  }

  /** Reads what the last run left, records an unclean exit, marks this run as running and clears old dumps. */
  begin (): void {
    const now = this.env.now()
    const previous = this.marker.read()
    const dumps = previous === undefined ? [] : listDumps(this.env.crashDumpsDir).filter((dump) => dump.mtimeMs >= previous.startedAt)
    const newestDump = dumps.reduce<number | undefined>((best, dump) => best === undefined || dump.mtimeMs > best ? dump.mtimeMs : best, undefined)
    const unclean = uncleanExitRecord(previous, this.store.list(), idFromBytes(this.env.randomBytes(8)), newestDump)
    if (unclean !== undefined) this.store.add(unclean, now)
    this.previousSessionId = previous?.sessionId
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

  /** The dump written within a minute of this crash, when Crashpad left one. */
  dumpOf (record: CrashRecord): ReturnType<typeof dumpFor> {
    return dumpFor(Date.parse(record.at), listDumps(this.env.crashDumpsDir))
  }
}
