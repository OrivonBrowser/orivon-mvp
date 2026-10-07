// What the report page may ask of main: the form's facts, the literal text of the report, to send it, to copy
// it, to delete a sent one, and the crash tests. The page names the choices on its form; main builds the report
// from them, so what the preview shows is what the server receives, to the byte. The facts and the log are
// taken once when the page asks for its state and kept for that page, because they change from one second to the
// next and a preview that differed from the send would not be the report.
import type { WebContents } from 'electron'
import { dumpFits } from './dumps.js'
import type { DumpFile } from './dumps.js'
import { newest } from './crash-records.js'
import type { CrashRecord } from './crash-records.js'
import type { Diagnostics } from './diagnostics-facts.js'
import type { LogSource } from './diagnostics-service.js'
import { eraseReport, FAILURE_TEXT, sendReport } from './report-channel.js'
import type { Post } from './report-channel.js'
import { buildPayload, cut, isSendable, LIMITS, previewText, wireBody } from './report-payload.js'
import type { ReportChoices, ReportPayload } from './report-payload.js'
import { reportMarkdown } from './report-text.js'
import { summaryOf } from './sent-reports.js'
import type { SentReport } from './sent-reports.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import { stamp } from './crash-records.js'

export type TestKind = 'renderer' | 'main-error' | 'main-native'

/** The part of the diagnostics service the page needs. */
export interface CrashSource {
  crashes: () => readonly CrashRecord[]
  crash: (id: string) => CrashRecord | undefined
  dumpOf: (record: CrashRecord) => DumpFile | undefined
  markReported: (crashId: string, reportId: string | undefined) => void
}

export interface SentSource {
  all: () => SentReport[]
  add: (entry: SentReport) => void
  remove: (reportId: string) => void
}

export interface ReportDeps {
  readonly isPrivate: boolean
  readonly version: string
  readonly home: string
  readonly ignoreCase: boolean
  readonly crashes: CrashSource
  readonly sent: SentSource
  /** The facts about this computer and this build, read now. */
  readonly diagnostics: () => Promise<Diagnostics>
  /** Whose log a report about `crash` carries (this run's when there is no crash). */
  readonly logSource: (crash: CrashRecord | undefined) => LogSource
  readonly logLines: (source: LogSource) => string[]
  readonly readDump: (dump: DumpFile) => string
  /** 32 lowercase hex characters, random. */
  readonly newReportId: () => string
  readonly post: Post
  readonly base: () => string
  readonly now: () => number
  readonly copy: (text: string) => void
  readonly openNotice: (page: WebContents) => void
  readonly runTest: (kind: TestKind, page: WebContents) => void
}

interface Snapshot {
  readonly diagnostics: Diagnostics
  /** The log lines of each source asked for so far, each read once: several crashes of one run share one. */
  readonly logs: Map<LogSource, string[]>
}

/** The report ID a page will use: one per report, kept across a failed send of the same text so the server counts the retry once, and replaced when the text changed. */
interface Pending {
  snapshot: Promise<Snapshot> | undefined
  fresh: string | undefined
  failed: { readonly fingerprint: string, readonly reportId: string } | undefined
}

/** How many report pages are remembered at once. */
const OPEN_FORMS = 4

const TESTS: readonly string[] = ['renderer', 'main-error', 'main-native']

function asChoices (value: unknown, crashes: CrashSource): ReportChoices {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const crashId = typeof raw['crashId'] === 'string' && crashes.crash(raw['crashId']) !== undefined ? raw['crashId'] : null
  const text = (key: string, limit: number): string => typeof raw[key] === 'string' ? cut(raw[key], limit) : ''
  return {
    crashId,
    description: text('description', LIMITS.description * 2),
    contact: text('contact', LIMITS.contact * 2),
    diagnostics: raw['diagnostics'] === true,
    log: raw['log'] === true,
    page: raw['page'] === true,
    dump: raw['dump'] === true
  }
}

function crashRow (record: CrashRecord, dump: DumpFile | undefined): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    at: record.at,
    process: record.process,
    reason: record.reason,
    hasPage: record.page !== undefined,
    dumpBytes: dump !== undefined && dumpFits(dump) ? dump.bytes : null,
    reported: record.reportedAs !== undefined
  }
}

