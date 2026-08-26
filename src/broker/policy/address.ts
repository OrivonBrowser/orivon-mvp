// The blocked-address-range table -- security-model.md T12.
//
// This is what stops an app holding `tcp.connect: ["*:*"]` from reaching the
// user's router, printer, NAS, or a cloud metadata endpoint at
// 169.254.169.254. The flagship genuinely declares `"*:*"`, so `*` has to be
// specified rather than inferred: capability-api.md and security-model.md T12
// both say it means PUBLIC UNICAST ONLY. Loopback, private, link-local,
// broadcast, multicast and reserved ranges are denied unless the manifest
// declares them separately and the user grants them.
//
// Two properties matter more than range coverage.
//
// 1. THE FAILURE IS SILENT. A missed encoding does not throw and does not log
//    -- it answers "public" for an address that reaches localhost, and the
//    connection succeeds. Nothing downstream re-checks. That is why this file
//    gets an exhaustive table test rather than a handful of examples.
//
// 2. IT FAILS CLOSED. Anything unparseable is blocked, never allowed. An
//    unparseable string is either a caller bug or someone hunting for an
//    encoding the table does not know, and neither earns the benefit of the
//    doubt.
//
// WHAT THIS DOES NOT DO. It classifies an ADDRESS, never a hostname. T12 is
// defeated outright by checking `example.com` and then dialling that name: a
// TTL-0 server re-resolves it to 127.0.0.1 between the check and the connect.
// The broker must resolve once, pass EVERY returned address through here, and
// then connect to the IP literal it validated. Node 24 defaults
// `autoSelectFamily: true`, so "every returned address" is not optional.
//
// It also takes a bare address, never `host:port` -- the caller splits the
// pattern first. A string with a port fails to parse, so the failure direction
// is safe, but it is not the intended input.
//
// Pure by construction: no `electron`, no `node:net`, no `node:dns`, no I/O of
// any kind (./README.md). That is why the address is parsed here by hand
// instead of being handed to `net.isIP`.

/**
 * Why an address is not public unicast.
 *
 * Kept for the broker's DENIAL LOG, not for the app. `OrivonError` with code
 * 'denied' is uniform and carries no reason by design (../../contracts/errors.ts):
 * denials that vary by reason let an app map exactly which pattern, port or
 * address class is blocked, turning the permission boundary into a probe
 * target.
 *
 * It is also what makes the table test meaningful -- asserting the RANGE that
 * matched catches a row that produces the right answer for the wrong reason,
 * which a boolean assertion cannot.
 */
export type AddressClass =
  | 'public'
  | 'unparseable'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'multicast'
  | 'broadcast'
  | 'reserved'

/** Largest value a 32-bit address can hold. */
const IPV4_MAX = 0xffffffff

/**
 * Bounds pathological input before any regex sees it. The longest real IPv6
 * literal is 45 characters (`0:0:0:0:0:ffff:255.255.255.255`); the rest of the
 * budget is brackets and a zone id.
 */
const MAX_LENGTH = 64

interface Ipv4Range {
  readonly base: number
  readonly prefix: number
  readonly cls: AddressClass
}

/** Composes four octets into the uint32 the range table compares against. */
function octets (a: number, b: number, c: number, d: number): number {
  return (a * 0x1000000) + (b * 0x10000) + (c * 0x100) + d
}

/**
 * Every IPv4 range that is not public unicast (RFC 6890's special-purpose
 * registry). Ordered so that where two rows overlap the more specific one
 * wins: 255.255.255.255 sits inside 240.0.0.0/4 and must read as broadcast.
 */
