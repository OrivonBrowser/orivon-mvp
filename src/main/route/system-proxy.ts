// The one question T20 asks: does a proxy apply to this computer's own connections, as the system says? While the whole browser
// is on the tunnel the default session is pointed at the tunnel's front, so asking it would always answer "a proxy", and every
// unrouted app's `orivon.net` would be refused. The answer comes from a session of its own that only ever follows the system.
// Main supplies it once; nothing asks before then, and a question asked then fails, which counts as a proxy.
//
// A name the verifier serves is never put to that session: it stays on `{ mode: 'system' }` and so hands the name to whatever script
// the system names, which can resolve it or send it anywhere. Those names are asked of a session that holds the copy of the
// system's settings, and refused without a question where no session does.

import { namesVerifierHost } from './verifier-name-guard.js'

type SystemProxyProbe = (url: string) => Promise<string>

let probe: SystemProxyProbe | undefined
let routedProbe: SystemProxyProbe | undefined

/** Called once at start by whoever owns the routes: `next` answers for ordinary hosts, and `routed` for the names the verifier serves. */
export function setSystemProxyProbe (next: SystemProxyProbe | undefined, routed?: SystemProxyProbe): void {
  probe = next
  routedProbe = routed
}

/** Chromium's answer for `url` on the system's proxy settings: `DIRECT`, or the proxy it names. A name the verifier serves is answered by the session that holds the copy of the settings, and rejects where that session would hand it to the system's script. */
export async function systemProxyFor (url: string): Promise<string> {
  if (namesVerifierHost(url)) {
    if (routedProbe === undefined) throw new Error('the system proxy cannot be asked about this name yet')
    return await routedProbe(url)
  }
  if (probe === undefined) throw new Error('the system proxy cannot be asked yet')
  return await probe(url)
}
