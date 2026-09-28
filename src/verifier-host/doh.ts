// DNS-over-HTTPS lookups through the host's allowlisted fetch: TXT records
// for DNSLink, and (dns-fallback.ts's own use) A/AAAA records to compare
// against what the system resolver says for a gateway that just failed.
// Every answer here is still unauthenticated DNS -- a DNSLink hop is never
// a verified one, whoever answers it, and an address comparison is only
// ever a SIGNAL that something is wrong, never proof of what is right.

import type { ResolveTxt } from '../ipfs/dnslink.js'
import { readCapped } from '../ipfs/gateways.js'
import { isPublicUnicast } from '../broker/policy/address.js'
import type { WebFetch } from './egress.js'

const TXT = 16
const A_RECORD = 1
const AAAA_RECORD = 28
const NXDOMAIN = 3
const MAX_ANSWER_BYTES = 64 * 1024

interface DnsAnswer {
  readonly type?: unknown
  readonly data?: unknown
}

/** One DNS-over-HTTPS query, tried against each endpoint in turn: the
 * answers for `name`/`type`, or `[]` for NXDOMAIN (a real, negative
 * answer, not a failure). Throws only once every endpoint has failed to
 * answer at all. Shared by the TXT and address resolvers below (Rule 3) --
 * they differ only in which record type they ask for and how they read
 * the answers back. */
async function dohQuery (endpoints: readonly string[], fetch: WebFetch, name: string, type: 'TXT' | 'A' | 'AAAA', signal: AbortSignal, timeoutMs: number): Promise<DnsAnswer[]> {
  const errors: string[] = []
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint)
      url.searchParams.set('name', name)
      // The mnemonic, not the numeric type code: every provider measured
      // accepts both, and the mnemonic is what a request log actually
      // reads as. The JSON *answer* still carries the type numerically
      // regardless (RFC-assigned codes), which is what the callers below
      // filter on.
      url.searchParams.set('type', type)
      const response = await fetch(url.toString(), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
      if (!response.ok) throw new Error(`${url.host} answered ${String(response.status)}`)
      const text = new TextDecoder().decode(await readCapped(response, MAX_ANSWER_BYTES))
      const body = JSON.parse(text) as { Status?: unknown, Answer?: DnsAnswer[] }
      if (body.Status === NXDOMAIN) return []
      if (body.Status !== 0) throw new Error(`${url.host} answered DNS status ${String(body.Status)}`)
      return body.Answer ?? []
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`no DNS-over-HTTPS resolver answered for ${name}: ${errors.join('; ')}`)
}

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
    const [a, aaaa] = await Promise.allSettled([
      dohQuery(endpoints, fetch, host, 'A', signal, timeoutMs),
      dohQuery(endpoints, fetch, host, 'AAAA', signal, timeoutMs)
    ])
    if (a.status === 'rejected' && aaaa.status === 'rejected') {
      throw new Error(`no DNS-over-HTTPS resolver answered for ${host}: ${a.reason instanceof Error ? a.reason.message : String(a.reason)}`)
    }
    const addresses: string[] = []
    for (const [result, type] of [[a, A_RECORD], [aaaa, AAAA_RECORD]] as const) {
      if (result.status !== 'fulfilled') continue
      for (const answer of result.value) {
        if (answer.type === type && typeof answer.data === 'string' && isPublicUnicast(answer.data)) addresses.push(answer.data)
      }
    }
    return addresses
  }
}
