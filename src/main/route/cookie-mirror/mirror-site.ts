// The site an address belongs to for the cookie mirror: who a cookie's owner is. Pure: no `electron` import.
import { parse } from 'tldts'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'

/**
 * The site of `address`: its registrable domain by the whole public suffix list, the private section included, so the customers of
 * a service that hands out domains (`alice.github.io`, `d111.cloudfront.net`, `vitalik.eth.limo`) are each a site. An address
 * Orivon serves (`<content>.ipfs.orivon`, a Swarm hash, a `.eth` name) is its whole host, since the domain above it is a namespace
 * shared by every party in it. An IP address, `localhost` and a name with no registrable domain are the host itself. Undefined
 * when `address` has no host.
 */
export function mirrorSiteOf (address: string): string | undefined {
  const parsed = parse(address, { allowPrivateDomains: true })
  const host = parsed.hostname
  if (host === null || host === '') return undefined
  if (parsed.isIp === true) return host
  if (BUILTIN_ADDRESSES.routesToVerifier(host)) return host
  return parsed.domain ?? host
}
