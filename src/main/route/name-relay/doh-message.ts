// The DNS message a DNS-over-HTTPS query carries (RFC 8484, `application/dns-message`) and the reading of its answer.
// Pure: no `electron` import.

import * as dns from '@dnsquery/dns-packet'

export type AddressFamily = 4 | 6

/** What an answer says: addresses with the shortest TTL on the way to them, or none (`nxdomain` tells a missing name from a name with no address of this family), or nothing usable. */
export type DohAnswer =
  | { readonly kind: 'addresses', readonly addresses: readonly string[], readonly ttl: number }
  | { readonly kind: 'empty', readonly nxdomain: boolean, readonly ttl: number }
  | { readonly kind: 'failed' }

/** The links of a CNAME chain that are followed from the asked name; a longer one is not an answer. */
export const MAX_CNAME_LINKS = 8

/** RFC 8467's block for padding a query. */
const PADDING_BLOCK = 128

const normalise = (name: string): string => name.toLowerCase().replace(/\.+$/, '')

/** The body of one question, RFC 8484 style: ID 0, a single question (a server may answer only the first of two, or refuse both), no client subnet, and an OPT record padded so that the message is a whole number of blocks. */
export function dohQuery (name: string, family: AddressFamily): Uint8Array<ArrayBuffer> {
  const padding = { code: 'PADDING' as const, length: 0 }
  const query: dns.Packet = {
    type: 'query',
    id: 0,
    flags: dns.RECURSION_DESIRED,
    questions: [{ type: family === 4 ? 'A' : 'AAAA', name: normalise(name) }],
    additionals: [{ type: 'OPT', name: '.', udpPayloadSize: 4096, flags: 0, options: [padding] } as unknown as dns.Answer]
  }
  padding.length = (PADDING_BLOCK - (dns.encode(query).length % PADDING_BLOCK)) % PADDING_BLOCK
  return new Uint8Array(dns.encode(query))
}

/** The negative TTL a response gives (RFC 2308): its SOA record's TTL or minimum, whichever is smaller; 0 when it has none. */
function negativeTtl (packet: dns.Packet): number {
  for (const record of packet.authorities ?? []) {
    if (record.type === 'SOA') return Math.min(record.ttl ?? 0, record.data.minimum ?? 0)
  }
  return 0
}

/** `bytes` as the answer to the question of `family` about `name`. */
export function readDohAnswer (bytes: Uint8Array, name: string, family: AddressFamily): DohAnswer {
  let packet: dns.Packet
  try {
    packet = dns.decode(bytes)
  } catch {
    return { kind: 'failed' }
  }
  if (packet.flag_qr !== true || packet.flag_tc === true) return { kind: 'failed' }
  if (packet.rcode === 'NXDOMAIN') return { kind: 'empty', nxdomain: true, ttl: negativeTtl(packet) }
  if (packet.rcode !== 'NOERROR') return { kind: 'failed' }
  const wanted = family === 4 ? 'A' : 'AAAA'
  const records = packet.answers ?? []
  let current = normalise(name)
  let ttl = Number.POSITIVE_INFINITY
  for (let links = 0; ; links += 1) {
    const found = records.filter((record) => record.type === wanted && normalise(record.name) === current)
    if (found.length > 0) {
      return { kind: 'addresses', addresses: found.map((record) => String(record.data)), ttl: Math.min(ttl, ...found.map((record) => record.ttl ?? 0)) }
    }
    const link = records.find((record) => record.type === 'CNAME' && normalise(record.name) === current)
    if (link === undefined) return { kind: 'empty', nxdomain: false, ttl: negativeTtl(packet) }
    if (links === MAX_CNAME_LINKS) return { kind: 'failed' }
    ttl = Math.min(ttl, link.ttl ?? 0)
    current = normalise(String(link.data))
  }
}
