// Chrome's own match-pattern grammar -- scheme, host with a leading `*.`
// wildcard, path glob, plus the `<all_urls>` shorthand -- used to decide
// whether an extension's declared host_permissions/permissions/
// content_scripts[].matches (extension-manifest.ts's own `hostPatterns`)
// cover a given URL. `src/main/extensions/README.md`'s Design notes says
// where this is wired in: chrome.cookies and chrome.tabs both gate on it.
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

/** Schemes Chrome's own `<all_urls>` covers -- `file` is deliberately left
 * out, along with ws/wss and every other scheme (the same allowlist-not-
 * denylist stance `origin.ts`'s `ORIGIN_BEARING_SCHEMES` documents for
 * itself): no installed extension is ever granted file access, so a `file`
 * URL, such as the dashboard's own install-path URL, must stay outside what
 * an `<all_urls>` extension can see. */
const ALL_URLS_SCHEMES = new Set(['http', 'https', 'ftp'])

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

/** `glob`'s `*` wildcards matched against `text` in linear time: no other
 * character is a wildcard (MDN's match-pattern reference says `*` is the
 * only one -- a `?` in a pattern stays the literal query-string separator
 * it usually is, never regex's "zero-or-one" quantifier), so this never
 * builds a regex at all. Split on `*`: the first piece must prefix `text`,
 * the last must suffix it, and every piece between is found with a single
 * forward `indexOf` scan that never backtracks -- unlike `.*` chained
 * through `RegExp`, whose backtracking on a pattern with many `*`s against
 * a long, mostly-matching `text` is exponential in the number of `*`s. */
function globMatches (glob: string, text: string): boolean {
  const parts = glob.split('*')
  if (parts.length === 1) return glob === text
  const first = parts[0] as string
  const last = parts[parts.length - 1] as string
  if (!text.startsWith(first) || !text.endsWith(last)) return false
  const suffixStart = text.length - last.length
  let pos = first.length
  if (pos > suffixStart) return false
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i] as string
    if (piece.length === 0) continue
    const found = text.indexOf(piece, pos)
    if (found === -1 || found + piece.length > suffixStart) return false
    pos = found + piece.length
  }
  return true
}

function pathMatches (patternPath: string, urlPath: string): boolean {
  return globMatches(patternPath, urlPath)
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
