// The one question T20 asks: does a proxy apply to this computer's own connections, as the system says? While the whole
// browser is on the tunnel the default session is pointed at the tunnel's front, so asking it would always answer "a proxy",
// and every unrouted app's `orivon.net` would be refused. The answer comes from a session of its own that only ever follows
// the system. Main supplies it once; nothing asks before then, and a question asked then fails, which counts as a proxy.

type SystemProxyProbe = (url: string) => Promise<string>

let probe: SystemProxyProbe | undefined

/** Called once at start by whoever owns the routes. */
export function setSystemProxyProbe (next: SystemProxyProbe | undefined): void {
  probe = next
}

/** Chromium's answer for `url` on the system's proxy settings: `DIRECT`, or the proxy it names. */
export async function systemProxyFor (url: string): Promise<string> {
  if (probe === undefined) throw new Error('the system proxy cannot be asked yet')
  return await probe(url)
}