const IPV4_BLOCKED: readonly Ipv4Range[] = [
  { base: octets(255, 255, 255, 255), prefix: 32, cls: 'broadcast' }, // RFC 919 limited broadcast
  { base: octets(0, 0, 0, 0), prefix: 8, cls: 'unspecified' }, // RFC 1122 "this network"
  { base: octets(10, 0, 0, 0), prefix: 8, cls: 'private' }, // RFC 1918
  { base: octets(100, 64, 0, 0), prefix: 10, cls: 'reserved' }, // RFC 6598 carrier-grade NAT
  { base: octets(127, 0, 0, 0), prefix: 8, cls: 'loopback' }, // RFC 1122
  { base: octets(169, 254, 0, 0), prefix: 16, cls: 'link-local' }, // RFC 3927 -- holds 169.254.169.254
  { base: octets(172, 16, 0, 0), prefix: 12, cls: 'private' }, // RFC 1918
  { base: octets(192, 0, 0, 0), prefix: 24, cls: 'reserved' }, // RFC 6890 IETF protocol assignments
  { base: octets(192, 0, 2, 0), prefix: 24, cls: 'reserved' }, // RFC 5737 TEST-NET-1
  { base: octets(192, 88, 99, 0), prefix: 24, cls: 'reserved' }, // RFC 7526 deprecated 6to4 relay anycast
  { base: octets(192, 168, 0, 0), prefix: 16, cls: 'private' }, // RFC 1918
  { base: octets(198, 18, 0, 0), prefix: 15, cls: 'reserved' }, // RFC 2544 benchmarking
  { base: octets(198, 51, 100, 0), prefix: 24, cls: 'reserved' }, // RFC 5737 TEST-NET-2
  { base: octets(203, 0, 113, 0), prefix: 24, cls: 'reserved' }, // RFC 5737 TEST-NET-3
  { base: octets(224, 0, 0, 0), prefix: 4, cls: 'multicast' }, // RFC 5771
  { base: octets(240, 0, 0, 0), prefix: 4, cls: 'reserved' } // RFC 1112 reserved for future use
]

interface Ipv6Range {
  /** Leading 16-bit words of the prefix. Words beyond the list are zero. */
  readonly words: readonly number[]
  readonly prefix: number
  readonly cls: AddressClass
}

/**
 * IPv6 ranges that are not public unicast. Not exhaustive on its own, and does
 * not need to be: anything outside 2000::/3 is denied by default below, so
 * this table exists to give the common ranges a precise label rather than to
 * be the only thing standing between an app and ::1.
 */
const IPV6_BLOCKED: readonly Ipv6Range[] = [
  { words: [0, 0, 0, 0, 0, 0, 0, 0], prefix: 128, cls: 'unspecified' }, // ::
  { words: [0, 0, 0, 0, 0, 0, 0, 1], prefix: 128, cls: 'loopback' }, // ::1
  { words: [0, 0, 0, 0, 0, 0], prefix: 96, cls: 'reserved' }, // deprecated IPv4-compatible ::a.b.c.d
  { words: [0x0064, 0xff9b, 0x0001], prefix: 48, cls: 'reserved' }, // RFC 8215 local-use NAT64
  { words: [0x0100], prefix: 64, cls: 'reserved' }, // RFC 6666 discard-only
  { words: [0x2001, 0x0000], prefix: 32, cls: 'reserved' }, // RFC 4380 Teredo
  { words: [0x2001, 0x0002, 0x0000], prefix: 48, cls: 'reserved' }, // RFC 5180 benchmarking
  { words: [0x2001, 0x0010], prefix: 28, cls: 'reserved' }, // RFC 4843 deprecated ORCHID
  { words: [0x2001, 0x0020], prefix: 28, cls: 'reserved' }, // RFC 7343 ORCHIDv2
  { words: [0x2001, 0x0db8], prefix: 32, cls: 'reserved' }, // RFC 3849 documentation
  { words: [0x3fff], prefix: 20, cls: 'reserved' }, // RFC 9637 documentation
  { words: [0x5f00], prefix: 16, cls: 'reserved' }, // RFC 9602 SRv6 segment routing
  { words: [0xfc00], prefix: 7, cls: 'private' }, // RFC 4193 unique local
  { words: [0xfe80], prefix: 10, cls: 'link-local' }, // RFC 4291
  { words: [0xfec0], prefix: 10, cls: 'reserved' }, // RFC 3879 deprecated site-local
  { words: [0xff00], prefix: 8, cls: 'multicast' } // RFC 4291
]

