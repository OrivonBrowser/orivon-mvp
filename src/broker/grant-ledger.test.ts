import { describe, expect, it } from 'vitest'
import { GrantLedger } from './grant-ledger.js'
import type { LedgerStorage } from './ledger-storage.js'
import type { Manifest } from '../contracts/index.js'

const APP = 'https://app.example'

/** A minimal, valid Manifest -- only `version` varies per call. */
function manifestWith (version: string): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

/** A Map-backed LedgerStorage double -- real behaviour, no disk, matching src/loader/test-helpers.ts's memoryStorage() idiom. */
function memoryLedgerStorage (): LedgerStorage & { readonly floors: Map<string, string> } {
  const floors = new Map<string, string>()
  return {
    floors,
    readVersionFloor: (origin) => floors.get(origin),
    writeVersionFloor: (origin, versionFloor) => { floors.set(origin, versionFloor) },
    deleteVersionFloor: (origin) => { floors.delete(origin) }
  }
}

/** A LedgerStorage double whose write always fails, for A57's write-failure tests below. */
function throwingLedgerStorage (): LedgerStorage {
  return {
    readVersionFloor: () => undefined,
    writeVersionFloor: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
    deleteVersionFloor: () => {}
  }
}

// T19's version floor: "the highest version ever installed for this origin"
// (security-model.md), so a validly-hash-pinned OLDER bundle can never be
// replayed to suppress a fix. Lives in the grant ledger, not the pin record
// (ADR-0009's own consequence: it must survive an uninstalled/reinstalled
// app, which a pin record does not).
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
})

// A57's own persistence path is unguarded against a write failure (EACCES,
// ENOSPC, EROFS). Left unguarded, the in-memory floor would already be
// raised while the disk copy is not, so a restart would hydrate the OLD,
// lower floor -- silently reopening the exact T19 rollback window A57 exists
// to close, the moment a write ever fails.
describe('GrantLedger -- a persist failure never raises the in-memory floor past what is on disk', () => {
  it('does not raise the in-memory floor when the write throws', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())

    expect(() => { ledger.registerApp(APP, manifestWith('1.0.0')) }).not.toThrow()

    expect(ledger.versionFloorFor(APP)).toBe('0.0.0')
  })

  it('a later call with a working write still raises the floor normally', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())
    ledger.registerApp(APP, manifestWith('1.0.0')) // fails, swallowed

    const storage = memoryLedgerStorage()
    const workingLedger = new GrantLedger(storage)
    workingLedger.registerApp(APP, manifestWith('1.0.0'))
    expect(workingLedger.versionFloorFor(APP)).toBe('1.0.0')
  })

  it('does not throw out of registerApp -- a synchronous throw here becomes an unhandled rejection at every one of the ~44 unawaited call sites', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())
    expect(() => { ledger.registerApp(APP, manifestWith('1.0.0')) }).not.toThrow()
  })
})
