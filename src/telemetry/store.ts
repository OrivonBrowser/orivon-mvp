// Disk persistence for one profile's telemetry state: the counted time, the record of what was sent,
// each report's schedule and the random identifiers that belong to the profile alone. The consent
// and the install ID are not here: they are the same for every profile and live in system-store.ts.
// Shaped after src/main/bookmarks.ts's own idiom: tolerant read on load, in-memory truth the rest of
// the app reads synchronously, explicit writes. See README.md, Design notes, for why this file
// diverges from bookmarks.ts on debouncing.
//
// STORAGE TIER: ADR-0003's "Browser state" row, plain JSON under <userData>, no safeStorage: a random
// stream and counted seconds are not secrets the way the identity seed is.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { INTERNAL_SITE, initialState, type AccountingState, type Period } from './accounting.js'
import { initialHistoryState, type HistoryEntry, type HistoryState } from './history.js'
import { initialKindSchedule, type KindSchedule } from './schedule.js'
import type { PayloadKind } from './disclosure.js'

export interface SchedulesDisk {
  readonly usage: KindSchedule
  readonly sites: KindSchedule
}

export interface TelemetryDisk {
  /** Random, made once per profile: two profiles open at once both count, and the server sums them under the one install ID. */
  readonly stream: string
  readonly accounting: AccountingState
  readonly history: HistoryState
  readonly schedules: SchedulesDisk
  /** The random ID of each recent period's sites report: the same every time that period is sent, never tied to anything else. */
  readonly reportIds: Readonly<Record<Period, string>>
}

/** The layout of telemetry.json; a file without it predates consent and is not read for counting. */
const DISK_SCHEMA = 2

/** How many periods' report IDs are kept; an older month has been reported and is not needed again. */
const KEPT_REPORT_IDS = 3

export const randomHex32 = (): string => randomBytes(16).toString('hex')

