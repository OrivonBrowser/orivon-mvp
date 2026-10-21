// The body of a bug report, built in main and never by the page: what the preview shows is this object, and
// what is sent is the same object. Every field is cut to the length the server accepts (a report never goes
// over a limit and is refused for it), and the person's home directory is replaced by `~` everywhere.
import type { CrashRecord } from './crash-records.js'
import { redactDeep, redactHome } from './redact.js'
import type { Diagnostics } from './diagnostics-facts.js'
import { LOG_LINE_LIMIT, LOG_RING_LINES } from './log-ring.js'

export const REPORT_SCHEMA = 1

/** What the server accepts. The page's form limits and the notice quote these. */
export const LIMITS = {
  description: 10_000,
  contact: 254,
  version: 32,
  process: 64,
  reason: 64,
  message: 2000,
  stack: 20_000,
  page: 2048,
  logLines: LOG_RING_LINES,
  logLine: LOG_LINE_LIMIT,
  diagnosticsBytes: 65_536,
  diagnosticsDepth: 8
} as const

export interface ReportCrash {
  readonly kind: CrashRecord['kind']
  readonly at: string
  readonly process: string
  readonly reason: string
  readonly exitCode: number | null
  readonly message: string
  readonly stack: string
}

export interface ReportPayload {
  readonly schema: 1
  readonly reportId: string
  readonly description: string
  readonly contact: string
  readonly version: string
  readonly crash: ReportCrash | null
  readonly diagnostics: Diagnostics | null
  readonly log: string[] | null
  readonly page: string | null
  readonly dump: { readonly base64: string, readonly bytes: number } | null
}

/** What the person chose on the form. */
export interface ReportChoices {
  readonly crashId: string | null
  readonly description: string
  readonly contact: string
  readonly diagnostics: boolean
  readonly log: boolean
  readonly page: boolean
  readonly dump: boolean
}

export interface ReportSources {
  readonly reportId: string
  readonly version: string
  readonly home: string
  readonly ignoreCase: boolean
  readonly choices: ReportChoices
  readonly crash: CrashRecord | undefined
  readonly diagnostics: Diagnostics
  readonly log: readonly string[]
  /** The dump that belongs to the crash, if one does and it fits: its size, and a way to read it that is called only when the dump is to go. */
  readonly dump: { readonly bytes: number, readonly base64: () => string } | undefined
}

export function cut (text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text
}

/** The version as the server accepts it: letters, digits and `. + -`, 1 to 32 of them. */
export function wireVersion (version: string): string {
  const clean = version.replace(/[^0-9A-Za-z.+-]/g, '')
  return cut(clean === '' ? '0' : clean, LIMITS.version)
}

function depthOf (value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  return 1 + Math.max(0, ...Object.values(value).map(depthOf))
}

/** The parts a report can lose, in the order they go when the block is over its size: the least useful first. */
const DROP_ORDER: ReadonlyArray<(d: Diagnostics) => Diagnostics> = [
  (d) => ({ ...d, recentCrashes: [] }),
  (d) => ({ ...d, processes: [] }),
  (d) => ({ ...d, browser: { ...d.browser, extensions: [] } }),
  (d) => ({ ...d, gpu: { ...d.gpu, features: {} } }),
  (d) => ({ ...d, displays: [] })
]

/** The diagnostics, made to fit the server's size and depth limits by dropping whole groups. */
export function fitDiagnostics (diagnostics: Diagnostics): Diagnostics {
  let fitted = diagnostics
  for (const drop of DROP_ORDER) {
    if (Buffer.byteLength(JSON.stringify(fitted)) <= LIMITS.diagnosticsBytes && depthOf(fitted) <= LIMITS.diagnosticsDepth) return fitted
    fitted = drop(fitted)
  }
  return fitted
}

function crashOf (record: CrashRecord, home: string, ignoreCase: boolean): ReportCrash {
  const text = (value: string, limit: number): string => cut(redactHome(value, home, ignoreCase), limit)
  return {
    kind: record.kind,
    at: record.at,
    process: text(record.process, LIMITS.process) || 'unknown',
    reason: text(record.reason, LIMITS.reason),
    exitCode: record.exitCode,
    message: text(record.message, LIMITS.message),
    stack: text(record.stack, LIMITS.stack)
  }
}

/** The report the person would send with these choices. The page address and the dump appear only when asked for, and only when the crash has them. */
export function buildPayload (sources: ReportSources): ReportPayload {
  const { choices, home, ignoreCase } = sources
  const crash = sources.crash === undefined ? undefined : crashOf(sources.crash, home, ignoreCase)
  const page = choices.page && sources.crash?.page !== undefined ? cut(redactHome(sources.crash.page, home, ignoreCase), LIMITS.page) : null
  return {
    schema: REPORT_SCHEMA,
    reportId: sources.reportId,
    description: cut(redactHome(choices.description.trim(), home, ignoreCase), LIMITS.description),
    contact: cut(choices.contact.trim(), LIMITS.contact),
    version: wireVersion(sources.version),
    crash: crash ?? null,
    diagnostics: choices.diagnostics ? fitDiagnostics(redactDeep(sources.diagnostics, home, ignoreCase)) : null,
    log: choices.log ? sources.log.slice(-LIMITS.logLines).map((line) => cut(redactHome(line, home, ignoreCase), LIMITS.logLine)) : null,
    page,
    dump: choices.dump && sources.dump !== undefined ? { base64: sources.dump.base64(), bytes: sources.dump.bytes } : null
  }
}

/** Whether the server would take this report: every field is already cut to its limit, so only the description can be missing. */
export function isSendable (payload: ReportPayload): boolean {
  return payload.description.length >= 1
}

/** The literal text of the report for the preview, with the dump shown as its size: its bytes are not text. */
export function previewText (payload: ReportPayload): string {
  const shown = payload.dump === null ? payload : { ...payload, dump: { base64: `<${payload.dump.bytes} bytes of binary>`, bytes: payload.dump.bytes } }
  return JSON.stringify(shown, null, 2)
}

/** The body that goes on the wire. */
export function wireBody (payload: ReportPayload): string {
  return JSON.stringify(payload)
}
