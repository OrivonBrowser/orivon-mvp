// The list of downloads, kept in <userData>/downloads.json. A private session keeps it in memory only, so
// nothing about its downloads reaches disk.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import type { DownloadEntry, DownloadReason, DownloadState } from './download-types.js'

const FILE_VERSION = 1
/** The most entries kept; past it the oldest are forgotten. Bounds the file against a browser used for years. */
export const MAX_ENTRIES = 1000

export interface DownloadStore {
  /** The stored list, newest first. Empty when there is none or it cannot be read. */
  read: () => DownloadEntry[]
  /** Replaces what is stored. May be batched. */
  write: (entries: readonly DownloadEntry[]) => void
  /** Resolves once the file reflects every write so far. */
  flush: () => Promise<void>
}

const STATES: readonly DownloadState[] = ['progressing', 'paused', 'held', 'completed', 'cancelled', 'interrupted']
const REASONS: readonly DownloadReason[] = ['network', 'server', 'disk', 'closed', 'flood']

const isString = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** One stored entry, or null when it is not one. Volatile fields (`missing`, `speed`) are never read back. */
function parseEntry (raw: unknown): DownloadEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  const { id, url, referrer, fileName, savePath, mime, total, received, state, reason, startedAt, endedAt, danger } = entry
  if (!isString(id) || id === '' || !isString(url) || !isString(referrer) || !isString(fileName) || !isString(savePath) || !isString(mime)) return null
  if (!isCount(total) || !isCount(received) || !isCount(startedAt) || typeof danger !== 'boolean') return null
  if (!STATES.includes(state as DownloadState)) return null
  return {
    id, url, referrer, fileName, savePath, mime, total, received, startedAt, danger,
    state: state as DownloadState,
    ...(REASONS.includes(reason as DownloadReason) ? { reason: reason as DownloadReason } : {}),
    ...(isCount(endedAt) ? { endedAt } : {}),
    ...(entry['held'] === true ? { held: true } : {})
  }
}

/** The entries a file holds: anything not in the file's shape is dropped, and a repeated id keeps its first. */
export function parseEntries (raw: unknown): DownloadEntry[] {
  if (typeof raw !== 'object' || raw === null || (raw as { version?: unknown }).version !== FILE_VERSION) return []
  const list = (raw as { entries?: unknown }).entries
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const entries: DownloadEntry[] = []
  for (const item of list) {
    const entry = parseEntry(item)
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
    if (entries.length >= MAX_ENTRIES) break
  }
  return entries
}

function persistable (entry: DownloadEntry): DownloadEntry {
  const { missing: _missing, speed: _speed, ...kept } = entry
  return kept
}

export class JsonDownloadStore implements DownloadStore {
  private pending: readonly DownloadEntry[] = []
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() })

  constructor (private readonly filePath: string) {}

  read (): DownloadEntry[] {
    try {
      return parseEntries(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] downloads file unreadable, starting with an empty list:', error)
      return []
    }
  }

  write (entries: readonly DownloadEntry[]): void {
    this.pending = entries.slice(0, MAX_ENTRIES).map(persistable)
    this.writer.schedule()
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private writeNow (): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, entries: this.pending }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist the downloads list:', error)
      throw error
    }
  }
}

/** A private session's list: held while the process runs, never written. */
export class MemoryDownloadStore implements DownloadStore {
  read (): DownloadEntry[] {
    return []
  }

  write (): void {}

  async flush (): Promise<void> {}
}
