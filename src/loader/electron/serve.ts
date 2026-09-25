// The Electron half of ADR-0007's serving mechanism -- everything in
// serve.ts is plain TypeScript against a stub LoaderStorage; this file is
// the thin layer that actually calls `session.fromPartition(...).protocol
// .handle(scheme, handler)`, mirroring electron/fetch.ts/electron-resolve.ts's
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
//
// A158 (docs/open-questions.md, resolved 2026-09-14): `registerServingFor`
// hydrates `origin`'s persisted grants from its pinned, hash-verified
// manifest (`serve.ts`'s `verifiedManifestFor`, `GrantLedger
// .hydrateFromPinnedManifest`) BEFORE registering anything that could answer
// a real request -- so a restored app's FIRST served document, and its
// first real capability call, already see the grants a person actually
// consented to, not an empty ledger waiting on a page load that has not
// happened yet.

import type { Session } from 'electron'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { checkConnectSecure } from '../../broker/policy/connect-secure.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { createPinCoverageTracker } from '../serve/pin-coverage.js'
import type { PinCoverageSnapshot } from '../serve/pin-coverage.js'
import { createAppRequestHandler, fetchThirdParty, verifiedManifestFor } from '../serve/serve.js'
import { saveCheckRecord } from '../fetch/update-check.js'
import type { AppRequestHandler, AuthoriseReach } from '../serve/serve.js'
import { cspHeaderValue } from '../serve/csp.js'
import { nodeReachDial } from '../reach/reach.js'
import { createRedirectChains } from '../reach/redirects.js'
import { createReachSlotPool } from '../reach/slots.js'
import type { ReachSlotPool } from '../reach/slots.js'
import type { LoaderStorage } from '../cache/storage.js'
import { parsePinRecord } from '../../broker/policy/pin.js'
import type { PinRecord } from '../../broker/policy/pin.js'

/**
 * One pin-coverage tracker per origin currently being served, keyed the same
 * way `partitionFor` keys a session -- one canonical origin. Replaced, not
 * merged, on every `registerServingFor` call: a reinstall within this run
 * starts a fresh session's counts rather than carrying the old ones forward,
 * matching `registerAppOrigin`'s own idempotent re-registration (this file's
 * own doc, above). Never persisted -- gone on restart, along with every
 * other in-process count this codebase keeps for the trust indicator.
 */
const coverageTrackers = new Map<string, ReturnType<typeof createPinCoverageTracker>>()

/** `origin`'s pin-coverage counts for the current process run, or `undefined` when nothing has registered serving for it yet -- src/trust/'s consumer end of pin-coverage.ts's "agreed shape" (that module's own header). */
export function pinCoverageFor (origin: string): PinCoverageSnapshot | undefined {
  return coverageTrackers.get(origin)?.snapshot()
}

/**
 * A200 (docs/open-questions.md): one reach-slot pool per origin, for the
 * process's lifetime. Not reset when an origin is re-registered: requests
 * the previous handler started are still real open connections, and each
 * releases into the pool it reserved from.
 */
const reachSlotPools = new Map<string, ReachSlotPool>()

/**
 * The (reserve, release) pair `serve.ts`'s `fetchThirdParty` uses to cap
 * this origin's concurrent third-party reach requests at its
 * manifest-declared socket allowance -- `Broker.app.socketAllowanceSync`,
 * the SAME clamp `net.connect`/`net.connectSecure`/`net.listen` already
 * enforce for a live handle (`GrantLedger.socketAllowance`, never
 * reimplemented here -- code-guidelines.md Rule 3). Shared by the app's own
 * document and every web context it opens, so all of them draw on one count.
 */
function reachSlotsFor (broker: Broker, origin: string): ReachSlotPool {
  let pool = reachSlotPools.get(origin)
  if (pool === undefined) {
    pool = createReachSlotPool(() => broker.app.socketAllowanceSync(origin))
    reachSlotPools.set(origin, pool)
  }
  return pool
}

/**
 * Every file (path -> leaf) each origin's pins have served this process.
 * After an update, a page still running the previous bundle may lazily
 * `import()` one of its old hashed chunks; those files stay on disk until
 * the next start prunes them (`restorePinnedServing`), and stay servable
 * until then, checked against the leaf they were pinned with.
 */
const servedAssets = new Map<string, Map<string, string>>()

