// The label a page's active seconds are counted under, and what may be said about it. Pure: the
// caller passes the address and what the trust layer concluded. Web2 sites are never named, not even
// on this computer; a Web3 or Web2.5 site is named only when the name is public by itself (a DNS
// name or an ENS name) or a Web3 Score provider has judged it.
import type { SiteClass } from '../trust/site-class.js'
import type { SiteKey } from './accounting.js'

export const UNLISTED = '(unlisted)'

/** Schemes whose pages are a site; anything else (the new tab page, Settings, a local file) is the browser's own. */
const SITE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ipfs:', 'ipns:'])

const PRIVATE_SUFFIXES: readonly string[] = ['.local', '.localhost', '.lan', '.home', '.home.arpa', '.internal', '.intranet', '.corp', '.test', '.invalid', '.example']

/** A host anyone on the Internet could resolve: dotted labels, a non-numeric end, not a local-network suffix. */
export function isPublicHostName (host: string): boolean {
  if (host.length === 0 || host.length > 253) return false
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false
  const labels = host.split('.')
  if (labels.some((label) => label.startsWith('-') || label.endsWith('-') || label.length > 63)) return false
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return false
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

function hostOf (url: string): { scheme: string, host: string } | null {
  try {
    const parsed = new URL(url)
    return { scheme: parsed.protocol, host: parsed.hostname.toLowerCase() }
  } catch {
    return null
  }
}

export interface SiteFacts {
  readonly url: string
  /** The class of the page's displayed Website level, or null when the trust layer had none. */
  readonly siteClass: SiteClass | null
  /** A Web3 Score provider has judged this site. */
  readonly judged: boolean
}

export function siteKeyFor (facts: SiteFacts): SiteKey {
  const where = hostOf(facts.url)
  if (where === null || !SITE_SCHEMES.has(where.scheme)) return 'internal'
  if (facts.siteClass === null || facts.siteClass === 'web2') return 'web2'
  const nameable = (isPublicHostName(where.host) || facts.judged) && /^[a-z0-9.-]{1,253}$/.test(where.host)
  return `${facts.siteClass}:${nameable ? where.host : ''}`
}

/** The class a key counts toward, or undefined for the browser's own pages. */
export function classOfKey (key: SiteKey): SiteClass | undefined {
  if (key === 'web2') return 'web2'
  if (key.startsWith('web3:')) return 'web3'
  if (key.startsWith('web25:')) return 'web25'
  return undefined
}

/** A named key as the report shows it: an empty name reads `(unlisted)`. */
export function reportedKey (key: SiteKey): string {
  const separator = key.indexOf(':')
  return separator >= 0 && separator === key.length - 1 ? `${key}${UNLISTED}` : key
}
