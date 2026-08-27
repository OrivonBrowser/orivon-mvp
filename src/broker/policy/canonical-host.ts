// String-level host and address-literal validation, split out of
// ./connect.ts (docs/development/code-guidelines.md Rule 2). Imports nothing
// -- see ./README.md, this directory is pure by structural rule.

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

/**
 * True only for an address written the one way every stack agrees on: a
 * strict dotted quad, or an RFC 4291 IPv6 literal with no zone id.
 *
 * WHY THIS EXISTS, given ./address.ts already parses addresses. The two
 * answer different questions. `classifyAddress` asks "what range is this in",
 * and it is deliberately PERMISSIVE -- it must understand `0177.0.0.1` and
 * `2130706433` in order to BLOCK them, which is right on the deny side. This
 * file also needs an IDENTITY answer on the ALLOW side: is this string one
 * that everything downstream will read as the same address. Those come apart
 * exactly where it hurts.
 *
 *   - `checkConnect` returns addresses for the broker to dial. `net.isIP`
 *     rejects `2130706433`, so `net.connect` resolves it as a NAME. Verified
 *     end to end before this guard existed: a manifest declaring
 *     `2130706433:22` produced `addresses: ["2130706433"]`, and dialling it
 *     performed a fresh DNS lookup and landed on 127.0.0.1.
 *   - A manifest may declare a private range only by naming it literally,
 *     because the user is shown that literal and grants it. `2130706433:22`
 *     is 127.0.0.1:22 rendered as an opaque number, which defeats the consent
 *     step the rule depends on.
 *
 * A NON-CANONICAL ADDRESS IS REJECTED, NOT DEMOTED TO A HOSTNAME. That
 * distinction is the whole safety of this guard: falling through would let
 * `2130706433` be compared as a name against a `2130706433` pattern host and
 * pass, which is worse than the bug it replaces. Every call site in
 * ./connect.ts and ./connect-patterns.ts denies on
 * `classifyAddress(x) !== 'unparseable' && !isCanonicalLiteral(x)`.
 *
 * A VALIDATOR, NOT A SECOND PARSER. It accepts a strict subset and never
 * assigns meaning, so it can only ever narrow what address.ts already
 * decided; a disagreement denies. That is the difference between this and the
 * duplicate parser address.ts's own comments argue against. The architecturally
 * cleaner fix is a `canonicalAddress()` export from ./address.ts, which would
 * also let the grant prompt and the update subset-check compare canonical
 * forms -- filed as docs/open-questions.md A20, deliberately not done here
 * because address.ts belongs to another stream.
 * Found by review, 2026-08-27.
 */
export function isCanonicalLiteral (value: string): boolean {
  if (value.includes(':')) {
    // No zone id: `fe80::1%eth0` names a local interface, is never
    // internet-reachable, and is not a thing a dialer should be handed.
    if (value.includes('%')) return false
    if (!/^[0-9a-f:.]+$/.test(value)) return false

    const gap = value.indexOf('::')
    if (gap !== value.lastIndexOf('::')) return false

    const head = gap === -1 ? value : value.slice(0, gap)
    const tail = gap === -1 ? '' : value.slice(gap + 2)
    const headGroups = head.length > 0 ? head.split(':') : []
    const tailGroups = tail.length > 0 ? tail.split(':') : []
    const groups = [...headGroups, ...tailGroups]
    if (groups.includes('')) return false

    let words = 0
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i] ?? ''
      if (group.includes('.')) {
        // A dotted quad is legal only as the very last group of the literal.
        if (i !== groups.length - 1) return false
        if (!isCanonicalIpv4(group)) return false
        words += 2
        continue
      }
      // Lower case only, and no leading zeros: RFC 5952's presentation form,
      // which is what every resolver and `net.isIP` round-trip produces.
      if (!/^(0|[1-9a-f][0-9a-f]{0,3})$/.test(group)) return false
      words += 1
    }

    return gap === -1 ? words === 8 : words <= 7
  }

  return isCanonicalIpv4(value)
}

/** A strict dotted quad: four decimal octets, no leading zeros, no short forms. */
function isCanonicalIpv4 (value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false
    if (Number.parseInt(part, 10) > 0xff) return false
  }
  return true
}

/** True only for a port an outbound connection can actually name. */
export function isValidPort (port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT
}
