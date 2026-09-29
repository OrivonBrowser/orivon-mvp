// The real I/O behind ./site-reach.js's decision: reads each enabled
// extension's manifest off its loaded folder -- the same read
// ./extensions-view-runner.js's `readExtensionFacts` already does for the
// extensions page, reused here rather than a second manifest read -- to get
// its resolved name and host patterns, then asks the pure matcher.

import { readExtensionFacts } from './extensions-view-runner.js'
import { extensionsReachingOrigin } from './site-reach.js'
import type { ExtensionSiteCandidate } from './site-reach.js'
import type { InstalledExtension } from './registry.js'

/** The one method this file needs off `ExtensionsApi` (`./extensions-
 * subsystem.js`) -- `Pick`, not the whole interface, the same narrowing
 * `../pages/pages-domain.js` uses for `WindowRegistry`, so a caller (and a
 * test) never has to stub methods this file never calls. */
export interface ExtensionLister {
  readonly list: () => readonly InstalledExtension[]
}

/**
 * The names of every enabled installed extension whose host access covers
 * `origin`, read fresh off disk each call -- there are at most a handful of
 * installed extensions, and this only runs when a grant or install-consent
 * prompt, or the site-info popup, is actually about to be shown, never on
 * a hot path.
 *
 * An origin served from its pinned cache short-circuits before `list()` is
 * even called: `extensionsReachingOrigin` would return none for it anyway
 * (its own doc says why), so there is nothing to read a manifest for.
 */
export async function extensionNamesForOrigin (
  extensions: ExtensionLister,
  origin: string,
  isOriginServedFromCacheSync: (origin: string) => boolean
): Promise<readonly string[]> {
  if (isOriginServedFromCacheSync(origin)) return []
  const enabled = extensions.list().filter((entry) => entry.enabled)
  const candidates: ExtensionSiteCandidate[] = await Promise.all(enabled.map(async (entry) => {
    const facts = await readExtensionFacts(entry)
    return { name: facts.resolvedName, hostPatterns: facts.manifestFacts?.hostPatterns ?? [] }
  }))
  return extensionsReachingOrigin(origin, candidates, isOriginServedFromCacheSync)
}
