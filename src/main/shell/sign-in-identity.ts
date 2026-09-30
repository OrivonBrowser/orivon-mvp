// Which hosts get a Firefox identity instead of this browser's own, and the
// string that identity is. See ./README.md's user-agent.ts design note for
// why Chrome's own identity cannot be repaired here: Electron has no API to
// add a "Google Chrome" brand to Sec-CH-UA/navigator.userAgentData, and
// Google's sign-in flow (support.google.com/accounts/answer/7675428) rejects
// its absence. Firefox reports neither Sec-CH-UA nor navigator.userAgentData
// at all, so presenting Firefox on these hosts alone sidesteps the check
// rather than trying to fake a brand list Electron cannot produce.

/** Exact hosts, never a suffix match -- `accounts.google.com` is Google's
 * sign-in page; `accounts.youtube.com` is its own account chooser, reached
 * mid-flow from a YouTube sign-in link. Never `google.com` or `youtube.com` at large:
 * this is the identity's whole surface, and it must not grow it by
 * accident. */
export const SIGN_IN_HOSTS: readonly string[] = ['accounts.google.com', 'accounts.youtube.com']

/** `host` is a request's or a document's own host: `new URL(url).host`
 * (hostname, plus `:port` only when the URL carries a non-default one) --
 * never `.hostname` alone, since a test fixture standing in for one of
 * these hosts (see sign-in-identity-test-seam.ts) is reached over an
 * explicit port and must not silently match every host sharing its bare
 * name. `hosts` defaults to the real list; a caller that also allows a
 * test seam's hosts passes the merged list instead. */
export function isSignInHost (host: string, hosts: readonly string[] = SIGN_IN_HOSTS): boolean {
  return hosts.includes(host)
}

/** Bump this when Firefox ships a new release -- Mozilla's own calendar
 * (whattrainisitnow.com), roughly every four weeks. A version far behind
 * Firefox's real current one is itself a tell, the same way an old Chrome
 * major would be; this file has no mechanism to keep it current on its own. */
const FIREFOX_VERSION = '143.0'

/** Firefox's own frozen platform tokens -- distinct from Chrome's own
 * (user-agent.ts's CHROME_PLATFORM_TOKENS): Firefox reports the real
 * Gecko platform string, not Chrome's, and the two must never be mixed
 * into one UA. */
const FIREFOX_PLATFORM_TOKENS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10.15'
}
const FIREFOX_LINUX_TOKEN = 'X11; Linux x86_64'

/** The full Firefox User-Agent string this platform's Firefox would send,
 * for the current OS Orivon runs on -- never Electron's or Chrome's
 * version, since Firefox's own UA carries no Chromium version at all. */
export function firefoxUserAgent (platform: NodeJS.Platform): string {
  const token = FIREFOX_PLATFORM_TOKENS[platform] ?? FIREFOX_LINUX_TOKEN
  return `Mozilla/5.0 (${token}; rv:${FIREFOX_VERSION}) Gecko/20100101 Firefox/${FIREFOX_VERSION}`
}

/** The request headers Chromium would send to a sign-in host, replaced with
 * what Firefox would send instead: its own User-Agent, and none of
 * Chromium's Sec-CH-UA* headers. Firefox sends neither Client Hints nor
 * navigator.userAgentData at all, and leaving Chromium's own Sec-CH-UA*
 * headers next to a Firefox User-Agent would be a louder tell than sending
 * neither -- a partial spoof (this file's own header note) is a signal on
 * its own. Case-insensitive on the way out: Electron does not guarantee a
 * header's original casing survives into `requestHeaders`. */
export function firefoxIdentityHeaders (headers: Readonly<Record<string, string>>, firefoxUA: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'user-agent' || lower.startsWith('sec-ch-ua')) continue
    out[name] = value
  }
  out['User-Agent'] = firefoxUA
  return out
}
