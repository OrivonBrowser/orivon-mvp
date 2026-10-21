// A fetch that leaves outside the tunnel even while the whole browser is on it, for what the person asked to run outside the
// tunnel ("Use tunnel to run network nodes" off): the Ethereum light client's RPC and beacon requests and CCIP-Read. Node
// sockets to an address this process resolves itself and checks (public unicast, canonical), with TLS checked against the real
// name: neither `net.fetch` nor `net.request` can leave a process whose network context `app.setProxy` pointed at the tunnel's
// front. Reached only by a request `allowlisted` or `guardedCcipRequest` already admitted.

import { isIP } from 'node:net'
import { canonicalAddress } from '../../broker/policy/address.js'
import type { DirectFetch } from './direct-fetch.js'
import type { WebFetch } from './egress.js'

export type ResolveHost = (host: string) => Promise<readonly string[]>

/** A request body as the text `direct-fetch.ts` sends: the light client's JSON-RPC bodies arrive as bytes, and are UTF-8. */
function textBody (body: RequestInit['body']): string | undefined {
  if (body === undefined || body === null || typeof body === 'string') return body ?? undefined
  if (body instanceof ArrayBuffer) return new TextDecoder('utf-8', { fatal: true }).decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder('utf-8', { fatal: true }).decode(body)
  throw new TypeError('a request sent outside the tunnel carries a string or bytes as its body')
}

export function createOutsideFetch (direct: DirectFetch, resolveHost: ResolveHost): WebFetch {
  return async (url, init) => {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    const answers = isIP(host) === 0 ? await resolveHost(host) : [host]
    const addresses = answers.flatMap((answer) => canonicalAddress(answer) ?? [])
    if (addresses.length === 0) throw new Error(`${host} has no address this computer can dial`)
    const body = textBody(init?.body)
    return await direct(url, init === undefined || body === init.body ? init : { ...init, ...(body === undefined ? { body: null } : { body }) }, addresses)
  }
}
