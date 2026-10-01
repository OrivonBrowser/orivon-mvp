// The "always use secure connections" decision: which plain-HTTP address is
// upgraded to HTTPS, and which is left alone because HTTPS could never work
// there or is already answered some other way. Pure: no `electron` import.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

/** Name endings no public certificate can cover: a network's own names. */
const LOCAL_SUFFIXES = ['.local', '.localdomain', '.lan', '.internal', '.home.arpa']

function ipv4Octets (host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return null
  const octets = match.slice(1).map(Number)
  return octets.every((octet) => octet <= 255) ? octets : null
}

function isPrivateIpv4 (octets: readonly number[]): boolean {
  const [a = 0, b = 0] = octets
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** `[::ffff:c0a8:1]` is the IPv4 address 192.168.0.1 written in IPv6; the URL parser always writes it in hex. */
function mappedIpv4 (inner: string): number[] | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
  if (match === null) return null
  const high = parseInt(match[1] ?? '', 16)
  const low = parseInt(match[2] ?? '', 16)
  return [high >> 8, high & 255, low >> 8, low & 255]
}

/** Loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10) IPv6 addresses, and IPv4 ones inside an IPv6 address. */
function isPrivateIpv6 (inner: string): boolean {
  if (inner === '::1' || inner === '::') return true
  const mapped = mappedIpv4(inner)
  if (mapped !== null) return isPrivateIpv4(mapped)
  return /^f[cd][0-9a-f]{2}:/.test(inner) || /^fe[89ab][0-9a-f]:/.test(inner)
}

/** The address of this computer or of its own network: HTTPS cannot be expected there, and a developer's server is on it. */
export function isLocalOrPrivateHost (hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('[') && host.endsWith(']')) return isPrivateIpv6(host.slice(1, -1))
  const octets = ipv4Octets(host)
  if (octets !== null) return isPrivateIpv4(octets)
  return !host.includes('.') || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

const isIpHost = (host: string): boolean => host.startsWith('[') || ipv4Octets(host) !== null

/**
 * The `https:` address for an `http:` one, or null when it stays as it is: not
 * an `http:` address, a local or private host, a name a protocol routes to the
 * verifier, or a host `exempt` names (the person's own "continue" answers and
 * this run's developer names). A named host with an explicit port is left
 * alone: dropping the port would send the tab to port 443, which is usually a
 * different service from the one the address names. An IP address keeps its
 * own port, because a bare IP has no other way to say which service it means.
 */
export function upgradeTarget (url: string, exempt: (host: string) => boolean): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '' || isLocalOrPrivateHost(host) || BUILTIN_ADDRESSES.routesToVerifier(host) || exempt(host)) return null
  // The URL parser reports the default port as none, so an explicit port here is never port 80.
  if (parsed.port !== '' && !isIpHost(host)) return null
  parsed.protocol = 'https:'
  return parsed.href
}
