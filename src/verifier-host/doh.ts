// TXT lookups for DNSLink over DNS-over-HTTPS's JSON form, through the
// host's allowlisted fetch. The answer is still unauthenticated DNS: a
// DNSLink hop is never a verified one, whoever answers it.

import type { ResolveTxt } from '../ipfs/dnslink.js'
import { readCapped } from '../ipfs/gateways.js'
import type { WebFetch } from './egress.js'

const TXT = 16
const NXDOMAIN = 3
const MAX_ANSWER_BYTES = 64 * 1024

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
    const errors: string[] = []
    for (const endpoint of endpoints) {
      try {
        const url = new URL(endpoint)
        url.searchParams.set('name', name)
        url.searchParams.set('type', 'TXT')
        const response = await fetch(url.toString(), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
        if (!response.ok) throw new Error(`${url.host} answered ${String(response.status)}`)
        const text = new TextDecoder().decode(await readCapped(response, MAX_ANSWER_BYTES))
        const body = JSON.parse(text) as { Status?: unknown, Answer?: Array<{ type?: unknown, data?: unknown }> }
        if (body.Status === NXDOMAIN) return []
        if (body.Status !== 0) throw new Error(`${url.host} answered DNS status ${String(body.Status)}`)
        return (body.Answer ?? []).filter((a) => a.type === TXT && typeof a.data === 'string').map((a) => txtStrings(a.data as string))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    throw new Error(`no DNS-over-HTTPS resolver answered for ${name}: ${errors.join('; ')}`)
  }
}
