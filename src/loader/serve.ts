// Serving a pinned bundle back out -- ADR-0007's other half. install()
// (index.ts) writes bytes that, before this file, nothing ever read again;
// this is the read path, built to become the `handler` argument of
// `session.fromPartition(...).protocol.handle(scheme, handler)`
// (electron-serve.ts wires the Electron half; this file has no `electron`
// import and is unit-testable against a stub LoaderStorage, matching every
// other file in this directory -- see README.md).
//
// SELF-SUFFICIENT FROM `storage` + `origin` ALONE -- no `Manifest` argument.
// The manifest is already a pinned leaf (bundle-hash.ts: "the manifest is a
// leaf like any other asset", hashed at MANIFEST_PATH), so re-reading and
// re-parsing it here is not an extra fetch or a second source of truth, and
// it means ONE function serves both "an app was just installed this run"
// and "restore serving for an app installed in a PRIOR run" identically --
// electron-serve.ts's restorePinnedServing calls this with nothing but an
// origin string from disk.
//
// THREE FAIL-CLOSED RULES, EACH WITH ITS OWN TEST BELOW: (1) no valid,
// re-verified pin -> deny everything; (2) a request whose own origin is not
// THIS app's origin -> deny, never proxied to the real network (see the
// deny branch's own comment for why); (3) a same-origin path not in the
// pinned set -> deny. See README.md's Design notes for the re-verification
// cost tradeoff this file spends, and for `verifiedManifestFor` below, the
// one exception to "no Manifest argument" above (an OUTPUT, not an input).

import { parsePinRecord } from '../broker/policy/pin.js'
import type { PinRecord } from '../broker/policy/pin.js'
import { MANIFEST_PATH } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { appCspHeaderValue, appReachCspHeaderValue } from '../broker/policy/connect-src.js'
import { checkConnectSecure } from '../broker/policy/connect-secure.js'
import type { ConnectSecureDecision } from '../broker/policy/connect-secure.js'
import type { Manifest, Pattern } from '../contracts/index.js'
import { entryCanonicalPath } from './fetch-bundle.js'
import { parseManifest } from './manifest.js'
import type { PinCoverageOutcome } from './pin-coverage.js'
import { contentTypeFor } from './serve-content-type.js'
import { guardReachResponse } from './serve-reach-guard.js'
import type { ReleaseReachSlot, ReserveReachSlot } from './serve-reach-guard.js'
import { parseRange } from './serve-range.js'
import { verifyPinnedTree } from './serve-verify.js'
import { isNavigationRequest, resolveRequestPath } from './serve-path.js'
import type { LoaderStorage } from './storage.js'

export type AppRequestHandler = (request: Request) => Promise<Response>

/**
 * Supplies this handler's origin's LIVE granted `tcp.connect` patterns,
 * called once per request rather than once at handler-build time -- a
 * revoke or a fresh grant (broker/grant-ledger.ts) is then reflected on the
 * very next request through this SAME registered handler, with no
 * re-registration needed. `undefined` (every existing test, dev-serve.ts,
 * and any future caller with no broker to ask) answers the safe default: a
 * CSP naming only `'self'`, never a wider guess. See README.md's Design
 * notes for the one thing even a live per-request read cannot fix: a
 * document already loaded keeps the CSP its own navigation response
 * carried, until the next load.
 */
export type GrantedConnectPatterns = () => Promise<readonly Pattern[]>

/**
 * Same shape and the same "read fresh, per request" contract as
 * `GrantedConnectPatterns`, but for the `https.connect` grant -- the
 * capability `fetchThirdParty` (below) actually authorises a third-party
 * request against, never `tcp.connect`.
 *
 * HEADER USE ONLY. This is wired into `img-src`/`font-src`/`media-src`
 * (`appReachCspHeaderValue`) so the browser knows a request is even worth
 * attempting; it is NEVER what decides whether one is actually served --
 * see `AuthoriseReach` for that, and A158 (docs/open-questions.md) for why
 * the two are allowed to disagree, briefly, after a restart.
 */
export type GrantedSecurePatterns = () => Promise<readonly Pattern[]>

