// ADR-0039's `web.embed` consent copy, split out of ./grant-prompt-render.ts
// (docs/development/code-guidelines.md Rule 2), the way ./grant-prompt-
// connect.ts holds the network wording. Pure and I/O-free, like that file.

import type { Pattern } from '../../contracts/index.js'
import { ANY_SITE, parseLocalPattern } from '../../broker/policy/embed-origin.js'
import type { CapabilityGrantSummary } from './grant-prompt-connect.js'
import { joinCapped, portsPhrase, WARNING_MARK } from './grant-prompt-connect.js'

/** `"a"`, `"a and b"`, `"a, b and c"`. */
function joinPhrases (phrases: readonly string[]): string {
  if (phrases.length < 2) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1] as string}`
}

/**
 * ADR-0039's `web.embed`, with ADR-0047's local pattern. At the warning
 * level, whatever the origins: the app can read and change what a shown
 * page shows, and the person is trusting it the way they trust a browser.
 * Each kind of entry the list holds is named -- "*" beside an exact origin
 * or a local pattern is never shown as "*" alone -- and a local pattern says
 * only which ports, since the pages under it come from the app's own server.
 */
export function describeEmbedGrant (patterns: readonly Pattern[]): CapabilityGrantSummary {
  const anySite = patterns.includes(ANY_SITE)
  const localPorts = [...new Set(patterns.flatMap((pattern) => {
    const local = parseLocalPattern(pattern)
    return local === null ? [] : [String(local.port)]
  }))]
  const hosts = patterns.filter((pattern) => pattern !== ANY_SITE && parseLocalPattern(pattern) === null).map((origin) => {
    try {
      return new URL(origin).host
    } catch {
      return origin
    }
  })
  const phrases: string[] = []
  if (anySite) phrases.push('any website')
  // Decision 10: capped, "and N more" -- a manifest can declare up to
  // MAX_PATTERNS (256) embed origins, all joined onto this one line.
  if (hosts.length > 0) phrases.push(`pages from ${joinCapped(hosts)}`)
  if (localPorts.length > 0) phrases.push(`pages it serves itself from this computer (${portsPhrase(localPorts)})`)
  const onlyExact = phrases.length === 1 && hosts.length > 0
  const explanation = 'Those pages open in a session kept apart from your ordinary browsing. The app can see and change everything you do on them.'
  return {
    warning: true,
    message: `${WARNING_MARK}Show ${joinPhrases(phrases)} inside itself, and read and change what ${onlyExact ? 'they' : 'those pages'} show`,
    explanation: localPorts.length > 0
      ? `${explanation} The pages from this computer come from a server the app itself runs on this computer.`
      : explanation
  }
}
