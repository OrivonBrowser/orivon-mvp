import { describe, expect, it } from 'vitest'
import { parsePattern } from '../connect-patterns.js'
import { RESERVED_PORTS, isReservedPort, namesPortExactly } from '../reserved-ports.js'

function parse (patterns: readonly string[]): ReturnType<typeof parsePattern>[] {
  return patterns.map(parsePattern)
}

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

describe('namesPortExactly', () => {
  it('is true when a pattern gives the port as a single literal', () => {
    expect(namesPortExactly(parse(['smtp.example.com:25']), 25)).toBe(true)
  })

  it('is false for a wildcard port -- the case this rule exists for', () => {
    expect(namesPortExactly(parse(['*:*']), 25)).toBe(false)
    expect(namesPortExactly(parse(['mail.example.com:*']), 25)).toBe(false)
  })

  it('is false for a range that merely contains the port', () => {
    // A range is not a naming. `20-30` covers 25 without anyone having read
    // the number, which is exactly the blanket this rule is about.
    expect(namesPortExactly(parse(['host.example:20-30']), 25)).toBe(false)
    expect(namesPortExactly(parse(['host.example:1-65535']), 25)).toBe(false)
  })

  it('is false for a single-port pattern naming a DIFFERENT port', () => {
    expect(namesPortExactly(parse(['host.example:587']), 25)).toBe(false)
  })

  it('is true when any one pattern in the list names it, not only the first', () => {
    expect(namesPortExactly(parse(['*:*', 'a.example:80', 'smtp.example:25']), 25)).toBe(true)
  })

  it('ignores unparseable patterns rather than treating them as a naming', () => {
    expect(namesPortExactly(parse(['', 'not-a-pattern', '::1:25']), 25)).toBe(false)
  })

  it('reads the port out of a bracketed IPv6 pattern too', () => {
    expect(namesPortExactly(parse(['[2606:4700::1111]:53']), 53)).toBe(true)
  })

  it('does not care about the host half -- that is hostMatches\' job', () => {
    // Deliberate: this answers "did anyone name this port", nothing else. The
    // host still has to match separately, so a naming here cannot widen
    // authority on its own.
    expect(namesPortExactly(parse(['unrelated.example:25']), 25)).toBe(true)
  })
})

describe('the reserved set itself', () => {
  it('is exactly the owner-approved list, so a silent addition fails here', () => {
    expect([...RESERVED_PORTS].sort((a, b) => a - b)).toEqual([23, 25, 53, 139, 445, 465, 587, 3389, 6667, 6697])
  })
})