/**
 * One dot-separated component of an IPv4 literal, in any base a C `inet_aton`
 * accepts: decimal, octal (leading `0`), hexadecimal (leading `0x`).
 *
 * These forms are the whole reason this file exists rather than a regex.
 * `0177.0.0.1` and `0x7f.0.0.1` are 127.0.0.1, and a checker that understands
 * only dotted decimal waves both straight through -- the classic SSRF bypass.
 * `08` is rejected, as inet_aton rejects it: a leading zero means octal, and 8
 * is not an octal digit.
 */
function parseComponent (text: string): number | null {
  let value: number
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) value = Number.parseInt(text.slice(2), 16)
  else if (/^0[0-7]+$/.test(text)) value = Number.parseInt(text.slice(1), 8)
  else if (/^(0|[1-9][0-9]*)$/.test(text)) value = Number.parseInt(text, 10)
  else return null

  // A long enough digit string overflows to Infinity rather than failing, and
  // Infinity compares as larger than every bound -- but say so explicitly
  // rather than relying on that.
  return Number.isInteger(value) ? value : null
}

/**
 * Parses an IPv4 literal in every form `inet_aton` accepts, as a uint32.
 * Returns null for anything else, which fails closed one level up.
 */
function parseIpv4 (text: string): number | null {
  const parts = text.split('.')
  if (parts.length > 4) return null

  const values: number[] = []
  for (const part of parts) {
    const value = parseComponent(part)
    if (value === null) return null
    values.push(value)
  }

  // inet_aton's short forms: the LAST component absorbs every byte the
  // preceding ones did not name. `127.1` is 127.0.0.1 and `2130706433` is the
  // whole address as one integer. Both are what `ping` accepts, so both are
  // what an app can hand the broker expecting them to work.
  const last = values[values.length - 1] ?? -1
  const leading = values.slice(0, -1)
  if (leading.some((value) => value > 0xff)) return null

  const lastBits = (5 - values.length) * 8
  const lastMax = lastBits >= 32 ? IPV4_MAX : (2 ** lastBits) - 1
  if (last < 0 || last > lastMax) return null

  let result = 0
  for (let i = 0; i < leading.length; i++) {
    result += (leading[i] ?? 0) * (2 ** (8 * (3 - i)))
  }
  return result + last
}

/**
 * The dotted-quad tail of an IPv6 literal (`::ffff:127.0.0.1`), parsed the way
 * `inet_pton` does: four decimal octets, no leading zeros, no octal, no hex,
 * no short forms.
 *
 * Deliberately STRICTER than parseIpv4. Every real stack rejects
 * `::ffff:0177.0.0.1` as a literal, so accepting it here would make this file
 * the only component in the system that believes that string is an address --
 * and a disagreement about what an address IS is exactly how the check and the
 * connect end up pointed at different hosts. Rejecting makes the whole literal
 * unparseable, and unparseable is blocked.
 */
function parseDottedQuad (text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null

  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const octet = Number.parseInt(part, 10)
    if (octet > 0xff) return null
    value = (value * 0x100) + octet
  }
  return value
}

/** Appends `groups` as 16-bit words, expanding a trailing dotted quad to two. */
function expandGroups (groups: readonly string[], quadAllowed: boolean, out: number[]): boolean {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? ''

    if (group.includes('.')) {
      if (!quadAllowed || i !== groups.length - 1) return false
      const quad = parseDottedQuad(group)
      if (quad === null) return false
      out.push((quad >>> 16) & 0xffff, quad & 0xffff)
      continue
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false
    out.push(Number.parseInt(group, 16))
  }
  return true
}

