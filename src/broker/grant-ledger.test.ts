import { describe, expect, it } from 'vitest'
import { GrantLedger } from './grant-ledger.js'
import { memoryLedgerStorage } from './index.test-helpers.js'
import type { LedgerStorage } from './ledger-storage.js'
import type { Manifest } from '../contracts/index.js'

const APP = 'https://app.example'

/** A minimal, valid Manifest -- only `version` varies per call. */
function manifestWith (version: string): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

/** A LedgerStorage double whose write always fails, for A57's write-failure tests below. */
function throwingLedgerStorage (): LedgerStorage {
  return {
    readVersionFloor: () => undefined,
    writeVersionFloor: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
    deleteVersionFloor: () => {},
    readAcknowledgedRollbackVersion: () => undefined,
    writeAcknowledgedRollbackVersion: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
    deleteAcknowledgedRollbackVersion: () => {}
  }
}

/**
 * Writes once, then fails -- the shape of a disk that fills up (or is
 * remounted read-only) partway through a session, which is what makes the
 * memory/disk divergence reachable at all.
 */
function failingAfterFirstWrite (): LedgerStorage & { readonly floors: Map<string, string> } {
  const storage = memoryLedgerStorage()
  let writes = 0
  return {
    ...storage,
    writeVersionFloor: (origin, versionFloor) => {
      writes++
      if (writes > 1) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
      storage.writeVersionFloor(origin, versionFloor)
    }
  }
}

/** A LedgerStorage double whose delete fails with something other than ENOENT -- a real permission error or a lock, not "already gone". */
function undeletableLedgerStorage (): LedgerStorage & { readonly floors: Map<string, string> } {
  const storage = memoryLedgerStorage()
  return {
    ...storage,
    deleteVersionFloor: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
  }
}

// T19's version floor: "the highest version ever installed for this origin"
// (security-model.md), so a validly-hash-pinned OLDER bundle is never
// installed unnoticed. Lives in the grant ledger, not the pin record --
// ADR-0009's original reasoning was that it must survive an uninstalled/
// reinstalled app, which its 2026-09-04 amendment corrects: the floor
// survives a restart (A57), not a full "remove this app" action.
describe('GrantLedger -- the version floor', () => {
  it('an origin never registered has floor 0.0.0', () => {
    expect(new GrantLedger().versionFloorFor(APP)).toBe('0.0.0')
  })

  it('registering a manifest raises the floor to its version', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('1.2.0'))
    expect(ledger.versionFloorFor(APP)).toBe('1.2.0')
  })

  it('registering a higher version raises the floor further', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('1.0.0'))
    ledger.registerApp(APP, manifestWith('2.0.0'))
    expect(ledger.versionFloorFor(APP)).toBe('2.0.0')
  })

  it('registering the same version again leaves the floor unchanged -- an ordinary page reload', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('1.5.0'))
    ledger.registerApp(APP, manifestWith('1.5.0'))
    expect(ledger.versionFloorFor(APP)).toBe('1.5.0')
  })

  // The floor is a REPLAY guard, not a mirror of "whatever registerApp was
  // last called with" -- it must never move backward, or a lower version
  // fed through registerApp (which only records what it is told, per its
  // own doc) would silently reopen the exact window T19 exists to close.
  it('registering a lower version does NOT lower the floor', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('2.0.0'))
    ledger.registerApp(APP, manifestWith('1.0.0'))
    expect(ledger.versionFloorFor(APP)).toBe('2.0.0')
  })

  it('two origins have independent floors', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('3.0.0'))
    expect(ledger.versionFloorFor('https://other.example')).toBe('0.0.0')
  })

  // Defensive: parseManifest already guarantees an orderable version before
  // a Manifest ever reaches here, so this should not occur in practice --
  // but GrantLedger's own doc says it "only remembers what it is told",
  // so an unparseable version must fail safe (floor unmoved) rather than
  // throw or silently accept a value compareVersions cannot order.
  it('an unparseable version does not move the floor, and does not throw', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('1.0.0'))
    expect(() => { ledger.registerApp(APP, manifestWith('not-a-version')) }).not.toThrow()
    expect(ledger.versionFloorFor(APP)).toBe('1.0.0')
  })
})