function rememberServed (origin: string, pin: PinRecord): void {
  const served = servedAssets.get(origin) ?? new Map<string, string>()
  for (const asset of pin.assets) served.set(asset.path, asset.leaf)
  servedAssets.set(origin, served)
}

/** The files earlier pins served that `pin` no longer declares. */
function retainedAssets (origin: string, pin: PinRecord): ReadonlyMap<string, string> {
  const retained = new Map(servedAssets.get(origin))
  for (const asset of pin.assets) retained.delete(asset.path)
  return retained
}

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
  servedPartitions.add(partitionFor(origin))
}

/** Partitions this process has actually installed a cache handler into.
 *
 * Keyed by partition, not origin, so the two sides cannot disagree about
 * canonical spelling: `partitionFor` is already the one function that decides
 * what "the same app" means, and tab-view.ts computes the identical string.
 *
 * There is no removal, because there is no unregistration -- `registerAppOrigin`
 * re-registers in place (see its own doc), and a handler lives for the process.
 */
const servedPartitions = new Set<string>()

/**
 * Is `origin` being served from the pinned cache right now -- synchronously,
 * with no side effect?
 *
 * Needed because a tab's partition is fixed when its `WebContentsView` is
 * constructed, so `isOriginServedFromCache` below (async) cannot answer in
 * time. Do NOT "simplify" this into asking Electron directly: that means
 * `session.fromPartition(...)`, which CREATES the session it asks about, and
 * `partitionFor` yields a `persist:` partition -- so probing it per navigation
 * would mint an on-disk app partition for every ordinary website visited,
 * which is the cost A109 removed.
 */
export function isOriginServedFromCacheSync (origin: string): boolean {
  return servedPartitions.has(partitionFor(origin))
}

/**
 * `origin`'s live grant for `capability`, straight off the broker -- shared
 * by `grantedConnectPatternsFor` (`tcp.connect`, bare sources in
 * `connect-src`) and `secureHeaderPatternsFor` (`https.connect`, the reach
 * sources serve/csp.ts puts in `connect-src`/`img-src`/`font-src`/
 * `media-src`) below, which differ only in which capability they ask for
 * (code-guidelines.md Rule 3: one implementation, not two that happen to
 * look alike). Falls back to `[]` on ANY failure (an unregistered origin, or
 * any other broker fault): the strictest answer is always safe to hand
 * back.
 *
 * READS THE LIVE LEDGER ONLY, WITH NO DISK FALLBACK OF ITS OWN -- and,
 * since A158's fix, needs none: `registerServingFor` (below) hydrates
 * `origin`'s persisted grants from its pinned, hash-verified manifest
 * BEFORE this function's caller can ever be reached by a real request, so
 * `broker.app.grants` is already the true, re-validated answer from the
 * first request onward. A disk-fallback of the shape this function used to
 * need (`persistedAppsSync`, widening a header while the live ledger stayed
 * empty) would now risk the OPPOSITE problem: disk holds the raw, unfiltered
 * persisted grant, while the live ledger holds it narrowed against the
 * pinned manifest (`GrantLedger.hydrateFromPinnedManifest`) -- reading disk
 * instead could show a WIDER pattern set than is actually live.
 */
async function liveGrantedPatternsFor (broker: Broker, origin: string, capability: CapabilityKind): Promise<readonly Pattern[]> {
  try {
    const grants = await broker.app.grants(origin)
    return grants.find((grant) => grant.capability === capability)?.patterns ?? []
  } catch {
    return []
  }
}

/** `connect-src`'s source -- `tcp.connect` is the ONLY thing standing
 * between an app's page and a live `WebSocket` connection (`docs/
 * open-questions.md` A42), so this must never be wider than what is truly
 * granted; see `liveGrantedPatternsFor`'s own doc for why reading the live
 * ledger is now always correct here, not merely safe. */
async function grantedConnectPatternsFor (broker: Broker, origin: string): Promise<readonly Pattern[]> {
  return await liveGrantedPatternsFor(broker, origin, 'tcp.connect')
}

/** The reach directives' source -- `https.connect`, a SEPARATE grant from
 * `tcp.connect` above. `fetchThirdParty`/`authoriseReachFor` (serve.ts)
 * independently live-check every `https:` request regardless of what this
 * header claims. */
