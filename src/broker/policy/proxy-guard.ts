// The URL a net capability asks `CreateBrokerOptions['proxyConfigured']`
// about (security-model.md T20, docs/open-questions.md A263): building the
// string is pure, so it lives here rather than in ../capabilities/, the way
// ./canonical-host.ts's helpers do for the host strings ./connect.ts checks.
// The probe itself is real I/O (main wires it to
// `session.defaultSession.resolveProxy`) and stays injected, never imported
// here -- see ../README.md's rule for this layer.

/**
 * The URL a capability with a real destination probes: `host`:`port`,
 * exactly what it is about to reach, IPv6-bracketed the way a URL authority
 * requires. `https:` is a fixed scheme, not a claim about the traffic --
 * `resolveProxy` reads only the authority to decide whether a PAC script or
 * the system proxy applies, and this URL is never dialled. `port` is
 * omitted for `net.lookup`, which names no port at all.
 */
export function proxyProbeUrl (host: string, port?: number): string {
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
