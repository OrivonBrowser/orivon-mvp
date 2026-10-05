// Which web addresses are an ENS gateway's copy of a `.eth` name, and the
// `.eth` address they stand for. Pure -- no `electron`; the redirect itself
// is ../shell/eth-gateway-redirect.ts.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { dnsName } from '../../protocols/resolution/dns-name.js'

/** The public gateways whose `<name>.eth.<suffix>` addresses stand for `<name>.eth`. */
export const ETH_GATEWAY_SUFFIXES: readonly string[] = ['eth.limo', 'eth.link']

/** Hosts under a gateway suffix that are the gateway's own services, never a name: `www` is its site and `dns` its DNS-over-HTTPS endpoint (eth.limo's "Gateway basics" page). */
const GATEWAY_SERVICE_LABELS: readonly string[] = ['www', 'dns']

/** The gateway suffix `parsed` sits under, over http or https; undefined for any other address. */
function gatewaySuffix (parsed: URL): string | undefined {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return ETH_GATEWAY_SUFFIXES.find((candidate) => parsed.hostname.endsWith(`.${candidate}`))
}

/** Whether `url` is an http or https address under a gateway suffix: the web-request handler's own test, so it runs for gateway hosts alone even once another handler widens the shared URL filter. */
export function isEthGatewayAddress (url: string): boolean {
  try {
    return gatewaySuffix(new URL(url)) !== undefined
  } catch {
    return false
  }
}

/**
 * The `.eth` address a gateway address stands for, with its path, query and
 * fragment kept; undefined for anything else. The scheme is `https:`, or
 * `http:` for a developer-mode name. The result's host ends in `.eth`, so it
 * is never a gateway address itself.
 */
export function ethGatewayTarget (url: string, isDevEthName: (name: string) => boolean): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const suffix = gatewaySuffix(parsed)
  if (suffix === undefined || parsed.port !== '') return undefined
  const labels = parsed.hostname.slice(0, -(suffix.length + 1))
  if (labels === '' || GATEWAY_SERVICE_LABELS.includes(labels)) return undefined
  const name = dnsName(`${labels}.eth`)
  if (name === undefined || name.split('.').some((label) => label.startsWith('xn--'))) return undefined
  if (BUILTIN_ADDRESSES.servedName(name)?.namespace !== '.eth') return undefined
  parsed.protocol = isDevEthName(name) ? 'http:' : 'https:'
  parsed.hostname = name
  parsed.username = ''
  parsed.password = ''
  parsed.port = ''
  return parsed.toString()
}
