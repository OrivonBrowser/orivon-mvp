// Whether a request's address is a port a local node holds, on any spelling of
// the computer's own address a page can write. Pure: the Electron half is
// local-node-port-gate.ts, which registers the check on every session.

/**
 * Match patterns for every spelling of loopback that reaches a node's listener on this computer, for every scheme a
 * page can use. A DNS name that an attacker points at 127.0.0.1 is not among them: a request's address is known only
 * after it connects, and docs/architecture/security-model.md T12 names that residual.
 */
export const LOOPBACK_URL_PATTERNS: readonly string[] = ['http', 'https', 'ws', 'wss'].flatMap((scheme) =>
  ['localhost', '*.localhost', '127.0.0.1', '[::1]', '[::ffff:7f00:1]', '0.0.0.0'].map((host) => `${scheme}://${host}/*`))

const LOOPBACK_HOST = /^(?:localhost|.+\.localhost|127\.0\.0\.1|\[::1\]|\[::ffff:7f00:1\]|0\.0\.0\.0)\.?$/

/** True for a URL that names a loopback address on one of `ports`. */
export function reachesLocalNode (url: string, ports: ReadonlySet<number>): boolean {
  if (ports.size === 0) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.port === '' || !ports.has(Number(parsed.port))) return false
  return LOOPBACK_HOST.test(parsed.hostname)
}
