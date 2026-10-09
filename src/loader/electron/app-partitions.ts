// Which origins have a handler of their own on their own partition (ADR-0007, ADR-0018), and which of those
// answer from the pin: the registry a tab's partition and every "is this an app" question read, and the one call
// that installs or removes a handler. Split from serve.ts, which builds the handlers.

import type { Session } from 'electron'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import type { AppRequestHandler } from '../serve/serve.js'

/**
 * Registers `handler` as `origin`'s own scheme's handler on `appSession`.
 *
 * IDEMPOTENT ACROSS CALLS, DELIBERATELY. Electron's `protocol.handle` throws
 * "The scheme has been registered" on a second call for a scheme already
 * handled on that session (`protocol_registry.cc`'s `RegisterProtocol` uses
 * `try_emplace`, which only inserts once) -- confirmed against Electron's
 * own source rather than assumed. `partitionFor` keys a session to exactly
 * one canonical origin (origin-hash.ts), so a second registration on the
 * SAME session can only mean this same origin was reinstalled within one
 * process run; `unhandle` first, then `handle` again, so the session always
 * answers with whatever `handler` the caller just built from the freshly
 * re-verified pin, never a stale one left over from before the update.
 */
export function registerAppOrigin (appSession: Session, origin: string, handler: AppRequestHandler, from: 'pin' | 'verifier' = 'pin'): void {
  if (!appSessions.has(appSession)) {
    appSessions.add(appSession)
    for (const listener of [...appSessionListeners]) listener(appSession)
  }
  const scheme = new URL(origin).protocol.replace(':', '')
  if (appSession.protocol.isProtocolHandled(scheme)) {
    appSession.protocol.unhandle(scheme)
  }
  appSession.protocol.handle(scheme, handler)
  servedPartitions.add(partitionFor(origin))
  if (from === 'pin') pinnedPartitions.add(partitionFor(origin))
  else pinnedPartitions.delete(partitionFor(origin))
}

/**
 * Takes an origin's handler off its partition and out of both registries: the origin is no app of this process any
 * more, and its next tab is built on the shared session. Never for an origin served from its pin.
 */
export function unregisterAppOrigin (appSession: Session, origin: string): void {
  const scheme = new URL(origin).protocol.replace(':', '')
  if (appSession.protocol.isProtocolHandled(scheme)) appSession.protocol.unhandle(scheme)
  servedPartitions.delete(partitionFor(origin))
  pinnedPartitions.delete(partitionFor(origin))
}

/** The sessions `registerAppOrigin` has served an origin from, and who wants to hear of each. */
const appSessions = new Set<Session>()
const appSessionListeners = new Set<(appSession: Session) => void>()

/**
 * Calls `listener` with every session an app is served from: the ones already so, and each new one
 * as its first origin registers. A cache-served app's page runs in such a session, so whatever must
 * guard an app's requests there installs through this rather than waiting for a tab to open.
 */
export function forEachAppSession (listener: (appSession: Session) => void): void {
  appSessionListeners.add(listener)
  for (const appSession of [...appSessions]) listener(appSession)
}

/** The partitions whose handler answers from the origin's pin, a subset of `servedPartitions`: the rest answer from the verifier until the pin lands. */
const pinnedPartitions = new Set<string>()

/** Partitions this process has actually installed an app handler into, from the pin or from the verifier.
 *
 * Keyed by partition, not origin, so the two sides cannot disagree about
 * canonical spelling: `partitionFor` is already the one function that decides
 * what "the same app" means, and tab-view.ts computes the identical string.
 *
 * An entry leaves only through `unregisterAppOrigin`, for an app that was served from
 * the verifier and then blocked; `registerAppOrigin` otherwise re-registers in place
 * (see its own doc), and a handler lives for the process.
 */
const servedPartitions = new Set<string>()

/**
 * Does `origin`'s own partition answer for it right now -- from its pin, or from the verifier while the pin is
 * still coming (`isOriginPinnedSync` says which) -- synchronously, with no side effect? The name is the older
 * of the two meanings: this is the test for "this origin runs in a partition of its own".
 *
 * Needed because a tab's partition is fixed when its `WebContentsView` is
 * constructed, and because the toolbar's own delivery/level query
 * (`../../main/permissions/site-info-controller.js`) must not itself probe
 * `session.fromPartition(...)` per navigation: that call CREATES the session
 * it asks about, and `partitionFor` yields a `persist:` partition -- so
 * probing it for every ordinary website visited would mint an on-disk app
 * partition for each one, which is the cost A109 removed.
 */
export function isOriginServedFromCacheSync (origin: string): boolean {
  return servedPartitions.has(partitionFor(origin))
}

/** Whether `origin`'s partition answers from its pin, as opposed to the verifier (`isOriginServedFromCacheSync` is true for both). */
export function isOriginPinnedSync (origin: string): boolean {
  return pinnedPartitions.has(partitionFor(origin))
}
