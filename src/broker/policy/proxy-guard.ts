// The URL a net capability asks `CreateBrokerOptions['proxyConfigured']`
// about (security-model.md T20, docs/open-questions.md A263): building the
// string is pure, so it lives here rather than in ../capabilities/, the way
// ./canonical-host.ts's helpers do for the host strings ./connect.ts checks.
// The probe itself is real I/O (main wires it to
// `session.defaultSession.resolveProxy`) and stays injected, never imported
// here -- see ../README.md's rule for this layer.

import { MAX_HOST_LENGTH } from './canonical-host.js'

/** What a probe host may contain: DNS-name characters, or an IPv6 literal's hex digits, colons and dots. Anything else is refused later by the connect policy anyway. */
const PROBE_HOST = /^(?:[A-Za-z0-9._-]+|[0-9A-Fa-f:.]+:[0-9A-Fa-f:.]*)$/

/**
 * The URL a capability with a real destination probes: `host`:`port`,
 * exactly what it is about to reach, IPv6-bracketed the way a URL authority
 * requires. `https:` is a fixed scheme, not a claim about the traffic --
 * `resolveProxy` reads only the authority to decide whether a PAC script or
 * the system proxy applies, and this URL is never dialled. `port` is
 * omitted for `net.lookup`, which names no port at all.
 *
 * The host and port come from an app before any policy check, and the
 * probe's cache keeps the URL, so a host that is not a plausible address
 * (longer than a DNS name, or with characters a URL would have to escape)
 * answers `null` and no URL is ever built from it: the caller refuses.
 */
export function proxyProbeUrl (host: string, port?: number): string | null {
  if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH || !PROBE_HOST.test(host)) {
    return null
  }
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)) {
    return null
  }
  const authority = host.includes(':') ? `[${host}]` : host
  return port === undefined ? `https://${authority}/` : `https://${authority}:${String(port)}/`
}

/**
 * The URL `tcp.listen` and `udp.bind` probe. Neither names a destination --
 * each opens a socket the network reaches THEM through, not one they reach
 * out to -- so there is no host:port to ask about. RFC 2606's reserved
 * `example.com`, never dialled, stands in for "an arbitrary public
 * destination": the only question a PAC script can answer with no real
 * destination to give it.
 */
export const GENERIC_PROXY_PROBE_URL = 'https://example.com/'
