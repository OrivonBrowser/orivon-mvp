// The module's own network, and the only one this process has: `fetch` (Nym's directory) and `WebSocket` (its
// gateways) over a dispatcher that dials `https:` and `wss:` alone, and only addresses that are public unicast. The
// check is made on the addresses the dial uses, so a name that answers differently a second time cannot lead to a
// private one. README.md's Design notes say why a dispatcher and not a wrapper.

import { lookup as systemLookup } from 'node:dns'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, buildConnector } from 'undici'
import { isPublicUnicast } from '../../broker/policy/address.js'

export class NetworkRefused extends Error {
  override readonly name = 'NetworkRefused'
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void
export type Lookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => void

interface ConnectOptions {
  readonly protocol?: string
  readonly hostname?: string
  readonly [key: string]: unknown
}
type Connector = (options: ConnectOptions, callback: (error: Error | null, socket: unknown) => void) => void

/** The address of a URL host as the address classifier reads it: no brackets around an IPv6 literal. */
function bare (hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** A lookup that answers only when every address the name has is public unicast: one other makes the whole name refused. */
export function checkedLookup (lookup: Lookup = systemLookup as Lookup): Lookup {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) { callback(error); return }
      const found = Array.isArray(addresses) ? addresses : []
      const refused = found.find((entry) => !isPublicUnicast(entry.address))
      if (found.length === 0 || refused !== undefined) {
        callback(Object.assign(new NetworkRefused(`${hostname} does not name a public address${refused === undefined ? '' : ` (${refused.address})`}`), { code: 'EACCES' }))
        return
      }
      if (options.all === true) callback(null, found)
      else callback(null, found[0]?.address ?? '', found[0]?.family ?? 4)
    })
  }
}

/** A connector that refuses a scheme other than `https:` and a literal address that is not public, then dials with the checked lookup. */
export function checkedConnector (dial: Connector): Connector {
  return (options, callback) => {
    if (options.protocol !== 'https:') { callback(new NetworkRefused(`the Nym module may reach https and wss addresses only, not ${String(options.protocol)}`), null); return }
    const host = bare(options.hostname ?? '')
    if (isIP(host) !== 0 && !isPublicUnicast(host)) { callback(new NetworkRefused(`the Nym module may not reach ${host}`), null); return }
    dial(options, callback)
  }
}

export interface ModuleNetwork {
  readonly fetch: typeof fetch
  readonly WebSocket: typeof WebSocket
}

/** What the module's `fetch` and `WebSocket` are, over a dispatcher made from `dial`. The default dial is the system's resolver, checked. */
export function createModuleNetwork (dial?: Connector, real: { fetch: typeof fetch, WebSocket: typeof WebSocket } = globalThis): ModuleNetwork {
  const connector = dial ?? (buildConnector({ lookup: checkedLookup() as never }) as unknown as Connector)
  const dispatcher = new Agent({ connect: checkedConnector(connector) as never })
  const base = real.WebSocket
  class ModuleWebSocket extends base {
    constructor (url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, dispatcher } as never)
    }
  }
  return {
    fetch: async (input, init) => await real.fetch(input, { ...init, dispatcher } as RequestInit),
    WebSocket: ModuleWebSocket
  }
}
