// The reports this computer has sent, newest 20: enough to delete one from the server later. The report itself
// is not kept, only its ID, when it was sent, which crash it was about, and a line saying what it said.
import { readFileOr, writeFileAtomic } from './crash-store.js'
import { join } from 'node:path'

export interface SentReport {
  readonly reportId: string
  /** `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly at: string
  readonly crashId?: string
  /** The first line of what the person wrote, cut short. */
  readonly summary: string
}

export const MAX_SENT = 20
export const SUMMARY_LIMIT = 120

export function summaryOf (description: string): string {
  const line = description.trim().split('\n')[0] ?? ''
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line
}

function isSent (value: unknown): value is SentReport {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry['reportId'] === 'string' && /^[0-9a-f]{32}$/.test(entry['reportId']) && typeof entry['at'] === 'string' && typeof entry['summary'] === 'string' && (entry['crashId'] === undefined || typeof entry['crashId'] === 'string')
}

export function parseSent (text: string): SentReport[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter(isSent).slice(-MAX_SENT) : []
  } catch {
    return []
  }
}

/** A retry of the same report ID replaces its entry rather than listing it twice. */
export function withSent (list: readonly SentReport[], entry: SentReport): SentReport[] {
  return [...list.filter((sent) => sent.reportId !== entry.reportId), entry].slice(-MAX_SENT)
}

export class SentStore {
  private list: SentReport[]
  private readonly path: string

  constructor (dir: string) {
    this.path = join(dir, 'sent-reports.json')
    this.list = parseSent(readFileOr(this.path) ?? '')
  }

  /** Newest first. */
  all (): SentReport[] {
    return [...this.list].reverse()
  }

  add (entry: SentReport): void {
    this.list = withSent(this.list, entry)
    this.save()
  }

  remove (reportId: string): void {
    this.list = this.list.filter((entry) => entry.reportId !== reportId)
    this.save()
  }

  private save (): void {
    try {
      writeFileAtomic(this.path, JSON.stringify(this.list))
    } catch {
      // The list is a convenience; a full disk must not fail the send that just succeeded.
    }
  }
}
