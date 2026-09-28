// DNSLink: `_dnslink.<domain>` TXT records naming `/ipfs/...` or `/ipns/...`.
// DNS is unauthenticated here, so whatever this returns is only ever a
// pointer "via DNS", never a verified one.

import { ResolutionError } from '../resolution/records.js'

/** Answers a TXT query: each record is the list of its strings. */
export type ResolveTxt = (name: string, signal: AbortSignal) => Promise<string[][]>

const PREFIX = 'dnslink='

/**
 * The DNSLink value for `domain`. When a name carries several, the
 * lexicographically first `/ipfs/` or `/ipns/` value is used, so every
 * resolver of the same answer picks the same one.
 */
export async function resolveDnslink (domain: string, resolveTxt: ResolveTxt, signal: AbortSignal): Promise<string> {
  let records: string[][]
  try {
    records = await resolveTxt(`_dnslink.${domain}`, signal)
  } catch (error) {
    throw new ResolutionError('unavailable', `DNSLink for ${domain}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const values = records
    .map((strings) => strings.join(''))
    .filter((text) => text.startsWith(PREFIX))
    .map((text) => text.slice(PREFIX.length).trim())
    .filter((value) => value.startsWith('/ipfs/') || value.startsWith('/ipns/'))
    .sort()
  const first = values[0]
  if (first === undefined) throw new ResolutionError('not-found', `${domain} publishes no DNSLink`)
  return first
}
