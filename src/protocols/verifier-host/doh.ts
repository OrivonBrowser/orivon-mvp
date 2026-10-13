// DNS-over-HTTPS lookups through the host's allowlisted fetch: TXT records
// for DNSLink, and (dns-fallback.ts's own use) A/AAAA records to compare
// against what the system resolver says for a gateway that just failed.
// Every answer here is still unauthenticated DNS -- a DNSLink hop is never
// a verified one, whoever answers it, and an address comparison is only
// ever a SIGNAL that something is wrong, never proof of what is right.

import type { ResolveTxt } from '../ipfs/dnslink.js'
import { dohHostAddresses, dohQuery } from '../gateways/doh-query.js'
import { canonicalAddress, isPublicUnicast } from '../../broker/policy/address.js'
import type { WebFetch } from './egress.js'

const TXT = 16

/** `"a" "b"` as one providers returns it, or bare text as another does, to its strings. */
export function txtStrings (data: string): string[] {
  const trimmed = data.trim()
  if (!trimmed.startsWith('"')) return [trimmed]
  const strings: string[] = []
  const quoted = /"((?:[^"\\]|\\.)*)"/g
  for (let match = quoted.exec(trimmed); match !== null; match = quoted.exec(trimmed)) {
    strings.push((match[1] ?? '').replace(/\\(.)/g, '$1'))
  }
  return strings
}

export function dohTxtResolver (endpoints: readonly string[], fetch: WebFetch, timeoutMs = 10_000): ResolveTxt {
  return async (name, signal) => {
    const answers = await dohQuery(endpoints, fetch, name, 'TXT', signal, timeoutMs)
    return answers.filter((a) => a.type === TXT && typeof a.data === 'string').map((a) => txtStrings(a.data as string))
  }
}

/**
 * A host's public-unicast A and AAAA addresses over DNS-over-HTTPS, for
 * comparison against what the SYSTEM resolver says for the same host
 * (dns-fallback.ts) -- never used to reach anything directly on its own.
 * Both record types are asked in parallel; either one answering is enough,
 * so a resolver that only carries one family does not make this fail.
 * A private or loopback answer is dropped rather than trusted: an
 * adversarial DoH provider naming a private address is not a route
 * anything here should ever take, whatever it's being compared against.
 */
export function dohAddressResolver (endpoints: readonly string[], fetch: WebFetch, timeoutMs = 5_000): (host: string, signal: AbortSignal) => Promise<string[]> {
  return async (host, signal) => {
    const addresses: string[] = []
    for (const { address } of (await dohHostAddresses(endpoints, fetch, host, signal, timeoutMs)).addresses) {
      if (!isPublicUnicast(address)) continue
      // The canonical spelling, or nothing: it is compared with the system
      // resolver's answer and may be dialled, and a zone id has no canonical form.
      const canonical = canonicalAddress(address)
      if (canonical !== null) addresses.push(canonical)
    }
    return addresses
  }
}
