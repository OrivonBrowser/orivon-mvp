import { matchesAnyHostPattern } from '../../../broker/policy/extension-host-patterns.js'
import type { DnrActionAccess } from './types.js'

/**
 * The `DnrActionAccess` an extension's host patterns imply -- the caller
 * side of `vendor/firefox-dnr/UPSTREAM.md` patch 12's
 * `RuleManager#actionAccess`. The match-pattern grammar itself is
 * `../../../broker/policy/extension-host-patterns.ts`'s
 * `matchesAnyHostPattern` (code-guidelines Rule 3: one matcher, shared with
 * the broker's own cookies/tabs host-access checks); this file adds only
 * what is DNR-specific -- checking both the request URL and its initiator,
 * and turning an extension's permission names into a `DnrActionAccess`.
 * Pure logic, no Electron and no Node I/O (this directory's README).
 */

/**
 * Builds the `hasHostAccess` predicate for one extension's host patterns
 * (`ExtensionManifestFacts.hostPatterns`, or a stripped copy's own recorded
 * patterns). Chrome checks the initiator only when one is known -- see
 * `DnrActionAccess`'s own doc.
 */
export function createHostAccessChecker(
  hostPatterns: readonly string[]
): (requestURI: URL, initiatorURI: URL | null) => boolean {
  return (requestURI, initiatorURI) => {
    // No extension ever gets file access, so file: is never covered here
    // -- ../../README.md's "allowFileAccess is never true" entry has why.
    if (requestURI.protocol === 'file:') {
      return false
    }
    if (!matchesAnyHostPattern(hostPatterns, requestURI.href)) {
      return false
    }
    if (initiatorURI === null) {
      return true
    }
    if (initiatorURI.protocol === 'file:') {
      return false
    }
    return matchesAnyHostPattern(hostPatterns, initiatorURI.href)
  }
}

/**
 * `DnrActionAccess` for an extension holding the given DNR-related
 * permissions and host patterns. `dnrPermissions` is whatever subset of
 * `declarativeNetRequest`/`declarativeNetRequestWithHostAccess` the
 * extension's original (pre-strip) manifest granted -- an extension with
 * neither should never reach `createDnrEngine()` at all (this package's own
 * README), so this function does not itself refuse that case.
 */
export function buildActionAccess(
  dnrPermissions: readonly string[],
  hostPatterns: readonly string[]
): DnrActionAccess {
  const hasPlainPermission = dnrPermissions.includes('declarativeNetRequest')
  return {
    hasHostAccess: createHostAccessChecker(hostPatterns),
    requiresHostAccessForAllActions: !hasPlainPermission,
  }
}
