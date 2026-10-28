// The fetch the Ethereum light client's lane is given: the lane's own (the net, the tunnel's front, the outside fetch, a tunnel
// profile's routed fetch) for the servers that are on the internet, and `local-rpc-fetch.ts` for those the person runs on this
// computer or their home network, whichever route the lane travels. A local server is never sent through a proxy or a tunnel:
// that would carry the request to the network of a tunnel's exit. Config the host cannot make sense of starts nothing.

import { EgressRefused, allowlisted, isInternetHost } from '../egress.js'
import type { WebFetch } from '../egress.js'
import type { LightClientConfig } from '../protocol.js'
import { isLocalLiteral, maskEndpoint } from './endpoint-mask.js'

/** The lane's fetch (`send`), or why this lane may not start: said in words that hold no part of an address. */
export type LightClientFetch = { readonly send: WebFetch } | { readonly off: string }

function refusalOf (config: LightClientConfig, local: WebFetch | undefined): string | undefined {
  const endpoints = [...config.executionRpcs, config.consensusRpc]
  const named = new Set<string>()
  for (const endpoint of config.localEndpoints ?? []) {
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      return 'a server named local is not an address'
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLocalLiteral(parsed.hostname)) return `${maskEndpoint(endpoint)} is named local but is not an address on this computer or a home network`
    named.add(parsed.origin)
  }
  if (named.size > 0 && local === undefined) return 'this host has no way to a server on this computer or a home network'
  for (const endpoint of endpoints) {
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      return 'a server is not an address'
    }
    if (isLocalLiteral(parsed.hostname)) {
      if (!named.has(parsed.origin)) return `${maskEndpoint(endpoint)} is on this computer or a home network but is not named local`
    } else if (!isInternetHost(parsed.hostname)) {
      return `${maskEndpoint(endpoint)} is not an address on the internet, and is not named local`
    } else if (parsed.protocol !== 'https:') {
      return `${maskEndpoint(endpoint)} is on the internet and would be reached without TLS`
    }
  }
  return undefined
}

/** `label` names the lane in a refusal. `local` is absent in a host with no path to a local server. */
export function lightClientFetch (config: LightClientConfig, remote: WebFetch, local: WebFetch | undefined, label: string): LightClientFetch {
  const off = refusalOf(config, local)
  if (off !== undefined) return { off }
  const localOrigins = new Set((config.localEndpoints ?? []).map((endpoint) => new URL(endpoint).origin))
  const split: WebFetch = async (url, init) => {
    if (!localOrigins.has(new URL(url).origin)) return await remote(url, init)
    // refusalOf has said there is a local fetch whenever one is named; a local server is never handed to the lane's own.
    if (local === undefined) throw new EgressRefused(`${label} has no way to a server on this computer`)
    return await local(url, init)
  }
  return { send: allowlisted([...config.executionRpcs, config.consensusRpc], split, label) }
}