function freshDisk (generateId: () => string): TelemetryDisk {
  return {
    stream: generateId(),
    accounting: initialState,
    history: initialHistoryState,
    schedules: { usage: initialKindSchedule, sites: initialKindSchedule },
    reportIds: {}
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates only shape (object? array? typeof?), not every leaf number: a malformed accounting number
 * cannot execute anything, and the worst a corrupt file can do is misreport this one profile's own
 * telemetry, so falling back to the well-typed default WHOLESALE on any doubt is proportionate.
 */
function parseAccountingState (raw: unknown): AccountingState {
  if (!isRecord(raw)) return initialState
  if (!isRecord(raw['perApp']) || !isRecord(raw['openSessions'])) return initialState
  if (raw['suspended'] !== true && raw['suspended'] !== false) return initialState

  return {
    perApp: raw['perApp'] as AccountingState['perApp'],
    perSite: isRecord(raw['perSite']) ? raw['perSite'] as AccountingState['perSite'] : {},
    currentSite: typeof raw['currentSite'] === 'string' ? raw['currentSite'] : INTERNAL_SITE,
    openSessions: raw['openSessions'] as AccountingState['openSessions'],
    focusedApp: typeof raw['focusedApp'] === 'string' ? raw['focusedApp'] : undefined,
    lastInteractionAt: typeof raw['lastInteractionAt'] === 'number' ? raw['lastInteractionAt'] : undefined,
    suspended: raw['suspended'],
    lastAccountedAt: typeof raw['lastAccountedAt'] === 'number' ? raw['lastAccountedAt'] : undefined
  }
}

/** An entry made before reports had a schema carries no `schema` and is dropped: it describes a payload that no longer exists. */
function parseHistoryState (raw: unknown): HistoryState {
  if (!isRecord(raw) || !Array.isArray(raw['entries'])) return initialHistoryState
  const entries = raw['entries'].filter((entry): entry is HistoryEntry => isRecord(entry) && isRecord(entry['payload']) && entry['payload']['schema'] === 2 && typeof entry['sentAtMs'] === 'number')
  return { entries }
}

function parseKindSchedule (raw: unknown): KindSchedule {
  if (!isRecord(raw)) return initialKindSchedule
  return {
    offsetPeriod: typeof raw['offsetPeriod'] === 'string' ? raw['offsetPeriod'] : undefined,
    offsetMs: typeof raw['offsetMs'] === 'number' && Number.isFinite(raw['offsetMs']) ? raw['offsetMs'] : 0,
    lastSentAtMs: typeof raw['lastSentAtMs'] === 'number' ? raw['lastSentAtMs'] : undefined,
    closedPeriod: typeof raw['closedPeriod'] === 'string' ? raw['closedPeriod'] : undefined
  }
}

function parseReportIds (raw: unknown): Record<Period, string> {
  if (!isRecord(raw)) return {}
  const out: Record<Period, string> = {}
  for (const [period, id] of Object.entries(raw)) if (typeof id === 'string') out[period] = id
  return out
}

/**
 * Parses the on-disk JSON, falling back to a fresh default for anything malformed: a corrupt telemetry
 * file must never stop the browser from starting, same policy as parseBookmarksFile. `generateId` is
 * injected so a test can pin the value.
 */
export function parseTelemetryFile (raw: string, generateId: () => string): TelemetryDisk {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return freshDisk(generateId)
  }
  if (!isRecord(data)) return freshDisk(generateId)
  // A file written before this layout holds time counted before any consent: nothing of it is kept but the stream.
  if (data['schema'] !== DISK_SCHEMA) return { ...freshDisk(generateId), stream: typeof data['stream'] === 'string' && /^[0-9a-f]{32}$/.test(data['stream']) ? data['stream'] : generateId() }
  const schedules = isRecord(data['schedules']) ? data['schedules'] : {}
  const stream = typeof data['stream'] === 'string' && /^[0-9a-f]{32}$/.test(data['stream']) ? data['stream'] : generateId()
  return {
    stream,
    accounting: parseAccountingState(data['accounting']),
    history: parseHistoryState(data['history']),
    schedules: { usage: parseKindSchedule(schedules['usage']), sites: parseKindSchedule(schedules['sites']) },
    reportIds: parseReportIds(data['reportIds'])
  }
}

export function serializeTelemetryFile (disk: TelemetryDisk): string {
  return JSON.stringify({ schema: DISK_SCHEMA, ...disk }, null, 2)
}

export class TelemetryStore {
  private disk: TelemetryDisk

  constructor (
    private readonly filePath: string,
    private readonly generateId: () => string = randomHex32
  ) {
    this.disk = freshDisk(generateId)
  }

  /**
   * Reads the file once at startup. Missing (first launch) or corrupt both yield fresh defaults. A newly
   * made stream is persisted before load() resolves: losing it to a crash between "made" and the first
   * checkpoint would start a second stream for the same profile.
   */
  async load (): Promise<void> {
    let raw: string | null
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      raw = null
    }
    this.disk = raw === null ? freshDisk(this.generateId) : parseTelemetryFile(raw, this.generateId)
    if (raw === null) await this.writeNow()
  }

  getStream (): string { return this.disk.stream }
  getAccountingState (): AccountingState { return this.disk.accounting }
  getHistoryState (): HistoryState { return this.disk.history }
  getSchedule (kind: PayloadKind): KindSchedule { return this.disk.schedules[kind] }

  /** In-memory only. Call checkpoint() to persist. */
  setAccountingState (accounting: AccountingState): void {
    this.disk = { ...this.disk, accounting }
  }

  /** In-memory only. Call checkpoint() to persist. */
  setHistoryState (history: HistoryState): void {
    this.disk = { ...this.disk, history }
  }

  /** In-memory only. Call checkpoint() to persist. */
  setSchedule (kind: PayloadKind, schedule: KindSchedule): void {
    this.disk = { ...this.disk, schedules: { ...this.disk.schedules, [kind]: schedule } }
  }

  /** The sites report ID of `period`, made the first time it is asked and kept for the periods after. */
  reportIdFor (period: Period): string {
    const known = this.disk.reportIds[period]
    if (known !== undefined) return known
    const made = this.generateId()
    const kept = Object.keys(this.disk.reportIds).sort().slice(-(KEPT_REPORT_IDS - 1))
    const reportIds: Record<Period, string> = {}
    for (const key of kept) reportIds[key] = this.disk.reportIds[key] ?? ''
    reportIds[period] = made
    this.disk = { ...this.disk, reportIds }
    return made
  }

  /** Forgets everything counted and sent, keeping the stream: what "Delete my data" does on this computer. */
  async eraseMeasurements (): Promise<void> {
    this.disk = { ...freshDisk(this.generateId), stream: this.disk.stream }
    await this.writeNow()
  }

  /** Persists everything together. The caller decides the cadence: this class has no timer of its own. */
  async checkpoint (): Promise<void> {
    await this.writeNow()
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, serializeTelemetryFile(this.disk), 'utf8')
    } catch (error) {
      // Loud, never silent, as bookmarks.ts: losing a write costs at most one checkpoint interval of activeSec.
      console.error('[orivon] failed to persist telemetry state:', error)
    }
  }
}