async function secureHeaderPatternsFor (broker: Broker, origin: string): Promise<readonly Pattern[]> {
  return await liveGrantedPatternsFor(broker, origin, 'https.connect')
}

/** The CSP a served response carries, from `origin`'s live grants -- shared with src/main/install/granted-origin-csp.ts, so an origin granted without installing runs under the same policy an installed one does. */
export async function liveCspHeaderFor (broker: Broker, origin: string): Promise<string> {
  return cspHeaderValue(await grantedConnectPatternsFor(broker, origin), await secureHeaderPatternsFor(broker, origin))
}

/**
 * THE live authorisation gate for a third-party request (serve.ts's
 * `AuthoriseReach`). Reads `origin`'s `https.connect` grant fresh, straight
 * off the LIVE ledger (`broker.app.grants`, never disk), and decides with
 * `checkConnectSecure` -- the SAME function `net-capability.ts`'s own
 * `connectSecure` calls, so this can never authorise a request
 * `orivon.net.connectSecure` itself would refuse.
 *
 * Reads the same live ledger `liveGrantedPatternsFor` reads for the header
 * above -- the two can no longer disagree the way they once could (A158):
 * `registerServingFor` hydrates this origin's real grants before either one
 * can be asked. An origin whose pin never verified, or that genuinely holds
 * no grant, has an empty live ledger either way; `checkConnectSecure` denies
 * an empty pattern list the same way it denies "never granted", because
 * from here those two cases MUST be indistinguishable (A137).
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
 * ADR-0019's whole network path for an isolated context: builds a
 * REACH-ONLY request handler for `opener`'s own `https.connect` grant,
 * reusing `authoriseReachFor`/`reachSlotsFor` UNCHANGED (code-guidelines.md
 * Rule 3) -- so a context's fetch is checked and budgeted on the exact same
 * live grant and concurrent-reach allowance as any other third-party
 * request the opener's own document makes, never a copy of that logic.
 *
 * NO CSP, NO PIN LOOKUP, NO SAME-ORIGIN BRANCH -- unlike
 * `createAppRequestHandler`'s own handler, a context's document has no
 * pinned bundle of its own; every request it makes is, by construction,
 * "third-party" from the opener's point of view (ADR-0019: "every request
 * it makes is authorised against THIS app's own https.connect grant").
 * `src/main/web-context-host.ts` is the one caller -- it wraps this in the
 * CORS headers a context's own origin needs (this file's own job stops at
 * the reach decision, not the response shape a context's fetch() expects).
 */
