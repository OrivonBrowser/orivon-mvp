// Which verifier cache a page's `.eth` request may use: its top-level
// page's origin, the way Chromium partitions its own HTTP cache. A name one
// site opened is then cold for every other site, so no page can time a
// `.eth` request to learn where the person has been (A256).

import type { TunnelRoute } from '../../protocols/verifier-host/protocol.js'

/** A request as the shell sees it: its URL, its kind, and the URL of the top-level page it came from, if any. */
export interface PageRequest {
  readonly url: string
  readonly resourceType: string
  readonly topUrl: string | undefined
  /** The request's `Sec-Fetch-Site`, which the browser sets and no script can: `same-origin` when the context that made it is of the URL's own origin. */
  readonly fetchSite?: string | undefined
}

function originOf (url: string): string | undefined {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/**
 * A navigation of the top-level page belongs to the page it opens; anything
 * else to the page on top. A request with no frame to ask (a worker's) belongs
 * to the origin it is for when a worker of that origin made it, which the
 * browser's own `Sec-Fetch-Site` says and nothing else does, so an allowed
 * app's service worker is answered as its pages are. Undefined otherwise, or
 * when the origin is none: the verifier then decides from the request itself.
 */
export function requestPartition (request: PageRequest): string | undefined {
  if (request.resourceType === 'mainFrame') return originOf(request.url)
  if (request.topUrl === undefined) return request.fetchSite === 'same-origin' ? originOf(request.url) : undefined
  return originOf(request.topUrl)
}

/** Whether `partition` is the origin `url` is for: a request of a site's own, the kind the verifier may hand to the shell. */
export function isOfOwnSite (partition: string | undefined, url: string): partition is string {
  return partition !== undefined && originOf(url) === partition
}

/**
 * `headers` with a condition no cache can answer, which Chromium's HTTP cache reads as "neither read nor write this
 * request": the answer comes from the server or not at all. A conditional header the page set itself is replaced.
 */
export function withoutHttpCache (headers: Readonly<Record<string, string>>): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'if-match'))
  out['If-Match'] = '*'
  return out
}

/** The value of the header `name` (lower case) in `headers`, whatever case it was sent in. */
export function headerValue (headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value
  return undefined
}

/**
 * `headers` with the partition header set to `partition`, or removed when
 * there is none: whatever a page put there itself never reaches the verifier.
 */
export function withPartition (headers: Readonly<Record<string, string>>, header: string, partition: string | undefined): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== header))
  if (partition !== undefined) out[header] = partition
  return out
}

/**
 * `headers` with the route header set to the tunnel when the request is a website's in that tunnel's profile, and removed
 * otherwise: whatever a page put there itself never reaches the verifier.
 */
export function withRoute (headers: Readonly<Record<string, string>>, header: string, tunnel: TunnelRoute | undefined): Record<string, string> {
  const out = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== header))
  if (tunnel !== undefined) out[header] = tunnel
  return out
}
