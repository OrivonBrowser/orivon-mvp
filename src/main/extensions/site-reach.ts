// Which installed extensions' host access covers a given origin -- pure, no
// electron, no I/O (this directory's suffix rule). Reused by the grant and
// install-consent prompts (../consent/) and the site-info popup
// (../permissions/), so a person deciding about a site's permissions also
// sees which extensions can act on it (the extensions disclosure,
// docs/planning/extensions-exploration.md; README.md's Design notes).

import { matchesAnyHostPattern } from '../../broker/policy/extension-host-patterns.js'

/**
 * What this function needs to know about one enabled extension: its
 * resolved name (`__MSG_...` already turned into text by
 * `resolveLocaleMessage`, `./extensions-view.js` -- this file never
 * resolves one itself, so there is only the one resolver) and every
 * host_permissions/content_scripts[].matches pattern its manifest declares
 * (`../../broker/policy/extension-manifest.js`'s own `hostPatterns`, which
 * already merges both, so no separate content-script-vs-host-permission
 * distinction survives to here).
 */
export interface ExtensionSiteCandidate {
  readonly name: string
  readonly hostPatterns: readonly string[]
}

/**
 * The names of every candidate in `extensions` whose host access covers
 * `origin`, in the order given. Checked as `${origin}/` against
 * `matchesAnyHostPattern` -- the all-sites patterns
 * (`../../broker/policy/extension-manifest.js`'s own `ALL_SITES_PATTERNS`)
 * already cover any origin under that grammar, so no separate case is
 * needed for either.
 *
 * An origin served from its pinned cache runs no extensions at all
 * (`../../broker/policy/extension-manifest.js`'s `GRANTED_APPS_CLAUSE`:
 * "except an app running from its pinned copy"), so this returns none for
 * it without ever looking at `extensions`. `isOriginServedFromCacheSync` is
 * injected rather than imported -- the real implementation lives in
 * `../../loader/electron/serve.js`, which this directory does not depend
 * on -- so this file stays pure and testable against a fake.
 */
export function extensionsReachingOrigin (
  origin: string,
  extensions: readonly ExtensionSiteCandidate[],
  isOriginServedFromCacheSync: (origin: string) => boolean
): readonly string[] {
  if (isOriginServedFromCacheSync(origin)) return []
  const url = `${origin}/`
  return extensions
    .filter((extension) => matchesAnyHostPattern(extension.hostPatterns, url))
    .map((extension) => extension.name)
}