/** Parses an IPv6 literal (no brackets, no zone id) into its 16 bytes. */
function parseIpv6 (text: string): Uint8Array | null {
  if (text.length === 0) return null
  if (!text.includes(':')) return null

  const gap = text.indexOf('::')
  if (gap !== text.lastIndexOf('::')) return null // two gaps, or ':::'

  const headText = gap === -1 ? text : text.slice(0, gap)
  const tailText = gap === -1 ? '' : text.slice(gap + 2)

  const head = headText.length > 0 ? headText.split(':') : []
  const tail = tailText.length > 0 ? tailText.split(':') : []

  // Only `::` may produce an empty group. A stray colon at either end
  // (`:1:2`, `1:2:`) is not an address.
  if (head.includes('') || tail.includes('')) return null

  // A dotted quad is legal only as the very last group of the whole literal.
  const quadIn = gap === -1 ? 'head' : (tail.length > 0 ? 'tail' : 'none')

  const headWords: number[] = []
  const tailWords: number[] = []
  if (!expandGroups(head, quadIn === 'head', headWords)) return null
  if (!expandGroups(tail, quadIn === 'tail', tailWords)) return null

  const total = headWords.length + tailWords.length
  if (gap === -1) {
    if (total !== 8) return null
  } else if (total > 7) {
    // `::` stands for AT LEAST one all-zero group, so eight explicit groups
    // plus a gap is not an address.
    return null
  }

  const words = new Array<number>(8).fill(0)
  for (let i = 0; i < headWords.length; i++) words[i] = headWords[i] ?? 0
  for (let i = 0; i < tailWords.length; i++) words[8 - tailWords.length + i] = tailWords[i] ?? 0

  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const word = words[i] ?? 0
    bytes[i * 2] = (word >> 8) & 0xff
    bytes[(i * 2) + 1] = word & 0xff
  }
  return bytes
}

function classifyIpv4 (value: number): AddressClass {
  for (const range of IPV4_BLOCKED) {
    const mask = (IPV4_MAX << (32 - range.prefix)) >>> 0
    if (((value & mask) >>> 0) === range.base) return range.cls
  }
  return 'public'
}

function allZero (bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if ((bytes[i] ?? 0) !== 0) return false
  }
  return true
}

function readUint32 (bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000) +
    ((bytes[at + 1] ?? 0) * 0x10000) +
    ((bytes[at + 2] ?? 0) * 0x100) +
    (bytes[at + 3] ?? 0)
}

/** The byte at `index` of a prefix expressed as leading 16-bit words. */
function prefixByte (words: readonly number[], index: number): number {
  const word = words[index >> 1] ?? 0
  return index % 2 === 0 ? (word >> 8) & 0xff : word & 0xff
}

function hasPrefix (bytes: Uint8Array, words: readonly number[], prefix: number): boolean {
  const whole = prefix >> 3
  const spare = prefix & 7

  for (let i = 0; i < whole; i++) {
    if ((bytes[i] ?? 0) !== prefixByte(words, i)) return false
  }
  if (spare === 0) return true

  const mask = (0xff << (8 - spare)) & 0xff
  return ((bytes[whole] ?? 0) & mask) === (prefixByte(words, whole) & mask)
}

/**
 * The IPv4 address carried inside an IPv6 one, or null if there is none.
 *
 * `::ffff:127.0.0.1` is 127.0.0.1 wearing a different hat, and it is THE
 * classic bypass of an IPv4-only table. 6to4 and the NAT64 well-known prefix
 * carry a v4 address the same way.
 *
 * All three delegate to the IPv4 table rather than being blanket-denied,
 * because a blanket deny would also reject `::ffff:8.8.8.8` -- a legitimate
 * way to write a public address, and one Node hands back for a dual-stack
 * lookup.
 */
