import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeLedgerStorage } from '../node-ledger-storage.js'
import { originHash } from '../origin-hash.js'

// Split out of node-ledger-storage.test.ts (code-guidelines.md Rule 2: 800
// lines for a test file) rather than grown inside it -- same real-temp-
// directory discipline as that file, no mocking, no `electron` import.

const APP = 'https://app.example'

// D-0007: "persisted picked paths need somewhere to live and a revocation
// path, so P4-3 and P4-4 now share a surface" -- SAME grants.json file
// readGrants/writeGrants use, a different top-level field. The trap this
// guards against is the two write paths clobbering each other's slice; see
// the cross-preservation tests below.
describe('readPickedPaths / writePickedPaths / deletePickedPaths (D-0007)', () => {
  it('readPickedPaths returns undefined for an origin never persisted', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    expect(storage.readPickedPaths(APP)).toBeUndefined()
  })

  it('writePickedPaths then readPickedPaths round-trips the exact set', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writePickedPaths(APP, { 'pick-1': { kind: 'directory', path: '/home/user/Downloads', pickedAt: 1000 } })

    expect(storage.readPickedPaths(APP)).toEqual({ 'pick-1': { kind: 'directory', path: '/home/user/Downloads', pickedAt: 1000 } })
  })

  it('writePickedPaths overwrites the whole set, including dropping a pick no longer present', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writePickedPaths(APP, {
      'pick-1': { kind: 'file', path: '/x/a.txt', pickedAt: 1 },
      'pick-2': { kind: 'file', path: '/x/b.txt', pickedAt: 2 }
    })
    storage.writePickedPaths(APP, { 'pick-2': { kind: 'file', path: '/x/b.txt', pickedAt: 2 } })

    expect(storage.readPickedPaths(APP)).toEqual({ 'pick-2': { kind: 'file', path: '/x/b.txt', pickedAt: 2 } })
  })

  it('two different origins get two different picked-path sets', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 1 } })
    storage.writePickedPaths('https://other.example', { 'pick-1': { kind: 'directory', path: '/y', pickedAt: 2 } })

    expect(storage.readPickedPaths(APP)).toEqual({ 'pick-1': { kind: 'file', path: '/x', pickedAt: 1 } })
    expect(storage.readPickedPaths('https://other.example')).toEqual({ 'pick-1': { kind: 'directory', path: '/y', pickedAt: 2 } })
  })

  it('lives in the SAME grants.json file as readGrants/writeGrants, not a second file', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 1 } })

    const dir = join(userData, 'grants', originHash(APP))
    expect(readdirSync(dir)).toEqual(['grants.json'])
  })

  it('writeGrants PRESERVES whatever picked paths were already on disk', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    storage.writePickedPaths(APP, { 'pick-1': { kind: 'directory', path: '/home/user/Downloads', pickedAt: 1 } })

    storage.writeGrants(APP, { fs: { patterns: [], grantedAt: 2 } })

    expect(storage.readPickedPaths(APP)).toEqual({ 'pick-1': { kind: 'directory', path: '/home/user/Downloads', pickedAt: 1 } })
    expect(storage.readGrants(APP)).toEqual({ fs: { patterns: [], grantedAt: 2 } })
  })

  it('writePickedPaths PRESERVES whatever grants were already on disk', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    storage.writeGrants(APP, { fs: { patterns: [], grantedAt: 1 } })

    storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 2 } })

    expect(storage.readGrants(APP)).toEqual({ fs: { patterns: [], grantedAt: 1 } })
    expect(storage.readPickedPaths(APP)).toEqual({ 'pick-1': { kind: 'file', path: '/x', pickedAt: 2 } })
  })

  it('writePickedPaths PRESERVES the app name written by an earlier writeGrants call', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    storage.writeGrants(APP, { fs: { patterns: [], grantedAt: 1 } }, 'Torrent App')

    storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 2 } })

    expect(storage.readPersistedApp(APP)?.appName).toBe('Torrent App')
  })

  it('a picked-paths file that is not valid JSON reads as undefined', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    const dir = join(userData, 'grants', originHash(APP))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'grants.json'), '{"pickedPaths": {')

    expect(storage.readPickedPaths(APP)).toBeUndefined()
  })

  it('an entry missing kind, path or pickedAt makes the whole file read as undefined', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    const dir = join(userData, 'grants', originHash(APP))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'grants.json'), JSON.stringify({ origin: APP, grants: {}, pickedPaths: { 'pick-1': { kind: 'file' } } }))

    expect(storage.readPickedPaths(APP)).toBeUndefined()
  })

  describe('deletePickedPaths', () => {
    it('removes picks, so a later read returns undefined again', () => {
      const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
      const storage = nodeLedgerStorage(userData)
      storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 1 } })

      storage.deletePickedPaths(APP)

      expect(storage.readPickedPaths(APP)).toBeUndefined()
    })

    it('is a silent no-op for an origin never persisted', () => {
      const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
      const storage = nodeLedgerStorage(userData)

      expect(() => { storage.deletePickedPaths(APP) }).not.toThrow()
    })

    it('does not disturb this origin\'s grants', () => {
      const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
      const storage = nodeLedgerStorage(userData)
      storage.writeGrants(APP, { fs: { patterns: [], grantedAt: 1 } })
      storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 2 } })

      storage.deletePickedPaths(APP)

      expect(storage.readPickedPaths(APP)).toBeUndefined()
      expect(storage.readGrants(APP)).toEqual({ fs: { patterns: [], grantedAt: 1 } })
    })
  })
})

describe('readPersistedApp includes pickedPaths (D-0007)', () => {
  it('is an empty object when this origin has grants but no picks', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    storage.writeGrants(APP, { fs: { patterns: [], grantedAt: 1 } })

    expect(storage.readPersistedApp(APP)?.pickedPaths).toEqual({})
  })

  it('carries the persisted picks once written', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)
    storage.writePickedPaths(APP, { 'pick-1': { kind: 'directory', path: '/home/user/Downloads', pickedAt: 1 } })

    expect(storage.readPersistedApp(APP)?.pickedPaths).toEqual({ 'pick-1': { kind: 'directory', path: '/home/user/Downloads', pickedAt: 1 } })
  })
})

describe('listPersistedOrigins includes an origin with ONLY picked paths, no grants', () => {
  it('lists it, the same as an origin with only grants', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orivon-ledger-storage-'))
    const storage = nodeLedgerStorage(userData)

    storage.writePickedPaths(APP, { 'pick-1': { kind: 'file', path: '/x', pickedAt: 1 } })

    expect(storage.listPersistedOrigins()).toEqual([APP])
  })
})
