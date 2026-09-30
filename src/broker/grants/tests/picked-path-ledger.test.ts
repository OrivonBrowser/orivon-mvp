import { describe, expect, it } from 'vitest'
import { PickedPathLedger } from '../picked-path-ledger.js'
import { memoryLedgerStorage } from '../../tests/index.test-helpers.js'

const APP = 'https://app.example'

describe('PickedPathLedger', () => {
  it('starts empty for an origin with no LedgerStorage supplied', () => {
    const ledger = new PickedPathLedger()

    expect(ledger.listFor(APP)).toEqual([])
  })

  it('record returns the new pick with a minted id, kind and path', () => {
    const ledger = new PickedPathLedger()

    const pick = ledger.record(APP, 'directory', '/home/user/Downloads', 1000, 'Torrent App')

    expect(pick.kind).toBe('directory')
    expect(pick.path).toBe('/home/user/Downloads')
    expect(pick.pickedAt).toBe(1000)
    expect(typeof pick.id).toBe('string')
    expect(pick.id.length).toBeGreaterThan(0)
  })

  it('two picks in the same origin get two different ids', () => {
    const ledger = new PickedPathLedger()

    const a = ledger.record(APP, 'file', '/x/a.txt', 1, undefined)
    const b = ledger.record(APP, 'file', '/x/b.txt', 2, undefined)

    expect(a.id).not.toBe(b.id)
    expect(ledger.listFor(APP).map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('listFor is empty for an origin nothing was ever recorded for', () => {
    const ledger = new PickedPathLedger()
    ledger.record(APP, 'file', '/x', 1, undefined)

    expect(ledger.listFor('https://other.example')).toEqual([])
  })

  it('revoke removes exactly the named pick and returns true', () => {
    const ledger = new PickedPathLedger()
    const kept = ledger.record(APP, 'file', '/x/a.txt', 1, undefined)
    const gone = ledger.record(APP, 'file', '/x/b.txt', 2, undefined)

    const removed = ledger.revoke(APP, gone.id)

    expect(removed).toBe(true)
    expect(ledger.listFor(APP).map((p) => p.id)).toEqual([kept.id])
  })

  it('revoke is a no-op, returning false, for an id never recorded', () => {
    const ledger = new PickedPathLedger()
    ledger.record(APP, 'file', '/x', 1, undefined)

    expect(ledger.revoke(APP, 'never-existed')).toBe(false)
    expect(ledger.revoke('https://never-touched.example', 'never-existed')).toBe(false)
  })

  describe('persistence (D-0007: survives a restart)', () => {
    it('a pick written through one ledger is visible from a FRESH ledger over the same storage', () => {
      const storage = memoryLedgerStorage()
      const first = new PickedPathLedger(storage)
      const pick = first.record(APP, 'directory', '/home/user/Downloads', 1000, 'Torrent App')

      // A brand-new instance, simulating the broker restarting -- the
      // in-memory Map above is gone; only `storage` carries over.
      const afterRestart = new PickedPathLedger(storage)

      expect(afterRestart.listFor(APP)).toEqual([pick])
    })

    it('a revoke persists too: it is gone after a simulated restart', () => {
      const storage = memoryLedgerStorage()
      const first = new PickedPathLedger(storage)
      const pick = first.record(APP, 'file', '/x', 1, undefined)
      first.revoke(APP, pick.id)

      const afterRestart = new PickedPathLedger(storage)

      expect(afterRestart.listFor(APP)).toEqual([])
    })

    it('does not persist a loopback origin\'s pick (T13c) -- gone after a simulated restart', () => {
      const storage = memoryLedgerStorage()
      const first = new PickedPathLedger(storage)
      first.record('http://localhost:5173', 'file', '/x', 1, undefined)

      const afterRestart = new PickedPathLedger(storage)

      expect(afterRestart.listFor('http://localhost:5173')).toEqual([])
    })

    it('writePickedPaths is never called when no LedgerStorage is supplied', () => {
      // No storage double to observe here -- the assertion is simply that
      // record/revoke do not throw with storage undefined, exercised above
      // in the "starts empty" and "revoke is a no-op" cases already. This
      // test documents the intent explicitly rather than leaving it implicit.
      const ledger = new PickedPathLedger(undefined)
      expect(() => { ledger.record(APP, 'file', '/x', 1, undefined) }).not.toThrow()
    })
  })

  // "Re-check persisted picked paths when they are restored" -- a pick
  // recorded before a guard existed (or from a machine where Orivon's own
  // data directory has since moved) must not go on looking legitimate in
  // the settings list forever just because it is read back off disk.
  describe('re-checking a hydrated pick against the picker guard', () => {
    it('drops a persisted pick the guard now blocks, the first time it is read back', () => {
      const storage = memoryLedgerStorage()
      const first = new PickedPathLedger(storage)
      const kept = first.record(APP, 'directory', '/home/user/Downloads', 1, undefined)
      const blocked = first.record(APP, 'directory', '/would/be/blocked', 2, undefined)

      const guardedReason = (path: string): string | null => path === blocked.path ? "this folder holds Orivon's own data" : null
      const afterRestart = new PickedPathLedger(storage, guardedReason)

      expect(afterRestart.listFor(APP)).toEqual([kept])
    })

    it('persists the drop immediately -- a further restart does not bring the blocked entry back', () => {
      const storage = memoryLedgerStorage()
      const first = new PickedPathLedger(storage)
      first.record(APP, 'directory', '/would/be/blocked', 1, undefined)

      const guardedReason = (): string | null => 'blocked'
      const afterFirstRestart = new PickedPathLedger(storage, guardedReason)
      afterFirstRestart.listFor(APP) // triggers hydration, and the persisted correction

      // A THIRD instance, with NO guard at all -- if the drop had not been
      // persisted, this would read the stale entry straight back.
      const afterSecondRestart = new PickedPathLedger(storage)
      expect(afterSecondRestart.listFor(APP)).toEqual([])
    })

    it('a caller with no guard concept (every test that predates this) keeps today\'s behaviour exactly', () => {
      const storage = memoryLedgerStorage()
      const first = new PickedPathLedger(storage)
      const pick = first.record(APP, 'directory', '/home/user/Downloads', 1, undefined)

      const afterRestart = new PickedPathLedger(storage)

      expect(afterRestart.listFor(APP)).toEqual([pick])
    })
  })

  // An origin with zero picks left should not go on holding a row in
  // this ledger's own per-origin map for the rest of the process -- see
  // `revoke`'s own comment. Not directly observable from outside the class
  // (the map is a true private field), so this proves the OBSERVABLE half:
  // revoking an origin's only pick, then picking again, behaves exactly as
  // if that origin had never been seen, with nothing left over from before.
  describe('revoke leaves nothing behind once an origin has no picks left', () => {
    it('an origin revoked down to zero picks behaves like a fresh one on its next pick', () => {
      const ledger = new PickedPathLedger()
      const first = ledger.record(APP, 'file', '/x/a.txt', 1, undefined)
      ledger.revoke(APP, first.id)
      expect(ledger.listFor(APP)).toEqual([])

      const second = ledger.record(APP, 'file', '/x/b.txt', 2, undefined)

      expect(ledger.listFor(APP)).toEqual([second])
    })
  })
})
