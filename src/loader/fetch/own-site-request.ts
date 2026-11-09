// Which requests for a site's host are the site's own, judged from the browser's Fetch Metadata and nothing a page can
// set. The verifier's server hands only such a request to the shell, and the shell's session keeps only such a request
// out of its HTTP cache, so the two must read a request alike: both ask this.

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

/**
 * Whether the browser made the request for the site itself: from a page or worker of the site's own origin
 * (`Sec-Fetch-Site: same-origin`), with no page behind it (`none`: a typed address, a bookmark, the favicon), or as the
 * navigation of a top-level document from any site (a link to the site opens it as the site). Another site's image,
 * script, request or frame is not: it is answered as it would be if the site were not kept, so no page can tell by the
 * answer that it is (A256). Chromium sets these headers and a page cannot change them.
 */
export function isOwnSiteRequest (headers: RequestHeaders): boolean {
  const site = requestHeader(headers, 'sec-fetch-site')
  if (site === 'same-origin' || site === 'none') return true
  return requestHeader(headers, 'sec-fetch-mode') === 'navigate' && requestHeader(headers, 'sec-fetch-dest') === 'document'
}
