// String-level host validation, split out of ./connect.ts
// (docs/development/code-guidelines.md Rule 2). Imports nothing -- see
// ./README.md, this directory is pure by structural rule.
//
// Address-LITERAL canonicalisation used to live here too, as a hand-rolled
// strict-subset validator (`isCanonicalLiteral`) kept in sync with
// ./address-parse.ts's parsers only by a human noticing both when one
// changed. That was Rule 3 (docs/development/code-guidelines.md) waiting to
// happen, and docs/open-questions.md A20 is where it did: retired in favour
// of `canonicalAddress` (./address.ts), which is built from the same parsers
// and cannot drift from them. Every former call site here now compares
// `canonicalAddress(x) === x`, which is exactly what `isCanonicalLiteral(x)`
// used to mean.

export const MAX_PORT = 65535

/** RFC 1035's limit on a presentation-format domain name. */
export const MAX_HOST_LENGTH = 253

/**
 * Lower-cases ASCII letters only, strips URL brackets and one trailing root
 * dot, and trims.
 *
 * ASCII-only because that is precisely DNS's rule (RFC 4343) and because
 * `toLowerCase()` applies full Unicode case folding -- U+212A KELVIN SIGN
 * folds to `k`, among others. A comparison whose notion of equality is wider
 * than DNS's is a comparison that can be steered.
 *
 * The trailing dot is the DNS root label: `example.com.` and `example.com` are
 * the same name, and treating them as different names is one string away from
 * a bypass.
 */
export function normalizeHost (value: string): string {
  let text = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase())
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (text.length > 1 && text.endsWith('.')) text = text.slice(0, -1)
  return text
}

/**
 * True only for a host made of characters DNS and this file both understand.
 *
 * NON-ASCII IS REJECTED, LOUDLY AND DELIBERATELY. `normalizeHost` folds only
 * ASCII case, for the good reason above, so `api.exÄmple.com` and
 * `api.exämple.com` compare unequal -- and an app that derives its host the
 * normal way, `new URL(...).hostname`, gets the punycode A-label
 * `api.xn--exmple-cua.com`, which matches neither. Three spellings of one
 * name, none of them matching a manifest a human wrote in Unicode.
 *
 * That failed CLOSED, so it was never a hole; it was a trap. The author got a
 * denial with no explanation and no log line. Rejecting the pattern outright
 * is the same argument this file already makes for `*.example.com`: an app
 * author finds a deliberate reject in seconds, and a user never finds a
 * silent non-match at all.
 *
 * Making IDN genuinely work means normalising both sides to A-labels, which
 * needs UTS-46 -- a dependency or a hundred hand-written lines in a directory
 * that is meant to have neither. Recorded in docs/open-questions.md A19.
 * Found by review, 2026-08-27.
 */
export function isAsciiHost (value: string): boolean {
  return !/[^\x20-\x7e]/.test(value)
}

/** True only for a port an outbound connection can actually name. */
export function isValidPort (port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT
}
