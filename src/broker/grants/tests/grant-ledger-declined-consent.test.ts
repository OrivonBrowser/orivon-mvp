import { describe, expect, it } from 'vitest'
import { GrantLedger } from '../grant-ledger.js'
import { memoryLedgerStorage } from '../../tests/index.test-helpers.js'
import type { LedgerStorage } from '../ledger-storage.js'

// A145: "a declined install-consent dialog is not remembered across a
// restart" -- this suite proves the fix at the GrantLedger level, mirroring
// grant-ledger.test.ts's own rollback-acknowledgement suite (same
// hydrate-on-first-touch discipline, same "a new GrantLedger stands in for
// a restart" idiom). src/main/tests/install-consent.test.ts proves the same
// fix one layer up, against the real requestInstallConsent flow.

const APP = 'https://app.example'

/** A LedgerStorage double whose declined-capabilities write always fails -- everything else succeeds, matching grant-ledger.test.ts's own per-field throwing doubles. */
function throwingDeclinedLedgerStorage (): LedgerStorage {
  const storage = memoryLedgerStorage()
  return { ...storage, writeDeclinedCapabilities: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) } }
}

describe('GrantLedger -- declined-consent memory (A145)', () => {
  it('an origin never declined reads undefined', () => {
    expect(new GrantLedger().declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('recording a decline makes it read back exactly that capability set', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect', 'fs'])
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect', 'fs'])
  })

  it('two origins have independent declined-capability records', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    expect(ledger.declinedCapabilitiesFor('https://other.example')).toBeUndefined()
  })

  it('recording a new decline overwrites the previous one, never merges', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect', 'fs'])
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('clearDeclinedConsent removes an origin\'s record', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    ledger.clearDeclinedConsent(APP)
    expect(ledger.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('clearDeclinedConsent on an origin never declined is a no-op, not a throw', () => {
    const ledger = new GrantLedger()
    expect(() => { ledger.clearDeclinedConsent(APP) }).not.toThrow()
    expect(ledger.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  // THE ADVERSARIAL CASE: a remembered decline must never become, or imply,
  // a grant -- through any path this class exposes. Recording a decline for
  // a capability must leave that capability exactly as ungranted as it was
  // before, however many times the decline is read back.
  it('a recorded decline never appears as a grant, and grantsFor stays empty', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect', 'fs'])

    expect(ledger.grantsFor(APP)).toEqual([])
    expect(ledger.currentGrant(APP, 'tcp.connect')).toBeUndefined()
    expect(ledger.currentGrant(APP, 'fs')).toBeUndefined()
    // Reading the decline back again changes nothing about the above --
    // the read path has no side effect that could later be mistaken for one.
    ledger.declinedCapabilitiesFor(APP)
    expect(ledger.grantsFor(APP)).toEqual([])
  })
})

describe('GrantLedger -- declined-consent persistence (A145)', () => {
  it('with no LedgerStorage supplied, behaves exactly as before -- in-memory only', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('recording persists via the injected storage', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    expect(storage.declined.get(APP)).toEqual(['tcp.connect'])
  })

  // THE RESTART PROOF: a decline persisted before this GrantLedger existed
  // is picked up on first touch -- the exact property A145 asks for, proven
  // the same way A57's own version-floor suite proves it for the floor.
  it('a decline persisted before this GrantLedger existed is picked up on first touch -- simulates surviving a restart', () => {
    const storage = memoryLedgerStorage()
    storage.declined.set(APP, ['tcp.connect', 'fs'])
    const ledger = new GrantLedger(storage)
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect', 'fs'])
  })

  it('reading (never recording) still hydrates from storage', () => {
    const storage = memoryLedgerStorage()
    storage.declined.set(APP, ['tcp.connect'])
    const ledger = new GrantLedger(storage)
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('clearing removes the persisted record too, so a later restart does not resurrect it', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.recordDeclinedConsent(APP, ['tcp.connect'])
    before.clearDeclinedConsent(APP)

    const after = new GrantLedger(storage)
    expect(after.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('two origins persist and hydrate independently', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.recordDeclinedConsent(APP, ['tcp.connect'])

    const after = new GrantLedger(storage)
    expect(after.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
    expect(after.declinedCapabilitiesFor('https://other.example')).toBeUndefined()
  })

  // Untrusted disk content, filtered rather than trusted whole -- a
  // hand-edited or corrupted file could name anything. An entry that is not
  // a real CapabilityKind is dropped, never passed through.
  it('an unrecognised capability name read off disk is dropped, not trusted', () => {
    const storage = memoryLedgerStorage()
    storage.declined.set(APP, ['tcp.connect', 'not-a-real-capability'])
    const ledger = new GrantLedger(storage)
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  // The safe collapse: if EVERY entry is unrecognised, this must read as
  // "never declined" (undefined), not as an empty-but-present array -- an
  // empty array would vacuously satisfy `capabilities.every(c =>
  // declined.includes(c))` for no manifest ever, so the distinction has no
  // live consequence today, but `undefined` is the honest reading of "storage
  // held nothing this ledger can trust" and is what every sibling hydration
  // (floor, rollback-ack, grants) already does on a corrupt read.
  it('a record with no recognisable capabilities hydrates as undefined, not an empty array', () => {
    const storage = memoryLedgerStorage()
    storage.declined.set(APP, ['not-a-real-capability'])
    const ledger = new GrantLedger(storage)
    expect(ledger.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  // A FAILED WRITE IS LOGGED, NEVER THROWN -- this value is advisory only
  // (A145), so a lost write costs one avoidable re-prompt, never a security
  // regression. Contrast with the version floor's own write, which DOES
  // throw (grant-ledger.test.ts's A57 suite) because that failure is
  // security-relevant.
  it('a persistence failure does not throw, and the in-memory record still lands', () => {
    const ledger = new GrantLedger(throwingDeclinedLedgerStorage())
    expect(() => { ledger.recordDeclinedConsent(APP, ['tcp.connect']) }).not.toThrow()
    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })
})

// A60/A23's "remove this app" forgets everything about an origin -- the
// decline record now included, matching the version floor, rollback
// acknowledgement and grants it already forgets alongside.
describe('GrantLedger -- forgetOrigin also clears the declined-consent record (A145)', () => {
  it('clears the in-memory record immediately', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    ledger.forgetOrigin(APP)
    expect(ledger.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('clears the persisted record so a later restart does not resurrect it', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.recordDeclinedConsent(APP, ['tcp.connect'])
    before.forgetOrigin(APP)

    const after = new GrantLedger(storage)
    expect(after.declinedCapabilitiesFor(APP)).toBeUndefined()
  })

  it('a failed disk delete leaves the in-memory decline record intact, exactly as it does for the floor', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger({
      ...storage,
      deleteDeclinedCapabilities: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }
    })
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])

    ledger.forgetOrigin(APP)

    expect(ledger.declinedCapabilitiesFor(APP)).toEqual(['tcp.connect'])
  })

  it('does not disturb a different origin\'s declined-consent record', () => {
    const ledger = new GrantLedger()
    ledger.recordDeclinedConsent(APP, ['tcp.connect'])
    ledger.recordDeclinedConsent('https://other.example', ['fs'])

    ledger.forgetOrigin(APP)

    expect(ledger.declinedCapabilitiesFor('https://other.example')).toEqual(['fs'])
  })
})
