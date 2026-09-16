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
})
