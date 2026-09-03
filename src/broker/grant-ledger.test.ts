import { describe, expect, it } from 'vitest'
import { GrantLedger } from './grant-ledger.js'
import type { Manifest } from '../contracts/index.js'

const APP = 'https://app.example'

/** A minimal, valid Manifest -- only `version` varies per call. */
function manifestWith (version: string): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
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
