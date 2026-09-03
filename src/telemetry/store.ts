// Disk persistence for telemetry state -- the piece accounting.ts,
// disclosure.ts, transport.ts and history.ts deliberately have none of
// (see each of their own module comments: "no I/O", "this module makes no
// electron import"). Shaped after src/main/bookmarks.ts's own idiom:
// tolerant read on load, in-memory truth the rest of the app reads
// synchronously, explicit writes.
//
// ONE DIVERGENCE FROM bookmarks.ts, DELIBERATE: BookmarkStore debounces
// every write, because a user can star/unstar rapidly and each click is
// independently worth persisting soon. Accounting state changes
// continuously as time passes, not in discrete user actions -- debouncing
// it would just mean "write shortly after every processed event", which
// is exactly the write-on-every-tick I/O pattern the checkpoint design
// (accounting.ts's own module comment) exists to avoid. So accounting/
// history writes here are explicit (checkpoint()), while country/consent
// -- genuine discrete user decisions, and ones that must not be lost to a
// crash right after the click -- persist immediately, same as
// BookmarkStore's add()/remove().
//
// STORAGE TIER: ADR-0003's "Browser state" row (bookmarks.json's own
// entry) -- plain JSON under <userData>, no safeStorage. A random install
// UUID and a self-declared country are not secrets the way the identity
// seed is.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initialState, type AccountingState } from './accounting.js'
import { initialConsentState, type ConsentState } from './disclosure.js'
import { initialHistoryState, type HistoryState } from './history.js'

export interface TelemetryDisk {
  readonly installId: string
  /** '' until the first-run disclosure screen (a future, separate UI)
   *  sets it -- see README's "self-declared" note in ADR-0004. */
  readonly country: string
  readonly consent: ConsentState
  readonly accounting: AccountingState
  readonly history: HistoryState
}

const KNOWN_CONSENT_STATES: readonly ConsentState[] = ['undecided', 'accepted', 'declined']

function freshDisk (generateInstallId: () => string): TelemetryDisk {
  return {
    installId: generateInstallId(),
    country: '',
    consent: initialConsentState,
    accounting: initialState,
    history: initialHistoryState
  }
}

/**
 * Validates only shape (object? array? typeof?), not every leaf number.
 * Unlike bookmarks.ts's stored URLs -- which are re-validated field by
 * field because a bad one is a stored-XSS vector in a privileged view --
 * a malformed accounting number here cannot execute anything. The worst
 * a corrupt file can do is misreport this one install's own telemetry, so
 * falling back to the well-typed default WHOLESALE on any doubt is
 * proportionate, and matches what bookmarks.ts and update-check-runner.ts
 * both already do on their own corrupt-file path.
 */
function parseAccountingState (raw: unknown): AccountingState {
  if (typeof raw !== 'object' || raw === null) return initialState
  const obj = raw as Record<string, unknown>
  if (typeof obj.perApp !== 'object' || obj.perApp === null) return initialState
  if (typeof obj.openSessions !== 'object' || obj.openSessions === null) return initialState
  if (obj.suspended !== true && obj.suspended !== false) return initialState

  return {
    perApp: obj.perApp as AccountingState['perApp'],
    openSessions: obj.openSessions as AccountingState['openSessions'],
    focusedApp: typeof obj.focusedApp === 'string' ? obj.focusedApp : undefined,
    lastInteractionAt: typeof obj.lastInteractionAt === 'number' ? obj.lastInteractionAt : undefined,
    suspended: obj.suspended,
    lastAccountedAt: typeof obj.lastAccountedAt === 'number' ? obj.lastAccountedAt : undefined
  }
}

function parseHistoryState (raw: unknown): HistoryState {
  if (typeof raw !== 'object' || raw === null) return initialHistoryState
  const entries = (raw as Record<string, unknown>).entries
  if (!Array.isArray(entries)) return initialHistoryState
  return { entries: entries as HistoryState['entries'] }
}

