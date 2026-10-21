// Whether a connection an app asked for lands on a loopback listener Orivon
// itself runs (the verifier, a held local node, a route front). A loopback
// grant exists for the person's own services; the webRequest gate that keeps
// pages off these ports never sees an orivon.net socket, so the connect
// decision makes the same exclusion (security-model.md T12).

import { classifyAddress } from './address.js'
import { normalizeHost } from './canonical-host.js'
import { LOCALHOST } from './connect-patterns.js'

/** `hosts` are the names or address literals the connection can end up at. True when any of them is this machine and `port` is one `isOwnPort` holds. */
export function reachesOwnLoopbackPort (hosts: readonly string[], port: number, isOwnPort: ((port: number) => boolean) | undefined): boolean {
  if (isOwnPort === undefined || !isOwnPort(port)) return false
  return hosts.some((host) => {
    const normalized = normalizeHost(host)
    const cls = classifyAddress(normalized)
    return normalized === LOCALHOST || cls === 'loopback' || cls === 'unspecified'
  })
}