export function reportDomain (deps: ReportDeps): InternalDomain {
  const pending = new Map<number, Pending>()
  const pendingFor = (contentsId: number): Pending => {
    const entry = pending.get(contentsId) ?? { snapshot: undefined, fresh: undefined, failed: undefined }
    // Moved to the newest end on every use: a page being used is never the one dropped for a newer one.
    pending.delete(contentsId)
    pending.set(contentsId, entry)
    // Each holds up to a few megabytes of log; a page that was closed does not tell this, so only the latest few are kept.
    for (const [id] of [...pending].slice(0, Math.max(0, pending.size - OPEN_FORMS))) pending.delete(id)
    return entry
  }

  /** The promise itself is kept, so requests that arrive together share one reading of the facts. */
  function snapshotOf (entry: Pending): Promise<Snapshot> {
    const made = entry.snapshot ??= deps.diagnostics().then((diagnostics) => ({ diagnostics, logs: new Map<LogSource, string[]>() }))
    made.catch(() => { if (entry.snapshot === made) entry.snapshot = undefined })
    return made
  }

  /** The report for these choices, with the ID it would go under. Only a send reads the dump's bytes; `bytes` is what the body will measure either way. */
  async function build (entry: Pending, choices: ReportChoices, readingDump: boolean): Promise<{ payload: ReportPayload, fingerprint: string, bytes: number }> {
    const snapshot = await snapshotOf(entry)
    const crash = choices.crashId === null ? undefined : deps.crashes.crash(choices.crashId)
    const dump = crash === undefined ? undefined : deps.crashes.dumpOf(crash)
    const source = deps.logSource(crash)
    if (!snapshot.logs.has(source)) snapshot.logs.set(source, deps.logLines(source))
    const make = (reportId: string, readDump: (file: DumpFile) => string): ReportPayload => buildPayload({
      reportId,
      version: deps.version,
      home: deps.home,
      ignoreCase: deps.ignoreCase,
      choices,
      crash,
      diagnostics: snapshot.diagnostics,
      log: snapshot.logs.get(source) ?? [],
      dump: dump !== undefined && dumpFits(dump) ? { bytes: dump.bytes, base64: () => readDump(dump) } : undefined
    })
    // The fingerprint leaves out the dump's bytes: reading a few megabytes to compare two attempts is not needed, since the crash chosen and the box ticked say the same.
    const empty = make('', () => '')
    const fingerprint = wireBody(empty)
    entry.fresh ??= deps.newReportId()
    const reportId = entry.failed?.fingerprint === fingerprint ? entry.failed.reportId : entry.fresh
    const payload = readingDump ? make(reportId, deps.readDump) : make(reportId, () => '')
    // Base64 is four characters for every three bytes, and needs no escaping in JSON, so the body's size is known from the file's.
    const bytes = Buffer.byteLength(wireBody(payload)) + (readingDump || payload.dump === null ? 0 : 4 * Math.ceil(payload.dump.bytes / 3))
    return { payload, fingerprint, bytes }
  }

  return {
    pages: ['report'],
    handle: async (command, caller) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as Record<string, unknown>
      const contentsId = caller.contents.id
      const entry = pendingFor(contentsId)
      switch (request['type']) {
        case 'state': {
          entry.snapshot = undefined
          await snapshotOf(entry)
          return {
            private: deps.isPrivate,
            limits: { description: LIMITS.description, contact: LIMITS.contact },
            crashes: newest(deps.crashes.crashes(), 20).map((record) => crashRow(record, deps.crashes.dumpOf(record))),
            sent: deps.sent.all()
          }
        }
        case 'preview': {
          const { payload, bytes } = await build(entry, asChoices(request['choices'], deps.crashes), false)
          return { text: previewText(payload), sendable: isSendable(payload), bytes }
        }
        case 'send': {
          const choices = asChoices(request['choices'], deps.crashes)
          const { payload, fingerprint } = await build(entry, choices, true)
          if (!isSendable(payload)) return { ok: false, why: 'empty', text: 'Say what happened before you send.' }
          const outcome = await sendReport(deps.post, deps.base(), payload)
          if (!outcome.ok) {
            entry.failed = { fingerprint, reportId: payload.reportId }
            entry.fresh = undefined
            return { ok: false, why: outcome.why, text: FAILURE_TEXT[outcome.why] }
          }
          deps.sent.add({ reportId: payload.reportId, at: stamp(deps.now()), ...(choices.crashId === null ? {} : { crashId: choices.crashId }), summary: summaryOf(payload.description) })
          if (choices.crashId !== null) deps.crashes.markReported(choices.crashId, payload.reportId)
          entry.failed = undefined
          entry.fresh = undefined
          entry.snapshot = undefined
          return { ok: true, reportId: payload.reportId, sent: deps.sent.all() }
        }
        case 'erase': {
          const reportId = request['reportId']
          if (typeof reportId !== 'string' || !/^[0-9a-f]{32}$/.test(reportId)) return { ok: false }
          if (!await eraseReport(deps.post, deps.base(), reportId)) return { ok: false, text: FAILURE_TEXT.offline }
          const gone = deps.sent.all().find((sent) => sent.reportId === reportId)
          deps.sent.remove(reportId)
          if (gone?.crashId !== undefined) deps.crashes.markReported(gone.crashId, undefined)
          return { ok: true, sent: deps.sent.all() }
        }
        case 'copy': {
          const { payload } = await build(entry, asChoices(request['choices'], deps.crashes), false)
          if (!isSendable(payload)) return { ok: false }
          deps.copy(reportMarkdown(payload))
          return { ok: true }
        }
        case 'copyId': {
          const known = deps.sent.all().some((sent) => sent.reportId === request['reportId'])
          if (!known || typeof request['reportId'] !== 'string') return { ok: false }
          deps.copy(request['reportId'])
          return { ok: true }
        }
        case 'test': {
          const kind = request['kind']
          if (typeof kind !== 'string' || !TESTS.includes(kind)) return undefined
          deps.runTest(kind as TestKind, caller.contents)
          return { ok: true }
        }
        case 'notice':
          deps.openNotice(caller.contents)
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
