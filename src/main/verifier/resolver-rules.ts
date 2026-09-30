// `--host-resolver-rules` has one owner, because a second copy of the switch
// replaces the first rather than adding to it. The first matching clause
// wins, so the order is: developer-mode names, then every host a protocol
// serves (each top-level domain, and the one suffix every address scheme
// shares) to the verifier's loopback server, then every `.localhost` name to
// the IPv4 loopback address, then whatever the command line already carried
// (a test run's hermetic rules).
//
// The `.localhost` clause is what makes a page under `web.embed`'s local
// pattern reach the app's own listener, which binds 127.0.0.1: left to
// itself Chromium resolves such a name to both families and tries IPv6
// first, so another program on `[::1]` would answer instead. An `EXCLUDE`
// clause anywhere on the command line beats every `MAP`, whatever the order,
// so a command line that excludes `.localhost` names switches this off.

/** Every `.localhost` name, to the IPv4 loopback address (the port is kept). */
const LOCALHOST_CLAUSE = 'MAP *.localhost 127.0.0.1'

/** The value to set, never empty: every protocol host reaches the verifier, whether or not it can verify anything, and every `.localhost` name reaches IPv4 loopback. */
export function composeResolverRules (parts: { readonly devClauses: string, readonly port: number, readonly suffixes: readonly string[], readonly existing: string }): string {
  const verifier = parts.suffixes.map((suffix) => `MAP *.${suffix} 127.0.0.1:${String(parts.port)}`)
  return [parts.devClauses, ...verifier, LOCALHOST_CLAUSE, parts.existing]
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
    .join(',')
}
