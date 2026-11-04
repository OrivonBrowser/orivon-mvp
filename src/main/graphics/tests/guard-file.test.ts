import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GUARD_FILE, readGuardRecord, writeGuardRecord } from '../guard-file.js'
import { NO_GUARD_RECORD } from '../x11-vulkan.js'

const dirs: string[] = []
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'orivon-guard-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the guard record on disk', () => {
  it('reads as none when the file is missing, not JSON, or not a record', () => {
    const dir = scratch()
    expect(readGuardRecord(join(dir, GUARD_FILE))).toEqual(NO_GUARD_RECORD)
    writeFileSync(join(dir, GUARD_FILE), '{ not json')
    expect(readGuardRecord(join(dir, GUARD_FILE))).toEqual(NO_GUARD_RECORD)
    writeFileSync(join(dir, GUARD_FILE), '"x"')
    expect(readGuardRecord(join(dir, GUARD_FILE))).toEqual(NO_GUARD_RECORD)
  })

  it('keeps what it was given, creating the folder, and reads it back', () => {
    const path = join(scratch(), 'profile', GUARD_FILE)
    const record = { pendingWindow: true, revert: { at: '2026-11-04T10:00:00.000Z', why: 'no-window' } } as const
    expect(writeGuardRecord(path, record)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record)
    expect(readGuardRecord(path)).toEqual(record)
  })

  it('says so, and does not throw, when the disk refuses', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'a-file'), '')
    expect(writeGuardRecord(join(dir, 'a-file', GUARD_FILE), NO_GUARD_RECORD)).toBe(false)
  })
})