export function reachOnlyHandlerFor (broker: Broker, opener: string): (request: Request) => Promise<Response> {
  const authoriseReach = authoriseReachFor(broker, opener)
  const reachDial = nodeReachDial()
  const { reserve, release } = reachSlotsFor(broker, opener)
  const options = { redirects: createRedirectChains() }
  return async (request: Request): Promise<Response> =>
    await fetchThirdParty(request, authoriseReach, reachDial, undefined, reserve, release, options)
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
 * with no grant-derived source in any directive and third-party reach
 * refused outright: the same safe "nothing granted" answer, not a degraded
 * mode of it.
 *
 * `nodeReachDial()` (A143, `reach/reach.ts`) is wired in unconditionally --
 * it needs no broker and performs no I/O until `fetchThirdParty` actually
 * calls it, which only happens once `authoriseReachFor` has already said
 * yes.
 *
 * A158's early-hydration seam RUNS FIRST, BEFORE `createAppRequestHandler`
 * and BEFORE `registerAppOrigin` -- order is load-bearing, not incidental:
 * nothing can answer a real request for `origin` until `registerAppOrigin`
 * (below) actually wires the handler onto the session, so hydrating before
 * that call guarantees every capability check this origin's first document
 * can ever trigger already sees its real, persisted grants, and that the
 * broker already counts the origin as registered (README.md, "A restored
 * app is a registered app from startup") when its first tab is built.
 * `verifiedManifestFor` performs its own independent whole-tree
 * re-verification (see its own doc for why that is an accepted, bounded
 * cost rather than a second source of truth) and answers `undefined` for
 * anything short of a fully verified pin -- skipped here, deliberately:
 * `createAppRequestHandler` below will re-derive the identical failure and
 * deny every request for this origin, so there is nothing to hydrate FROM.
 */
export async function registerServingFor (storage: LoaderStorage, origin: string, broker?: Broker): Promise<void> {
  const pinnedManifest = await verifiedManifestFor(storage, origin)
  // A damaged cache must not wait out the update-check interval, or answer a
  // 304 for a manifest it no longer holds intact: the next visit checks in full.
  if (pinnedManifest === undefined) await saveCheckRecord(storage, origin, undefined)
  if (pinnedManifest === undefined && !carriesLiveAuthority(origin, broker)) {
    // README.md, "When the cached bundle fails verification": serve nothing,
    // so the origin loads as an ordinary website and its hint reinstalls it.
    console.warn(`[loader] ${origin}'s cached bundle is missing or failed verification; not serving it, so its next visit can reinstall it`)
    return
  }
  if (broker !== undefined && pinnedManifest !== undefined) await broker.app.hydrateFromPinnedManifest(origin, pinnedManifest)
  const pin = pinnedManifest === undefined ? null : parsePinRecord(await storage.readPin(origin))

  const tracker = createPinCoverageTracker()
  coverageTrackers.set(origin, tracker)
  const reachSlots = broker === undefined ? undefined : reachSlotsFor(broker, origin)

  const handler = await createAppRequestHandler(
    storage,
    origin,
    broker === undefined ? undefined : async () => await grantedConnectPatternsFor(broker, origin),
    broker === undefined ? undefined : async () => await secureHeaderPatternsFor(broker, origin),
    broker === undefined ? undefined : authoriseReachFor(broker, origin),
    nodeReachDial(),
    tracker.record,
    reachSlots?.reserve,
    reachSlots?.release,
    pin === null ? undefined : retainedAssets(origin, pin)
  )
  const { session } = await import('electron')
  registerAppOrigin(session.fromPartition(partitionFor(origin)), origin, handler)
  if (pin !== null) rememberServed(origin, pin)
}

/**
 * Whether `origin`'s partition already carries authority this session -- it
 * is being served from cache, or holds a live grant. Such an origin whose
 * bundle then fails verification keeps a handler that denies everything:
 * its partition must never fall through to whatever the network serves.
 */
function carriesLiveAuthority (origin: string, broker: Broker | undefined): boolean {
  return isOriginServedFromCacheSync(origin) || broker?.app.hasGrantsSync(origin) === true
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

/**
 * At start, before any page can still need them: deletes the files earlier
 * pins left behind (install never prunes, see install.ts) and any staging a
 * crash left. A failure is logged; it costs disk, never correctness.
 */
async function pruneToPin (storage: LoaderStorage, origin: string): Promise<void> {
  try {
    const pin = parsePinRecord(await storage.readPin(origin))
    if (pin !== null) await storage.pruneAssets(origin, pin.assets.map((asset) => asset.path))
    await storage.clearStaging(origin)
  } catch (error) {
    console.error('[loader] could not prune superseded files at start', origin, error)
  }
}

/** One origin's outcome from `restorePinnedServing`, for the caller's own logging/tests. */
export interface RestoredOrigin {
  readonly origin: string
  readonly ok: boolean
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
 * A158 (docs/open-questions.md): RESOLVED for every directive, including
 * `connect-src` -- `registerServingFor`'s own early-hydration call means an
 * origin restored here with a real, persisted grant is genuinely LIVE
 * (`GrantLedger.hydrateFromPinnedManifest`) before this loop's very first
 * `await registerServingFor` returns, not merely reflected in a header a
 * live gate underneath might still refuse. There is no longer a window in
 * which a real grant is widened only in what a header claims -- so, unlike
 * this function's own history, there is nothing left here worth a
 * diagnostic: an origin either hydrates (a verified pin existed) or it does
 * not (no pin, or one that failed re-verification), and either way what is
 * served and what is actually granted now agree from the first request.
 */
export async function restorePinnedServing (storage: LoaderStorage, broker?: Broker): Promise<readonly RestoredOrigin[]> {
  const origins = await storage.listPinnedOrigins()
  const results: RestoredOrigin[] = []

  for (const origin of origins) {
    try {
      await registerServingFor(storage, origin, broker)
      await pruneToPin(storage, origin)
      results.push({ origin, ok: true })
    } catch (error) {
      console.error('[loader] failed to restore cache-serving for', origin, error)
      results.push({ origin, ok: false })
    }
  }

  return results
}
