// What the cookie mirror keeps on disk: the sites it has copied into each profile, and whether a clear of them is owed. A turned-on
// switch must still clear the profiles after a crash or a restart, and a restart must keep the scope, so both outlive the run.
// Synchronous, atomic, and neither function throws.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../../broker/adapters/atomic-write.js'

const FILE_VERSION = 1
/** Past this many sites for one profile a site is not mirrored: a record that grows without bound is no setting. */
export const MAX_SITES_PER_PROFILE = 5000
const MAX_PROFILES = 16

export interface MirrorRecord {
  /** For each profile session (its name without `persist:`), the sites (registrable domains) whose cookies are kept the same as the default session's. */
  readonly domains: Readonly<Record<string, readonly string[]>>
  /** The switch was turned back on and the profiles' cookies of those sites are not known to be cleared yet. */
  readonly owed: boolean
}

export const NO_RECORD: MirrorRecord = { domains: {}, owed: false }

/** The record a parsed file holds; what is not a record, or is not valid, is dropped. */
export function recordFrom (parsed: unknown): MirrorRecord {
  if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) return NO_RECORD
  const { domains, owed } = parsed as { domains?: unknown, owed?: unknown }
  const kept: Record<string, string[]> = {}
  if (typeof domains === 'object' && domains !== null && !Array.isArray(domains)) {
    for (const [label, sites] of Object.entries(domains).slice(0, MAX_PROFILES)) {
      if (!/^[a-z0-9-]{1,64}$/.test(label) || !Array.isArray(sites)) continue
      const valid = sites.filter((site): site is string => typeof site === 'string' && site.length > 0 && site.length <= 255).slice(0, MAX_SITES_PER_PROFILE)
      if (valid.length > 0) kept[label] = valid
    }
  }
  return { domains: kept, owed: owed === true }
}

/** The record at `path`; none when the file is missing, unreadable or not a record. */
export function readMirrorRecord (path: string): MirrorRecord {
  try {
    return recordFrom(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return NO_RECORD
  }
}

/** Keeps `record` at `path`; false when the disk refused it. */
export function writeMirrorRecord (path: string, record: MirrorRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileAtomic(path, JSON.stringify({ version: FILE_VERSION, ...record }))
    return true
  } catch (error) {
    console.error('[cookie-mirror] the record of what it mirrors could not be kept:', error instanceof Error ? error.name : error)
    return false
  }
}