/**
 * THE live authorisation gate for a third-party request -- the only thing
 * `fetchThirdParty` ever asks before proxying one to the real network.
 * Deliberately a DIFFERENT type than `GrantedSecurePatterns`: a caller
 * cannot pass the (possibly advisory-widened, header-only) pattern list in
 * by mistake, because this function returns a decision, not patterns. A
 * real implementation (electron-serve.ts) reads the origin's LIVE, hydrated
 * `https.connect` grant and calls `checkConnectSecure` against it -- the
 * SAME function `orivon.net.connectSecure` itself calls (net-capability.ts)
 * -- never anything read off disk (A137).
 */
export type AuthoriseReach = (host: string, port: number) => Promise<ConnectSecureDecision>

/**
 * Performs the actual network fetch to a host `AuthoriseReach` has already
 * authorised, and turns whatever comes back into a `Response`. Injected
 * rather than called directly so this file (see its own header) stays free
 * of any real network I/O and unit-testable with a stub -- the real
 * implementation (`serve-reach.ts`'s `nodeReachDial`) is wired in by
 * electron-serve.ts.
 */
export type ReachDial = (request: Request, host: string, port: number) => Promise<Response>

/**
 * Reports one request's pin-coverage outcome (pin-coverage.ts), called once
 * per request alongside the response it produced -- same "supply a callback,
 * every existing caller passes `undefined`" shape as the patterns above.
 * `bytes` is read from what the response already carries (`Uint8Array.length`
 * for a pinned asset, the peer's own `content-length` header for a
 * third-party one), never measured by buffering -- see pin-coverage.ts.
 */
export type RecordPinCoverage = (outcome: PinCoverageOutcome, bytes?: number) => void

export { isNavigationRequest, resolveRequestPath } from './serve-path.js'
export type { ResolvedRequest } from './serve-path.js'

function denyResponse (reason: string): Response {
  return new Response(`Orivon: ${reason}`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** `response`'s own `content-length`, when the peer sent one and it parses as a real size -- `undefined` otherwise (a chunked or compressed response carries none), never a guessed value. */
function contentLengthOf (response: Response): number | undefined {
  const header = response.headers.get('content-length')
  if (header === null) return undefined
  const length = Number(header)
  return Number.isFinite(length) && length >= 0 ? length : undefined
}

/**
 * S4-6's CSP, for a pinned, hash-verified bundle: `connect-src` from the
 * live grant (`appCspHeaderValue`, T22), `default-src 'self'` for every
 * other fetch directive A42 found unset (`img-src`, `frame-src`,
 * `form-action`, `worker-src`, ...), and `script-src`/`style-src` widened
 * back to `'self' 'unsafe-inline'` rather than left at the `default-src`
 * fallback.
 *
 * THE INLINE-SCRIPT CALL IS DELIBERATE, NOT AN OVERSIGHT: this origin only
 * ever serves pinned, hash-verified files (ADR-0007's fail-closed rule,
 * enforced above this function, on every request) -- an inline `<script>`
 * sitting inside a pinned `.html` file is exactly as verified as a pinned
 * `.js` file `'self'` already allows, and there is no hash/nonce allowlist
 * built yet to admit one without the other. Blocking it would not raise
 * the bar this origin is held to; it would only break an app that legitimately
 * ships inline script, for a rule this origin's own serving guarantee
 * already makes redundant. `default-src 'self'` still blocks the thing CSP
 * actually exists to stop here: a SUBRESOURCE the pinned bundle never
 * declared, from a host CSP's own grammar cannot enumerate around
 * `connect-src`'s allowlist (img/frame/form-action, A42's gap, now mostly
 * closed) -- it does not stand between a page and its own already-verified
 * markup.
 *
 * NOT CLOSED BY THIS: `<a href>`/`location.href` navigation (CSP's
 * `default-src` never covers it) and CSP naming a hostname where
 * `checkConnect` authorises a resolved address (DNS rebinding) --
 * both already filed as A42, unaffected by this change.
 *
 * `img-src`/`font-src`/`media-src` (A143) name what `fetchThirdParty`
 * will actually serve, sourced from `https.connect`, never `tcp.connect` --
 * a different grant than `connect-src`'s own. `securePatterns` MAY be wider
 * than the origin's live, hydrated grant (electron-serve.ts's own A158
 * fallback, for the narrow window right after a restart) without that being
 * a security bug: this header only decides whether the BROWSER attempts a
 * request at all, never whether one succeeds -- `fetchThirdParty` re-checks
 * the LIVE grant on every single request regardless of what this header
 * claimed, so a too-permissive header here still gets a real, unwidened
 * refusal from the handler underneath it (see `AuthoriseReach`'s own doc).
 */
function cspHeaderValue (connectPatterns: readonly Pattern[], securePatterns: readonly Pattern[]): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    appCspHeaderValue(connectPatterns),
    appReachCspHeaderValue(securePatterns)
  ].join('; ')
}

