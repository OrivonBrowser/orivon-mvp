// Whether a request's address is a port a local node holds, on any spelling of
// the computer's own address a page can write. Pure: the Electron half is
// local-node-port-gate.ts, which registers the check on every session. A DNS name an
// attacker points at 127.0.0.1 is not decided here: a request's address is known only
// after it connects, and docs/architecture/security-model.md T12 names that residual.

import { canonicalAddress } from '../../broker/policy/address.js'

/** `localhost` and every name under it, with or without the dots that end a name: the system answers all of them with loopback. */
const LOCALHOST_NAME = /(?:^|\.)localhost\.*$/i

/**
 * The addresses refused, once an IPv4-mapped IPv6 literal is read as the IPv4 address it maps: 127.0.0.1, where Orivon's own nodes listen; 0.0.0.0, which a
 * connection reaches as the computer's own address; and `::1`, the other address `localhost` names. The rest of 127.0.0.0/8 and `::` reach no listener of
 * theirs, which bind 127.0.0.1 alone.
 */
const REFUSED_ADDRESSES: ReadonlySet<string> = new Set(['127.0.0.1', '0.0.0.0', '::1'])

/** The URL of a request to one of `ports`, or undefined when it names none: the test that runs before the host is looked at. */
function toHeldPort (url: string, ports: ReadonlySet<number>): URL | undefined {
  if (ports.size === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  return parsed.port !== '' && ports.has(Number(parsed.port)) ? parsed : undefined
}

/** True for a URL that names one of `ports` on any host: the filter in front of the host decision, so it costs nothing while no node runs. */
export function requestsHeldPort (url: string, ports: ReadonlySet<number>): boolean {
  return toHeldPort(url, ports) !== undefined
}

/** True for a host that names this computer's own address, on whichever spelling the URL gives it. */
function namesThisComputer (hostname: string): boolean {
  if (LOCALHOST_NAME.test(hostname)) return true
  const address = canonicalAddress(hostname)
  return address !== null && REFUSED_ADDRESSES.has(address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, ''))
}

/** True for a URL that names a loopback address on one of `ports`. */
export function reachesLocalNode (url: string, ports: ReadonlySet<number>): boolean {
  const parsed = toHeldPort(url, ports)
  return parsed !== undefined && namesThisComputer(parsed.hostname)
}
