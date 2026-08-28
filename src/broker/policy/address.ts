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
//
// Split into three files (Rule 2, docs/development/code-guidelines.md):
// ./address-ranges.ts (the RFC 6890/4291 tables), ./address-parse.ts (the
// literal parsers), and this file (classification, canonicalisation, and the
// public API).
//
// TWO PUBLIC ANSWERS SHARE THIS FILE ON PURPOSE. `classifyAddress` answers
// "what range is this in" for the DENY side and stays permissive -- it has to
// recognise `2130706433` in order to block it. `canonicalAddress`, below,
// answers a different question for the ALLOW side: "will everything
// downstream read this string as the same address" (docs/open-questions.md
// A20). Both are built from the same ./address-parse.ts parsers, so they
// cannot disagree about what an address IS -- only about how it should be
// spelled.

import { type AddressClass, IPV4_BLOCKED, IPV4_MAX, IPV6_BLOCKED, MAX_LENGTH } from './address-ranges.js'
import { parseIpv4, parseIpv6 } from './address-parse.js'

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

/** The strict dotted-quad spelling of a packed IPv4 address: four decimal octets, no leading zeros. */
function formatIpv4 (value: number): string {
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

/**
 * The RFC 5952 canonical spelling of a parsed IPv6 literal: lower-case hex,
 * no leading zeros, the LONGEST run of consecutive zero words compressed to
 * `::` (leftmost on a tie, RFC 5952 SS4.2), and a run of exactly one word
 * never compressed -- `:0:` is exactly as long as `::`, so compressing it
 * buys nothing and RFC 5952 forbids it.
 *
 * ONE DELIBERATE EXCEPTION. An IPv4-mapped address (`::ffff:0:0/96`) is
 * spelled with the embedded dotted quad -- `::ffff:127.0.0.1`, never
 * `::ffff:7f00:1` -- because RFC 5952 SS5 recommends exactly that form, and
 * it is the one a human (and the grant prompt this function's caller
 * ultimately feeds, docs/open-questions.md A20) can actually read. Scoped
 * narrowly to that one prefix: 6to4 and NAT64 also carry a v4 address (see
 * `embeddedIpv4` above) but RFC 5952 does not recommend dotted-quad for
 * either, and inventing a convention nobody else in the stack shares is how a
 * second "canonical" spelling of one address ends up existing again -- the
 * exact bug `canonicalAddress` exists to retire.
 */
function formatIpv6 (bytes: Uint8Array): string {
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${formatIpv4(readUint32(bytes, 12))}`
  }

  const words: number[] = []
  for (let i = 0; i < 8; i++) {
    words.push((((bytes[i * 2] ?? 0) << 8) | (bytes[(i * 2) + 1] ?? 0)) >>> 0)
  }

  // The longest run of zero words, leftmost on a tie: `runLen > bestLen` is
  // strict, so a later run of equal length never displaces an earlier one.
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  let runLen = 0
  for (let i = 0; i < 8; i++) {
    if (words[i] === 0) {
      if (runStart === -1) runStart = i
      runLen++
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart }
    } else {
      runStart = -1
      runLen = 0
    }
  }

  const hex = words.map((word) => word.toString(16))
  if (bestLen < 2) return hex.join(':')

  const head = hex.slice(0, bestStart)
  const tail = hex.slice(bestStart + bestLen)
  return `${head.join(':')}::${tail.join(':')}`
}

/**
 * The single spelling everything downstream will read as the same address --
 * NORMALISED, not merely validated. `canonicalAddress('2130706433')`,
 * `canonicalAddress('0177.0.0.1')` and `canonicalAddress('127.0.0.1')` all
 * return `'127.0.0.1'`; asking which spelling was "the real" address is the
 * wrong question; they were always the same one.
 *
 * WHY THIS EXISTS ALONGSIDE classifyAddress. See this file's header. In
 * short: `connect.ts` needs an IDENTITY answer that `classifyAddress`'s
 * permissiveness cannot give it. `net.isIP` rejects `2130706433`, so
 * `net.connect` treats it as a NAME and looks it up again -- the rebinding
 * window this whole directory exists to close, reopened one layer below the
 * check (docs/open-questions.md A20, found by review 2026-08-27).
 *
 * BUILT FROM THE SAME PARSERS classifyAddress uses (./address-parse.ts), not
 * a second grammar. The stopgap this replaces, `isCanonicalLiteral`
 * (formerly ./canonical-host.ts), hand-rolled its own strict-subset regex
 * grammar next to this file's, kept in sync only by a human noticing both
 * when one changed -- precisely the failure Rule 3
 * (docs/development/code-guidelines.md) names. Parsing once and formatting
 * the result means there is only one opinion in this codebase about what an
 * address is.
 *
 * REJECT vs NORMALISE was the open call (docs/open-questions.md A20): this
 * function normalises, because an echo-only validator would give the grant
 * prompt and `policy/update.ts`'s pattern comparison nothing to work with --
 * `2130706433:22` needs to RENDER, and COMPARE, as `127.0.0.1:22`, not
 * disappear into a denial. A caller that instead wants connect.ts's own
 * "declare it legibly or the connection is refused" policy gets it for free
 * by comparing the result to the input -- `canonicalAddress(x) === x` is
 * exactly what `isCanonicalLiteral(x)` used to mean, and every call site in
 * ./connect.ts and ./connect-patterns.ts is written that way.
 *
 * Null for anything classifyAddress calls 'unparseable' -- same parsers, so
 * the two can never disagree about what counts as an address -- AND for a
 * literal carrying a zone id (`fe80::1%eth0`). That second null is a
 * deliberate DIVERGENCE from classifyAddress, not an oversight:
 * classifyAddress strips the zone and classifies anyway, because failing
 * closed on the deny side is free, but this function feeds the allow side,
 * and dropping the zone would hand back a spelling of a DIFFERENT, unscoped
 * address -- there is no canonical form to return, only a wrong answer.
 */
export function canonicalAddress (addr: string): string | null {
  if (typeof addr !== 'string') return null

  let text = addr.trim()
  if (text.length === 0 || text.length > MAX_LENGTH) return null

  // Mirrors classifyAddress's own bracket-handling (see its comment) so the
  // two never disagree about what counts as an address, only about spelling.
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)

  if (text.includes(':')) {
    if (text.includes('%')) return null
    const bytes = parseIpv6(text)
    return bytes === null ? null : formatIpv6(bytes)
  }

  const value = parseIpv4(text)
  return value === null ? null : formatIpv4(value)
}

/**
 * True only if `addr` is an ordinary public internet address -- the one thing
 * a `*` pattern is allowed to reach.
 *
 * FALSE for loopback, RFC 1918, carrier-grade NAT, link-local (including the
 * cloud metadata endpoint at 169.254.169.254), unique local, multicast,
 * broadcast, and every reserved or unassigned range, in any encoding -- AND
 * for anything it cannot parse.
 *
 * PHRASED THIS WAY ON PURPOSE. The obvious inverse, `isPrivateAddress`, reads
 * as an invitation to write the check as
 *
 *     if (isPrivateAddress(addr) && !manifestDeclaresPrivate) deny
 *
 * which fails OPEN on unparseable input for any app that declares private
 * ranges -- and the flagship torrent app declares exactly that. Asking "is
 * this a normal internet address" instead puts the unparseable case on the
 * denying side of every natural call site, so the fail-closed property
 * survives being used rather than only being documented.
 *
 * Still an ADDRESS, never a hostname: see `classifyAddress`. Resolve first,
 * check every resolved address, connect to the literal that was checked.
 */
export function isPublicUnicast (addr: string): boolean {
  return classifyAddress(addr) === 'public'
}

export type { AddressClass }
