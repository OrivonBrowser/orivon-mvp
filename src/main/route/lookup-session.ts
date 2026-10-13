// The session the lookups made about a routed app go through: the ones the browser makes for it from main (a tab's
// icon from another host, the Web3 Score provider), which would otherwise leave from the default session. Main
// supplies the answer once; a caller asks per lookup, so an app switched on or off is followed at once.

import type { Session } from 'electron'

type LookupSessionSource = (origin: string) => Promise<Session | undefined>

let source: LookupSessionSource | undefined

/** Called once at start by whoever owns the routes. */
export function setLookupSessionSource (next: LookupSessionSource): void {
  source = next
}

/** The session to ask through for a lookup about `origin`'s app: undefined when the app is not routed and the lookup goes the ordinary way. A rejection means the app is routed and its route could not be set up, and the lookup does not happen. */
export async function lookupSessionFor (origin: string): Promise<Session | undefined> {
  return await source?.(origin)
}
