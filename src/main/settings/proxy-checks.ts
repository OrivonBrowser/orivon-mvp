// The shape of the SOCKS5 proxy a person points an app's route at: a host and a port, nothing more. Pure, so the
// settings schema, the route and the Settings page's Test action all read an address the same way.
import { isIPv6 } from 'node:net'

export interface ProxyAddress {
  readonly host: string
  readonly port: number
}

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/
const PREFIX = 'socks5://'

/** The host and port in `text` (an IPv6 literal in brackets), or undefined when it is anything else. */
export function parseProxyAddress (text: string): ProxyAddress | undefined {
  let rest = text.trim()
  if (rest.startsWith(PREFIX)) rest = rest.slice(PREFIX.length)
  const split = rest.lastIndexOf(':')
  if (split <= 0) return undefined
  const portText = rest.slice(split + 1)
  if (!/^\d{1,5}$/.test(portText)) return undefined
  const port = Number(portText)
  if (port < 1 || port > 65535) return undefined
  let host = rest.slice(0, split)
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return undefined
    host = host.slice(1, -1)
    return isIPv6(host) ? { host, port } : undefined
  }
  return HOSTNAME.test(host) ? { host, port } : undefined
}

/** Empty (no proxy chosen), or one address. */
export function isEmptyOrProxyAddress (value: string): boolean {
  return value === '' || parseProxyAddress(value) !== undefined
}