// A57: the floor must survive a process restart, not just an app's own
// uninstall -- ADR-0009 requires it, and until now GrantLedger was
// constructed fresh, in-memory, exactly once per process launch. A new
// GrantLedger stands in for "the browser restarted": same persisted
// storage, a brand new ledger with nothing in memory yet.
describe('GrantLedger -- version floor persistence (A57)', () => {
  it('with no LedgerStorage supplied, behaves exactly as before -- in-memory only', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('1.0.0'))
    expect(ledger.versionFloorFor(APP)).toBe('1.0.0')
  })

  it('registering a manifest persists the new floor via the injected storage', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, manifestWith('1.2.0'))
    expect(storage.floors.get(APP)).toBe('1.2.0')
  })

  it('registering the same version again does not re-persist (the floor did not move)', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, manifestWith('1.0.0'))
    storage.floors.set(APP, 'untouched-marker')
    ledger.registerApp(APP, manifestWith('1.0.0'))
    expect(storage.floors.get(APP)).toBe('untouched-marker')
  })

  it('a floor persisted before this GrantLedger existed is picked up on first touch -- simulates surviving a restart', () => {
    const storage = memoryLedgerStorage()
    storage.floors.set(APP, '3.0.0')
    const ledger = new GrantLedger(storage) // stands in for the browser restarting
    expect(ledger.versionFloorFor(APP)).toBe('3.0.0')
  })

  it('the persisted floor still blocks a rollback after a simulated restart, exactly like T19 requires within one session', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestWith('2.0.0'))

    const after = new GrantLedger(storage) // the "restart"
    expect(after.versionFloorFor(APP)).toBe('2.0.0')
    after.registerApp(APP, manifestWith('1.0.0')) // an adversarial host replaying an older version
    expect(after.versionFloorFor(APP)).toBe('2.0.0') // still not lowered
  })

  it('a persisted floor lower than the in-memory default is still applied -- hydration raises from 0.0.0, it does not require a higher value to already be present', () => {
    const storage = memoryLedgerStorage()
    storage.floors.set(APP, '1.0.0')
    const ledger = new GrantLedger(storage)
    expect(ledger.versionFloorFor(APP)).toBe('1.0.0')
  })

  it('reading the floor (never registering) still hydrates from storage', () => {
    const storage = memoryLedgerStorage()
    storage.floors.set(APP, '4.0.0')
    const ledger = new GrantLedger(storage)
    // No registerApp call at all -- Loader.load() reads versionFloorFor
    // before any registration decision, so hydration must not depend on
    // registerApp having run first this session.
    expect(ledger.versionFloorFor(APP)).toBe('4.0.0')
  })

  // Corrupt persisted data (docs/open-questions.md A57, LedgerStorage's own
  // doc contract) must fail CLOSED, not silently reset to '0.0.0' -- that
  // would make a corrupted floor file indistinguishable from "never
  // installed", reopening exactly the T19 rollback this exists to close.
  // update.ts's own compareVersions/isAtOrAboveFloor already fail closed on
  // an unorderable pair (its own doc comment says so); this proves the
  // corrupt value actually reaches that check rather than being masked.
  it('an unparseable persisted floor is NOT silently replaced with 0.0.0', () => {
    const storage = memoryLedgerStorage()
    storage.floors.set(APP, 'not-a-version-at-all')
    const ledger = new GrantLedger(storage)
    expect(ledger.versionFloorFor(APP)).toBe('not-a-version-at-all')
  })

  it('two origins persist and hydrate independently', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestWith('1.0.0'))
    before.registerApp('https://other.example', manifestWith('9.0.0'))

    const after = new GrantLedger(storage)
    expect(after.versionFloorFor(APP)).toBe('1.0.0')
    expect(after.versionFloorFor('https://other.example')).toBe('9.0.0')
  })
})

