// The Electron half of ADR-0007's serving mechanism -- everything in
// serve.ts is plain TypeScript against a stub LoaderStorage; this file is
// the thin layer that actually calls `session.fromPartition(...).protocol
// .handle(scheme, handler)`, mirroring electron-fetch.ts/electron-resolve.ts's
// own split (dynamic `import('electron')`, so this module stays importable
// outside a real Electron process).
//
// TWO CALLERS: subsystem.ts's afterReady calls restorePinnedServing() once,
// at startup, for every origin listPinnedOrigins() finds on disk -- this is
// what makes "offline first-run keeps working for pre-cached apps"
// (README.md) true across a restart, with no dependency on the consent-flow
// UI that does not exist yet (build step 4's other lanes). A future caller
// that just finished install() may call registerAppOrigin() directly for
// that one freshly-installed origin, immediately, in the same run.

import type { Session } from 'electron'
import { partitionFor } from '../broker/grants/origin-hash.js'
import type { Broker } from '../broker/broker-contracts.js'
import { checkConnectSecure } from '../broker/policy/connect-secure.js'
import type { Pattern } from '../contracts/index.js'
import { createAppRequestHandler } from './serve.js'
import type { AppRequestHandler, AuthoriseReach } from './serve.js'
import { nodeReachDial } from './serve-reach.js'
import type { LoaderStorage } from './storage.js'

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
export function registerAppOrigin (appSession: Session, origin: string, handler: AppRequestHandler): void {
  const scheme = new URL(origin).protocol.replace(':', '')
  if (appSession.protocol.isProtocolHandled(scheme)) {
    appSession.protocol.unhandle(scheme)
  }
  appSession.protocol.handle(scheme, handler)
}

/**
 * `origin`'s live `tcp.connect` grant, straight off the broker -- for the
 * `connect-src` header ONLY, never cached. Falls back to `[]` on ANY
 * failure (an unregistered origin, or any other broker fault): the
 * strictest answer is always safe to hand back.
 *
 * DELIBERATELY HAS NO A158 DISK FALLBACK, UNLIKE `secureHeaderPatternsFor`
 * BELOW -- a REAL DIFFERENCE, not an oversight. `connect-src` is the ONLY
 * thing standing between an app's page and a live `WebSocket` connection
 * (`docs/open-questions.md` A42: "`connect-src` bounds `fetch` AND
 * `WebSocket`") -- `ws:`/`wss:` is a scheme `registerAppOrigin` never
 * registers a handler for, so a `wss://` attempt never reaches
 * `fetchThirdParty` or any other live re-check at all; CSP is the whole
 * gate. Widening THIS header from a persisted grant this run has not yet
 * re-validated would therefore widen a REAL authorisation, exactly what
 * `A137` forbids -- the reasoning that makes `secureHeaderPatternsFor`'s own
 * fallback safe (a live handler underneath re-checks every actual request
 * regardless of what the header claimed) does not hold here, because for
 * `WebSocket` there is no such handler.
 */
async function grantedConnectPatternsFor (broker: Broker, origin: string): Promise<readonly Pattern[]> {
  try {
    const grants = await broker.app.grants(origin)
    return grants.find((grant) => grant.capability === 'tcp.connect')?.patterns ?? []
  } catch {
    return []
  }
}

/**
 * `origin`'s patterns for `https.connect`, for the `img-src`/`font-src`/
 * `media-src` header ONLY -- never wired into anything that authorises a
 * real request (see `AuthoriseReach`, below, for that).
 *
 * A158 (docs/open-questions.md), SAFE HERE SPECIFICALLY. Once the origin IS
 * hydrated (`isRegisteredSync`), the live ledger is used, exactly like
 * `grantedConnectPatternsFor` above. Before that -- the narrow window right
 * after a restart -- this falls back to `persistedAppsSync`'s real,
 * disk-persisted patterns, the SAME pair `hasUnhydratedPersistedSecureGrant`
 * (below) already reads for display. That fallback is safe ONLY because
 * every request these three directives can ever cause is an ordinary
 * http(s) subresource load, which ALWAYS reaches `fetchThirdParty` (same
 * scheme as the app's own origin, so always intercepted, unlike
 * `WebSocket` -- see `grantedConnectPatternsFor`'s own doc for the case
 * where this reasoning does NOT apply) -- so a header that is momentarily
 * too permissive here grants nothing by itself; it only decides whether the
 * browser ATTEMPTS a request the live-checked handler still, correctly,
 * refuses if the grant was not real. `A137`'s ruling is about AUTHORITY:
 * nothing here is ever treated as one, so trusting disk for this header is
 * a different question than trusting it for a decision.
 */
