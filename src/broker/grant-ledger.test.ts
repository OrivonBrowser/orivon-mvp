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
    writeVersionFloor: (origin, versionFloor) => { floors.set(origin, versionFloor) }
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
