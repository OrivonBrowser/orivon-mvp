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
//
// The last clauses refuse every onion name (RFC 7686): a name Chromium would resolve itself goes to no resolver, whichever
// session, process or code path asks. A request that goes through a proxy is not resolved here at all, so a name sent on to
// the person's own SOCKS5 tunnel is unaffected. They come after the rules already given, so a test run's own mapping of an
// onion name to a local server (the specs that prove a session never asks for one) still wins.

import { exemptFromEnvironmentProxy } from './no-proxy.js'

/** Every `.localhost` name, to the IPv4 loopback address (the port is kept). */
const LOCALHOST_CLAUSE = 'MAP *.localhost 127.0.0.1'

/** Every onion name, with or without the root dot, and `onion` itself: not found, whatever resolver would have been asked. */
const ONION_CLAUSES = ['MAP *.onion ~NOTFOUND', 'MAP *.onion. ~NOTFOUND', 'MAP onion ~NOTFOUND']

/** The value to set, never empty: every protocol host reaches the verifier, whether or not it can verify anything, and every `.localhost` name reaches IPv4 loopback. */
export function composeResolverRules (parts: { readonly devClauses: string, readonly port: number, readonly suffixes: readonly string[], readonly existing: string }): string {
  const verifier = parts.suffixes.map((suffix) => `MAP *.${suffix} 127.0.0.1:${String(parts.port)}`)
  return [parts.devClauses, ...verifier, LOCALHOST_CLAUSE, parts.existing, ...ONION_CLAUSES]
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
    .join(',')
}

/** The part of Electron's command line this writes to. */
export interface CommandLineSwitches {
  readonly getSwitchValue: (name: string) => string
  readonly appendSwitch: (name: string, value: string) => void
}

/**
 * Makes every name a protocol serves answer on this computer: the resolver rules go on the command line, and a proxy Chromium
 * finds in the environment (Linux with no desktop proxy setting) is told not to carry these names. Every other system reads its
 * own proxy settings, which no switch can exempt: see `../route/verifier-name-guard.ts`. The hosts and local nodes Orivon starts
 * inherit the variable; none of them is known to request a name a protocol serves.
 */
export function answerNamesHere (commandLine: CommandLineSwitches, env: Record<string, string | undefined>, parts: { readonly devClauses: string, readonly port: number, readonly suffixes: readonly string[] }): void {
  commandLine.appendSwitch('host-resolver-rules', composeResolverRules({ ...parts, existing: commandLine.getSwitchValue('host-resolver-rules') }))
  exemptFromEnvironmentProxy(env, parts.suffixes)
}