/**
 * Parses the on-disk JSON, falling back to a fresh default (with a newly
 * generated installId) for anything malformed -- a corrupt telemetry file
 * must never stop the browser from starting, same policy as
 * parseBookmarksFile. `generateInstallId` is injected so a test can pin
 * the value; the real caller passes `() => randomUUID()`.
 */
export function parseTelemetryFile (raw: string, generateInstallId: () => string): TelemetryDisk {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return freshDisk(generateInstallId)
  }
  if (typeof data !== 'object' || data === null) return freshDisk(generateInstallId)
  const obj = data as Record<string, unknown>

  const installId = typeof obj.installId === 'string' && obj.installId.length > 0
    ? obj.installId
    : generateInstallId()
  const country = typeof obj.country === 'string' ? obj.country : ''
  const consent = KNOWN_CONSENT_STATES.includes(obj.consent as ConsentState)
    ? (obj.consent as ConsentState)
    : initialConsentState

  return {
    installId,
    country,
    consent,
    accounting: parseAccountingState(obj.accounting),
    history: parseHistoryState(obj.history)
  }
}

export function serializeTelemetryFile (disk: TelemetryDisk): string {
  return JSON.stringify(disk, null, 2)
}

export class TelemetryStore {
  private disk: TelemetryDisk

  constructor (
    private readonly filePath: string,
    private readonly generateInstallId: () => string = randomUUID
  ) {
    // Overwritten by load(); a value must exist before load() resolves so
    // a caller that reads a getter before awaiting load() fails loudly
    // (undefined installId) rather than silently, but nothing here
    // depends on this placeholder being seen.
    this.disk = freshDisk(generateInstallId)
  }

  /**
   * Reads the file once at startup. Missing (first launch) or corrupt both
   * yield fresh defaults -- see parseTelemetryFile. A freshly generated
   * installId is persisted immediately, before load() resolves: losing it
   * to a crash between "generated" and "first checkpoint" would mint a
   * second anonymous identity for the same real install on next launch,
   * which is exactly the kind of drift ADR-0004's monthly-aggregate design
   * depends on not happening.
   */
  async load (): Promise<void> {
    let raw: string | null
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      raw = null
    }

    const hadFile = raw !== null
    this.disk = raw === null ? freshDisk(this.generateInstallId) : parseTelemetryFile(raw, this.generateInstallId)

    if (!hadFile) await this.writeNow()
  }

  getInstallId (): string { return this.disk.installId }
  getCountry (): string { return this.disk.country }
  getConsentState (): ConsentState { return this.disk.consent }
  getAccountingState (): AccountingState { return this.disk.accounting }
  getHistoryState (): HistoryState { return this.disk.history }

  async setCountry (country: string): Promise<void> {
    this.disk = { ...this.disk, country }
    await this.writeNow()
  }

  /** Persists immediately -- see the file header for why consent gets no
   *  checkpoint delay the way accounting/history do. */
  async setConsentState (consent: ConsentState): Promise<void> {
    this.disk = { ...this.disk, consent }
    await this.writeNow()
  }

  /** In-memory only. Call checkpoint() to persist -- see the file header. */
  setAccountingState (accounting: AccountingState): void {
    this.disk = { ...this.disk, accounting }
  }

  /** In-memory only. Call checkpoint() to persist -- see the file header. */
  setHistoryState (history: HistoryState): void {
    this.disk = { ...this.disk, history }
  }

  /** Persists everything together. The caller decides the cadence
   *  (runner.ts's periodic timer, plus quit/suspend) -- this class has no
   *  timer of its own. */
  async checkpoint (): Promise<void> {
    await this.writeNow()
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, serializeTelemetryFile(this.disk), 'utf8')
    } catch (error) {
      // Loud, never silent -- same policy bookmarks.ts applies. Losing a
      // write costs at most one checkpoint interval of activeSec; hiding
      // the failure would let that keep happening unnoticed.
      console.error('[orivon] failed to persist telemetry state:', error)
    }
  }
}
