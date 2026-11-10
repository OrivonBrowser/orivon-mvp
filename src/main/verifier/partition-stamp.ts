// The two request handlers every session that can reach the verifier needs: which requests are the verifier's, and the
// stamp that tells it which partition (and which route) a request belongs to. Electron-bound (a session's web request
// owner), and holds no state of its own.

import { webContents } from 'electron'
import type { Session, WebFrameMain, WebRequestFilter } from 'electron'
import { PARTITION_HEADER, ROUTE_HEADER, SHELL_ANSWERED_HEADER } from '../../loader/fetch/content-root.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { refusesWorkerScript } from '../sessions/app-workers.js'
import { noteMainFrameResponse } from '../sessions/shell-answered.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { TunnelRoute } from '../../protocols/verifier-host/protocol.js'
import { failedFiles } from './failed-files-store.js'
import { noteCompletedFile } from './failed-files.js'
import { requestPartition, withPartition, withoutHttpCache, withRoute } from './partition.js'
import { isHandedToShell } from './shell-serves.js'

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
 * A request the verifier hands to the shell (`shell-serves.ts`'s `isHandedToShell`) is also kept out of the
 * HTTP cache, read and write: the session's cache may hold bytes from before the site was served that the shell's check never
 * saw (see README.md's Design notes).
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
    const stamped = withRoute(withPartition(current.requestHeaders, PARTITION_HEADER, partition), ROUTE_HEADER, tunnel)
    // The stamped headers: the host decides on what it receives, and the stamp is part of its rule.
    return { ...current, requestHeaders: isHandedToShell(details.url, stamped) ? withoutHttpCache(stamped) : stamped }
  })
}

/** Whether `headers` (as Electron gives them: a list for each name) carry the mark of an answer the shell gave, once and as `1`. */
function carriesShellMark (headers: Record<string, string[]> | undefined): boolean {
  if (headers === undefined) return false
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() === SHELL_ANSWERED_HEADER) return values.length === 1 && values[0] === '1'
  }
  return false
}

/**
 * Notes, for each page of the session, whether the shell answered the main-frame response of its document
 * (`../sessions/shell-answered.ts`): the verifier's server puts the mark on every answer it relays and on none it gives
 * itself, and a response read from the HTTP cache is none of the shell's.
 */
export function installShellAnswerWatch (target: Session): void {
  webRequestOwnerFor(target).onResponseStarted(verifiedHostFilter(), targetsVerifiedHost, (details) => {
    if (details.resourceType !== 'mainFrame' || details.webContents === undefined || details.webContents === null) return
    noteMainFrameResponse(details.webContents, details.url, !details.fromCache && carriesShellMark(details.responseHeaders))
  })
}

/**
 * Refuses a service worker script (or one it imports) of an origin the shell serves where websites run, unless the shell
 * answered it (`../sessions/app-workers.ts`). A worker registered in the moment the host has not yet learned the app is served
 * would otherwise be one the check never saw, and would answer the app's navigations with the grants of its document.
 */
export function installWorkerScriptGuard (target: Session): void {
  webRequestOwnerFor(target).onHeadersReceived(RUN_LAST, verifiedHostFilter(), targetsVerifiedHost, (details, current) => {
    const refused = refusesWorkerScript({ url: details.url, resourceType: details.resourceType, hasPage: details.webContents !== undefined && details.webContents !== null, answeredByShell: carriesShellMark(details.responseHeaders) })
    if (!refused) return current
    console.warn('[verifier] refused a service worker script the shell did not serve:', details.url)
    return { ...current, cancel: true }
  })
}

export function installFileFailureWatch (target: Session): void {
  webRequestOwnerFor(target).onCompleted(verifiedHostFilter(), targetsVerifiedHost, (details) => {
    noteCompletedFile(failedFiles, details, (id) => { const found = webContents.fromId(id); return found === undefined || found.isDestroyed() ? undefined : found })
  })
}
