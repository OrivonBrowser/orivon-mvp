// The guard's record on disk: one small JSON file in the profile, read and written before and after the first window.
// Synchronous, and neither function throws: a profile whose record cannot be kept simply has no guard.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { NO_GUARD_RECORD, guardRecordFrom } from './x11-vulkan.js'
import type { GuardRecord } from './x11-vulkan.js'

export const GUARD_FILE = 'x11-vulkan.json'

/** The record at `path`; none when the file is missing, unreadable or not a record. */
export function readGuardRecord (path: string): GuardRecord {
  try {
    return guardRecordFrom(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return NO_GUARD_RECORD
  }
}

/** Keeps `record` at `path`; false when the disk refused it. */
export function writeGuardRecord (path: string, record: GuardRecord): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileAtomic(path, JSON.stringify(record))
    return true
  } catch (error) {
    console.error('[graphics] the WebGPU-on-X11 guard could not keep its record:', error)
    return false
  }
}
