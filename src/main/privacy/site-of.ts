// Which "site" an address belongs to: its registrable domain, so `www.shop.example`
// and `cdn.shop.example` are one site and `shop.example` and `other.example` are
// two. The rule for cookies, HTTPS-only exemptions and the per-site data list.
// Pure: no `electron` import.
import { parse } from 'tldts'

/**
 * The registrable domain of `url` (`shop.example` for `https://www.shop.example/a`),
 * or the host itself when it has none: an IP address, `localhost` and its
 * subdomains, a single-label name. Null when `url` has no host. A domain some
 * service hands out to its customers (`name.github.io`) is one site, not many:
 * the public-suffix list's private section is not consulted.
 */
export function siteOf (url: string): string | null {
  const parsed = parse(url, { allowPrivateDomains: false })
  if (parsed.hostname === null || parsed.hostname === '') return null
  if (parsed.isIp === true) return parsed.hostname
  return parsed.domain ?? parsed.hostname
}

/** Whether two addresses are the same site. False when either has no host. */
export function sameSite (urlA: string, urlB: string): boolean {
  const a = siteOf(urlA)
  return a !== null && a === siteOf(urlB)
}