// A60's escape hatch. registerApp raises the floor unconditionally, even for
// a manifest that was only ever fetched, never actually installed -- so a
// hostile origin can poison the floor with a fake high version and lock the
// user out of every real future update. Before A57, restarting the browser
// reset every floor, poisoned ones included; A57 removed that reset. This is
// the replacement way out: forget one origin's floor entirely.
describe('GrantLedger -- forgetOrigin (A60 escape hatch)', () => {
  it('clears the in-memory floor immediately', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestWith('99.0.0'))
    ledger.forgetOrigin(APP)
    expect(ledger.versionFloorFor(APP)).toBe('0.0.0')
  })

  it('deletes the persisted floor, so a fresh GrantLedger (simulating a restart) sees 0.0.0 again, not the old value', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestWith('99.0.0'))

    before.forgetOrigin(APP)

    const after = new GrantLedger(storage) // the "restart"
    expect(after.versionFloorFor(APP)).toBe('0.0.0')
  })

  it('does not throw when no LedgerStorage was ever supplied', () => {
    const ledger = new GrantLedger()
    expect(() => { ledger.forgetOrigin(APP) }).not.toThrow()
  })

  it('is a no-op, not a throw, for an origin the ledger has no record of', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    expect(() => { ledger.forgetOrigin('https://never-touched.example') }).not.toThrow()
  })

  it('does not disturb a different origin\'s floor', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, manifestWith('2.0.0'))
    ledger.registerApp('https://other.example', manifestWith('5.0.0'))

    ledger.forgetOrigin(APP)

    expect(ledger.versionFloorFor('https://other.example')).toBe('5.0.0')
  })

  // Clearing memory first and disk second means a failing delete leaves a
  // state WORSE than not having called forgetOrigin at all: the grants and
  // manifest are gone while the poisoned floor is still on disk, waiting to
  // hydrate straight back on the origin's next touch. Disk first, and leave
  // memory alone if it fails, so a failed forget changes nothing.
  it('leaves the in-memory record completely intact when the on-disk delete fails', () => {
    const ledger = new GrantLedger(undeletableLedgerStorage())
    ledger.registerApp(APP, manifestWith('9.0.0'))
    ledger.grant(APP, 'tcp.connect', ['93.184.216.34:443'], 0)
    ledger.reserveFsBytes(APP, 128)

    ledger.forgetOrigin(APP)

    expect(ledger.versionFloorFor(APP)).toBe('9.0.0')
    expect(ledger.manifestFor(APP)?.version).toBe('9.0.0')
    expect(ledger.grantsFor(APP)).toHaveLength(1)
    expect(ledger.fsBytesWritten(APP)).toBe(128)
  })

  it('does not throw when the on-disk delete fails -- it is best-effort cleanup, not a security-critical write', () => {
    const ledger = new GrantLedger(undeletableLedgerStorage())
    ledger.registerApp(APP, manifestWith('9.0.0'))

    expect(() => { ledger.forgetOrigin(APP) }).not.toThrow()
  })
})

// A23: T13c forbids ever persisting a grant for a loopback, `file:` or
// plain-http origin -- session-scoped only, re-prompted every launch. The
// version floor is exactly that kind of state, and A23's own "Needed by"
// line names this file's persist path as the place to enforce it.
describe('GrantLedger -- non-persistable origins never touch disk (A23/T13c)', () => {
  it.each([
    'http://127.0.0.1:8080',
    'http://[::1]:9000',
    'http://localhost:3000',
    'http://app.example' // plain http on an ordinary host -- still forbidden
  ])('%s: registering raises the in-memory floor but writes nothing to storage', (origin) => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)

    ledger.registerApp(origin, manifestWith('1.2.0'))

    expect(ledger.versionFloorFor(origin)).toBe('1.2.0') // still works normally in-memory
    expect(storage.floors.has(origin)).toBe(false) // never written
  })

  it('an ordinary https origin still persists normally', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)

    ledger.registerApp(APP, manifestWith('1.2.0'))

    expect(storage.floors.get(APP)).toBe('1.2.0')
  })

  it('a non-persistable origin does not survive a simulated restart -- it was never on disk to hydrate from', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp('http://127.0.0.1:8080', manifestWith('9.0.0'))

    const after = new GrantLedger(storage) // the "restart"
    expect(after.versionFloorFor('http://127.0.0.1:8080')).toBe('0.0.0')
  })

  // The read side is gated too, not only the write side. Nothing in this
  // codebase writes such a file, so this is what stops one that arrived some
  // other way -- a bug, a hand-edit, a future code path -- being honoured for
  // an origin T13c says must be session-scoped.
  it.each([
    'http://127.0.0.1:8080',
    'https://localhost',
    'https://app.localhost',
    'https://0.0.0.0'
  ])('%s: a floor already on disk is NOT hydrated for a non-persistable origin', (origin) => {
    const storage = memoryLedgerStorage()
    storage.floors.set(origin, '9.0.0')

    expect(new GrantLedger(storage).versionFloorFor(origin)).toBe('0.0.0')
  })
})

