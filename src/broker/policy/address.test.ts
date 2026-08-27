import { describe, expect, it } from 'vitest'
import { classifyAddress, isPublicUnicast, type AddressClass } from './address.js'

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

interface Row {
  readonly addr: string
  readonly cls: AddressClass
  readonly why: string
}

// ---------------------------------------------------------------------------
// IPv4: every blocked range, both edges, and the address one step outside.
// ---------------------------------------------------------------------------

const IPV4_RANGES: readonly Row[] = [
  { addr: '0.0.0.0', cls: 'unspecified', why: '0.0.0.0/8 first' },
  { addr: '0.255.255.255', cls: 'unspecified', why: '0.0.0.0/8 last' },
  { addr: '1.0.0.0', cls: 'public', why: 'one past 0.0.0.0/8' },

  { addr: '9.255.255.255', cls: 'public', why: 'one below 10.0.0.0/8' },
  { addr: '10.0.0.0', cls: 'private', why: 'RFC 1918 10/8 first' },
  { addr: '10.255.255.255', cls: 'private', why: 'RFC 1918 10/8 last' },
  { addr: '11.0.0.0', cls: 'public', why: 'one past 10.0.0.0/8' },

  { addr: '100.63.255.255', cls: 'public', why: 'one below 100.64.0.0/10' },
  { addr: '100.64.0.0', cls: 'reserved', why: 'RFC 6598 carrier-grade NAT first' },
  { addr: '100.127.255.255', cls: 'reserved', why: 'RFC 6598 carrier-grade NAT last' },
  { addr: '100.128.0.0', cls: 'public', why: 'one past 100.64.0.0/10' },

  { addr: '126.255.255.255', cls: 'public', why: 'one below 127.0.0.0/8' },
  { addr: '127.0.0.0', cls: 'loopback', why: '127/8 first' },
  { addr: '127.0.0.1', cls: 'loopback', why: 'the one everybody means' },
  { addr: '127.255.255.255', cls: 'loopback', why: '127/8 last -- NOT just 127.0.0.1' },
  { addr: '128.0.0.0', cls: 'public', why: 'one past 127.0.0.0/8' },

  { addr: '169.253.255.255', cls: 'public', why: 'one below 169.254.0.0/16' },
  { addr: '169.254.0.0', cls: 'link-local', why: 'RFC 3927 first' },
  { addr: '169.254.169.254', cls: 'link-local', why: 'THE cloud metadata endpoint' },
  { addr: '169.254.255.255', cls: 'link-local', why: 'RFC 3927 last' },
  { addr: '169.255.0.0', cls: 'public', why: 'one past 169.254.0.0/16' },

  { addr: '172.15.255.255', cls: 'public', why: 'one below 172.16.0.0/12' },
  { addr: '172.16.0.0', cls: 'private', why: 'RFC 1918 172.16/12 first' },
  { addr: '172.31.255.255', cls: 'private', why: 'RFC 1918 172.16/12 last -- /12, not /16' },
  { addr: '172.32.0.0', cls: 'public', why: 'one past 172.16.0.0/12' },

  { addr: '192.0.0.1', cls: 'reserved', why: 'IETF protocol assignments' },
  { addr: '192.0.2.1', cls: 'reserved', why: 'TEST-NET-1' },
  { addr: '192.88.99.1', cls: 'reserved', why: 'deprecated 6to4 relay anycast' },

  { addr: '192.167.255.255', cls: 'public', why: 'one below 192.168.0.0/16' },
  { addr: '192.168.0.0', cls: 'private', why: 'RFC 1918 192.168/16 first' },
  { addr: '192.168.1.1', cls: 'private', why: 'the home router' },
  { addr: '192.168.255.255', cls: 'private', why: 'RFC 1918 192.168/16 last' },
  { addr: '192.169.0.0', cls: 'public', why: 'one past 192.168.0.0/16' },

  { addr: '198.17.255.255', cls: 'public', why: 'one below 198.18.0.0/15' },
  { addr: '198.18.0.0', cls: 'reserved', why: 'benchmarking first' },
  { addr: '198.19.255.255', cls: 'reserved', why: 'benchmarking last -- /15, not /16' },
  { addr: '198.20.0.0', cls: 'public', why: 'one past 198.18.0.0/15' },

  { addr: '198.51.100.1', cls: 'reserved', why: 'TEST-NET-2' },
  { addr: '203.0.113.1', cls: 'reserved', why: 'TEST-NET-3' },

  { addr: '223.255.255.255', cls: 'public', why: 'one below 224.0.0.0/4' },
  { addr: '224.0.0.0', cls: 'multicast', why: 'multicast first' },
  { addr: '224.0.0.1', cls: 'multicast', why: 'all-hosts group' },
  { addr: '239.255.255.255', cls: 'multicast', why: 'multicast last' },
  { addr: '240.0.0.0', cls: 'reserved', why: 'reserved for future use, first' },
  { addr: '255.255.255.254', cls: 'reserved', why: 'reserved for future use, last before broadcast' },
  { addr: '255.255.255.255', cls: 'broadcast', why: 'limited broadcast beats the enclosing 240/4 row' }
]