function embeddedIpv4 (bytes: Uint8Array): number | null {
  // ::ffff:0:0/96 -- IPv4-mapped, RFC 4291.
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return readUint32(bytes, 12)
  }

  // 64:ff9b::/96 -- NAT64 well-known prefix, RFC 6052.
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    allZero(bytes, 4, 12)
  ) {
    return readUint32(bytes, 12)
  }

  // 2002::/16 -- 6to4, RFC 3056. The v4 address is the next 32 bits, so
  // 2002:7f00:1:: is a 6to4 wrapper around 127.0.0.1.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return readUint32(bytes, 2)
  }

  return null
}

/** Global unicast is 2000::/3. Everything outside it is not ordinary internet. */
function isGlobalUnicast (bytes: Uint8Array): boolean {
  return ((bytes[0] ?? 0) & 0xe0) === 0x20
}

function classifyIpv6 (bytes: Uint8Array): AddressClass {
  // Embedded IPv4 first: an address that is really a v4 address must be judged
  // by the v4 table, or every row above is bypassable by rewriting the literal.
  const embedded = embeddedIpv4(bytes)
  if (embedded !== null) return classifyIpv4(embedded)

  for (const range of IPV6_BLOCKED) {
    if (hasPrefix(bytes, range.words, range.prefix)) return range.cls
  }

  // DEFAULT DENY. Only 2000::/3 is assigned as global unicast; the rest of the
  // space is unassigned or special-purpose, and an unassigned prefix arriving
  // from a resolver means something local is answering for it. Failing closed
  // here is what keeps a prefix delegated after this file was written from
  // silently becoming reachable.
  if (!isGlobalUnicast(bytes)) return 'reserved'

  return 'public'
}

/**
 * Classifies a single IP address literal. Never throws.
 *
 * Accepts IPv4 in every `inet_aton` form (dotted quad, short forms, decimal,
 * octal, hex), IPv6 with or without a `::` gap, an embedded dotted quad, an
 * optional zone id, and optional URL brackets.
 *
 * Takes a BARE ADDRESS: no port, no hostname. A hostname returns 'unparseable'
 * -- which blocks, and is the right direction -- but a caller relying on that
 * has already lost to DNS rebinding (security-model.md T12). Resolve first,
 * classify every resolved address, connect to the literal.
 */
export function classifyAddress (addr: string): AddressClass {
  if (typeof addr !== 'string') return 'unparseable'

  let text = addr.trim()
  if (text.length === 0 || text.length > MAX_LENGTH) return 'unparseable'

  // `[::1]` is how a URL carries an IPv6 host. Accepted so that a caller who
  // forgot to unwrap it gets the correct answer rather than a fail-closed one.
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)

  if (text.includes(':')) {
    // A zone id (`fe80::1%eth0`) names a local interface, so an address
    // carrying one is by definition not internet-reachable -- but strip it and
    // classify the literal properly rather than leaning on that.
    const zone = text.indexOf('%')
    const bytes = parseIpv6(zone === -1 ? text : text.slice(0, zone))
    return bytes === null ? 'unparseable' : classifyIpv6(bytes)
  }

  const value = parseIpv4(text)
  return value === null ? 'unparseable' : classifyIpv4(value)
}

/**
 * True if `addr` must NOT be reached under a `*` pattern: loopback, RFC 1918,
 * carrier-grade NAT, link-local (including the cloud metadata endpoint at
 * 169.254.169.254), unique local, multicast, broadcast, or any reserved or
 * unassigned range -- in any encoding.
 *
 * ALSO TRUE FOR ANYTHING IT CANNOT PARSE. The name says "private" because
 * that is what the manifest and the grant prompt call these ranges, but the
 * question it actually answers is "is this anything other than public
 * unicast", and an unparseable string is certainly not public unicast.
 */
export function isPrivateAddress (addr: string): boolean {
  return classifyAddress(addr) !== 'public'
}
