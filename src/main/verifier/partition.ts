// Which verifier cache a page's `.eth` request may use: its top-level
// page's origin, the way Chromium partitions its own HTTP cache. A name one
// site opened is then cold for every other site, so no page can time a
// `.eth` request to learn where the person has been (A256).

/** A request as the shell sees it: its URL, its kind, and the URL of the top-level page it came from, if any. */
export interface PageRequest {
  readonly url: string
  readonly resourceType: string
  readonly topUrl: string | undefined
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
 * else to the page on top. Undefined when neither has an origin, so the
 * request gets a cache of its own.
 */
export function requestPartition (request: PageRequest): string | undefined {
  if (request.resourceType === 'mainFrame') return originOf(request.url)
  return request.topUrl === undefined ? undefined : originOf(request.topUrl)
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
