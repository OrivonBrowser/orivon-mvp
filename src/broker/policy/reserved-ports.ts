// Ports a BROAD connect grant does not reach, however wide the grant is.
// Owner decision, 2026-09-06 (docs/open-questions.md A82). The rationale --
// what this defends against and what it deliberately does not -- is in
// ../README.md's design notes, not repeated here.

import type { ParsedPattern } from './connect-patterns.js'
import { parsePortSpec } from './connect-patterns.js'

/**
 * The list is the owner's, not a heuristic: the ports with a real outbound
 * abuse history and essentially no legitimate use from a page's own network
 * grant. Mail submission (spam relay), DNS (amplification and exfiltration),
 * IRC (botnet control), and the remote-access trio.
 *
 * Not a substitute for the address rules. `policy/address.ts` already denies
 * every private, loopback, link-local and metadata address outright, so the
 * remote-access ports here only matter for a PUBLIC host -- narrower than it
 * looks, and included because the owner chose the wider set knowing that.
 */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([
  23, // telnet
  25, 465, 587, // SMTP, SMTPS, submission
  53, // DNS
  139, 445, // NetBIOS session service, SMB
  3389, // RDP
  6667, 6697 // IRC, IRC over TLS
])

export function isReservedPort (port: number): boolean {
  return RESERVED_PORTS.has(port)
}

/**
 * Whether any pattern gives `port` as a single literal -- `:25`, never `:*`
 * and never a range that happens to contain it.
 *
 * A RANGE IS NOT A NAMING, and that is the whole distinction this function
 * draws. `20-30` covers port 25 without anyone having read the number, which
 * is the same blanket `*` is; requiring `lo === hi === port` means a reserved
 * port is reachable only when an app author typed it and a person approved
 * that exact line.
 *
 * Says nothing about the host half, on purpose: `hostMatches` still has to
 * agree separately, so a naming here can never widen authority by itself.
 */
export function namesPortExactly (parsed: readonly (ParsedPattern | null)[], port: number): boolean {
  return parsed.some((pattern) => {
    if (pattern === null) return false
    const spec = parsePortSpec(pattern.port)
    return spec !== null && spec !== 'any' && spec.lo === port && spec.hi === port
  })
}
