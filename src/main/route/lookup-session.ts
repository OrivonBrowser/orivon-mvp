// The session the lookups made about a routed app, or a website open through the proxy, go through: the ones the
// browser makes for it from main (a tab's icon from another host, the Web3 Score provider), which would otherwise
// leave from the default session. Main supplies the answer once; a caller asks per lookup, so an app switched on or off
// is followed at once. A request made from main has no web contents, and the application's `login` event is not raised
// for one: the request answers the front's proxy challenge itself, through `answerRouteChallenge`.

import type { Session } from 'electron'

type LookupSessionSource = (origin: string) => Promise<Session | undefined>

let source: LookupSessionSource | undefined

/** Called once at start by whoever owns the routes. */
export function setLookupSessionSource (next: LookupSessionSource): void {
  source = next
}

/** The session to ask through for a lookup about `origin`'s app, or about a site a temporary routed tab shows: undefined when neither is routed and the lookup goes the ordinary way. A rejection means the app is routed and its route could not be set up, and the lookup does not happen. */
export async function lookupSessionFor (origin: string): Promise<Session | undefined> {
  return await source?.(origin)
}

/** What a proxy challenge from an app's front is answered with, or undefined when the challenge is not from one. */
export type RouteChallengeSource = (info: { readonly isProxy: boolean, readonly host: string, readonly port: number }) => { readonly username: string, readonly password: string } | undefined

let challenge: RouteChallengeSource | undefined

/** Called once at start by whoever owns the routes. */
export function setRouteChallengeSource (next: RouteChallengeSource): void {
  challenge = next
}

/** For a `login` listener on a request made from main: signs in to an app's front, and cancels any other challenge, as a request with no listener does. */
export function answerRouteChallenge (info: Parameters<RouteChallengeSource>[0], callback: (username?: string, password?: string) => void): void {
  const credentials = challenge?.(info)
  if (credentials === undefined) callback()
  else callback(credentials.username, credentials.password)
}

/**
 * Where Orivon's lookups about a website that is not routed go while the whole browser is on the tunnel: a session on the
 * system's proxy, because the default session is then the tunnel's. Undefined while the browser-wide setting is off, when
 * the default session is the ordinary one.
 */
type DirectLookupSource = () => Session | undefined

let direct: DirectLookupSource | undefined

/** Called once at start by whoever owns the routes. */
export function setDirectLookupSource (next: DirectLookupSource): void {
  direct = next
}

/** The session an unrouted website's lookup is made in, or undefined for the default session. */
export function directLookupSession (): Session | undefined {
  return direct?.()
}
