// A session Orivon makes for its own work, with no page in it, carries what that work sends and nothing else: the relay's lookups,
// a read through the pinned endpoint, the fetch of a proxy script, the questions asked of the system's proxy. Electron's spell
// checker would fetch a dictionary into it from a fixed host as its first request: through the proxy it is set to, by name, which
// is a lookup the relay did not make; through the pinned endpoint, a connection nobody pinned; on a direct session, a connection
// from this computer that nothing asked for. Tied to Electron through the session it is handed.

import type { Session } from 'electron'

export type QuietableSession = Pick<Session, 'setSpellCheckerEnabled' | 'setSpellCheckerLanguages'>

/** Takes the spell checker off `session` before it makes a request, and hands the session back. */
export function quietSession<S extends QuietableSession> (session: S): S {
  session.setSpellCheckerEnabled(false)
  session.setSpellCheckerLanguages([])
  return session
}
