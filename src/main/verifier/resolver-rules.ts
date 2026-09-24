// `--host-resolver-rules` has one owner, because a second copy of the switch
// replaces the first rather than adding to it. The first matching clause
// wins, so the order is: developer-mode names, then every other `.eth` name
// to the verifier's loopback server, then whatever the command line already
// carried (a test run's hermetic rules).

/** The value to set, never empty: every `.eth` name reaches the verifier, whether or not it can verify anything. */
export function composeResolverRules (parts: { readonly devClauses: string, readonly port: number, readonly existing: string }): string {
  return [parts.devClauses, `MAP *.eth 127.0.0.1:${String(parts.port)}`, parts.existing]
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
    .join(',')
}