// ---------------------------------------------------------------------------
// The encodings. This block is the reason the file exists: every row below is
// 127.0.0.1 or 169.254.169.254, and a dotted-decimal-only checker passes all
// of them straight through to the socket.
// ---------------------------------------------------------------------------

const IPV4_ENCODINGS: readonly Row[] = [
  { addr: '2130706433', cls: 'loopback', why: '127.0.0.1 as one decimal integer' },
  { addr: '0x7f000001', cls: 'loopback', why: '127.0.0.1 as one hex integer' },
  { addr: '0X7F000001', cls: 'loopback', why: 'uppercase 0X and uppercase digits' },
  { addr: '017700000001', cls: 'loopback', why: '127.0.0.1 as one octal integer' },
  { addr: '0177.0.0.1', cls: 'loopback', why: 'octal first octet' },
  { addr: '0x7f.0.0.1', cls: 'loopback', why: 'hex first octet' },
  { addr: '0x7F.0x0.0x0.0x1', cls: 'loopback', why: 'every octet in hex' },
  { addr: '0177.0000.0000.0001', cls: 'loopback', why: 'every octet in octal' },
  { addr: '127.000.000.001', cls: 'loopback', why: 'zero-padded octets are octal, and still 127.0.0.1' },
  { addr: '127.1', cls: 'loopback', why: 'inet_aton two-part form -- what `ping 127.1` reaches' },
  { addr: '127.0.1', cls: 'loopback', why: 'inet_aton three-part form' },
  { addr: '10.1', cls: 'private', why: 'short form of an RFC 1918 address' },
  { addr: '3232235777', cls: 'private', why: '192.168.1.1 as one integer' },
  { addr: '4294967295', cls: 'broadcast', why: '255.255.255.255 as one integer, the maximum' },

  { addr: '2852039166', cls: 'link-local', why: 'cloud metadata as one decimal integer' },
  { addr: '0xa9fea9fe', cls: 'link-local', why: 'cloud metadata as one hex integer' },
  { addr: '0xa9.0xfe.0xa9.0xfe', cls: 'link-local', why: 'cloud metadata, every octet in hex' },
  { addr: '0251.0376.0251.0376', cls: 'link-local', why: 'cloud metadata, every octet in octal' },
  { addr: '169.254.43518', cls: 'link-local', why: 'cloud metadata, three-part form' },
  { addr: '169.16689662', cls: 'link-local', why: 'cloud metadata, two-part form' },

  // The leniency must not swing the other way and start blocking the internet.
  { addr: '0x08080808', cls: 'public', why: '8.8.8.8 in hex is still public' },
  { addr: '134744072', cls: 'public', why: '8.8.8.8 as one integer is still public' },
  { addr: '0x01010101', cls: 'public', why: '1.1.1.1 in hex is still public' }
]

// ---------------------------------------------------------------------------
// IPv6, including every way a v4 address can hide inside one.
// ---------------------------------------------------------------------------