async function secureHeaderPatternsFor (broker: Broker, origin: string): Promise<readonly Pattern[]> {
  try {
    if (broker.app.isRegisteredSync(origin)) {
      const grants = await broker.app.grants(origin)
      return grants.find((grant) => grant.capability === 'https.connect')?.patterns ?? []
    }
    const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
    return persisted?.grants['https.connect']?.patterns ?? []
  } catch {
    return []
  }
}

/**
 * THE live authorisation gate for a third-party request (serve.ts's
 * `AuthoriseReach`). Reads `origin`'s `https.connect` grant fresh, straight
 * off the LIVE ledger (`broker.app.grants`, never disk), and decides with
 * `checkConnectSecure` -- the SAME function `net-capability.ts`'s own
 * `connectSecure` calls, so this can never authorise a request
 * `orivon.net.connectSecure` itself would refuse.
 *
 * DELIBERATELY DOES NOT SHARE `headerPatternsFor`'s disk fallback (A158).
 * An unhydrated origin genuinely has no live grant yet; `checkConnectSecure`
 * denies an empty pattern list the same way it denies "never granted",
 * because from here those two cases MUST be indistinguishable -- that is
 * what makes the header above safe to widen without this ever being
 * (A137).
 */
function authoriseReachFor (broker: Broker, origin: string): AuthoriseReach {
  return async (host, port) => {
    try {
      const grants = await broker.app.grants(origin)
      const patterns = grants.find((grant) => grant.capability === 'https.connect')?.patterns ?? []
      return checkConnectSecure(patterns, host, port)
    } catch {
      return { allowed: false, code: 'denied', reason: 'not-declared' }
    }
  }
}

/**
 * Builds `origin`'s request handler (re-verifying its whole pinned tree --
 * serve.ts's own cost choice) and registers it on that origin's own
 * partition. The one thing both call sites below need done identically:
 * `restorePinnedServing`, once per origin at startup, and `subsystem.ts`'s
 * `onInstalled` hook, once, immediately after a fresh install completes
 * within the current process run.
 *
 * `broker`, when given, is threaded straight into the handler as a
 * per-request CSP source (`grantedConnectPatternsFor`/`secureHeaderPatternsFor`
 * above) and as the live gate for a third-party request (`authoriseReachFor`,
 * A143) -- `undefined` (no broker subsystem this run) still serves the app,
 * with `connect-src`/`img-src`/`font-src`/`media-src` all `'self'` only and
 * third-party reach refused outright, which is the same safe "nothing
 * granted" answer as before this lane, not a degraded mode of it.
 *
 * `nodeReachDial()` (A143, `serve-reach.ts`) is wired in unconditionally --
 * it needs no broker and performs no I/O until `fetchThirdParty` actually
 * calls it, which only happens once `authoriseReachFor` has already said
 * yes.
 */
export async function registerServingFor (storage: LoaderStorage, origin: string, broker?: Broker): Promise<void> {
  const handler = await createAppRequestHandler(
    storage,
    origin,
    broker === undefined ? undefined : async () => await grantedConnectPatternsFor(broker, origin),
    broker === undefined ? undefined : async () => await secureHeaderPatternsFor(broker, origin),
    broker === undefined ? undefined : authoriseReachFor(broker, origin),
    nodeReachDial()
  )
  const { session } = await import('electron')
  registerAppOrigin(session.fromPartition(partitionFor(origin)), origin, handler)
}

/**
 * The address bar's own S4-6 provenance signal (ADR-0007: "the padlock is
 * now misleading unless the UI corrects it"). Asks Electron's OWN
 * protocol-handler registry, never the broker's `isRegisteredSync` --
 * `registerApp` (a manifest in the grant ledger) and `registerServingFor`
 * (this file, actually intercepting the scheme) are two separate calls, and
 * only this one reflects whether a request to `origin` right now would
 * truly be answered from the pinned cache rather than reaching the real
 * network. A malformed `origin` answers `false`, the same fail-closed
 * default `deliveryProvenanceFor` (src/main/) already applies one layer up.
 */
