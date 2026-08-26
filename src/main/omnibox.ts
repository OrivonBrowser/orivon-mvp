// Classifies address-bar input. Pure function, no Electron/Node dependency --
// this is the one genuinely unit-testable piece of build step 1
// (build-plan.md SS Testing: security-critical logic only).
//
// Security-critical rows: `javascript:`, `data:`, `file:` and `about:` must
// NEVER resolve to { kind: 'url' }. The address bar is chrome-privileged
// input -- a scheme the shell would happily navigate to here is a sandbox
// escape or a local-file-disclosure vector one keystroke away, unlike a
// normal page navigation which is already sandboxed.
//
// Owner decision, 2026-08-26: non-address input goes to DuckDuckGo
// (mvp-scope.md IN table, updated the same day -- this is a deliberate
// scope addition, not a silent one).

export type OmniboxResult =
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string }
  | { kind: 'reject'; reason: string }

const DANGEROUS_SCHEMES = ['javascript:', 'data:', 'file:', 'about:']

function hasDangerousScheme (input: string): boolean {
  const lower = input.toLowerCase()
  return DANGEROUS_SCHEMES.some((scheme) => lower.startsWith(scheme))
}

/**
 * True if `input` (no scheme) looks like something with a host: a domain
 * name, an IPv4 literal, or `host:port` / `[ipv6]:port` forms. Used to
 * decide bare (schemeless) input between a URL and a search query.
 */
function looksLikeHost (input: string): boolean {
  // Bracketed IPv6, optionally with a port: [::1] or [::1]:8080
  if (/^\[[0-9a-fA-F:]+\](:\d+)?$/.test(input)) return true

  // Strip an optional trailing :port and an optional path/query for the
  // host-shape check below.
  const withoutPath = input.split(/[/?#]/)[0] ?? ''
  const hostPart = withoutPath.replace(/:\d+$/, '')

  if (hostPart.length === 0) return false

  // No spaces allowed in a host.
  if (/\s/.test(hostPart)) return false

  // localhost is a host even with no dot.
  if (hostPart === 'localhost') return true

  // IPv4 literal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart)) return true

  // A domain: at least one dot, and every label is alphanumeric/hyphen
  // (this also accepts punycode `xn--` labels, which are ordinary
  // alphanumeric-hyphen strings).
  if (hostPart.includes('.')) {
    const labels = hostPart.split('.')
    return labels.every((label) => label.length > 0 && /^[a-zA-Z0-9-]+$/.test(label))
  }

  return false
}

export function parseOmniboxInput (raw: string): OmniboxResult {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return { kind: 'reject', reason: 'empty' }
  }

  if (hasDangerousScheme(trimmed)) {
    return { kind: 'reject', reason: 'dangerous-scheme' }
  }

  // Already has an http(s) scheme -- pass through unchanged except for
  // URL normalisation (trailing slash on a bare origin, etc).
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return { kind: 'url', url: new URL(trimmed).toString() }
    } catch {
      return { kind: 'reject', reason: 'invalid-url' }
    }
  }

  // No recognised scheme: schemeless host-shaped input defaults to https,
  // except that a bare `host:port` form (including bracketed IPv6) defaults
  // to http, matching the common "point this at a local dev server" case.
  if (looksLikeHost(trimmed)) {
    const isBareHostPort =
      /^\[[0-9a-fA-F:]+\]:\d+$/.test(trimmed) || /^[^/?#]+:\d+([/?#].*)?$/.test(trimmed)
    const scheme = isBareHostPort ? 'http://' : 'https://'
    try {
      return { kind: 'url', url: new URL(scheme + trimmed).toString() }
    } catch {
      return { kind: 'reject', reason: 'invalid-url' }
    }
  }

  // Not URL-shaped: a DuckDuckGo search.
  const query = new URLSearchParams({ q: trimmed }).toString()
  return { kind: 'search', url: `https://duckduckgo.com/?${query}` }
}

/**
 * Validates a URL ARGUMENT, not typed address-bar text -- the caller
 * (setWindowOpenHandler's `details.url`, "open link in new tab") already
 * has what it believes is an absolute URL. Unlike parseOmniboxInput, this
 * never falls back to a search: plain text here means the caller did not
 * supply a real URL, and the safe response is to reject it, not guess
 * intent for it. Returns the normalised URL string, or null.
 */
export function sanitizeDirectUrl (input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (hasDangerousScheme(trimmed)) return null
  if (!/^https?:\/\//i.test(trimmed)) return null

  try {
    return new URL(trimmed).toString()
  } catch {
    return null
  }
}
