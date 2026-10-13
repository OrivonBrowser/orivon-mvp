// One DNS-over-HTTPS query (the JSON form), tried against each endpoint in
// turn, and a host's A and AAAA answers as the providers wrote them. The
// verifier host reads TXT records and compares addresses with it
// (verifier-host/doh.ts); a local node resolves its peers' names with it
// (local-node/node-dns.ts). Every answer is unauthenticated DNS: what a caller
// does with an address is its own rule to make.

import { readCapped } from './gateways.js'
import type { WebFetch } from './allowlisted-fetch.js'

const A_RECORD = 1
const AAAA_RECORD = 28
const NXDOMAIN = 3
const MAX_ANSWER_BYTES = 64 * 1024

export interface DnsAnswer {
  readonly type?: unknown
  readonly data?: unknown
  readonly TTL?: unknown
}

/** One DNS-over-HTTPS query, tried against each endpoint in turn: the
 * answers for `name`/`type`, or `[]` for NXDOMAIN (a real, negative
 * answer, not a failure). Throws only once every endpoint has failed to
 * answer at all. Shared by the TXT and address resolvers (Rule 3) -- they
 * differ only in which record type they ask for and how they read the
 * answers back. */
export async function dohQuery (endpoints: readonly string[], fetch: WebFetch, name: string, type: 'TXT' | 'A' | 'AAAA', signal: AbortSignal, timeoutMs: number): Promise<DnsAnswer[]> {
  const errors: string[] = []
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint)
      url.searchParams.set('name', name)
      // The mnemonic, not the numeric type code: every provider measured
      // accepts both, and the mnemonic is what a request log actually
      // reads as. The JSON *answer* still carries the type numerically
      // regardless (RFC-assigned codes), which is what the callers
      // filter on.
      url.searchParams.set('type', type)
      const response = await fetch(url.toString(), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
      if (!response.ok) throw new Error(`${url.host} answered ${String(response.status)}`)
      const text = new TextDecoder().decode(await readCapped(response, MAX_ANSWER_BYTES))
      const body = JSON.parse(text) as { Status?: unknown, Answer?: unknown }
      if (body.Status === NXDOMAIN) return []
      if (body.Status !== 0) throw new Error(`${url.host} answered DNS status ${String(body.Status)}`)
      return Array.isArray(body.Answer) ? body.Answer as DnsAnswer[] : []
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`no DNS-over-HTTPS resolver answered for ${name}: ${errors.join('; ')}`)
}

export interface HostAddress {
  /** The address text exactly as the provider wrote it: not checked, not canonical. */
  readonly address: string
  readonly family: 'IPv4' | 'IPv6'
  /** The record's TTL in seconds, when the provider gave a usable one. */
  readonly ttlSeconds: number | undefined
}

/**
 * Every A and AAAA address a host's answers name. Both record types are
 * asked in parallel and either one answering is enough, so a resolver that
 * carries one family does not make this fail; it throws only when neither
 * could be answered at all. An empty result is a real answer: the name has no
 * address.
 */
export async function dohHostAddresses (endpoints: readonly string[], fetch: WebFetch, host: string, signal: AbortSignal, timeoutMs: number): Promise<HostAddress[]> {
  const [a, aaaa] = await Promise.allSettled([
    dohQuery(endpoints, fetch, host, 'A', signal, timeoutMs),
    dohQuery(endpoints, fetch, host, 'AAAA', signal, timeoutMs)
  ])
  if (a.status === 'rejected' && aaaa.status === 'rejected') {
    throw new Error(`no DNS-over-HTTPS resolver answered for ${host}: ${a.reason instanceof Error ? a.reason.message : String(a.reason)}`)
  }
  const addresses: HostAddress[] = []
  for (const [result, type, family] of [[a, A_RECORD, 'IPv4'], [aaaa, AAAA_RECORD, 'IPv6']] as const) {
    if (result.status !== 'fulfilled') continue
    for (const answer of result.value) {
      if (answer.type !== type || typeof answer.data !== 'string') continue
      const ttl = typeof answer.TTL === 'number' && Number.isFinite(answer.TTL) && answer.TTL >= 0 ? answer.TTL : undefined
      addresses.push({ address: answer.data, family, ttlSeconds: ttl })
    }
  }
  return addresses
}