export async function isOriginServedFromCache (origin: string): Promise<boolean> {
  let scheme: string
  try {
    scheme = new URL(origin).protocol.replace(':', '')
  } catch {
    return false
  }
  const { session } = await import('electron')
  return session.fromPartition(partitionFor(origin)).protocol.isProtocolHandled(scheme)
}

/** One origin's outcome from `restorePinnedServing`, for the caller's own logging/tests. */
export interface RestoredOrigin {
  readonly origin: string
  readonly ok: boolean
}

/**
 * A158 (docs/open-questions.md): true when `origin` holds a real, persisted
 * `https.connect` grant from a prior session that THIS run's ledger has not
 * yet re-validated. `registerApp` only hydrates it once this origin's page
 * has loaded and reported its manifest hint -- so this is true for the
 * narrow window right after a restart, before that happens.
 *
 * `https.connect` SPECIFICALLY, NOT "ANY CAPABILITY" -- narrower than this
 * function's own pre-A143 version on purpose. `secureHeaderPatternsFor`
 * above widens `img-src`/`font-src`/`media-src` from this SAME persisted
 * state once hydration is missing, safely, because that header is advisory
 * and `fetchThirdParty`/`authoriseReachFor` (serve.ts) still live-check the
 * real ledger on every actual request. `grantedConnectPatternsFor`
 * (`connect-src`, `tcp.connect`) has NO such fallback -- see its own doc for
 * why (`WebSocket` has no live re-check to fall back on) -- so a persisted
 * `tcp.connect`-only grant with no `https.connect` alongside it changes
 * nothing this lane touches, and must not trigger this log.
 *
 * READS ONLY ALREADY-SANCTIONED DISPLAY DATA. `isRegisteredSync` and
 * `persistedAppsSync` are the exact pair `src/main/permissions.ts`'s
 * settings list already reads off disk for display without treating it as
 * live authority (A137) -- this function does the same, purely to decide
 * whether to log, and never feeds the answer back into what is served.
 */
function hasUnhydratedPersistedSecureGrant (broker: Broker, origin: string): boolean {
  if (broker.app.isRegisteredSync(origin)) return false
  const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
  return persisted?.grants['https.connect'] !== undefined
}

/**
 * For every origin `storage` holds a pin for, registers its serving (via
 * `registerServingFor` above). Called once, at startup, so a previously-
 * installed app is served from cache again without waiting for anything to
 * call `Loader.load()` first.
 *
 * One origin's failure (a corrupted pin, an unreadable asset) is logged and
 * does not stop the rest -- the same "one bad entry does not take down
 * everything else" stance `runAfterReady` (main/registry.ts) already takes
 * for subsystems, applied here per app instead of per subsystem.
 *
 * A158 (RESOLVED for the served `img-src`/`font-src`/`media-src`, STILL
 * OPEN for `connect-src`, see both functions' own docs above): an origin
 * restored here with a real, not-yet-hydrated `https.connect` grant now
 * gets those three directives widened from that same persisted state
 * (`secureHeaderPatternsFor`) rather than falsely `'self'`-only -- but
 * `authoriseReachFor` still, correctly, refuses an actual third-party
 * request until this origin's manifest hint lands and `registerApp`
 * hydrates the real ledger. Logged rather than left silent, so that
 * narrow, real window is diagnosable rather than reading as an unexplained
 * handful of early 404s.
 */
export async function restorePinnedServing (storage: LoaderStorage, broker?: Broker): Promise<readonly RestoredOrigin[]> {
  const origins = await storage.listPinnedOrigins()
  const results: RestoredOrigin[] = []

  for (const origin of origins) {
    try {
      await registerServingFor(storage, origin, broker)
      if (broker !== undefined && hasUnhydratedPersistedSecureGrant(broker, origin)) {
        console.warn(
          '[loader]', origin, 'was restored with a real, persisted https.connect grant this run has not yet re-validated --',
          'its img-src/font-src/media-src were widened from that persisted state, but an actual third-party request may still be refused',
          'until this app reports its manifest hint (A158, docs/open-questions.md)'
        )
      }
      results.push({ origin, ok: true })
    } catch (error) {
      console.error('[loader] failed to restore cache-serving for', origin, error)
      results.push({ origin, ok: false })
    }
  }

  return results
}
