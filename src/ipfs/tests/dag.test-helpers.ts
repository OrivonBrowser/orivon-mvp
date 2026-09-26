import { importer } from 'ipfs-unixfs-importer'
import type { ImportCandidate, ImporterOptions } from 'ipfs-unixfs-importer'
import { CID } from 'multiformats/cid'
import type { Fetch } from '../gateways.js'

export interface Dag {
  readonly root: CID
  readonly blocks: Map<string, Uint8Array>
}

/** A UnixFS DAG, built as a publisher would, held in memory. */
export async function buildDag (files: Record<string, string | Uint8Array>, options: ImporterOptions = {}): Promise<Dag> {
  const blocks = new Map<string, Uint8Array>()
  const store = {
    put: async (cid: CID, bytes: Uint8Array) => {
      blocks.set(cid.toString(), bytes)
      return cid
    }
  }
  const candidates: ImportCandidate[] = Object.entries(files).map(([path, content]) => ({
    path,
    content: typeof content === 'string' ? new TextEncoder().encode(content) : content
  }))
  let root: CID | undefined
  for await (const entry of importer(candidates, store, { wrapWithDirectory: true, cidVersion: 1, rawLeaves: true, ...options })) {
    root = entry.cid
  }
  if (root === undefined) throw new Error('empty import')
  return { root, blocks }
}

export interface FakeGateway {
  readonly fetch: Fetch
  readonly requests: string[]
  /** Serve this CID's block with one byte flipped, from these gateways. */
  tamper: (cid: string, gateways?: readonly string[]) => void
  /** These gateways answer every request with 500. */
  failing: Set<string>
  /** These gateways never answer at all -- the fetch settles only once the
   * caller's own signal aborts, the same shape a hung connection takes. */
  hanging: Set<string>
  /** These gateways refuse the connection outright -- the fetch rejects
   * immediately, before any signal or timeout is involved. */
  unreachable: Set<string>
  /** These gateways answer 429, with `retryAfter` as the header's value
   * (omit for no header at all). */
  rateLimit: (gateway: string, retryAfter?: string) => void
  /** Answer requests for this CID with a body of this many bytes. */
  oversize: (cid: string, bytes: number) => void
  /** Signed IPNS records by key, served for `?format=ipns-record`, per gateway when `only` is given. */
  ipns: (key: string, record: Uint8Array, only?: readonly string[]) => void
}

/** Trustless gateways over `blocks`, speaking `?format=raw`. */
export function fakeGateways (blocks: ReadonlyMap<string, Uint8Array>): FakeGateway {
  const requests: string[] = []
  const tampered = new Map<string, readonly string[] | undefined>()
  const oversized = new Map<string, number>()
  const failing = new Set<string>()
  const hanging = new Set<string>()
  const unreachable = new Set<string>()
  const rateLimited = new Map<string, string | undefined>()
  const records = new Map<string, Array<{ record: Uint8Array, only: readonly string[] | undefined }>>()
  const fetch: Fetch = async (url, init) => {
    requests.push(url)
    if (init.signal.aborted) throw new Error('aborted')
    const parsed = new URL(url)
    const gateway = parsed.origin
    if (unreachable.has(gateway)) throw new TypeError('getaddrinfo ENOTFOUND (simulated)')
    if (hanging.has(gateway)) {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { reject(new Error('aborted (simulated hang)')) }, { once: true })
      })
    }
    if (rateLimited.has(gateway)) {
      const retryAfter = rateLimited.get(gateway)
      return new Response('slow down', { status: 429, headers: retryAfter !== undefined ? { 'retry-after': retryAfter } : {} })
    }
    if (failing.has(gateway)) return new Response('down', { status: 500 })
    const ipns = /^\/ipns\/([^/?]+)$/.exec(parsed.pathname)
    if (ipns !== null && parsed.searchParams.get('format') === 'ipns-record') {
      const served = (records.get(ipns[1]!) ?? []).find((r) => r.only === undefined || r.only.includes(gateway))
      return served === undefined ? new Response('not found', { status: 404 }) : new Response(served.record.slice(), { headers: { 'content-type': 'application/vnd.ipfs.ipns-record' } })
    }
    const match = /^\/ipfs\/([^/?]+)$/.exec(parsed.pathname)
    if (match === null || parsed.searchParams.get('format') !== 'raw') return new Response('bad request', { status: 400 })
    const key = CID.parse(match[1]!).toString()
    const size = oversized.get(key)
    if (size !== undefined) return new Response(new Uint8Array(size), { headers: { 'content-type': 'application/vnd.ipld.raw' } })
    const block = blocks.get(key)
    if (block === undefined) return new Response('not found', { status: 404 })
    const body = block.slice()
    const only = tampered.get(key)
    if (tampered.has(key) && (only === undefined || only.includes(gateway))) body[body.length - 1] = body[body.length - 1]! ^ 0x01
    return new Response(body, { headers: { 'content-type': 'application/vnd.ipld.raw' } })
  }
  return {
    fetch,
    requests,
    failing,
    hanging,
    unreachable,
    rateLimit: (gateway, retryAfter) => { rateLimited.set(gateway, retryAfter) },
    tamper: (cid, gateways) => { tampered.set(cid, gateways) },
    oversize: (cid, bytes) => { oversized.set(cid, bytes) },
    ipns: (key, record, only) => { records.set(key, [...(records.get(key) ?? []), { record, only }]) }
  }
}
