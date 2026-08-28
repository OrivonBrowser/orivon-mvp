import { describe, expect, it } from 'vitest'
import { classifyAddress, isPublicUnicast } from './address.js'
import { IPV4_ENCODINGS, IPV4_RANGES, IPV6_EMBEDDED_V4, IPV6_RANGES, MALFORMED, PUBLIC, type Row } from './address-vectors.js'

// The table IS the test. security-model.md T12 fails SILENTLY -- a missed
// encoding returns "public" for an address that reaches localhost, nothing
// throws, nothing logs, and the connection succeeds. Examples would pass
// against a half-right implementation; a table that names every range, both
// of its edges, the address one step outside it, and every legal spelling of
// 127.0.0.1 will not.
//
// Rows assert the CLASS, not just the boolean. A row that lands in the wrong
// range still answers "blocked", and that is how a table quietly rots into
// something that blocks 8.8.8.8 or stops blocking 169.254.169.254.

// ---------------------------------------------------------------------------

const BLOCKED_TABLES: readonly Row[] = [
  ...IPV4_RANGES,
  ...IPV4_ENCODINGS,
  ...IPV6_RANGES,
  ...IPV6_EMBEDDED_V4,
  ...PUBLIC
]

describe('classifyAddress', () => {
  describe('IPv4 ranges and their edges', () => {
    it.each(IPV4_RANGES)('$addr is $cls ($why)', ({ addr, cls }) => {
      expect(classifyAddress(addr)).toBe(cls)
    })
  })

  describe('IPv4 alternate encodings -- the silent bypass', () => {
    it.each(IPV4_ENCODINGS)('$addr is $cls ($why)', ({ addr, cls }) => {
      expect(classifyAddress(addr)).toBe(cls)
    })
  })

  describe('IPv6 ranges', () => {
    it.each(IPV6_RANGES)('$addr is $cls ($why)', ({ addr, cls }) => {
      expect(classifyAddress(addr)).toBe(cls)
    })
  })

  describe('IPv4 hidden inside IPv6', () => {
    it.each(IPV6_EMBEDDED_V4)('$addr is $cls ($why)', ({ addr, cls }) => {
      expect(classifyAddress(addr)).toBe(cls)
    })
  })

  describe('ordinary public addresses are NOT flagged', () => {
    it.each(PUBLIC)('$addr is public ($why)', ({ addr }) => {
      expect(classifyAddress(addr)).toBe('public')
    })
  })

  describe('malformed input', () => {
    it.each(MALFORMED)('%j does not throw and is not public', (addr) => {
      expect(() => classifyAddress(addr)).not.toThrow()
      expect(classifyAddress(addr)).toBe('unparseable')
    })
  })

  describe('input length is bounded before any regex sees it', () => {
    // Without this the bound is free to drift upward, and the whole DoS
    // argument for this file rests on it: every regex here is anchored and
    // non-backtracking, but that is only cheap because the input is short.
    it('the longest real IPv6 literal still fits', () => {
      const longest = 'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255'
      expect(longest.length).toBe(45)
      expect(classifyAddress(longest)).not.toBe('unparseable')
    })

    it('that literal bracketed and carrying a Linux-length zone id still fits', () => {
      // 45 + 2 brackets + '%' + a 15-character interface name = 63.
      const padded = `[fe80:ffff:ffff:ffff:ffff:ffff:255.255.255.255%${'e'.repeat(15)}]`
      expect(padded.length).toBeLessThanOrEqual(64)
      expect(classifyAddress(padded)).toBe('link-local')
    })

    it('a VALID address made overlong is rejected on length, not on syntax', () => {
      // A zone id is stripped before parsing, so this address is perfectly
      // well-formed and would classify as loopback but for its length. That
      // is what makes it discriminating: a test using malformed input would
      // pass with the bound raised or removed entirely.
      const overlong = `::1%${'e'.repeat(70)}`
      expect(overlong.length).toBeGreaterThan(64)
      expect(classifyAddress(overlong)).toBe('unparseable')
      expect(classifyAddress('::1%eth0')).toBe('loopback')
    })

    it('a megabyte of digits short-circuits instead of parsing', () => {
      expect(classifyAddress('1'.repeat(1_000_000))).toBe('unparseable')
    })
  })
})

describe('isPublicUnicast', () => {
  it.each(BLOCKED_TABLES)('$addr: true only when the class is public ($why)', ({ addr, cls }) => {
    expect(isPublicUnicast(addr)).toBe(cls === 'public')
  })

  it.each(MALFORMED)('%j is not public unicast', (addr) => {
    expect(isPublicUnicast(addr)).toBe(false)
  })

  // The property the NAME exists to protect. `isPrivateAddress` answered the
  // same question inverted, and an app that declares private ranges has to
  // widen the check somewhere -- at which point `!isPrivateAddress(addr)`
  // puts UNPARSEABLE input on the allow side. Asked this way round, widening
  // means naming the classes you accept, and 'unparseable' is never one of
  // them. That is the shape `connect.ts` must use, and its tests enforce it
  // at the call site; here we only pin the primitive both shapes rest on.
  it.each(MALFORMED)('%j is never reachable, whatever an app declares', (addr) => {
    // Neither branch of a widened check can admit it: not public unicast, and
    // not any nameable class either.
    expect(isPublicUnicast(addr)).toBe(false)
    expect(classifyAddress(addr)).toBe('unparseable')
  })

  // The headline case, called out separately so a future edit that breaks it
  // fails against a test named after the thing it protects.
  it.each([
    '169.254.169.254',
    '2852039166',
    '0xa9fea9fe',
    '0251.0376.0251.0376',
    '0xa9.0xfe.0xa9.0xfe',
    '169.254.43518',
    '169.16689662',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '64:ff9b::169.254.169.254'
  ])('blocks the cloud metadata endpoint written as %s', (addr) => {
    expect(isPublicUnicast(addr)).toBe(false)
  })

  // Cheap insurance for the "never throws" half of the contract: the table
  // above covers the malformed shapes anyone thought of, and this covers the
  // ones nobody did. Deterministic -- a flaky security test gets deleted.
  it('never throws on generated junk, and never calls it public', () => {
    const alphabet = '0123456789abcdefxX.:%[]/-+ \tg\u{ff11}'
    let seed = 0x2545f491

    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0
      return seed >>> 1
    }

    // Junk that happens to spell a real address is the one legitimate way to
    // reach `true`; assert the fail-closed property against everything else,
    // rather than only that a boolean came back.
    let publicCount = 0
    for (let i = 0; i < 2000; i++) {
      let junk = ''
      const length = next() % 24
      for (let j = 0; j < length; j++) junk += alphabet[next() % alphabet.length] ?? ''

      expect(() => isPublicUnicast(junk)).not.toThrow()
      const verdict = isPublicUnicast(junk)
      expect(typeof verdict).toBe('boolean')

      // FAIL CLOSED: true is permitted only for something that really parses
      // to a public unicast address, never as a side effect of a parse slip.
      if (verdict) {
        publicCount++
        expect(classifyAddress(junk)).toBe('public')
      }
    }

    // Guards the assertion above from becoming vacuous: if a future change
    // made everything unparseable, the loop would still pass.
    expect(publicCount).toBeGreaterThan(0)
  })
})
