// The origins whose first-visit question the person answered with Deny (ADR-0074): each opens as a plain website
// and is not asked about again, until the person asks for the question back (Settings, Sites). A site-level record,
// kept apart from the broker's per-capability refusals: it authorises nothing and only ever suppresses a question.
// Written only by a pressed Deny; Escape, a closed tab and a navigation record nothing.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { originFromUrl } from '../../broker/policy/origin.js'

const FILE_VERSION = 1

/** Past this many origins a new one is refused: a record that grows without bound is no setting. */
export const MAX_DECLINED_APPS = 2000

export class DeclinedApps {
  private readonly origins = new Set<string>()

  /** `filePath` undefined keeps the record in memory only, for a private session. A file that cannot be read is an empty record. */
  constructor (private readonly filePath?: string) {
    if (filePath === undefined) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) return
      const origins = (parsed as { origins?: unknown }).origins
      if (!Array.isArray(origins)) return
      for (const entry of origins) {
        if (typeof entry === 'string' && originFromUrl(entry) === entry && this.origins.size < MAX_DECLINED_APPS) this.origins.add(entry)
      }
    } catch {
      // Missing or corrupt: nothing is recorded, so every first visit asks.
    }
  }

  has (origin: string): boolean {
    return this.origins.has(origin)
  }

  list (): string[] {
    return [...this.origins].sort()
  }

  /** True when `origin` is recorded afterwards: false for a string that is not an origin or a full record. A write that failed still holds for this run. */
  add (origin: string): boolean {
    if (originFromUrl(origin) !== origin) return false
    if (this.origins.has(origin)) return true
    if (this.origins.size >= MAX_DECLINED_APPS) return false
    this.origins.add(origin)
    if (this.persist()) return true
    // Kept in memory for this run even when the disk refused it: the person said no, and being asked again at once would not be an answer.
    return true
  }

  /** True when `origin` was recorded and no longer is. A failed write puts it back, so memory never says less than disk. */
  remove (origin: string): boolean {
    if (!this.origins.delete(origin)) return false
    if (this.persist()) return true
    this.origins.add(origin)
    return false
  }

  private persist (): boolean {
    if (this.filePath === undefined) return true
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, origins: [...this.origins] }, null, 2))
      return true
    } catch (error) {
      console.error('[orivon] failed to persist the apps whose first visit was refused:', error)
      return false
    }
  }
}

let installed: DeclinedApps | undefined

/** The record the shell consults, set once at start by the install subsystem (and by a test); undefined until then. */
export function installDeclinedApps (apps: DeclinedApps | undefined): void {
  installed = apps
}

export function declinedApps (): DeclinedApps | undefined {
  return installed
}