// d-0017 (owner decision): T19 warns on a below-floor version instead of only
// ever blocking it, and lets the user accept it -- once per origin, for the
// SPECIFIC version accepted. Not a bare per-origin flag: a review caught
// that a flag would let accepting one real rollback (1.2.0 -> 1.1.9)
// permanently wave through any OTHER below-floor version the same origin
// later serves, with no new prompt. `acknowledgeRollback` therefore takes
// the version being accepted, and `rollbackAcknowledgedVersionFor` returns
// the specific version last accepted (or undefined) -- a future UI-wiring
// PR compares that against whatever below-floor version is being offered
// and prompts fresh on anything but an exact match. No orivon.* counterpart,
// same category as versionFloorFor.
describe('GrantLedger -- rollback acknowledgement (d-0017)', () => {
  it('an origin never acknowledged reads undefined', () => {
    expect(new GrantLedger().rollbackAcknowledgedVersionFor(APP)).toBeUndefined()
  })

  it('acknowledging a version makes it read back exactly that version', () => {
    const ledger = new GrantLedger()
    ledger.acknowledgeRollback(APP, '1.1.9')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('two origins have independent acknowledged versions', () => {
    const ledger = new GrantLedger()
    ledger.acknowledgeRollback(APP, '1.1.9')
    expect(ledger.rollbackAcknowledgedVersionFor('https://other.example')).toBeUndefined()
  })

  // The property the whole redesign exists for: accepting a rollback to ONE
  // version must not silently cover a DIFFERENT, unrelated below-floor
  // version from the same origin -- the caller (not this class) is expected
  // to compare `rollbackAcknowledgedVersionFor` against the version it is
  // about to offer and prompt again on anything but an exact match.
  it('acknowledging 1.1.9 does not read as an acknowledgement of a different version, 1.1.8', () => {
    const ledger = new GrantLedger()
    ledger.acknowledgeRollback(APP, '1.1.9')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).not.toBe('1.1.8')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('acknowledging a new version overwrites the previously acknowledged one', () => {
    const ledger = new GrantLedger()
    ledger.acknowledgeRollback(APP, '1.1.9')
    ledger.acknowledgeRollback(APP, '1.1.5')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.5')
  })
})

// Mirrors the version floor's own A57 persistence suite above -- same
// hydrate-on-first-touch discipline, same "a new GrantLedger stands in for a
// restart" idiom.
describe('GrantLedger -- rollback-acknowledgement persistence (d-0017)', () => {
  it('with no LedgerStorage supplied, behaves exactly as before -- in-memory only', () => {
    const ledger = new GrantLedger()
    ledger.acknowledgeRollback(APP, '1.1.9')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('acknowledging persists via the injected storage', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.acknowledgeRollback(APP, '1.1.9')
    expect(storage.rollbackAcks.get(APP)).toBe('1.1.9')
  })

  it('an acknowledged version persisted before this GrantLedger existed is picked up on first touch -- simulates surviving a restart', () => {
    const storage = memoryLedgerStorage()
    storage.rollbackAcks.set(APP, '1.1.9')
    const ledger = new GrantLedger(storage)
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('reading (never acknowledging) still hydrates from storage', () => {
    const storage = memoryLedgerStorage()
    storage.rollbackAcks.set(APP, '1.1.9')
    const ledger = new GrantLedger(storage)
    // No acknowledgeRollback call at all -- a future caller may need to read
    // this before it ever decides to write it, the same reason
    // versionFloorFor's own hydration cannot depend on registerApp running
    // first.
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('two origins persist and hydrate independently', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.acknowledgeRollback(APP, '1.1.9')

    const after = new GrantLedger(storage)
    expect(after.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
    expect(after.rollbackAcknowledgedVersionFor('https://other.example')).toBeUndefined()
  })

  // F11 (this repo's own review, as first applied to the boolean design this
  // replaced): the fail-closed collapse must not produce a value that could
  // pass a future exact-match comparison. `undefined` never equals any real
  // version string a manifest could declare, so a storage double that
  // returns it directly (what node-ledger-storage.ts's own corrupt-read path
  // collapses to -- see its test file) proves GrantLedger does not layer a
  // second, more dangerous defaulting rule on top of what storage decided.
  it('a corrupt persisted record (storage already collapsed to undefined) never reads back as any version', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger({ ...storage, readAcknowledgedRollbackVersion: () => undefined })
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBeUndefined()
  })
})

// A60's escape hatch already forgets the version floor; d-0017's acknowledged
// version has the same lifecycle ("remove this app" forgets everything
// about it), so forgetOrigin clears both.
describe('GrantLedger -- forgetOrigin also clears the rollback acknowledgement (d-0017)', () => {
  it('clears the in-memory acknowledged version immediately', () => {
    const ledger = new GrantLedger()
    ledger.acknowledgeRollback(APP, '1.1.9')
    ledger.forgetOrigin(APP)
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBeUndefined()
  })

  it('deletes the persisted acknowledged version, so a fresh GrantLedger (simulating a restart) sees undefined again', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.acknowledgeRollback(APP, '1.1.9')

    before.forgetOrigin(APP)

    const after = new GrantLedger(storage)
    expect(after.rollbackAcknowledgedVersionFor(APP)).toBeUndefined()
  })

  it('does not disturb a different origin\'s acknowledged version', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.acknowledgeRollback(APP, '1.1.9')
    ledger.acknowledgeRollback('https://other.example', '2.0.0')

    ledger.forgetOrigin(APP)

    expect(ledger.rollbackAcknowledgedVersionFor('https://other.example')).toBe('2.0.0')
  })

  // Disk-first, memory-untouched-on-failure -- forgetOrigin's own existing
  // rule for the floor, extended to cover either half failing: a failed
  // forget must change nothing, regardless of which of the two deletes is
  // the one that failed.
  it('leaves the in-memory acknowledged version intact when the on-disk FLOOR delete fails', () => {
    const storage = memoryLedgerStorage()
    const failing: LedgerStorage = { ...storage, deleteVersionFloor: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    const ledger = new GrantLedger(failing)
    ledger.registerApp(APP, manifestWith('9.0.0'))
    ledger.acknowledgeRollback(APP, '1.1.9')

    ledger.forgetOrigin(APP)

    expect(ledger.versionFloorFor(APP)).toBe('9.0.0')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('leaves the in-memory floor intact when the on-disk ACKNOWLEDGEMENT delete fails', () => {
    const storage = memoryLedgerStorage()
    const failing: LedgerStorage = { ...storage, deleteAcknowledgedRollbackVersion: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    const ledger = new GrantLedger(failing)
    ledger.registerApp(APP, manifestWith('9.0.0'))
    ledger.acknowledgeRollback(APP, '1.1.9')

    ledger.forgetOrigin(APP)

    expect(ledger.versionFloorFor(APP)).toBe('9.0.0')
    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })
})

// A23/T13c applies to every piece of state this ledger ever persists, not
// only the floor -- session-scoped only for loopback, file: and plain-http
// origins.
describe('GrantLedger -- rollback acknowledgement on non-persistable origins never touches disk (A23/T13c)', () => {
  it.each([
    'http://127.0.0.1:8080',
    'http://[::1]:9000',
    'http://localhost:3000',
    'http://app.example'
  ])('%s: acknowledging raises the in-memory version but writes nothing to storage', (origin) => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)

    ledger.acknowledgeRollback(origin, '1.1.9')

    expect(ledger.rollbackAcknowledgedVersionFor(origin)).toBe('1.1.9') // still works normally in-memory
    expect(storage.rollbackAcks.has(origin)).toBe(false) // never written
  })
})

// Same discipline as registerApp's own failure-handling suite below: the
// in-memory version must rise unconditionally and first, and a write
// failure is reported rather than swallowed.
describe('GrantLedger -- a rollback-acknowledgement persist failure still raises the in-memory version', () => {
  it('raises the in-memory version even though the write threw', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.acknowledgeRollback(APP, '1.1.9') }).toThrow()

    expect(ledger.rollbackAcknowledgedVersionFor(APP)).toBe('1.1.9')
  })

  it('throws out of acknowledgeRollback rather than swallowing the failure', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.acknowledgeRollback(APP, '1.1.9') })
      .toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  })

  it('a non-persistable origin never reaches the write, so it cannot throw at all', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.acknowledgeRollback('http://localhost:3000', '1.1.9') }).not.toThrow()
    expect(ledger.rollbackAcknowledgedVersionFor('http://localhost:3000')).toBe('1.1.9')
  })
})