/**
 * Turns `content` into the actual `Response`, honouring a `Range` request.
 *
 * CSP LIVES HERE, NOT IN `onHeadersReceived` -- A110 (docs/open-questions.md)
 * confirmed that listener never fires for a `protocol.handle`-served
 * response in this Electron version. This function fully controls the
 * `Response` it builds, so the header goes straight on it; the caller
 * supplies fresh `connectPatterns` on every call (see
 * `GrantedConnectPatterns`'s own doc) rather than this function or its
 * caller caching them across requests. Set on every served asset, not only
 * the entry document: a worker script served through this same handler
 * inherits its OWN response's CSP, never the document's (README.md's Design
 * notes).
 */
function buildResponse (
  content: Uint8Array,
  canonicalPath: string,
  rangeHeader: string | null,
  connectPatterns: readonly Pattern[],
  securePatterns: readonly Pattern[]
): Response {
  const contentType = contentTypeFor(canonicalPath)
  const csp = cspHeaderValue(connectPatterns, securePatterns)
  const total = content.length
  const range = parseRange(rangeHeader, total)

  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes', 'content-security-policy': csp } })
  }

  if (range.kind === 'none') {
    return new Response(content as BodyInit, {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(total), 'accept-ranges': 'bytes', 'content-security-policy': csp }
    })
  }

  const { start, end } = range.range
  const chunk = content.subarray(start, end + 1)
  return new Response(chunk as BodyInit, {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(chunk.length),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'content-security-policy': csp
    }
  })
}

/**
 * Answers a request whose own origin differs from this handler's app origin
 * -- reached here only because `protocol.handle` intercepts the WHOLE
 * scheme for this partition, not merely the app's own host (A143). Granted,
 * not declared: authorised against the app's LIVE `https.connect` grant via
 * `authoriseReach`, never against anything the manifest merely asked for
 * and never against anything read off disk.
 *
 * PLAIN `http:` STAYS DENIED, DELIBERATELY, NOT AS A GAP. `checkConnectSecure`
 * binds identity through the TLS handshake itself -- there is no equivalent
 * binding for a plain connection, which would need `checkConnect`'s own
 * resolve-then-check discipline instead. `reachDial`'s transport has no way
 * to pin a request's underlying connection to an address already checked
 * (the same limitation `electron-fetch.ts`'s own A66 already names for a
 * different caller, confirmed against Electron's own API surface) -- so
 * authorising a plain request here would check one address and could
 * legitimately connect to another moments later (T12, DNS rebinding). That
 * gap is accepted elsewhere in this codebase for a single, narrow,
 * address-literal-constrained install-time fetch; it is not accepted here,
 * for a general surface any page content can point at a fresh hostname of
 * its choosing. AI recommendation, not an owner decision.
 *
 * ANY OTHER FAILURE -- no live grant for this host, no `reachDial`/
 * `authoriseReach` wired in at all (dev-serve.ts's own no-broker case), or
 * `reachDial` itself throwing (a real connection failure, a refused
 * redirect) -- answers the same `denyResponse` shape as every other refusal
 * in this file. Nothing here distinguishes "not granted" from "granted but
 * unreachable" to the page; see `README.md`'s own note on why a denial
 * reason is a local log concern, not a renderer-visible one.
 *
 * A199/A200 (docs/open-questions.md): a live authorisation check and a free
 * allowance slot are only true THIS INSTANT -- neither stayed true for the
 * request's whole lifetime before this fix. `reserveReachSlot`/
 * `releaseReachSlot` cap how many of these an app may hold open at once
 * (A200), and `guardReachResponse` (./serve-reach-guard.js) keeps checking
 * `authoriseReach` while the body streams so a mid-download revoke actually
 * stops it (A199) -- see that file's own doc for what a reading page
 * observes when it does.
 */
