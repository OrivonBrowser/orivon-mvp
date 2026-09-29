// Chrome's own match-pattern grammar -- scheme, host with a leading `*.`
// wildcard, path glob, plus the `<all_urls>` shorthand -- used to decide
// whether an extension's declared host_permissions/permissions/
// content_scripts[].matches (extension-manifest.ts's own `hostPatterns`)
// cover a given URL. `src/main/extensions/README.md`'s Design notes says
// where this is wired in: chrome.cookies and chrome.tabs both gate on it now.
//
// Pure (this directory's own README): no electron, no Node I/O. Refuses an
// unparsable pattern or URL rather than guessing -- this file's own stance
// on untrusted input, the same one extension-manifest.ts states for itself.

interface ParsedPattern {
  readonly scheme: string
  readonly host: string
  readonly path: string
}

const PATTERN_SHAPE = /^(\*|[a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(\/.*)$/

function parsePattern (pattern: string): ParsedPattern | undefined {
  if (pattern === '<all_urls>') return { scheme: '*', host: '*', path: '/*' }
  const match = PATTERN_SHAPE.exec(pattern)
  if (match === null) return undefined
  return { scheme: match[1] ?? '', host: match[2] ?? '', path: match[3] ?? '' }
}

/** Schemes Chrome's own `<all_urls>` covers -- ws/wss and every other
 * scheme are deliberately excluded, the same allowlist-not-denylist stance
 * `origin.ts`'s `ORIGIN_BEARING_SCHEMES` documents for itself. */
const ALL_URLS_SCHEMES = new Set(['http', 'https', 'file', 'ftp'])

function schemeMatches (patternScheme: string, urlScheme: string, isAllUrls: boolean): boolean {
  if (isAllUrls) return ALL_URLS_SCHEMES.has(urlScheme)
  if (patternScheme === '*') return urlScheme === 'http' || urlScheme === 'https'
  return patternScheme === urlScheme
}

function hostMatches (patternHost: string, urlHost: string): boolean {
  if (patternHost === '*') return true
  const lowerUrlHost = urlHost.toLowerCase()
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2).toLowerCase()
    return lowerUrlHost === suffix || lowerUrlHost.endsWith(`.${suffix}`)
  }
  return patternHost.toLowerCase() === lowerUrlHost
}

/** `glob`'s `*` wildcards, translated to a regex that matches the whole
 * string -- every other regex-special character is escaped literally
 * first, so a path segment is never itself read as a pattern. */
function globToRegExp (glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function pathMatches (patternPath: string, urlPath: string): boolean {
  return globToRegExp(patternPath).test(urlPath)
}

/** True when `pattern` (Chrome match-pattern grammar, or `<all_urls>`)
 * covers `urlString`. */
export function matchesHostPattern (pattern: string, urlString: string): boolean {
  const parsed = parsePattern(pattern)
  if (parsed === undefined) return false
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return false
  }
  const urlScheme = url.protocol.slice(0, -1)
  if (!schemeMatches(parsed.scheme, urlScheme, pattern === '<all_urls>')) return false
  if (!hostMatches(parsed.host, url.hostname)) return false
  if (!pathMatches(parsed.path, `${url.pathname}${url.search}`)) return false
  return true
}

/** True when any pattern in `patterns` covers `urlString`. */
export function matchesAnyHostPattern (patterns: readonly string[], urlString: string): boolean {
  return patterns.some((pattern) => matchesHostPattern(pattern, urlString))
}
