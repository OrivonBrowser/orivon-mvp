// checkLookup -- orivon.net.lookup's own decision function (d-0030). See
// ../lookup.ts's own header for what differs from ./connect.test.ts and
// ./connect-secure.test.ts: no port, no resolved address, host portion only.

import { describe, expect, it } from 'vitest'
import { checkLookup } from '../lookup.js'
import { MAX_PATTERNS } from '../connect-preflight.js'

describe('checkLookup authorises a name by the HOST portion of a held pattern only', () => {
  it('denies when nothing was granted', () => {
    const decision = checkLookup([], 'api.example.com')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'not-declared' })
  })

  it('denies a non-array patterns value rather than throwing -- GrantLedger rehydration is untrusted shape', () => {
    // @ts-expect-error -- exercising the runtime guard against a bad shape a compile-time signature cannot rule out
    const decision = checkLookup('not-an-array', 'api.example.com')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'not-declared' })
  })

  it('denies more than MAX_PATTERNS rather than scanning them', () => {
    const patterns = Array.from({ length: MAX_PATTERNS + 1 }, () => '*:*')
    const decision = checkLookup(patterns, 'api.example.com')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'too-many-patterns' })
  })

  it('allows an exact hostname match regardless of the pattern\'s own port', () => {
    // A82's reserved-port carve-out narrows which PORT a pattern reaches;
    // lookup has no port at all, so a hostname granted only on port 25
    // (reserved for connect/connectSecure) still authorises its own lookup --
    // this lane's read of d-0030, see ../README.md's Design notes.
    const decision = checkLookup(['mail.example.com:25'], 'mail.example.com')
    expect(decision).toEqual({ allowed: true, hostname: 'mail.example.com' })
  })

  it('denies a hostname no held pattern names -- the exfiltration case', () => {
    const decision = checkLookup(['api.example.com:443'], 'what-i-stole.attacker.example')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('denies a hostname granted only under a DIFFERENT pattern in the same list', () => {
    const decision = checkLookup(['api.example.com:443', 'other.example.com:443'], 'evil.example.com')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('allows any hostname when the grant is the unlimited "*:*" pattern', () => {
    const decision = checkLookup(['*:*'], 'anything.example.org')
    expect(decision).toEqual({ allowed: true, hostname: 'anything.example.org' })
  })

  it('allows any hostname under a wildcard host paired with a narrow port', () => {
    // The host portion is '*' regardless of which port it is paired with --
    // this function never reads the port at all (see ../lookup.ts's header).
    const decision = checkLookup(['*:80'], 'anything.example.org')
    expect(decision).toEqual({ allowed: true, hostname: 'anything.example.org' })
  })

  it('denies an address-literal pattern authorising a NAME lookup -- a literal names one address, not a name to resolve', () => {
    const decision = checkLookup(['93.184.216.34:443'], 'evil.example.com')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('denies a sub-glob pattern -- authorises nothing, matching hostSpecKind', () => {
    const decision = checkLookup(['*.example.com:443'], 'api.example.com')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('normalises case and a trailing root dot the same way on both sides', () => {
    const decision = checkLookup(['API.Example.com:443'], 'api.example.com.')
    expect(decision).toEqual({ allowed: true, hostname: 'api.example.com' })
  })

  it('denies a non-string hostname rather than throwing', () => {
    // @ts-expect-error -- exercising the runtime guard
    const decision = checkLookup(['*:*'], 42)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'bad-host' })
  })

  it('denies an empty hostname', () => {
    const decision = checkLookup(['*:*'], '')
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'bad-host' })
  })
})
