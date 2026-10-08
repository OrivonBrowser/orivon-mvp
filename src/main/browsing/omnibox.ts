// Classifies address-bar input. Pure function, no Electron/Node dependency --
// this is a unit-testable piece with security-critical logic.
//
// Security-critical rows: `javascript:`, `data:`, `file:` and `about:` must
// NEVER resolve to { kind: 'url' }. The address bar is chrome-privileged
// input -- a scheme the shell would happily navigate to here is a sandbox
// escape or a local-file-disclosure vector one keystroke away, unlike a
// normal page navigation which is already sandboxed.
//
// Input that is not an address goes to the chosen search engine, DuckDuckGo
// unless the person picked another (./search-engines.ts).

import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { DEFAULT_SEARCH_ENGINE, searchUrlFor } from './search-engines.js'

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
 * name (an internationalised one included), an IPv4 literal, a one-word
 * machine name with a port, or `host:port` / `[ipv6]:port` forms, each
 * optionally followed by a path. Used to decide bare (schemeless) input
 * between a URL and a search query.
 */
function looksLikeHost (input: string): boolean {
  // Bracketed IPv6, optionally with a port and a path: [::1], [::1]:8080, [::1]:8080/api
  if (/^\[[0-9a-fA-F:.]+\](:\d+)?([/?#].*)?$/.test(input)) return true

  // Strip an optional trailing :port and an optional path/query for the
  // host-shape check below.
  const withoutPath = input.split(/[/?#]/)[0] ?? ''
  const hasPort = /:\d+$/.test(withoutPath)
  const hostPart = withoutPath.replace(/:\d+$/, '').toLowerCase()

  if (hostPart.length === 0) return false

  // No spaces allowed in a host.
  if (/\s/.test(hostPart)) return false

  // localhost is a host even with no dot.
  if (hostPart === 'localhost') return true

  // IPv4 literal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart)) return true

  // Every label is letters (of any script: the URL parser turns them into
  // punycode), digits or hyphens.
  const labels = hostPart.split('.')
  if (!labels.every((label) => label.length > 0 && /^[\p{L}\p{N}\p{M}-]+$/u.test(label))) return false

  // One word is a machine on the local network only when a port says so
  // (`nas:5000`); alone it is a search.
  if (labels.length === 1) return hasPort

  // A last label of digits alone is not a domain: the URL parser reads it as
  // an IPv4 shorthand (`3.14` would open 3.0.0.14) or refuses the host
  // (`python3.12`), so the text is a search.
  return !/^\d+$/.test(labels[labels.length - 1] ?? '')
}

/** `searchUrl` turns a query into the URL that searches for it. */
export function parseOmniboxInput (
  raw: string,
  isDevEthName: (host: string) => boolean = () => false,
  searchUrl: (query: string) => string = (query) => searchUrlFor(DEFAULT_SEARCH_ENGINE, '', query)
): OmniboxResult {
  const trimmed = raw.trim()

  if (trimmed.length === 0) {
    return { kind: 'reject', reason: 'empty' }
  }

  // A leading `?` asks for a search whatever the rest looks like: `? example.com` searches for the address
  // instead of going to it. It comes before the scheme check because a search never navigates to that scheme.
  if (trimmed.startsWith('?')) {
    const query = trimmed.slice(1).trim()
    return query === '' ? { kind: 'reject', reason: 'empty' } : { kind: 'search', url: searchUrl(query) }
  }

  if (hasDangerousScheme(trimmed)) {
    return { kind: 'reject', reason: 'dangerous-scheme' }
  }

  // A protocol's address (`ipfs://...`) loads from the https URL that
  // protocol's pages are served at, which is all servedUrl ever returns.
  const served = BUILTIN_ADDRESSES.servedUrl(trimmed)
  if (served !== undefined) return { kind: 'url', url: served }

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
  // to http, matching the common "point this at a local dev server" case --
  // and except a developer-mode `.eth` name from orivon-ports' names file,
  // which is a plain http server on loopback with no certificate to present.
  // Every other `.eth` name stays https: the verifier serves it (../verifier/).
  // Checked on the host portion only, so a path that happens to end in
  // `.eth` (`example.com/x.eth`) is unaffected.
  if (looksLikeHost(trimmed)) {
    const isBareHostPort =
      /^\[[0-9a-fA-F:]+\]:\d+$/.test(trimmed) || /^[^/?#]+:\d+([/?#].*)?$/.test(trimmed)
    const host = (trimmed.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '').toLowerCase()
    const scheme = (isBareHostPort || (host.endsWith('.eth') && isDevEthName(host))) ? 'http://' : 'https://'
    try {
      return { kind: 'url', url: new URL(scheme + trimmed).toString() }
    } catch {
      // Host-shaped, but no URL (a label the URL parser refuses): the person typed text, so it is a search.
    }
  }

  // Not URL-shaped: a search.
  return { kind: 'search', url: searchUrl(trimmed) }
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
  const served = BUILTIN_ADDRESSES.servedUrl(trimmed)
  if (served !== undefined) return served
  if (!/^https?:\/\//i.test(trimmed)) return null

  try {
    return new URL(trimmed).toString()
  } catch {
    return null
  }
}
