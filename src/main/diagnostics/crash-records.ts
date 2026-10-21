// What the browser knows about its own crashes: the record kept for each one, and the rules for which survive.
// Pure: reading and writing the file is crash-store.ts's, and the clock and the randomness come in as arguments.

export type CrashKind = 'main-error' | 'renderer' | 'child-process' | 'unclean-exit'

export interface CrashRecord {
  /** 16 lowercase hex characters. */
  readonly id: string
  /** The run that crashed: one value per start of the browser. */
  readonly sessionId: string
  readonly kind: CrashKind
  /** `YYYY-MM-DDTHH:MM:SSZ`, UTC. */
  readonly at: string
  readonly process: string
  readonly reason: string
  readonly exitCode: number | null
  readonly message: string
  readonly stack: string
  /** The crashed tab's address. Never stored in a private session. */
  readonly page?: string
  /** The page's own id in this run, which the sad-tab card uses to find its record. */
  readonly webContentsId?: number
  /** The report ID once the person has sent a report about this crash. */
  readonly reportedAs?: string
}

export const MAX_RECORDS = 30
export const RECORD_MAX_AGE_MS = 30 * 24 * 3600 * 1000

const KINDS: readonly CrashKind[] = ['main-error', 'renderer', 'child-process', 'unclean-exit']
const HEX16 = /^[0-9a-f]{16}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** `YYYY-MM-DDTHH:MM:SSZ`: the one time format a record and a report carry. */
export function stamp (ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

export function stampMs (value: string): number {
  return Date.parse(value)
}

/** Sixteen hex characters from eight random bytes, which the caller supplies. */
export function idFromBytes (bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What an error object says, as text: a thrown string or a rejection with no stack still gives a message. */
export function errorFacts (error: unknown): { message: string, stack: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack ?? '' }
  if (typeof error === 'string') return { message: error, stack: '' }
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: '' }
  } catch {
    return { message: String(error), stack: '' }
  }
}

function isRecord (value: unknown): value is CrashRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && HEX16.test(record['id']) &&
    typeof record['sessionId'] === 'string' &&
    KINDS.includes(record['kind'] as CrashKind) &&
    typeof record['at'] === 'string' && STAMP.test(record['at']) &&
    typeof record['process'] === 'string' && typeof record['reason'] === 'string' &&
    (record['exitCode'] === null || typeof record['exitCode'] === 'number') &&
    typeof record['message'] === 'string' && typeof record['stack'] === 'string' &&
    (record['page'] === undefined || typeof record['page'] === 'string') &&
    (record['webContentsId'] === undefined || typeof record['webContentsId'] === 'number') &&
    (record['reportedAs'] === undefined || typeof record['reportedAs'] === 'string')
}

/** The records in a `crashes.json`; whatever is unreadable, or shaped wrongly, is dropped rather than trusted. */
export function parseRecords (text: string): CrashRecord[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

/** Without the records older than 30 days, and without all but the newest 30. Oldest first, as kept. */
export function pruneRecords (records: readonly CrashRecord[], nowMs: number): CrashRecord[] {
  const fresh = records.filter((record) => nowMs - stampMs(record.at) <= RECORD_MAX_AGE_MS)
  return fresh.slice(Math.max(0, fresh.length - MAX_RECORDS))
}

/** The newest `count`, newest first. */
export function newest (records: readonly CrashRecord[], count: number): CrashRecord[] {
  return [...records].sort((a, b) => stampMs(b.at) - stampMs(a.at)).slice(0, count)
}

export function withRecord (records: readonly CrashRecord[], record: CrashRecord, nowMs: number): CrashRecord[] {
  return pruneRecords([...records.filter((entry) => entry.id !== record.id), record], nowMs)
}

export function withReported (records: readonly CrashRecord[], id: string, reportId: string | undefined): CrashRecord[] {
  return records.map((record) => {
    if (record.id !== id) return record
    const { reportedAs: _dropped, ...rest } = record
    return reportId === undefined ? rest : { ...rest, reportedAs: reportId }
  })
}

/** The run marker: written at start, removed at an orderly quit. One left behind says that run did not end in one. */
export interface RunMarker {
  readonly sessionId: string
  readonly pid: number
  /** Milliseconds since the epoch. */
  readonly startedAt: number
}

export function parseMarker (text: string): RunMarker | undefined {
  try {
    const value = JSON.parse(text) as Partial<RunMarker> | null
    if (typeof value !== 'object' || value === null) return undefined
    const { sessionId, pid, startedAt } = value
    return typeof sessionId === 'string' && sessionId !== '' && typeof pid === 'number' && typeof startedAt === 'number' ? { sessionId, pid, startedAt } : undefined
  } catch {
    return undefined
  }
}

/** The record for a previous run that did not end in an orderly quit, or undefined when there is nothing to record: no marker, or that run already left a fatal record of its own. `at` is when the run began, unless a native crash dump of that run says better. */
export function uncleanExitRecord (marker: RunMarker | undefined, records: readonly CrashRecord[], id: string, dumpAtMs: number | undefined): CrashRecord | undefined {
  if (marker === undefined) return undefined
  if (records.some((record) => record.sessionId === marker.sessionId && record.kind === 'main-error')) return undefined
  return {
    id,
    sessionId: marker.sessionId,
    kind: 'unclean-exit',
    at: stamp(dumpAtMs ?? marker.startedAt),
    process: 'main',
    reason: dumpAtMs === undefined ? 'abnormal-exit' : 'crashed',
    exitCode: null,
    message: dumpAtMs === undefined ? 'The previous run ended without an orderly quit.' : 'The previous run ended in a native crash.',
    stack: ''
  }
}

/** The crash of the run just before this one that the person may still report: a fatal error or an unclean exit not yet sent. */
export function lastRunCrash (records: readonly CrashRecord[], previousSessionId: string | undefined): CrashRecord | undefined {
  if (previousSessionId === undefined) return undefined
  return newest(records.filter((record) => record.sessionId === previousSessionId && (record.kind === 'main-error' || record.kind === 'unclean-exit') && record.reportedAs === undefined), 1)[0]
}
