// checkConnectSecure -- the https.connect twin of ./connect.test.ts, testing
// the ONE thing that differs from checkConnect (its own header, and
// ../connect-secure.ts's): patterns are matched against the HOSTNAME ITSELF,
// never a resolved address, because ADR-0017's certificate/hostname
// verification is what does the binding a resolved-address match exists to
// approximate for plain TCP. There is no resolver here at all -- every case
// below is synchronous.

import { describe, expect, it } from 'vitest'
import { checkConnectSecure } from '../connect-secure.js'
import { MAX_PATTERNS } from '../connect.js'

describe('checkConnectSecure authorises by hostname, never by resolved address', () => {
  it('denies when nothing was granted', () => {
    const decision = checkConnectSecure([], 'api.example.com', 443)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'not-declared' })
  })

  it('denies a non-array patterns value rather than throwing -- GrantLedger rehydration is untrusted shape', () => {
    // @ts-expect-error -- exercising the runtime guard against a bad shape a compile-time signature cannot rule out
    const decision = checkConnectSecure('not-an-array', 'api.example.com', 443)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'not-declared' })
  })

  it('denies more than MAX_PATTERNS rather than scanning them', () => {
    const patterns = Array.from({ length: MAX_PATTERNS + 1 }, () => '*:*')
    const decision = checkConnectSecure(patterns, 'api.example.com', 443)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'too-many-patterns' })
  })

  it('allows an exact hostname:port match and echoes back the normalised host', () => {
    const decision = checkConnectSecure(['api.example.com:443'], 'api.example.com', 443)
    expect(decision).toEqual({ allowed: true, host: 'api.example.com' })
  })

  it('denies a hostname the granted pattern does not name', () => {
    const decision = checkConnectSecure(['api.example.com:443'], 'evil.example.com', 443)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('denies the right host at the wrong port', () => {
    const decision = checkConnectSecure(['api.example.com:443'], 'api.example.com', 8443)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('normalises case and a trailing root dot the same way on both sides', () => {
    const decision = checkConnectSecure(['API.Example.com:443'], 'api.example.com.', 443)
    expect(decision).toEqual({ allowed: true, host: 'api.example.com' })
  })

  it('"*" authorises any hostname at a matching port -- the unlimited-HTTPS declaration ADR-0017 permits', () => {
    const decision = checkConnectSecure(['*:*'], 'anything.example', 443)
    expect(decision).toEqual({ allowed: true, host: 'anything.example' })
  })

  it('never grants the cross product of host and port across two different patterns', () => {
    const patterns = ['a.example:443', 'b.example:8080']
    expect(checkConnectSecure(patterns, 'a.example', 8080)).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
    expect(checkConnectSecure(patterns, 'b.example', 443)).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('an address-literal pattern authorises only that exact literal, not a hostname that might resolve there', () => {
    const patterns = ['203.0.113.5:443']
    expect(checkConnectSecure(patterns, '203.0.113.5', 443)).toEqual({ allowed: true, host: '203.0.113.5' })
    expect(checkConnectSecure(patterns, '203.0.113.6', 443)).toEqual({ allowed: false, code: 'denied', reason: 'no-pattern-match' })
  })

  it('denies a non-canonical address literal rather than silently normalising it', () => {
    // Leading zero octet -- ../address.ts's canonicalAddress does not accept this spelling.
    const decision = checkConnectSecure(['*:*'], '203.000.113.5', 443)
    expect(decision).toEqual({ allowed: false, code: 'denied', reason: 'non-canonical-host' })
  })

  it('matches a bracketed IPv6 pattern against the unbracketed literal the app asked for', () => {
    const decision = checkConnectSecure(['[::1]:8443'], '::1', 8443)
    expect(decision).toEqual({ allowed: true, host: '::1' })
  })

  it('matches a port range', () => {
    const decision = checkConnectSecure(['api.example.com:8000-9000'], 'api.example.com', 8443)
    expect(decision).toEqual({ allowed: true, host: 'api.example.com' })
  })

  it('rejects a bad port', () => {
    expect(checkConnectSecure(['*:*'], 'api.example.com', 0)).toEqual({ allowed: false, code: 'denied', reason: 'bad-port' })
    expect(checkConnectSecure(['*:*'], 'api.example.com', 70000)).toEqual({ allowed: false, code: 'denied', reason: 'bad-port' })
  })

  it('rejects a non-string, empty or non-ASCII host', () => {
    // @ts-expect-error -- exercising the runtime guard against a non-string host
    expect(checkConnectSecure(['*:*'], 42, 443)).toEqual({ allowed: false, code: 'denied', reason: 'bad-host' })
    expect(checkConnectSecure(['*:*'], '', 443)).toEqual({ allowed: false, code: 'denied', reason: 'bad-host' })
    expect(checkConnectSecure(['*:*'], 'exämple.com', 443)).toEqual({ allowed: false, code: 'denied', reason: 'bad-host' })
  })

  it('A82: a blanket "*:*" grant does not reach a reserved port unless a pattern names it exactly', () => {
    expect(checkConnectSecure(['*:*'], 'mail.example.com', 25)).toEqual({ allowed: false, code: 'denied', reason: 'reserved-port' })
    expect(checkConnectSecure(['*:25'], 'mail.example.com', 25)).toEqual({ allowed: true, host: 'mail.example.com' })
  })
})
