import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
})
