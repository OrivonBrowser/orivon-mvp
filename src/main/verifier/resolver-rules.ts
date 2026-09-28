// `--host-resolver-rules` has one owner, because a second copy of the switch
// replaces the first rather than adding to it. The first matching clause
// wins, so the order is: developer-mode names, then every host a protocol
// serves (each top-level domain, and the one suffix every address scheme
// shares) to the verifier's loopback server, then whatever the command line
// already carried (a test run's hermetic rules).

/** The value to set, never empty: every protocol host reaches the verifier, whether or not it can verify anything. */
export function composeResolverRules (parts: { readonly devClauses: string, readonly port: number, readonly suffixes: readonly string[], readonly existing: string }): string {
  const verifier = parts.suffixes.map((suffix) => `MAP *.${suffix} 127.0.0.1:${String(parts.port)}`)
  return [parts.devClauses, ...verifier, parts.existing]
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
    .join(',')
}
