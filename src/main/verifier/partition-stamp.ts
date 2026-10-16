// The two request handlers every session that can reach the verifier needs: which requests are the verifier's, and the
// stamp that tells it which partition (and which route) a request belongs to. Electron-bound (a session's web request
// owner), and holds no state of its own.

import { webContents } from 'electron'
import type { Session, WebFrameMain, WebRequestFilter } from 'electron'
import { PARTITION_HEADER, ROUTE_HEADER } from '../../loader/fetch/content-root.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { TunnelRoute } from '../../protocols/verifier-host/protocol.js'
import { failedFiles } from './failed-files-store.js'
import { noteCompletedFile } from './failed-files.js'
import { requestPartition, withPartition, withRoute } from './partition.js'

/** Only a request whose host a protocol actually routes to the verifier --
 * `verifiedHostFilter` below builds Electron's own coarse `{ urls }` filter
 * from the same `routedSuffixes()`, so this is the precise check the owner
 * runs on whatever that filter already let through. */
export function targetsVerifiedHost (url: string): boolean {
  if (!url.startsWith('https://')) return false
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return BUILTIN_ADDRESSES.routesToVerifier(hostname)
}

/** Electron's own `{ urls }` filter for `installPartitionStamp` below --
 * `*.` matches a suffix's own bare host as well as any subdomain (Chromium's
 * match-pattern syntax), covering exactly what `routesToVerifier` (and so
 * `targetsVerifiedHost` above) accepts. */
export function verifiedHostFilter (): WebRequestFilter {
  return { urls: BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `https://*.${suffix}/*`) }
}

/**
 * Stamps every page's request to the verifier with the partition its top-level page
 * owns, and strips whatever a request set itself: a worker's request has no
 * frame, and could otherwise name any partition. Installed on the default
 * session and on each website's session of its own (see README.md's Design notes for why no other), LAST among
 * `onBeforeSendHeaders` handlers there, so nothing that runs before it --
 * including a future extension rule -- can set or remove this header.
 * The same handler marks every request of a tunnel profile's session with that tunnel, whatever frame it
 * came from or whether it has one, and strips the mark from every other session's: the verifier fetches for it only
 * through that tunnel.
 */
export function installPartitionStamp (target: Session, tunnel: TunnelRoute | undefined): void {
  webRequestOwnerFor(target).onBeforeSendHeaders(RUN_LAST, verifiedHostFilter(), targetsVerifiedHost, (details, current) => {
    let frame: WebFrameMain | null | undefined
    try {
      frame = details.frame
    } catch {
      frame = undefined
    }
    const partition = requestPartition({ url: details.url, resourceType: details.resourceType, topUrl: frame?.top?.url })
    return { ...current, requestHeaders: withRoute(withPartition(current.requestHeaders, PARTITION_HEADER, partition), ROUTE_HEADER, tunnel) }
  })
}

export function installFileFailureWatch (target: Session): void {
  webRequestOwnerFor(target).onCompleted(verifiedHostFilter(), targetsVerifiedHost, (details) => {
    noteCompletedFile(failedFiles, details, (id) => { const found = webContents.fromId(id); return found === undefined || found.isDestroyed() ? undefined : found })
  })
}
