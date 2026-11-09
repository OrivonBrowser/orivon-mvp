// Which requests for a site's host are the site's own, judged from what the shell stamped on the request and the browser's
// Fetch Metadata, and nothing a page can set. The verifier's server hands only such a request to the shell, and the
// shell's session keeps only such a request out of its HTTP cache, so the two must read a request alike: both ask this.
import { PARTITION_HEADER } from './content-root.js'

/** An origin, as the shell names a request's top-level page; nothing else is taken as a partition. */
const PARTITION = /^[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]{1,253}$/

/** Request headers as Node or Electron hold them: names in any case, a value possibly a list. */
export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>

/** The first value of the header `name` (lower case), whatever case it was sent in. */
export function requestHeader (headers: RequestHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    return typeof value === 'string' ? value : value?.[0]
  }
  return undefined
}

/** The origin of the top-level page the shell stamped on the request, or undefined when it stamped none (a request no page started). */
export function namedPartition (headers: RequestHeaders): string | undefined {
  const named = requestHeader(headers, PARTITION_HEADER)
  return named !== undefined && PARTITION.test(named) ? named : undefined
}

/**
 * Whether the request is the site's own, for the site at `host`: its top-level page is the site's (a page of it, its
 * frames, even a sandboxed one), or no page started it and the browser marked it `Sec-Fetch-Site` `none` (a typed address,
 * the favicon) or `same-origin` (a worker of the site's), or it is the navigation of a top-level document from any site (a
 * link to the site opens it as the site). Another site's page asking for the host, its image, script or frame, is not: it
 * is answered as it would be if the site were not kept, so no page can tell by the answer that it is (A256), whatever its
 * `Sec-Fetch-Site` says. Chromium sets the Fetch Metadata and the shell sets the stamp; a page can change neither.
 */
export function isOwnSiteRequest (headers: RequestHeaders, host: string): boolean {
  if (requestHeader(headers, 'sec-fetch-mode') === 'navigate' && requestHeader(headers, 'sec-fetch-dest') === 'document') return true
  const named = namedPartition(headers)
  if (named !== undefined) return named === `https://${host}`
  const site = requestHeader(headers, 'sec-fetch-site')
  return site === 'none' || site === 'same-origin'
}
