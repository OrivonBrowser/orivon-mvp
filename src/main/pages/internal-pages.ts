// The shell's own pages (Settings, History, ...): which there are, and how a
// URL names one. Pure: no Electron, no Node.

export const INTERNAL_SCHEME = 'orivon'

/** The session internal pages run in: named without `persist:`, so it lives in memory. */
export const INTERNAL_PARTITION = 'orivon-internal'

export const INTERNAL_PAGES = [
  'extensions',
  'history',
  'private',
  'profiles',
  'settings'
] as const
export type InternalPageId = (typeof INTERNAL_PAGES)[number]

export function isInternalPageId (value: unknown): value is InternalPageId {
  return typeof value === 'string' && (INTERNAL_PAGES as readonly string[]).includes(value)
}

export interface InternalAddress {
  readonly page: InternalPageId
  /** Path, query and hash after the page name, `/` when there are none. */
  readonly path: string
}

/** Reads `orivon://<page>[/path]`, however the person capitalised or spaced
 * it. Anything else is null: another scheme, a page that does not exist, or
 * an address with a user, a password or a port, which no internal page has. */
export function parseInternalUrl (input: string): InternalAddress | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== `${INTERNAL_SCHEME}:`) return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  const page = url.hostname.toLowerCase()
  if (!isInternalPageId(page)) return null
  // Not a scheme the URL parser treats as special, so a bare address has no path at all.
  return { page, path: `${url.pathname === '' ? '/' : url.pathname}${url.search}${url.hash}` }
}

/** The URL of a page, and of a place inside it. */
export function internalUrl (page: InternalPageId, path = '/'): string {
  return `${INTERNAL_SCHEME}://${page}${path.startsWith('/') ? path : `/${path}`}`
}
