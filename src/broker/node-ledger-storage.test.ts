import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeLedgerStorage } from './node-ledger-storage.js'
import { originHash } from './origin-hash.js'
import { compareVersions } from './policy/update.js'

// Real temp directory, no mocking -- the same discipline
// src/loader/node-storage.test.ts already established, for the same reason:
// this file has no `electron` import.

const APP = 'https://app.example'

// Permission-based fault injection (below) has no effect for root, which
// bypasses filesystem permission checks entirely.
const isRoot = process.getuid !== undefined && process.getuid() === 0

describe('nodeLedgerStorage', () => {
  it('readVersionFloor returns undefined for an origin never persisted', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    expect(storage.readVersionFloor(APP)).toBeUndefined()
  })

  it('writeVersionFloor then readVersionFloor round-trips the value', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writeVersionFloor(APP, '1.2.0')

    expect(storage.readVersionFloor(APP)).toBe('1.2.0')
  })

  it('writeVersionFloor overwrites whatever was there before', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writeVersionFloor(APP, '1.0.0')
    storage.writeVersionFloor(APP, '2.0.0')

    expect(storage.readVersionFloor(APP)).toBe('2.0.0')
  })

  it('two different origins get two different floors', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writeVersionFloor(APP, '1.0.0')
    storage.writeVersionFloor('https://other.example', '5.0.0')

    expect(storage.readVersionFloor(APP)).toBe('1.0.0')
    expect(storage.readVersionFloor('https://other.example')).toBe('5.0.0')
  })

  // A file that exists but cannot be read as the expected shape is NOT the
  // same as "never persisted" -- ledger-storage.ts's own doc contract. Real
  // bytes, written directly (never through storage.writeVersionFloor, so
  // this exercises exactly what a crash mid-write would leave behind), not
  // a mock.
  it('a version-floor file that exists but is not valid JSON returns something compareVersions cannot order, not undefined', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    const dir = join(userData, 'grants', originHash(APP))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'version-floor.json'), '{"versionFloor": "1.0.0')

    const result = storage.readVersionFloor(APP)

    expect(result).not.toBeUndefined()
    expect(compareVersions(result as string, result as string)).toBeNull()
  })

  it('a version-floor file with the wrong JSON shape also fails to order, not undefined', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    const dir = join(userData, 'grants', originHash(APP))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'version-floor.json'), '{"notVersionFloor": 123}')

    const result = storage.readVersionFloor(APP)

    expect(result).not.toBeUndefined()
    expect(compareVersions(result as string, result as string)).toBeNull()
  })

  it('the floor lives under a separate grants/ root, never inside the loader\'s apps/ tree', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writeVersionFloor(APP, '1.0.0')

    const path = join(userData, 'grants', originHash(APP), 'version-floor.json')
    expect(() => readFileSync(path, 'utf8')).not.toThrow()
  })

  // A bare writeFileSync can leave a truncated file behind if the process
  // dies mid-write. A write-to-temp-then-rename leaves no trace of an
  // in-progress write at all -- the directory holds either the old complete
  // file (rename never happened) or the new one (it did), and nothing in
  // between.
  it('a normal write leaves no temp file behind -- it lands via rename, not a truncate in place', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writeVersionFloor(APP, '1.0.0')

    const dir = join(userData, 'grants', originHash(APP))
    expect(readdirSync(dir)).toEqual(['version-floor.json'])
  })

  it('a second write also leaves no temp file behind', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writeVersionFloor(APP, '1.0.0')
    storage.writeVersionFloor(APP, '2.0.0')

    const dir = join(userData, 'grants', originHash(APP))
    expect(readdirSync(dir)).toEqual(['version-floor.json'])
    expect(storage.readVersionFloor(APP)).toBe('2.0.0')
  })

  // The real proof an atomic write is happening at all, without mocking
  // node:fs: creating a NEW directory entry (the temp file) needs directory
  // write permission; overwriting an EXISTING file's content in place does
  // not (POSIX governs that by the file's own permissions). A read-only
  // directory therefore fails a temp-file-then-rename write before it ever
  // touches the real target -- and would silently SUCCEED, truncating the
  // target directly, for the bare writeFileSync this replaces.
  it.skipIf(isRoot)('a write that cannot create its temp file leaves the previously-persisted value completely untouched', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    storage.writeVersionFloor(APP, '1.0.0')

    const dir = join(userData, 'grants', originHash(APP))
    chmodSync(dir, 0o555)
    try {
      expect(() => { storage.writeVersionFloor(APP, '2.0.0') }).toThrow()
    } finally {
      chmodSync(dir, 0o755)
    }

    expect(storage.readVersionFloor(APP)).toBe('1.0.0')
  })

  // A60's escape hatch: GrantLedger.forgetOrigin needs a real on-disk
  // delete, or a "forgotten" origin's poisoned floor would silently
  // resurrect itself the next time this origin is hydrated.
  describe('deleteVersionFloor', () => {
    it('removes the file, so a later read returns undefined again -- never persisted', () => {
      const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
      const storage = nodeLedgerStorage(userData)
      storage.writeVersionFloor(APP, '9.0.0')

      storage.deleteVersionFloor(APP)

      expect(storage.readVersionFloor(APP)).toBeUndefined()
    })

    it('is a silent no-op for an origin never persisted', () => {
      const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
      const storage = nodeLedgerStorage(userData)

      expect(() => { storage.deleteVersionFloor(APP) }).not.toThrow()
    })

    it('does not disturb a different origin\'s persisted floor', () => {
      const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
      const storage = nodeLedgerStorage(userData)
      storage.writeVersionFloor(APP, '1.0.0')
      storage.writeVersionFloor('https://other.example', '5.0.0')

      storage.deleteVersionFloor(APP)

      expect(storage.readVersionFloor(APP)).toBeUndefined()
      expect(storage.readVersionFloor('https://other.example')).toBe('5.0.0')
    })
  })
})
