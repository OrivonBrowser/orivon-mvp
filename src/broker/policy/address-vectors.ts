// The address classification vector tables, split out of ./address.test.ts
// (docs/development/code-guidelines.md's guidance to move a vector table into
// a sibling data module before a test file approaches its line limit --
// address.test.ts is well under it today, but this is the largest table in
// the repo's test suite and the split makes each row individually reviewable
// and type-checked against AddressClass). See address.test.ts's header for
// why the table IS the test.

import type { AddressClass } from './address.js'

export interface Row {
  readonly addr: string
  readonly cls: AddressClass
  readonly why: string
}

// ---------------------------------------------------------------------------
// IPv4: every blocked range, both edges, and the address one step outside.
// ---------------------------------------------------------------------------

export const IPV4_RANGES: readonly Row[] = [
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

export const IPV4_ENCODINGS: readonly Row[] = [
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

export const IPV6_RANGES: readonly Row[] = [
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

export const IPV6_EMBEDDED_V4: readonly Row[] = [
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

export const PUBLIC: readonly Row[] = [
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

// ---------------------------------------------------------------------------
// canonicalAddress: the single spelling, not just a classification
// (docs/open-questions.md A20). The same address can appear in the tables
// above AND here with a different assertion -- classifyAddress cares only
// what range it names, canonicalAddress cares what it is spelled as.
// ---------------------------------------------------------------------------

export interface CanonicalRow {
  readonly addr: string
  /** null means canonicalAddress refuses the input outright -- see address.ts. */
  readonly canonical: string | null
  readonly why: string
}

export const CANONICAL_FORMS: readonly CanonicalRow[] = [
  // Already canonical: round-trips to itself.
  { addr: '127.0.0.1', canonical: '127.0.0.1', why: 'ordinary dotted quad' },
  { addr: '0.0.0.0', canonical: '0.0.0.0', why: 'the all-zero address' },
  { addr: '255.255.255.255', canonical: '255.255.255.255', why: 'the all-one address' },
  { addr: '::1', canonical: '::1', why: 'IPv6 loopback, already compressed' },
  { addr: '::', canonical: '::', why: 'the unspecified address, already compressed' },
  { addr: '2606:4700::1111', canonical: '2606:4700::1111', why: 'an ordinary public IPv6 address' },
  {
    addr: '::ffff:127.0.0.1',
    canonical: '::ffff:127.0.0.1',
    why: 'IPv4-mapped, already in the RFC 5952 SS5 dotted-quad form'
  },

  // The task's own non-canonical spellings (docs/open-questions.md A20):
  // NORMALISE, do not reject -- decided so the grant prompt and
  // policy/update.ts's pattern comparison have a value to work with, rather
  // than a denial with nothing to render or compare.
  { addr: '0177.0.0.1', canonical: '127.0.0.1', why: 'octal first octet' },
  { addr: '2130706433', canonical: '127.0.0.1', why: 'loopback as one decimal integer' },
  { addr: '0x7f.0.0.1', canonical: '127.0.0.1', why: 'hex first octet' },
  { addr: '127.1', canonical: '127.0.0.1', why: 'inet_aton short form' },
  {
    addr: '::ffff:7f00:1',
    canonical: '::ffff:127.0.0.1',
    why: 'IPv4-mapped loopback, hex groups instead of the recommended dotted quad'
  },

  // Further normalisation the same design implies, beyond the task's list.
  { addr: '  127.0.0.1  ', canonical: '127.0.0.1', why: 'surrounding whitespace' },
  { addr: '[::1]', canonical: '::1', why: 'the bracketed URL host form' },
  { addr: '::FFFF:7F00:0001', canonical: '::ffff:127.0.0.1', why: 'uppercase, and hex groups' },
  { addr: '0:0:0:0:0:ffff:127.0.0.1', canonical: '::ffff:127.0.0.1', why: 'IPv4-mapped, fully uncompressed' },
  { addr: '10.1', canonical: '10.0.0.1', why: 'a PRIVATE address in inet_aton short form' },
  { addr: '0x08080808', canonical: '8.8.8.8', why: 'a PUBLIC address in hex -- normalisation is not only about blocked ranges' },

  // RFC 5952 SS4.2's compression rule has a tie-break (leftmost run wins) and
  // a floor (a single zero word is never compressed) that nothing above
  // exercises.
  {
    addr: '1:0:0:2:0:0:0:3',
    canonical: '1:0:0:2::3',
    why: 'the longer run (3 words) compresses, not the shorter (2 words)'
  },
  {
    addr: '1:0:0:2:0:0:3:4',
    canonical: '1::2:0:0:3:4',
    why: 'a tie between two 2-word runs: the LEFTMOST one compresses'
  },
  {
    addr: '1:0:2:3:4:5:6:7',
    canonical: '1:0:2:3:4:5:6:7',
    why: 'a single zero word is never compressed -- ":0:" is exactly as long as "::"'
  },

  // Not addresses at all, or addresses this function specifically refuses to
  // normalise rather than getting a spelling wrong -- both return null.
  { addr: 'not an address', canonical: null, why: 'unparseable, agrees with classifyAddress' },
  { addr: '', canonical: null, why: 'empty' },
  {
    addr: '::1%1',
    canonical: null,
    why: 'a zone id -- classifyAddress accepts it (see IPV6_RANGES above), canonicalAddress deliberately does not'
  },
  { addr: 'fe80::1%eth0', canonical: null, why: 'a named zone id, same deliberate refusal' }
]

export const MALFORMED: readonly string[] = [
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
