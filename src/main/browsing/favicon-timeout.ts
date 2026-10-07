// How long a tab's icon may take to fetch. Pure: no Electron import, so favicon-fetch.ts stays importable under plain vitest.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

export const FAVICON_TIMEOUT_MS = 5_000
/** The budget for an icon on a host the verifier serves (`<cid>.ipfs.orivon`, `.eth`): its bytes arrive block by
 * block from gateways, each block allowed 30 s (`protocols/ipfs/limits.ts`), so a few seconds is a slow gateway, not a
 * dead host. Two block timeouts: the icon sits in a nested directory, and a failed capture leaves the globe until the
 * page announces another icon set. Provisional: not measured against real gateways. */
export const VERIFIED_FAVICON_TIMEOUT_MS = 60_000
/** How long a fetch of `url` may run in all, redirects included. A verifier-served host resolves to loopback, so
 * isSafeFaviconUrl lets one through only as the declaring page's own origin, the same path the page loads from; a page
 * cannot nominate one for the long budget from elsewhere. A redirect to another host keeps the long budget, which only
 * bounds how long that one request is held open. */
export function faviconTimeoutMs (url: string): number {
  try {
    return BUILTIN_ADDRESSES.routesToVerifier(new URL(url).hostname) ? VERIFIED_FAVICON_TIMEOUT_MS : FAVICON_TIMEOUT_MS
  } catch {
    return FAVICON_TIMEOUT_MS
  }
}
