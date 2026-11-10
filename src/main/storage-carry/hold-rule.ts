// Which request the carry holds: the main-frame page of a served origin, other than the shell's own empty document.
// The web-request owner offers a handler every kind of request for a URL it matches (README.md's Design notes), so the kind is
// decided here, where a unit test reaches it.

import { originFromUrl } from '../../broker/policy/origin.js'
import { isCarryPageUrl } from '../../loader/electron/carry-page.js'

export function holdsRequest (request: { readonly url: string, readonly resourceType: string }, servesOrigin: (origin: string) => boolean): boolean {
  if (request.resourceType !== 'mainFrame' || isCarryPageUrl(request.url)) return false
  const origin = originFromUrl(request.url)
  return origin !== null && servesOrigin(origin)
}
