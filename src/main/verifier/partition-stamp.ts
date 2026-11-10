// The two request handlers every session that can reach the verifier needs: which requests are the verifier's, and the
// stamp that tells it which partition (and which route) a request belongs to. Electron-bound (a session's web request
// owner), and holds no state of its own.

import { webContents } from 'electron'
import type { Session, WebFrameMain, WebRequestFilter } from 'electron'
import { PARTITION_HEADER, ROUTE_HEADER, SHELL_ANSWERED_HEADER } from '../../loader/fetch/content-root.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { holdsWorkerScript, refusesWorkerScript } from '../sessions/app-workers.js'
import { noteMainFrameResponse } from '../sessions/shell-answered.js'
import { RUN_LAST, webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { settledOrigin } from '../sessions/worker-settle.js'
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
  // The mark is read where the network's headers arrive, before any extension's rule or listener can change them: an extension
  // may rewrite a response, but what the host said stays what decides whether the shell answered it.
  const given = new Map<number, boolean>()
  webRequestOwnerFor(target).onHeadersReceived(0, verifiedHostFilter(), targetsVerifiedHost, (details, current) => {
    if (details.resourceType === 'mainFrame' && details.webContents !== undefined && details.webContents !== null) {
      given.set(details.id, carriesShellMark(details.responseHeaders))
      // A request that never reaches a response started leaves its entry; the oldest go first.
      if (given.size > MAIN_FRAME_MARKS_KEPT) given.delete(given.keys().next().value as number)
    }
    return current
  })
  webRequestOwnerFor(target).onResponseStarted(verifiedHostFilter(), targetsVerifiedHost, (details) => {
    if (details.resourceType !== 'mainFrame' || details.webContents === undefined || details.webContents === null) return
    const marked = given.get(details.id) === true
    given.delete(details.id)
    noteMainFrameResponse(details.webContents, details.url, !details.fromCache && marked)
  })
}

/** How long a shell-served worker script waits for its origin to settle before it is cancelled: a registration that waits longer is one the next load makes again. */
const SCRIPT_HOLD_MS = 20_000

/** How many main-frame responses' marks are held between the headers arriving and the response starting. */
const MAIN_FRAME_MARKS_KEPT = 256

/**
 * Refuses a service worker script (or one it imports) of an origin the shell serves where websites run, unless the shell
 * answered it (`../sessions/app-workers.ts`). A worker registered in the moment the host has not yet learned the app is served
 * would otherwise be one the check never saw, and would answer the app's navigations with the grants of its document. A script
 * the shell did answer waits until the origin has settled (`../sessions/worker-settle.ts`), so the registration it starts
 * comes after the removal of what a website left; one that settles never is cancelled.
 */
export function installWorkerScriptGuard (target: Session, holdMs: number = SCRIPT_HOLD_MS): void {
  webRequestOwnerFor(target).onHeadersReceived(RUN_LAST, verifiedHostFilter(), targetsVerifiedHost, async (details, current) => {
    const response = { url: details.url, resourceType: details.resourceType, hasPage: details.webContents !== undefined && details.webContents !== null, answeredByShell: carriesShellMark(details.responseHeaders), ...(details.initiatorOrigin === undefined ? {} : { initiatorOrigin: details.initiatorOrigin }) }
    if (refusesWorkerScript(response)) {
      console.warn('[verifier] refused a service worker script the shell did not serve:', details.url)
      return { ...current, cancel: true }
    }
    if (holdsWorkerScript(response) && !(await settledOrigin(new URL(details.url).origin, holdMs))) {
      console.warn('[verifier] refused a service worker script of an origin that had not settled:', details.url)
      return { ...current, cancel: true }
    }
    return current
  })
}

export function installFileFailureWatch (target: Session): void {
  webRequestOwnerFor(target).onCompleted(verifiedHostFilter(), targetsVerifiedHost, (details) => {
    noteCompletedFile(failedFiles, details, (id) => { const found = webContents.fromId(id); return found === undefined || found.isDestroyed() ? undefined : found })
  })
}