// A57's persistence path can fail (EACCES, ENOSPC, EROFS), and the first
// round of this review answered that by holding the IN-MEMORY floor back
// until a write succeeded. That made this class strictly less safe than
// having no persistence at all, in the same session, with no restart
// involved: with no LedgerStorage the floor always rises, so a replay of the
// superseded version is refused immediately; with a failing one the floor
// stayed where it was and the replay passed.
//
// So the in-memory raise is unconditional and happens FIRST -- it is the
// property this class exists for and it must hold every session -- and the
// write failure is surfaced to the caller rather than swallowed. The residual
// risk is the original A57 one and no worse: if writes keep failing until a
// real restart, the restart hydrates the older on-disk value. That is now
// observable, because registerApp throws.
describe('GrantLedger -- a persist failure still raises the in-memory floor', () => {
  it('raises the in-memory floor even though the write threw', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.registerApp(APP, manifestWith('1.0.0')) }).toThrow()

    expect(ledger.versionFloorFor(APP)).toBe('1.0.0')
  })

  // The regression this replaces, reproduced end to end. Version 1.0.0
  // installs and persists; 2.0.0 installs while the disk is unwritable; the
  // host then replays 1.0.0 in the SAME session. Holding the floor at 1.0.0
  // would let `isAtOrAboveFloor` pass that replay.
  it('a same-session replay of a superseded version is still refused after a failed persist', () => {
    const storage = failingAfterFirstWrite()
    const ledger = new GrantLedger(storage)

    ledger.registerApp(APP, manifestWith('1.0.0'))
    expect(() => { ledger.registerApp(APP, manifestWith('2.0.0')) }).toThrow()

    expect(ledger.versionFloorFor(APP)).toBe('2.0.0')

    ledger.registerApp(APP, manifestWith('1.0.0')) // the replay
    expect(ledger.versionFloorFor(APP)).toBe('2.0.0')
  })

  // Same scenario, stated as the property that makes the fix worth making:
  // persistence configured must never leave the ledger weaker than
  // persistence absent.
  it('matches the no-storage ledger exactly, which is the floor this must never fall below', () => {
    const withoutStorage = new GrantLedger()
    const withFailingStorage = new GrantLedger(throwingLedgerStorage())

    withoutStorage.registerApp(APP, manifestWith('2.0.0'))
    expect(() => { withFailingStorage.registerApp(APP, manifestWith('2.0.0')) }).toThrow()

    expect(withFailingStorage.versionFloorFor(APP)).toBe(withoutStorage.versionFloorFor(APP))
  })

  // Swallowing it made a disk that stopped accepting writes completely
  // invisible. There is no production caller of Broker.registerApp yet
  // (every call site is a test), so this is the moment the interface can
  // still choose to report the failure at all.
  it('throws out of registerApp rather than swallowing the failure', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.registerApp(APP, manifestWith('1.0.0')) })
      .toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  })

  it('re-registering the same version after a failed persist does not throw again -- the floor did not move, so nothing is written', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())
    expect(() => { ledger.registerApp(APP, manifestWith('1.0.0')) }).toThrow()

    expect(() => { ledger.registerApp(APP, manifestWith('1.0.0')) }).not.toThrow()
    expect(ledger.versionFloorFor(APP)).toBe('1.0.0')
  })

  it('a non-persistable origin never reaches the write, so it cannot throw at all', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.registerApp('http://localhost:3000', manifestWith('1.0.0')) }).not.toThrow()
    expect(ledger.versionFloorFor('http://localhost:3000')).toBe('1.0.0')
  })
})
