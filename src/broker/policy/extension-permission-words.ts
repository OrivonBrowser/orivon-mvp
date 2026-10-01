// The words a person reads for what an extension may do: one line per API
// permission and one per host pattern. Shared by the install prompt, the
// permission prompt at request time and the details page, so the three never
// say different things about one permission. Pure: no electron, no I/O.

/** One line per API permission Orivon serves that deserves a warning.
 * `sidePanel` and `activeTab` have none: neither reaches anything the person
 * has not just chosen to show it. `cookies`, `clipboardRead`, `notifications`
 * and the other permissions Chrome words itself keep their wording in
 * extension-manifest.ts's API_PERMISSION_LINES. */
export const PERMISSION_WORDS: Readonly<Record<string, string>> = {
  bookmarks: 'Read and change your bookmarks',
  history: 'Read and change your browsing history',
  topSites: 'Read a list of your most visited websites',
  downloads: 'Manage your downloads',
  'downloads.open': 'Open downloaded files',
  sessions: 'Read your recently closed tabs',
  browsingData: 'Clear your browsing data',
  management: 'Manage your extensions',
  readingList: 'Read and change your reading list',
  search: 'Search with your default search engine',
  tabGroups: 'View and manage your tab groups',
  pageCapture: 'Save pages you visit',
  identity: 'Ask you to sign in to other websites',
  webRequest: 'See the requests websites make',
  privacy: 'Read your privacy settings'
}

/** The two patterns that, on their own, already cover every site. A
 * scheme-qualified equivalent (matching http alone, say) is not one of them:
 * it still excludes https. (A literal "star colon slash slash star slash
 * star" is not spelled out in this comment: it closes a block comment early.) */
const ALL_SITES_PATTERNS = new Set(['<all_urls>', '*://*/*'])

export function isAllSitesPattern (pattern: string): boolean {
  return ALL_SITES_PATTERNS.has(pattern)
}

/** A pattern's host portion for display: everything between "://" and the
 * next "/". Falls back to the raw pattern when it does not parse in that
 * scheme-host-path shape; display only, never used for a security decision. */
export function friendlyHost (pattern: string): string {
  const match = /^[a-zA-Z*][a-zA-Z0-9+.-]*:\/\/([^/]+)/.exec(pattern)
  return match?.[1] ?? pattern
}

/** One host pattern in words: "Read and change your data on example.com", or
 * "... on every website" for a pattern that covers any host. */
export function hostWords (pattern: string): string {
  const host = friendlyHost(pattern)
  if (isAllSitesPattern(pattern) || host === '*') return 'Read and change your data on every website'
  if (host.startsWith('*.')) return `Read and change your data on ${host.slice(2)} and its subdomains`
  return `Read and change your data on ${host}`
}