export async function fetchThirdParty (
  request: Request,
  authoriseReach: AuthoriseReach | undefined,
  reachDial: ReachDial | undefined,
  recordCoverage: RecordPinCoverage | undefined,
  reserveReachSlot: ReserveReachSlot | undefined,
  releaseReachSlot: ReleaseReachSlot | undefined
): Promise<Response> {
  if (authoriseReach === undefined || reachDial === undefined) {
    recordCoverage?.('denied')
    return denyResponse('cross-origin request inside this app\'s own partition is not served')
  }

  const url = new URL(request.url)
  if (url.protocol !== 'https:') {
    recordCoverage?.('denied')
    return denyResponse('only a granted https host may be reached from inside this app\'s own partition')
  }
  const port = url.port === '' ? 443 : Number(url.port)

  const decision = await authoriseReach(url.hostname, port)
  if (!decision.allowed) {
    recordCoverage?.('denied')
    return denyResponse('this host is not granted to this app')
  }

  // A200: checked AFTER authorisation, never before -- a request this
  // origin was never granted must not consume a slot at all.
  if (reserveReachSlot !== undefined && !reserveReachSlot()) {
    recordCoverage?.('denied')
    return denyResponse('this app has reached its concurrent-connection limit')
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    releaseReachSlot?.()
  }

  try {
    const response = await reachDial(request, decision.host, port)
    recordCoverage?.('third-party', contentLengthOf(response))
    return guardReachResponse(response, url.hostname, port, authoriseReach, release)
  } catch (error) {
    release()
    recordCoverage?.('denied')
    return denyResponse(`reaching the granted host failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Builds the request handler for one app's own origin, doing the
 * whole-bundle re-verification ONCE here rather than per request (README.md
 * Design notes) -- everything the returned handler needs (the pin, the
 * manifest's `entry`) is already resolved by the time it starts answering
 * requests.
 *
 * A pin that fails to parse, or a tree that fails re-verification, is not a
 * thrown error: it produces a handler that denies every request, since a
 * caller registering this against `session.protocol.handle` has no other
 * sensible outcome to hand Electron for a scheme it must now answer for.
 */
/** What `resolveVerifiedBundle` (below) found, or why it refused -- the ONE
 * place this file's whole-tree verification and manifest read/parse
 * happen, shared by `createAppRequestHandler` and `verifiedManifestFor` so
 * neither re-derives it independently (code-guidelines.md Rule 3). */
type VerifiedBundleResult =
  | { readonly ok: true, readonly pin: PinRecord, readonly manifest: Manifest }
  | { readonly ok: false, readonly reason: string }

async function resolveVerifiedBundle (storage: LoaderStorage, origin: string): Promise<VerifiedBundleResult> {
  const rawPin = await storage.readPin(origin)
  const pin = parsePinRecord(rawPin)
  if (pin === null) {
    return { ok: false, reason: 'this origin has no valid cached bundle' }
  }

  if (!await verifyPinnedTree(storage, origin, pin)) {
    return { ok: false, reason: 'the cached bundle failed re-verification against disk' }
  }

  const manifestBytes = await storage.readAsset(origin, MANIFEST_PATH)
  const manifestResult = manifestBytes === undefined
    ? null
    : parseManifest(new TextDecoder().decode(manifestBytes))
  if (manifestResult === null || !manifestResult.ok) {
    return { ok: false, reason: 'the cached manifest could not be read back' }
  }

  return { ok: true, pin, manifest: manifestResult.manifest }
}

/**
 * A158's early-hydration seam (`docs/open-questions.md`): `origin`'s
 * manifest, read from its pinned bundle ONLY once `verifyPinnedTree` has
 * confirmed that whole tree still hashes to `pin.bundleHash` -- undefined
 * for anything short of that (no pin, a corrupt one, or one that fails
 * re-verification). The SAME resolution `createAppRequestHandler` performs
 * to decide what it serves, exposed separately so a caller
 * (`electron-serve.ts`'s `registerServingFor`) can hand this exact,
 * already-verified manifest to `GrantLedger.hydrateFromPinnedManifest`
 * BEFORE registering anything that could answer a real request -- never an
 * unverified copy (A137).
 *
 * Re-verifies the tree independently of whatever `createAppRequestHandler`
 * does moments later for the same origin -- a deliberate, bounded doubling
 * of this file's own accepted per-launch cost (`README.md`'s "Re-
 * verification cost" design note), not a second source of truth: both calls
 * run the identical `resolveVerifiedBundle` above.
 */
export async function verifiedManifestFor (storage: LoaderStorage, origin: string): Promise<Manifest | undefined> {
  const resolved = await resolveVerifiedBundle(storage, origin)
  return resolved.ok ? resolved.manifest : undefined
}

export async function createAppRequestHandler (
  storage: LoaderStorage,
  origin: string,
  grantedConnectPatterns?: GrantedConnectPatterns,
  grantedSecurePatterns?: GrantedSecurePatterns,
  authoriseReach?: AuthoriseReach,
  reachDial?: ReachDial,
  recordCoverage?: RecordPinCoverage,
  reserveReachSlot?: ReserveReachSlot,
  releaseReachSlot?: ReleaseReachSlot
): Promise<AppRequestHandler> {
  const resolved = await resolveVerifiedBundle(storage, origin)
  if (!resolved.ok) {
    return async () => denyResponse(resolved.reason)
  }
  const { pin, manifest } = resolved

  const entryPath = entryCanonicalPath(origin, manifest.entry)

  return async (request: Request): Promise<Response> => {
    // Every https/http request inside this app's OWN partition passes
    // through here, not only requests to this app's own origin -- Electron's
    // protocol.handle intercepts the whole scheme for the session
    // (confirmed against electron/electron's protocol_registry.cc), and
    // nothing about registering a handler for 'https' scopes it to one
    // host. A page in its own partition fetching a THIRD-PARTY https URL is
    // handled by fetchThirdParty below, on the SAME live-authorisation
    // terms `orivon.net.connectSecure` itself uses -- never proxied on the
    // strength of anything this handler already trusted for its OWN origin
    // (docs/open-questions.md A143).
    if (originFromUrl(request.url) !== origin) {
      return await fetchThirdParty(request, authoriseReach, reachDial, recordCoverage, reserveReachSlot, releaseReachSlot)
    }

    const resolved = resolveRequestPath(entryPath, pin, request.url, isNavigationRequest(request))
    if (!resolved.ok) {
      recordCoverage?.('denied')
      return denyResponse(resolved.reason)
    }
    if ('redirectTo' in resolved) return new Response(null, { status: 302, headers: { location: resolved.redirectTo } })

    const content = await storage.readAsset(origin, resolved.canonicalPath)
    if (content === undefined) {
      // verifyPinnedTree above already read every pinned asset successfully
      // at handler-creation time -- reaching this branch means the file was
      // removed from disk AFTER that, during this same process run. Same
      // fail-closed answer as never having been readable.
      recordCoverage?.('denied')
      return denyResponse('cached asset became unavailable after this app was loaded')
    }

    const connectPatterns = grantedConnectPatterns === undefined ? [] : await grantedConnectPatterns()
    const securePatterns = grantedSecurePatterns === undefined ? [] : await grantedSecurePatterns()
    const response = buildResponse(content, resolved.canonicalPath, request.headers.get('range'), connectPatterns, securePatterns)
    // A175: record what buildResponse actually SENT, not `content.length`
    // (the whole pinned asset) -- a Range request serves only a slice, and
    // an unsatisfiable one (416) serves no body at all, so counting the
    // full asset size there inflates pinned coverage by bytes that were
    // never on the wire. `content-length` is always set by buildResponse on
    // a 200/206; a 416 carries none, but that is a KNOWN zero (no body was
    // built), not a size that could not be measured, so it must read as 0,
    // never trip `bytesIncomplete` (pin-coverage.ts's own contract).
    recordCoverage?.('pinned', response.status === 416 ? 0 : contentLengthOf(response))
    return response
  }
}
