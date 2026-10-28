import { bytesToHex, concat } from 'viem'
import type { Fetch } from '../../gateways/gateways.js'
import type { WebFetch } from '../../verifier-host/egress.js'
import { CHUNK_PAYLOAD_BYTES, REFERENCE_BYTES, SPAN_BYTES, readSpan } from '../chunk.js'

/** Which endpoints a switch applies to; all of them when omitted. */
type Only = readonly string[] | undefined

export interface FakeSwarm {
  readonly fetch: Fetch
  readonly requests: string[]
  /** Serve this chunk with one byte flipped. */
  tamper: (address: string, only?: Only) => void
  /** Answer this chunk with a 302 to somewhere else, as a content filter does. */
  redirect: (address: string, only?: Only) => void
  /** These endpoints have none of the chunks. */
  readonly empty: Set<string>
  /** Endpoints answering `/feeds/...` with this index (hex, as the header carries it). Others answer 501, as a node without that route does. */
  readonly feedHints: Map<string, string>
  /** Whether `/bytes/<hex>` answers with the bytes under that chunk; without it, a 404. */
  bytesRoute: boolean
  /** Subtrees whose `/bytes` answer has one byte flipped, in its second leaf. */
  readonly tamperedBytes: Set<string>
}

/** The bytes under the chunk at `address`, joined as a node's `/bytes` route joins them; undefined when a chunk is missing. */
function joined (chunks: ReadonlyMap<string, Uint8Array>, address: string): Uint8Array | undefined {
  const chunk = chunks.get(address)
  if (chunk === undefined) return undefined
  const { size } = readSpan(chunk)
  const payload = chunk.subarray(SPAN_BYTES)
  if (size <= CHUNK_PAYLOAD_BYTES) return payload.subarray(0, size)
  const ref = (i: number): string => bytesToHex(payload.subarray(i * REFERENCE_BYTES, (i + 1) * REFERENCE_BYTES)).slice(2)
  const first = chunks.get(ref(0))
  if (first === undefined) return undefined
  const parts: Uint8Array[] = []
  for (let i = 0; i < Math.ceil(size / readSpan(first).size); i++) {
    const part = joined(chunks, ref(i))
    if (part === undefined) return undefined
    parts.push(part)
  }
  return concat(parts)
}

/** Bee-API endpoints over `chunks`, speaking `/chunks/<hex>`, `/bytes/<hex>` and `/feeds/<owner>/<topic>`. */
export function fakeSwarm (chunks: ReadonlyMap<string, Uint8Array>): FakeSwarm {
  const requests: string[] = []
  const tampered = new Map<string, Only>()
  const redirected = new Map<string, Only>()
  const empty = new Set<string>()
  const feedHints = new Map<string, string>()
  const applies = (only: Only, endpoint: string): boolean => only === undefined || only.includes(endpoint)
  const fetch: Fetch = async (url, init) => {
    requests.push(url)
    if (init.signal.aborted) throw new Error('aborted')
    const parsed = new URL(url)
    const endpoint = parsed.origin
    const chunk = /^\/chunks\/([0-9a-f]{64})$/.exec(parsed.pathname)
    if (chunk !== null) {
      const address = chunk[1]!
      const bytes = chunks.get(address)
      if (bytes === undefined || empty.has(endpoint)) return new Response('not found', { status: 404 })
      if (redirected.has(address) && applies(redirected.get(address), endpoint)) return new Response(null, { status: 302, headers: { location: `https://filter.example/forbidden?hash=${address}` } })
      const body = new Uint8Array(bytes)
      if (tampered.has(address) && applies(tampered.get(address), endpoint)) body[body.length - 1] = body[body.length - 1]! ^ 1
      return new Response(body, { headers: { 'content-type': 'application/octet-stream' } })
    }
    const subtree = /^\/bytes\/([0-9a-f]{64})$/.exec(parsed.pathname)
    if (subtree !== null) {
      const body = swarm.bytesRoute && !empty.has(endpoint) ? joined(chunks, subtree[1]!)?.slice() : undefined
      if (body === undefined) return new Response('not found', { status: 404 })
      const flipped = 2 * CHUNK_PAYLOAD_BYTES - 1
      if (swarm.tamperedBytes.has(subtree[1]!)) body[flipped] = body[flipped]! ^ 1
      return new Response(body)
    }
    if (parsed.pathname.startsWith('/feeds/')) {
      const hint = feedHints.get(endpoint)
      return hint === undefined ? new Response('not implemented', { status: 501 }) : new Response('{}', { headers: { 'swarm-feed-index': hint } })
    }
    return new Response('bad request', { status: 400 })
  }
  const swarm: FakeSwarm = {
    fetch,
    requests,
    tamper: (address, only) => { tampered.set(address, only) },
    redirect: (address, only) => { redirected.set(address, only) },
    empty,
    feedHints,
    bytesRoute: true,
    tamperedBytes: new Set()
  }
  return swarm
}

export const A = 'https://a.endpoint'
export const B = 'https://b.endpoint'

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
export const text = (data: Uint8Array): string => new TextDecoder().decode(data)

/** A private key for tests: never used anywhere else. */
export const TEST_KEY = `0x${'11'.repeat(32)}` as const
export const TOPIC = 'ab'.repeat(32)

/** A `Fetch` as the host's allowlist wraps it, which takes an optional init. */
export const asWebFetch = (fetch: Fetch): WebFetch => async (url, init) => await fetch(url, { headers: {}, signal: init?.signal ?? new AbortController().signal })
