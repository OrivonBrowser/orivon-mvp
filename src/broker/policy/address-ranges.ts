// The blocked-address RFC 6890/4291 range tables, split out of ./address.ts
// (Rule 2, docs/development/code-guidelines.md). Pure data plus one small
// helper -- see ./address.ts for the classification logic built on top.
//
// Pure by construction: no `electron`, no `node:net`, no `node:dns`, no I/O of
// any kind (./README.md).

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
export const IPV4_MAX = 0xffffffff

/**
 * Bounds pathological input before any regex sees it. The longest fully
 * expanded IPv6 literal is 45 characters
 * (`ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`); the rest of the budget is
 * brackets and a zone id, which on Linux is an interface name capped at 15.
 */
export const MAX_LENGTH = 64

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
 * Every IPv4 range IANA marks globally unreachable, from RFC 6890's
 * special-purpose registry. Ordered so that where two rows overlap the more
 * specific one wins: 255.255.255.255 sits inside 240.0.0.0/4 and must read as
 * broadcast.
 *
 * Not every special-purpose range is here, and that is correct rather than a
 * gap: 192.31.196.0/24 (AS112-v4), 192.52.193.0/24 (AMT) and 192.175.48.0/24
 * are special-purpose but globally ROUTED, so `public` is the right answer for
 * them. The test is reachability, not whether a registry lists the prefix.
 */
export const IPV4_BLOCKED: readonly Ipv4Range[] = [
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
 * IPv6 ranges that are not public unicast.
 *
 * TWO KINDS OF ROW, and the difference decides whether one can be deleted.
 *
 * Rows OUTSIDE 2000::/3 -- `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`,
 * `100::/64`, `5f00::/16` -- are labelling only. The default-deny at the
 * bottom of `classifyIpv6` already blocks them; these rows exist so the
 * denial log says `loopback` rather than `reserved`.
 *
 * Rows INSIDE 2000::/3 -- Teredo, both ORCHIDs, RFC 5180 benchmarking,
 * `2001:db8::/32` and `3fff::/20` -- ARE LOAD-BEARING. Global unicast is
 * exactly 2000::/3, so nothing else stands between an app and these; delete a
 * row and its range silently becomes reachable. Teredo is the one that
 * matters most: it tunnels IPv4, so a Teredo address is a route to a v4
 * destination this file never gets to classify.
 */
export const IPV6_BLOCKED: readonly Ipv6Range[] = [
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
