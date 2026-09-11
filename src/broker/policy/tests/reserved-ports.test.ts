import { describe, expect, it } from 'vitest'
import { parsePattern } from '../connect-patterns.js'
import { RESERVED_PORTS, isReservedPort, patternNamesPortExactly } from '../reserved-ports.js'

describe('isReservedPort', () => {
  it('covers the mail submission ports', () => {
    expect([25, 465, 587].every(isReservedPort)).toBe(true)
  })

  it('covers DNS, IRC and the remote-access ports', () => {
    expect([53, 6667, 6697, 23, 139, 445, 3389].every(isReservedPort)).toBe(true)
  })

  it('leaves the ports an ordinary app actually uses alone', () => {
    expect([80, 443, 8080, 8443, 6881, 51413, 1, 65535].some(isReservedPort)).toBe(false)
  })

  it('is false for anything that is not a port number at all', () => {
    expect(isReservedPort(Number.NaN)).toBe(false)
    expect(isReservedPort(-25)).toBe(false)
  })
})

describe('patternNamesPortExactly', () => {
  it('is true when a pattern gives the port as a single literal', () => {
    expect(patternNamesPortExactly(parsePattern('smtp.example.com:25'), 25)).toBe(true)
  })

  it('is false for a wildcard port -- the case this rule exists for', () => {
    expect(patternNamesPortExactly(parsePattern('*:*'), 25)).toBe(false)
    expect(patternNamesPortExactly(parsePattern('mail.example.com:*'), 25)).toBe(false)
  })

  it('is false for a range that merely contains the port', () => {
    // A range is not a naming. `20-30` covers 25 without anyone having read
    // the number, which is exactly the blanket `*` is.
    expect(patternNamesPortExactly(parsePattern('host.example:20-30'), 25)).toBe(false)
    expect(patternNamesPortExactly(parsePattern('host.example:1-65535'), 25)).toBe(false)
  })

  it('is false for a single-port pattern naming a DIFFERENT port', () => {
    expect(patternNamesPortExactly(parsePattern('host.example:587'), 25)).toBe(false)
  })

  it('is false for an unparseable or null pattern rather than treating it as a naming', () => {
    expect(patternNamesPortExactly(parsePattern('not-a-pattern'), 25)).toBe(false)
    expect(patternNamesPortExactly(parsePattern('::1:25'), 25)).toBe(false)
    expect(patternNamesPortExactly(null, 25)).toBe(false)
  })

  it('reads the port out of a bracketed IPv6 pattern too', () => {
    expect(patternNamesPortExactly(parsePattern('[2606:4700::1111]:53'), 53)).toBe(true)
  })

  it('says nothing about the host -- it is decided per pattern, never across a set', () => {
    // The function this replaced scanned a WHOLE pattern list and answered
    // "did ANY pattern name this port", independently of which pattern went
    // on to match the host. That let a naming in one pattern authorise a
    // completely different pattern's host match -- a grant of
    // `['mail.example.com:25', '*:*']` reached an unrelated host at port 25
    // (docs/open-questions.md A82, the cross-pattern bypass). Being
    // per-pattern removes the seam: this only ever answers for the ONE
    // pattern handed to it, so a caller can no longer mix the naming from one
    // pattern with the host authorisation from another. See
    // ../tests/connect.test.ts and ../tests/connect-secure.test.ts for the
    // caller-level regression coverage of that bypass.
    expect(patternNamesPortExactly(parsePattern('unrelated.example:25'), 25)).toBe(true)
  })
})

describe('the reserved set itself', () => {
  it('is exactly the owner-approved list, so a silent addition fails here', () => {
    expect([...RESERVED_PORTS].sort((a, b) => a - b)).toEqual([23, 25, 53, 139, 445, 465, 587, 3389, 6667, 6697])
  })
})
