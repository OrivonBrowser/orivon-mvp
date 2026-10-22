// What the gateway mapping needs beyond the address rule (./eth-gateway-rule.ts)
// once it covers content inside a page: which resource types it maps, the CORS
// headers a gateway answers with, and the requests it moved. Durable: no `electron`.

/** A `.eth` name serves no socket, and a ping or a violation report is no content, so those three types are left out. */
const MAPPED_TYPES: ReadonlySet<string> = new Set(['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'media', 'other'])

/** Whether a request of this Electron resource type is mapped: a page and everything a page loads. */
export function mapsResourceType (resourceType: string): boolean {
  return MAPPED_TYPES.has(resourceType)
}

/** What a gateway adds to every response (eth.limo answers every request with these), lowercase as Electron lists response headers. */
export const GATEWAY_CORS_HEADERS: Readonly<Record<string, readonly string[]>> = {
  'access-control-allow-origin': ['*'],
  'access-control-allow-methods': ['GET, HEAD, OPTIONS, POST'],
  'access-control-allow-headers': ['Content-Type,Range,User-Agent,X-Requested-With'],
  'access-control-expose-headers': ['Content-Length,Content-Range,X-Chunked-Output,X-Ipfs-Path,X-Ipfs-Roots,X-Stream-Output'],
  'access-control-allow-credentials': ['false']
}

/** `headers` with the gateway's CORS headers in place of any of the same names, in any case. */
export function withGatewayCors (headers: Readonly<Record<string, string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, values] of Object.entries(headers)) if (!(name.toLowerCase() in GATEWAY_CORS_HEADERS)) out[name] = values
  for (const [name, values] of Object.entries(GATEWAY_CORS_HEADERS)) out[name] = [...values]
  return out
}

/** The most request ids kept, so a page that loads without end cannot grow the set. */
export const MAX_MAPPED_REQUESTS = 1024

/** The ids of the page-content requests the mapping moved from a gateway address to a `.eth` one: only these get the gateway's CORS headers back. */
export class MappedRequests {
  private readonly ids = new Set<number>()

  get size (): number {
    return this.ids.size
  }

  add (id: number): void {
    this.ids.delete(id)
    this.ids.add(id)
    if (this.ids.size > MAX_MAPPED_REQUESTS) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
  }

  has (id: number): boolean {
    return this.ids.has(id)
  }

  forget (id: number): void {
    this.ids.delete(id)
  }
}
