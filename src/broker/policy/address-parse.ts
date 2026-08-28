// Literal parsers for IPv4 and IPv6, split out of ./address.ts (Rule 2,
// docs/development/code-guidelines.md). Self-contained: string in, a packed
// uint32 or 16 bytes out, or null.
//
// Pure by construction: no `electron`, no `node:net`, no `node:dns`, no I/O of
// any kind (./README.md). That is why an address is parsed here by hand
// instead of being handed to `net.isIP`.

import { IPV4_MAX } from './address-ranges.js'

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
export function parseIpv4 (text: string): number | null {
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
export function parseIpv6 (text: string): Uint8Array | null {
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
