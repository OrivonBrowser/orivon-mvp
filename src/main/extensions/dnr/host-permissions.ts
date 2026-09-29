import type { DnrActionAccess } from './types.js'

/**
 * Chrome match-pattern matching
 * (https://developer.chrome.com/docs/extensions/mv3/match_patterns/) and the
 * `DnrActionAccess` an extension's host patterns imply -- the caller side of
 * `vendor/firefox-dnr/UPSTREAM.md` patch 12's `RuleManager#actionAccess`.
 * Pure logic, no Electron and no Node I/O (this directory's README).
 */

interface ParsedHostPattern {
  readonly scheme: string
  /** `''` for a `file:` pattern (no host component). */
  readonly host: string
  readonly path: string
}

const PATTERN_RE = /^(\*|[a-zA-Z][a-zA-Z0-9+.-]*):\/\/(\*|(?:\*\.)?[^/*]+)?(\/.*)$/

function parseHostPattern(pattern: string): ParsedHostPattern | null {
  if (pattern === '<all_urls>') {
    return { scheme: '*', host: '*', path: '/*' }
  }
  if (pattern.startsWith('file:///')) {
    return { scheme: 'file', host: '', path: pattern.slice('file://'.length) }
  }
  const match = PATTERN_RE.exec(pattern)
  if (!match) {
    return null
  }
  const [, scheme, host, path] = match
  return { scheme: scheme!, host: host ?? '*', path: path! }
}

function schemeMatches(patternScheme: string, urlScheme: string): boolean {
  // Chrome's documented '*' scheme wildcard matches only http/https, never
  // file/ftp/ws(s) -- https://developer.chrome.com/docs/extensions/mv3/match_patterns/.
  if (patternScheme === '*') {
    return urlScheme === 'http' || urlScheme === 'https'
  }
  return patternScheme === urlScheme
}

function hostMatches(patternHost: string, urlHost: string): boolean {
  if (patternHost === '*') {
    return true
  }
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2)
    return urlHost === suffix || urlHost.endsWith(`.${suffix}`)
  }
  return patternHost === urlHost
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathMatches(patternPath: string, urlPath: string): boolean {
  const regExp = new RegExp(`^${patternPath.split('*').map(escapeRegExp).join('.*')}$`)
  return regExp.test(urlPath)
}

/** Whether one Chrome match-pattern string matches one URL. Exported for tests. */
export function hostPatternMatchesUrl(pattern: string, url: URL): boolean {
  const parsed = parseHostPattern(pattern)
  if (!parsed) {
    return false
  }
  const urlScheme = url.protocol.slice(0, -1)
  if (!schemeMatches(parsed.scheme, urlScheme)) {
    return false
  }
  if (parsed.scheme !== 'file' && !hostMatches(parsed.host, url.hostname)) {
    return false
  }
  return pathMatches(parsed.path, `${url.pathname}${url.search}`)
}

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
    if (!hostPatterns.some(pattern => hostPatternMatchesUrl(pattern, requestURI))) {
      return false
    }
    if (initiatorURI === null) {
      return true
    }
    return hostPatterns.some(pattern => hostPatternMatchesUrl(pattern, initiatorURI))
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
