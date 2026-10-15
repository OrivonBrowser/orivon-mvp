// The person's yes to loading a site through public gateways when the node cannot serve it, for ONE load. The yes is made by
// following the link on the error page the host served for that site (a token only that page was given, an HMAC of the site's
// origin), waits a short while for the load that follows the press to ask for it, and is used up by the first mount that does.
// Nothing is remembered: the next load of the site asks again, and an unused yes is gone after a minute. Memory only.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Where the error page's button leads. A path under this prefix is never a site's own file. */
export const CONSENT_PATH = '/.orivon/load-through-gateways'

/** How long a yes waits for the load that follows the press: the redirect, the name's resolution and the node's own wait for peers fit within it. */
export const CONSENT_LIFE_MS = 60_000

export class GatewayConsent {
  private readonly key = randomBytes(32)
  /** The sites (origins) with a yes not used yet, and when it was given. */
  private readonly given = new Map<string, number>()

  constructor (private readonly now: () => number = Date.now) {}

  /** The token the error page of `partition` carries; it proves the request that follows came from that page. */
  tokenFor (partition: string): string {
    return createHmac('sha256', this.key).update(partition).digest('base64url')
  }

  /** Records the yes when `token` is the one `tokenFor(partition)` gave. */
  grant (partition: string | undefined, token: string | null): boolean {
    if (partition === undefined || token === null) return false
    const expected = Buffer.from(this.tokenFor(partition))
    const given = Buffer.from(token)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false
    this.given.set(partition, this.now())
    return true
  }

  /** Uses up the yes for the site (origin) this mount is for, if it has one that is still fresh; true at most once per press. */
  take (partition: string | undefined): boolean {
    if (partition === undefined) return false
    const at = this.given.get(partition)
    if (at === undefined) return false
    this.given.delete(partition)
    return this.now() - at <= CONSENT_LIFE_MS
  }
}
