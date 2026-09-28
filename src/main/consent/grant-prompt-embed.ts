// ADR-0039's `web.embed` consent copy, split out of ./grant-prompt-render.ts
// (docs/development/code-guidelines.md Rule 2), the way ./grant-prompt-
// connect.ts holds the network wording. Pure and I/O-free, like that file.

import type { Pattern } from '../../contracts/index.js'
import { ANY_SITE } from '../../broker/policy/embed-origin.js'
import type { CapabilityGrantSummary } from './grant-prompt-connect.js'
import { WARNING_MARK } from './grant-prompt-connect.js'

/**
 * ADR-0039's `web.embed`. At the warning level, whatever the origins: the
 * app can read and change what a shown page shows, and the person is
 * trusting it the way they trust a browser. The wording is the ADR's own.
 */
export function describeEmbedGrant (patterns: readonly Pattern[]): CapabilityGrantSummary {
  const explanation = 'Those pages open in a session kept apart from your ordinary browsing. The app can see and change everything you do on them.'
  if (patterns.includes(ANY_SITE)) {
    return {
      warning: true,
      message: `${WARNING_MARK}Show any website inside itself, and read and change what those pages show`,
      explanation
    }
  }
  const hosts = patterns.map((origin) => {
    try {
      return new URL(origin).host
    } catch {
      return origin
    }
  })
  return {
    warning: true,
    message: `${WARNING_MARK}Show pages from ${hosts.join(', ')} inside itself, and read and change what they show`,
    explanation
  }
}
