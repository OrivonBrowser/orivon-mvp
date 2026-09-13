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
// cost tradeoff this file spends.

import { isPinnedPath, parsePinRecord } from '../broker/policy/pin.js'
import type { PinRecord } from '../broker/policy/pin.js'
import { MANIFEST_PATH, canonicalAssetPath } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { entryCanonicalPath } from './fetch-bundle.js'
import { parseManifest } from './manifest.js'
import { contentTypeFor } from './serve-content-type.js'
import { parseRange } from './serve-range.js'
import { verifyPinnedTree } from './serve-verify.js'
import type { LoaderStorage } from './storage.js'

export type AppRequestHandler = (request: Request) => Promise<Response>

/** Everything a request needs decided before a byte is read off disk -- deliberately exported for direct, Electron-free unit testing (this file's own header). */
export type ResolvedRequest =
  | { readonly ok: true, readonly canonicalPath: string }
  | { readonly ok: false, readonly reason: string }

/**
 * Decides which pinned asset, if any, a request answers to.
 *
 * `/` IS THE ONE SPECIAL CASE (the task this function exists for: "a
 * directory-ish or `/` request needs a stated rule"). It maps to
 * `manifest.entry`, and ONLY the bare root -- `isValidCanonicalPath`
 * rejects every OTHER path ending in `/` (a trailing empty segment), so
 * `/foo/` is not a directory index, it is simply not a valid canonical path
 * and falls through to the ordinary pinned-set check below, which denies
 * it. There is no directory listing and no index-file fallback beyond the
 * root: a pinned bundle is a fixed, hashed asset MAP, not a filesystem.
 *
 * Every other path must be an EXACT pinned canonical path -- the fail-closed
 * rule ADR-0007 names directly: "a same-origin request whose path is not in
 * the pinned set is denied, not fetched."
 */
export function resolveRequestPath (entryPath: string | null, pin: PinRecord, requestUrl: string): ResolvedRequest {
  const url = new URL(requestUrl)

  if (url.pathname === '/') {
    if (entryPath === null || !isPinnedPath(pin, entryPath)) {
      return { ok: false, reason: 'entry point is not part of the pinned bundle' }
    }
    return { ok: true, canonicalPath: entryPath }
  }

  const canonicalPath = canonicalAssetPath(requestUrl)
  if (canonicalPath === null) return { ok: false, reason: 'not a valid canonical asset path' }
  if (!isPinnedPath(pin, canonicalPath)) return { ok: false, reason: 'not in the pinned asset set' }
  return { ok: true, canonicalPath }
}

function denyResponse (reason: string): Response {
  return new Response(`Orivon: ${reason}`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/**
 * Turns `content` into the actual `Response`, honouring a `Range` request.
 *
 * CSP AND OTHER RESPONSE HEADERS BELONG HERE, NOT IN `onHeadersReceived` --
 * A110 (docs/open-questions.md) confirmed that listener never fires for a
 * `protocol.handle`-served response in this Electron version. This function
 * fully controls the `Response` it builds, so whichever build step wires a
 * CSP header (S4-6, not this one) adds it to the `headers` object below --
 * this comment is that seam.
 */
function buildResponse (content: Uint8Array, canonicalPath: string, rangeHeader: string | null): Response {
  const contentType = contentTypeFor(canonicalPath)
  const total = content.length
  const range = parseRange(rangeHeader, total)

  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' } })
  }

  if (range.kind === 'none') {
    return new Response(content as BodyInit, {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(total), 'accept-ranges': 'bytes' }
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
      'accept-ranges': 'bytes'
    }
  })
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
export async function createAppRequestHandler (storage: LoaderStorage, origin: string): Promise<AppRequestHandler> {
  const rawPin = await storage.readPin(origin)
  const pin = parsePinRecord(rawPin)
  if (pin === null) {
    return async () => denyResponse('this origin has no valid cached bundle')
  }

  if (!await verifyPinnedTree(storage, origin, pin)) {
    return async () => denyResponse('the cached bundle failed re-verification against disk')
  }

  const manifestBytes = await storage.readAsset(origin, MANIFEST_PATH)
  const manifestResult = manifestBytes === undefined
    ? null
    : parseManifest(new TextDecoder().decode(manifestBytes))
  if (manifestResult === null || !manifestResult.ok) {
    return async () => denyResponse('the cached manifest could not be read back')
  }

  const entryPath = entryCanonicalPath(origin, manifestResult.manifest.entry)

  return async (request: Request): Promise<Response> => {
    // Every https/http request inside this app's OWN partition passes
    // through here, not only requests to this app's own origin -- Electron's
    // protocol.handle intercepts the whole scheme for the session
    // (confirmed against electron/electron's protocol_registry.cc), and
    // nothing about registering a handler for 'https' scopes it to one
    // host. A page in its own partition fetching a THIRD-PARTY https URL is
    // therefore denied here rather than reaching the real network -- ADR-0005
    // already assumes a fully self-contained, pre-hashed bundle, and
    // proxying an unrelated origin through this handler is a live-network
    // trust decision this lane does not make. Filed as
    // docs/open-questions.md A138 rather than resolved silently.
    if (originFromUrl(request.url) !== origin) {
      return denyResponse('cross-origin request inside this app\'s own partition is not served')
    }

    const resolved = resolveRequestPath(entryPath, pin, request.url)
    if (!resolved.ok) return denyResponse(resolved.reason)

    const content = await storage.readAsset(origin, resolved.canonicalPath)
    if (content === undefined) {
      // verifyPinnedTree above already read every pinned asset successfully
      // at handler-creation time -- reaching this branch means the file was
      // removed from disk AFTER that, during this same process run. Same
      // fail-closed answer as never having been readable.
      return denyResponse('cached asset became unavailable after this app was loaded')
    }

    return buildResponse(content, resolved.canonicalPath, request.headers.get('range'))
  }
}
