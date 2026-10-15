// The two halves of the error page's button "Load through public gateways" that decide something: whether a failure
// offers it (and with which link), and what following the link does. The server writes the responses; the yes itself
// is `../gateway-consent.ts`'s.

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { GatewaysOffered, ResolutionError } from '../../resolution/records.js'
import { CONSENT_PATH } from '../gateway-consent.js'
import type { GatewayConsent } from '../gateway-consent.js'
import type { GatewayOffer } from './error-pages.js'

/** The only paths of a served name that are the host's own, not the site's. */
const OWN_PREFIX = '/.orivon/'

/** A path on the same name, as the link carries it back: never another host, never the host's own paths. */
export function returnPathOf (target: string | null): string {
  // A backslash reads as a slash in a Location, so `/\evil` would name another host.
  if (target === null || !/^\/[^\\\x00-\x1f]*$/.test(target) || target.startsWith('//') || target.startsWith(OWN_PREFIX)) return '/'
  return target
}

/** A page load the person started in a tab (its document), not a frame's or a file's. */
export function isDocumentLoad (req: IncomingMessage): boolean {
  return req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document'
}

/**
 * The person followed the error page's button: the site this request is for is loaded through public gateways, this once, and the
 * page is sent back to where it was. Only the token the error page was given says yes, and only a navigation the person started (a click or
 * a key on the link: the browser marks it `Sec-Fetch-User`) can follow it, so a script on any page cannot follow it for them.
 */
export function answerConsent (consent: GatewayConsent, headers: IncomingHttpHeaders, url: URL, partition: string | undefined, res: ServerResponse, csp: string): void {
  if (headers['sec-fetch-mode'] !== 'navigate' || headers['sec-fetch-user'] !== '?1' || !consent.grant(partition, url.searchParams.get('token'))) {
    res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('this is not the page that asks')
    return
  }
  res.writeHead(303, { location: returnPathOf(url.searchParams.get('to')), 'cache-control': 'no-store', 'content-security-policy': csp }).end()
}

/**
 * The error page's offer of gateways, for a failure that "could not get it" (the node could not serve the mount, or the site it served could not
 * be read), and only for a page the person is looking at: a script's fetch or a frame of the same origin could read the token.
 */
export function gatewayOffer (consent: GatewayConsent, headers: IncomingHttpHeaders, url: URL, partition: string | undefined, error: unknown, servedByNode: boolean, tunnelled: boolean): GatewayOffer | undefined {
  const couldNotGet = error instanceof GatewaysOffered || (servedByNode && error instanceof ResolutionError && error.failure === 'unavailable')
  if (!couldNotGet || partition === undefined || headers['sec-fetch-dest'] !== 'document') return undefined
  return { href: `${CONSENT_PATH}?token=${consent.tokenFor(partition)}&to=${encodeURIComponent(`${url.pathname}${url.search}`)}`, tunnelled }
}
