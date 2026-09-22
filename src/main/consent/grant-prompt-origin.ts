// The origin line every permission dialog shows, split out of
// grant-prompt-render.ts when that file reached Rule 2's 500-line ceiling.
// One concern: turning a real origin into the string a person reads and
// judges the app by. Kept whole rather than cut by line count -- the label
// rule, the elision marker and the A161 suffix list only make sense
// together, and a reader deciding whether a displayed origin is honest
// needs all three in front of them.

import { isIP } from 'node:net'


// ASCII, not the Unicode ellipsis glyph -- guaranteed to render identically
// under whatever font a native dialog falls back to, where a missing glyph
// could otherwise leave a blank box exactly where "text was cut here" needs
// to be unambiguous.
const ELISION_MARKER = '...'

// Owner decision, 2026-09-14: always show the last three dot-separated
// labels of the host -- "the sub domain, the domain name, and the domain
// name level 1 (the www, the google and the .com)" -- and the whole host
// when it has three or fewer. See this directory's README (Design notes)
// for why a label count, not a character count, and why this closes A142
// without a public-suffix-list dependency.
const DISPLAYED_LABEL_COUNT = 3

// A161: a small, evidenced list of multi-label PRIVATE hosting suffixes the
// fixed three-label cut can land entirely inside -- each checked directly
// against the live Public Suffix List's private section, not assumed. NOT
// an attempt at public-suffix-list coverage (A142 is parked precisely
// because that needs a dependency this file does not carry); each entry
// here is one this codebase has concrete evidence for. See the README
// (Design notes) for why the fix is "show one more label", not a fuller
// suffix-matching scheme.
const RECOGNISED_PRIVATE_SUFFIXES: ReadonlyArray<readonly string[]> = [
  ['s3', 'amazonaws', 'com'],
  ['compute', 'amazonaws', 'com'],
  ['storage', 'googleapis', 'com']
]

/** The recognised suffix `labels` ends with, longest match first, or null.
 * Compared label-for-label, never as a substring -- `nots3.amazonaws.com`
 * must not match `s3.amazonaws.com`. */
function matchingPrivateSuffix (labels: readonly string[]): readonly string[] | null {
  const candidates = [...RECOGNISED_PRIVATE_SUFFIXES].sort((a, b) => b.length - a.length)
  for (const suffix of candidates) {
    if (labels.length < suffix.length) continue
    const tail = labels.slice(-suffix.length)
    if (tail.every((label, i) => label === suffix[i])) return suffix
  }
  return null
}

/**
 * The origin, formatted for a person rather than for an exact match --
 * A115/T25: `accounts.google.com.attacker.example` reads reassuringly
 * left-to-right while `attacker.example`, the label that actually decides
 * authority, sits at the far right, exactly where a narrow or truncated
 * dialog is least likely to show it. Keeps only the last
 * `DISPLAYED_LABEL_COUNT` labels of the HOST, so the authority-deciding end
 * always survives; the scheme and a non-default port are never touched.
 * Full reasoning, including why a plain label count gets `example.co.uk`
 * right without a public-suffix list, is in the README (Design notes), not
 * repeated here.
 *
 * An IP literal (IPv4, or IPv6 in its bracketed form) is never chopped --
 * it is not label-structured the way a domain name is, and cutting it would
 * change which machine it names, not just shorten a cosmetic prefix.
 *
 * Never throws: a value `new URL` cannot parse is returned unchanged rather
 * than propagating out of what is otherwise a pure formatting function with
 * no failure mode of its own.
 */
export function formatOriginForDisplay (origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return origin
  }

  const hostname = parsed.hostname
  const bareHostname = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (isIP(bareHostname) !== 0) return origin

  // A trailing dot (an explicit FQDN root, e.g. `example.com.`) is a
  // canonicalisation artefact, not a label -- strip it before counting so
  // it cannot itself push an otherwise-short host over the threshold, and
  // let the ordinary tail below drop it, same as it drops "www".
  const withoutRoot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  const labels = withoutRoot.split('.')
  if (labels.length <= DISPLAYED_LABEL_COUNT) return origin

  // A161: a host ending in a RECOGNISED private suffix widens the kept
  // window to that suffix plus one more label, so the label an attacker
  // actually controls (a bucket name, an EC2 region) is what survives,
  // rather than a string that reads as the platform's own domain. Every
  // other host keeps the plain three-label cut, unchanged.
  const suffix = matchingPrivateSuffix(labels)
  const keepCount = suffix !== null ? suffix.length + 1 : DISPLAYED_LABEL_COUNT
  if (labels.length <= keepCount) return origin

  const tail = labels.slice(-keepCount).join('.')
  const port = parsed.port === '' ? '' : `:${parsed.port}`
  return `${parsed.protocol}//${ELISION_MARKER}${tail}${port}`
}