const IPV6_RANGES: readonly Row[] = [
  { addr: '::', cls: 'unspecified', why: 'the unspecified address' },
  { addr: '::1', cls: 'loopback', why: 'IPv6 loopback' },
  { addr: '0:0:0:0:0:0:0:1', cls: 'loopback', why: 'IPv6 loopback, uncompressed' },
  { addr: '0000:0000:0000:0000:0000:0000:0000:0001', cls: 'loopback', why: 'IPv6 loopback, fully padded' },
  { addr: '[::1]', cls: 'loopback', why: 'the bracketed URL host form' },
  { addr: '::1%1', cls: 'loopback', why: 'with a numeric zone id' },

  { addr: 'fc00::', cls: 'private', why: 'unique local first' },
  { addr: 'fc00::1', cls: 'private', why: 'unique local' },
  { addr: 'fd00::1', cls: 'private', why: 'the half of fc00::/7 that is actually used' },
  { addr: 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', cls: 'private', why: 'unique local last -- /7, not /8' },
  { addr: 'FD00::1', cls: 'private', why: 'uppercase is the same address' },

  { addr: 'fe80::1', cls: 'link-local', why: 'IPv6 link-local' },
  { addr: 'FE80::1', cls: 'link-local', why: 'uppercase link-local' },
  { addr: 'fe80::1%eth0', cls: 'link-local', why: 'link-local with a named zone id' },
  { addr: 'febf:ffff::1', cls: 'link-local', why: 'link-local last -- /10, not /16' },
  { addr: 'fec0::1', cls: 'reserved', why: 'deprecated site-local' },

  { addr: 'ff00::', cls: 'multicast', why: 'multicast first' },
  { addr: 'ff02::1', cls: 'multicast', why: 'all-nodes link-local multicast' },

  { addr: '100::1', cls: 'reserved', why: 'discard-only prefix' },
  { addr: '64:ff9b:1::1', cls: 'reserved', why: 'local-use NAT64' },
  { addr: '2001::1', cls: 'reserved', why: 'Teredo' },
  { addr: '2001:2::1', cls: 'reserved', why: 'benchmarking' },
  { addr: '2001:10::1', cls: 'reserved', why: 'deprecated ORCHID' },
  { addr: '2001:20::1', cls: 'reserved', why: 'ORCHIDv2' },
  { addr: '2001:db8::1', cls: 'reserved', why: 'documentation' },
  { addr: '2001:0db8:85a3::8a2e:370:7334', cls: 'reserved', why: 'the documentation address everyone copies' },
  { addr: '3fff::1', cls: 'reserved', why: 'RFC 9637 documentation' },
  { addr: '5f00::1', cls: 'reserved', why: 'SRv6 segment routing' },

  // Default deny outside 2000::/3. Without this row a prefix delegated after
  // this file was written becomes reachable the day IANA assigns it.
  { addr: '1fff:ffff::1', cls: 'reserved', why: 'below 2000::/3 -- unassigned, denied by default' },
  { addr: '4000::1', cls: 'reserved', why: 'above 2000::/3 -- unassigned, denied by default' },
  { addr: 'fbff::1', cls: 'reserved', why: 'one below fc00::/7, and still not global unicast' }
]

const IPV6_EMBEDDED_V4: readonly Row[] = [
  { addr: '::ffff:127.0.0.1', cls: 'loopback', why: 'THE classic bypass: IPv4-mapped loopback' },
  { addr: '::ffff:7f00:1', cls: 'loopback', why: 'the same address written in hex groups' },
  { addr: '::FFFF:7F00:0001', cls: 'loopback', why: 'the same address, uppercase' },
  { addr: '[::ffff:127.0.0.1]', cls: 'loopback', why: 'IPv4-mapped loopback, bracketed' },
  { addr: '0:0:0:0:0:ffff:127.0.0.1', cls: 'loopback', why: 'IPv4-mapped loopback, uncompressed' },
  { addr: '::ffff:169.254.169.254', cls: 'link-local', why: 'IPv4-mapped cloud metadata' },
  { addr: '::ffff:a9fe:a9fe', cls: 'link-local', why: 'IPv4-mapped cloud metadata, hex groups' },
  { addr: '::ffff:192.168.1.1', cls: 'private', why: 'IPv4-mapped RFC 1918' },
  { addr: '::ffff:10.0.0.1', cls: 'private', why: 'IPv4-mapped RFC 1918' },
  { addr: '::ffff:0:0', cls: 'unspecified', why: 'IPv4-mapped 0.0.0.0' },

  { addr: '2002:7f00:1::', cls: 'loopback', why: '6to4 wrapper around 127.0.0.1' },
  { addr: '2002:c0a8:101::', cls: 'private', why: '6to4 wrapper around 192.168.1.1' },
  { addr: '64:ff9b::127.0.0.1', cls: 'loopback', why: 'NAT64 well-known prefix over loopback' },
  { addr: '64:ff9b::7f00:1', cls: 'loopback', why: 'NAT64 over loopback, hex groups' },
  { addr: '64:ff9b::169.254.169.254', cls: 'link-local', why: 'NAT64 over cloud metadata' },

  { addr: '::127.0.0.1', cls: 'reserved', why: 'deprecated IPv4-compatible form, blocked wholesale' },
  { addr: '::8.8.8.8', cls: 'reserved', why: '::/96 is deprecated, so even a public v4 inside it is denied' },

  // Delegating to the v4 table rather than blanket-denying is what keeps these
  // three public -- Node hands back ::ffff: forms for a dual-stack lookup.
  { addr: '::ffff:8.8.8.8', cls: 'public', why: 'IPv4-mapped public address stays public' },
  { addr: '::ffff:0808:0808', cls: 'public', why: 'the same, in hex groups' },
  { addr: '2002:808:808::', cls: 'public', why: '6to4 over a public address stays public' },
  { addr: '64:ff9b::8.8.8.8', cls: 'public', why: 'NAT64 over a public address stays public' }
]

const PUBLIC: readonly Row[] = [
  { addr: '8.8.8.8', cls: 'public', why: 'Google DNS' },
  { addr: '1.1.1.1', cls: 'public', why: 'Cloudflare DNS' },
  { addr: '9.9.9.9', cls: 'public', why: 'Quad9' },
  { addr: '93.184.216.34', cls: 'public', why: 'an ordinary web server' },
  { addr: '208.67.222.222', cls: 'public', why: 'OpenDNS' },
  { addr: '2606:4700::1111', cls: 'public', why: 'Cloudflare DNS over IPv6' },
  { addr: '2001:4860:4860::8888', cls: 'public', why: 'Google DNS over IPv6 -- 2001: prefixed but NOT Teredo' },
  { addr: '2000::', cls: 'public', why: 'the first global unicast address' },
  { addr: '[2606:4700::1111]', cls: 'public', why: 'bracketed public IPv6' },
  { addr: '  8.8.8.8  ', cls: 'public', why: 'surrounding whitespace is trimmed' }
]

// ---------------------------------------------------------------------------
// Malformed input. Must never throw, and must never read as public: an
// unparseable string is a caller bug or someone hunting for an encoding the
// table does not know, and neither earns the benefit of the doubt.
// ---------------------------------------------------------------------------

const MALFORMED: readonly string[] = [
  '',
  '   ',
  '\t\n',
  'localhost',
  'example.com',
  'not an address',
  '999.999.999.999',
  '256.0.0.1',
  '127.0.0.256',
  '127.0.0.1.1',
  '127.0.0.',
  '.127.0.0.1',
  '127..0.1',
  '4294967296', // one past the largest 32-bit address
  '0x100000000',
  '99999999999999999999999999',
  '-1',
  '+127.0.0.1',
  '08.0.0.1', // a leading zero means octal, and 8 is not an octal digit
  '0x',
  '0b1111111', // inet_aton knows decimal, octal and hex -- not binary
  '127.0.0.1:8080', // a port: the caller splits host from port, not this function
  '\u{ff11}\u{ff12}\u{ff17}.0.0.1', // fullwidth digits are not digits
  '::gggg',
  '12345::1',
  '1:2:3:4:5:6:7',
  '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:7:8::',
  '::1::2',
  ':::1',
  ':1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7:8:',
  '1.2.3.4::',
  '::1.2.3.4.5',
  '::ffff:127.0.0',
  '::ffff:0177.0.0.1', // inet_pton rejects octal inside a literal, so we do too
  '::ffff:127.0.0.01',
  '::ffff:0x7f.0.0.1',
  '[::1',
  '::1]',
  '%eth0',
  'x'.repeat(200)
]

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
