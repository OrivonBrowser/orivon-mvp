// Fetches a manifest and its declared assets, and turns them into a hashed,
// entry-checked BundleTree: (fetch, hintedUrl, assetPaths) in, a validated
// bundle out. TOFU vs. decideUpdate() branching and persistence are
// index.ts's job, not this file's -- why this file exists on its own:
// README.md, Design notes.

import type { Manifest } from '../contracts/index.js'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, bundleTree } from '../broker/policy/bundle-hash.js'
import type { BundleEntry, BundleTree } from '../broker/policy/bundle-hash.js'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES, canonicalAssetPath } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { isOrivonErrorLike } from '../broker/errors.js'
import { MAX_MANIFEST_BYTES, parseManifest } from './manifest.js'

/**
 * Structurally typed against the real global `fetch`'s `Response` (which
 * satisfies this shape as-is) so tests can stub it trivially, the same way
 * src/broker/policy/connect.ts's `Resolver` and src/broker/index.ts's `Dial`
 * are minimal structural types rather than the full web API.
 */
export interface FetchResponse {
  readonly ok: boolean
  readonly status: number
  /**
   * The RESOLVED url, after any redirect. `fetchBundle()`'s origin and
   * canonical-path checks are derived from this, never from the url that was
   * requested -- see those checks for why.
   */
  readonly url: string
  /**
   * Optional: not every caller can supply headers, and their absence never
   * weakens the caps below -- only removes the fail-fast-before-download
   * optimisation that reading one provides.
   */
  readonly headers?: { get(name: string): string | null }
  /**
   * The body as a stream -- what fetchWithBudget actually reads from, chunk
   * by chunk, so the byte caps below are enforced against bytes actually
   * arriving rather than a fully buffered whole (T11b). `null` for a
   * body-less response, matching the real global fetch's `Response.body`.
   */
  readonly body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * `signal` mirrors src/broker/index.ts's `Dial` (`(addresses, port, signal)
 * => ...`) -- the same "the caller owns cancellation, the callee just reacts
 * to it" shape, so a real implementation can wire it straight to the global
 * `fetch`'s own `{ signal }` option. fetchWithBudget below does not rely on
 * a caller actually honouring it, though: it races its own wait on top, so
 * a `Fetch` that ignores the signal still cannot hang the loader forever.
 */
export type Fetch = (url: string, signal: AbortSignal) => Promise<FetchResponse>

/**
 * Bounds BOTH the request (fetchFn itself) and the body read that follows
 * it -- one wall-clock deadline for the whole one-asset operation. Without
 * this, `fetchFn(url)` or a stalled/slowloris body could block an install of
 * up to MAX_BUNDLE_ENTRIES sequential fetches indefinitely; nothing else in
 * this file has a clock. 20s is generous for a legitimate host to deliver a
 * full MAX_ASSET_BYTES (16 MiB) asset over a slow connection, and short
 * enough that one unresponsive peer cannot stall the whole install for long.
 * AI-recommended and uncalibrated against a real host, the same caveat the
 * byte caps themselves carry -- see docs/open-questions.md A15.
 */
export const FETCH_TIMEOUT_MS = 20_000

/**
 * Bounds the WHOLE fetchBundle() operation -- manifest plus every asset --
 * with one wall-clock deadline, on top of FETCH_TIMEOUT_MS's per-asset one.
 * The two bound different things and neither replaces the other:
 * FETCH_TIMEOUT_MS stops one stuck request; this stops death by a thousand
 * cuts. Without it, a hostile origin can serve up to MAX_BUNDLE_ENTRIES - 1
 * (4095) assets, each arriving in just under FETCH_TIMEOUT_MS and never
 * tripping ITS timer -- roughly 22.6 hours during which fetchBundle()
 * returns none of its documented outcomes. That is the same T11b
 * denial-of-service the streaming byte budget already closes along the
 * memory axis (readBodyWithBudget), reopened along the duration axis
 * instead.
 *
 * Set to 30 * FETCH_TIMEOUT_MS: if every one of the first 30 assets
 * happened to take the full per-asset timeout, the bundle deadline would
 * still let the install finish. A real frontend is expected to have far
 * fewer than 30 assets that are each individually that slow; an attacker
 * needs 4095 to reach the old 22.6-hour figure. Either way this cuts the
 * worst case from hours to minutes -- it does not claim to be tuned to a
 * real host. AI-recommended and uncalibrated, the same caveat FETCH_TIMEOUT_MS
 * and the byte caps themselves carry -- see docs/open-questions.md A15.
 */
export const BUNDLE_TIMEOUT_MS = 30 * FETCH_TIMEOUT_MS

/**
 * Races `promise` against `signal` firing. Exists because a `Fetch` (or a
 * body stream's `read()`) is not guaranteed to honour an AbortSignal on its
 * own -- this makes the timeout real regardless of what the callee does
 * with it, the same "does not trust what it was handed" stance
 * broker/port-pump.ts's credit clamp takes for a different input.
 *
 * What this does NOT do: force the ABANDONED `promise` to release
 * whatever it holds. If the callee (a `Fetch`, or a body stream's
 * `read()`) genuinely ignores its `AbortSignal`, that promise keeps
 * running -- and, more importantly, whatever real resource backs it
 * (a socket, a timer, buffered bytes) stays open -- until it eventually
 * settles on its own, if it ever does. JavaScript has no way to force an
 * arbitrary foreign promise to cancel; `AbortSignal` is cooperative by
 * design, and a callee that does not cooperate cannot be made to from the
 * caller's side. That is a real, currently-unclosed gap this file cannot
 * close alone -- see BUNDLE_TIMEOUT_MS's own comment for how bounding the
 * whole operation at least bounds how many such abandoned attempts one
 * fetchBundle() call can accumulate. **The real `Fetch` implementation
 * must itself observe `signal` and promptly abort/release the underlying
 * request on it** -- this file can hand the signal down and stop waiting
 * on the promise, nothing more. Recorded as docs/open-questions.md A52.
 */
async function raceAbort<T> (promise: Promise<T>, signal: AbortSignal, makeError: () => Error): Promise<T> {
  if (signal.aborted) throw makeError()
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(makeError()) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) }
    )
  })
}

function concatChunks (chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Reads `response.body` chunk by chunk, rejecting the INSTANT the running
 * total would exceed either cap -- an oversized or never-ending body is
 * never buffered whole first. This is what actually enforces `assetCap`/
 * `remaining` against a chunked, compressed (Content-Length is the wire
 * size; decoded bytes can be far larger -- a decompression bomb), or lying
 * response; fetchWithBudget's own Content-Length pre-check only ever
 * catches a response that DECLARES its size honestly.
 *
 * RESIDUAL LIMIT, not closed by this function: the check below can only
 * refuse a chunk AFTER `await reader.read()` has already returned it, and
 * that Uint8Array is already fully allocated by then -- whoever produced it
 * (the real stream implementation behind `response.body`) decided its size,
 * not this loop. So the actual bound this file enforces is "one chunk",
 * not "the cap": a producer that hands back the whole body as a single
 * `read()` result -- a decompressing fetch, a naive shim that buffers then
 * emits once, or a real undici under a gzip bomb -- still allocates that
 * one oversized chunk before the rejection below can fire, even though the
 * rejection is correct and immediate once it does (proven in
 * fetch-bundle.test.ts's "still rejects a single stream chunk..." case).
 * Closing this fully would need a bounded (BYOB) reader, which requires the
 * stream to declare `type: 'bytes'` -- not guaranteed by this file's
 * minimal structural `FetchResponse` type (see this file's header), and not
 * something a stub or a naive real implementation is likely to provide.
 * Not implemented for that reason; the real `Fetch`/stream implementation
 * bounding its own chunk sizes is what would close this the rest of the way.
 * Recorded as docs/open-questions.md A52.
 */
async function readBodyWithBudget (
  response: FetchResponse,
  assetCap: number,
  remaining: number,
  signal: AbortSignal,
  label: string,
  url: string,
  bundleSignal: AbortSignal
): Promise<Uint8Array | FetchBundleRejected> {
  const body = response.body
  if (body === null) return new Uint8Array(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    let step: ReadableStreamReadResult<Uint8Array>
    try {
      step = await raceAbort(
        reader.read(),
        signal,
        // `bundleSignal` is already aborted by the time this runs in that
        // case -- fetchWithBudget's forwarding listener aborts `signal`
        // (this per-asset controller) synchronously in reaction to
        // `bundleSignal` firing, before this makeError callback can run.
        () => bundleSignal.aborted
          ? new Error(`reading ${label} was cut short by the bundle's overall deadline of ${String(BUNDLE_TIMEOUT_MS)}ms: ${url}`)
          : new Error(`reading ${label} timed out after ${String(FETCH_TIMEOUT_MS)}ms: ${url}`)
      )
    } catch (error) {
      reader.cancel().catch(() => {})
      return rejected(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (step.done) break
    total += step.value.byteLength
    if (total > assetCap) {
      reader.cancel().catch(() => {})
      return rejected(`${label} exceeds its cap of ${String(assetCap)} bytes (MAX_ASSET_BYTES): ${url}`)
    }
    if (total > remaining) {
      reader.cancel().catch(() => {})
      return rejected(`${label} does not fit in the bundle's remaining byte budget (MAX_BUNDLE_BYTES): ${url}`)
    }
    chunks.push(step.value)
  }
  return concatChunks(chunks, total)
}

export interface FetchBundleOk {
  readonly ok: true
  readonly canonicalOrigin: string
  readonly manifest: Manifest
  readonly tree: BundleTree
  /** Every leaf's raw bytes, manifest included (bundle-hash.ts: "the manifest is a leaf like any other asset"). */
  readonly entries: readonly BundleEntry[]
}

export interface FetchBundleRejected {
  readonly ok: false
  /** Developer-facing, same stance as manifest.ts's own ManifestRejected -- never shown to an end user as-is. */
  readonly reason: string
}

export type FetchBundleResult = FetchBundleOk | FetchBundleRejected

function rejected (reason: string): FetchBundleRejected {
  return { ok: false, reason }
}

/** `Content-Length`, if present and a valid non-negative integer. Never trusted alone -- see checkBudget. */
function declaredLength (response: FetchResponse): number | undefined {
  const raw = response.headers?.get('content-length') ?? response.headers?.get('Content-Length')
  if (raw === null || raw === undefined) return undefined
  if (!/^[0-9]+$/.test(raw)) return undefined
  return Number(raw)
}

/**
 * One fetch, with the byte caps applied on both sides of the download: the
 * DECLARED length (Content-Length), when the server sent one, is checked
 * BEFORE the body is read -- so an oversized response can be rejected
 * without ever downloading it. The ACTUAL length is checked incrementally
 * WHILE the body is read (readBodyWithBudget), never after buffering it in
 * full -- a declared length is advisory and may be absent (any chunked or
 * dynamically generated response has none), wrong, or a lie. Both checks
 * are against the same two numbers: this one asset's own cap (`assetCap`)
 * and how much room is left in the whole bundle (`remaining`).
 *
 * Two deadlines apply, and both matter: FETCH_TIMEOUT_MS via this call's own
 * AbortController bounds ONE asset; `bundleSignal` (BUNDLE_TIMEOUT_MS,
 * started once in fetchBundle) bounds the WHOLE install. `bundleSignal`
 * firing is forwarded onto this call's own controller, so either deadline
 * aborts the same in-flight fetch/read the same way -- see BUNDLE_TIMEOUT_MS's
 * own comment for why the second deadline exists. If `bundleSignal` has
 * already fired before this call even starts (the common case once the
 * deadline has passed: every later asset in fetchBundle's loop reaches this
 * function after the one that got cut off), the fetch never starts at all.
 */
async function fetchWithBudget (
  fetchFn: Fetch,
  url: string,
  assetCap: number,
  remaining: number,
  label: string,
  bundleSignal: AbortSignal
): Promise<{ readonly response: FetchResponse, readonly content: Uint8Array } | FetchBundleRejected> {
  if (bundleSignal.aborted) {
    return rejected(`bundle install exceeded its overall deadline of ${String(BUNDLE_TIMEOUT_MS)}ms before ${label} could be fetched: ${url}`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  const forwardBundleAbort = (): void => { controller.abort() }
  bundleSignal.addEventListener('abort', forwardBundleAbort, { once: true })
  try {
    let response: FetchResponse
    try {
      response = await raceAbort(
        fetchFn(url, controller.signal),
        controller.signal,
        () => bundleSignal.aborted
          ? new Error(`bundle install exceeded its overall deadline of ${String(BUNDLE_TIMEOUT_MS)}ms`)
          : new Error(`timed out after ${String(FETCH_TIMEOUT_MS)}ms`)
      )
    } catch (error) {
      return rejected(`could not fetch ${label} (${url}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) return rejected(`${label} fetch failed: HTTP ${String(response.status)} (${url})`)

    const declared = declaredLength(response)
    if (declared !== undefined) {
      if (declared > assetCap) return rejected(`${label} declares ${String(declared)} bytes, over its cap of ${String(assetCap)}: ${url}`)
      if (declared > remaining) return rejected(`${label} declares ${String(declared)} bytes, more than fits in the bundle's remaining budget: ${url}`)
    }

    const body = await readBodyWithBudget(response, assetCap, remaining, controller.signal, label, url, bundleSignal)
    if (!(body instanceof Uint8Array)) return body
    return { response, content: body }
  } finally {
    clearTimeout(timer)
    bundleSignal.removeEventListener('abort', forwardBundleAbort)
  }
}

/**
 * `new URL(path, base)`, guarded. `URL`'s constructor throws `TypeError` on
 * a malformed `path` (confirmed live: `new URL('http://[not-valid-ipv6/x.js',
 * 'https://good.example/')`) -- this file's own header promises exactly four
 * outcomes and never a fifth, so nothing here may let that escape as an
 * uncaught exception. Both callers below resolve caller-supplied path
 * strings this way; neither may trust the input is well-formed.
 */
function resolveUrl (path: string, base: string): string | null {
  try {
    return new URL(path, base).href
  } catch {
    return null
  }
}

/**
 * Resolves the app's entry point to the canonical path bundleTree()'s
 * output must be checked against. `entry` is already known safe as a STRING
 * (manifest.ts's validateEntry ran inside parseManifest) -- this resolves it
 * against the real origin the same way an asset URL would be, so the
 * comparison below is exact-string against `tree.assets`, never a second,
 * looser notion of "matches". Guarded via resolveUrl anyway: validateEntry's
 * own encoding walks `entry` one path segment at a time, a different
 * algorithm from resolving the whole string as a relative reference here --
 * a string that survives one is not proven to survive the other.
 */
function entryCanonicalPath (canonicalOrigin: string, entry: string): string | null {
  const resolved = resolveUrl(entry, `${canonicalOrigin}/`)
  return resolved === null ? null : canonicalAssetPath(resolved)
}

/**
 * `assetPaths` is an explicit parameter here, not discovered from the
 * manifest -- `Manifest` (src/contracts/manifest.ts) has no field naming an
 * app's frontend files, only `entry`, one HTML file, and nothing in the doc
 * corpus specifies a discovery/crawl mechanism (filed as
 * docs/open-questions.md A45 rather than guessed). Everything downstream of
 * `assetPaths` is fully real; only "how the caller assembles this list" is
 * still open.
 */
export async function fetchBundle (
  fetchFn: Fetch,
  hintedUrl: string,
  assetPaths: readonly string[]
): Promise<FetchBundleResult> {
  const canonicalOrigin = originFromUrl(hintedUrl)
  if (canonicalOrigin === null) return rejected(`hintedUrl is not a valid app origin: ${hintedUrl}`)

  // Cheap and exact -- checked before any network call, per this lane's
  // acceptance criteria ("fail before exceeding them, not after").
  if (assetPaths.length + 1 > MAX_BUNDLE_ENTRIES) {
    return rejected(`bundle would have ${String(assetPaths.length + 1)} entries, more than MAX_BUNDLE_ENTRIES (${String(MAX_BUNDLE_ENTRIES)})`)
  }

  // BUNDLE_TIMEOUT_MS's one clock for the whole operation below -- started
  // here so it covers the manifest fetch too, not just the asset loop.
  // `bundleController.signal` is threaded into every fetchWithBudget call;
  // see BUNDLE_TIMEOUT_MS's and fetchWithBudget's own comments for why.
  const bundleController = new AbortController()
  const bundleTimer = setTimeout(() => { bundleController.abort() }, BUNDLE_TIMEOUT_MS)
  try {
    let bytesUsed = 0
    // Always exactly `<origin>${MANIFEST_PATH}` (capability-api.md "How a
    // URL becomes an app"), never a path component of `hintedUrl`. Not a
    // stylistic choice: bundleTree() rejects any bundle with no leaf at that
    // literal canonical path (canonical-path.ts's MANIFEST_PATH), so a
    // manifest fetched from anywhere else could never produce an accepted
    // bundle regardless -- `hintedUrl` is used only to name which origin is
    // being installed.
    const manifestUrl = `${canonicalOrigin}${MANIFEST_PATH}`
    const manifestFetch = await fetchWithBudget(fetchFn, manifestUrl, MAX_MANIFEST_BYTES, MAX_BUNDLE_BYTES, 'manifest', bundleController.signal)
    if ('ok' in manifestFetch) return manifestFetch
    bytesUsed += manifestFetch.content.length

    // Derived from the RESOLVED url the fetch actually returned
    // (`response.url`), never the url that was requested. Same "trust what
    // happened, not what was asked for" stance origin.ts's
    // originFromSenderFrame takes for T3 -- a redirect must not be able to
    // silently attribute these bytes to a path, or an origin, other than
    // where they actually came from. The asset loop below applies the same
    // stance to `assetFetch.response.url`.
    const manifestOrigin = originFromUrl(manifestFetch.response.url)
    if (manifestOrigin !== canonicalOrigin) {
      return rejected(`manifest was served from a different origin (${manifestOrigin ?? 'invalid'}) than requested (${canonicalOrigin})`)
    }
    const manifestCanonicalPath = canonicalAssetPath(manifestFetch.response.url)
    if (manifestCanonicalPath !== MANIFEST_PATH) {
      return rejected(`manifest was served from ${manifestCanonicalPath ?? manifestFetch.response.url}, not the well-known path ${MANIFEST_PATH}`)
    }

    const manifestText = new TextDecoder('utf-8', { fatal: false }).decode(manifestFetch.content)
    const parsed = parseManifest(manifestText)
    if (!parsed.ok) return rejected(parsed.reason)
    const manifest = parsed.manifest

    const entries: BundleEntry[] = [{ path: MANIFEST_PATH, content: manifestFetch.content }]

    for (const assetPath of assetPaths) {
      const assetUrl = resolveUrl(assetPath, `${canonicalOrigin}/`)
      if (assetUrl === null) return rejected(`asset path is not a valid URL: ${assetPath}`)

      // Checked BEFORE fetchFn is ever called: `new URL(assetPath, base)`
      // honours an absolute or protocol-relative assetPath (e.g.
      // "https://attacker.example/x"), so without this an entry crafted that
      // way would trigger a real outbound request before the origin is ever
      // looked at. The post-fetch check below on the RESOLVED url still runs
      // too -- this one catches a bad request before it happens, that one
      // catches a redirect after it happens; neither replaces the other.
      const requestedOrigin = originFromUrl(assetUrl)
      if (requestedOrigin !== canonicalOrigin) {
        return rejected(`asset ${assetPath} resolves to a different origin (${requestedOrigin ?? 'invalid'}) than the app's (${canonicalOrigin})`)
      }

      const assetFetch = await fetchWithBudget(fetchFn, assetUrl, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES - bytesUsed, `asset ${assetPath}`, bundleController.signal)
      if ('ok' in assetFetch) return assetFetch

      // Resolved url, not requested url -- same stance as the manifest
      // check above.
      const assetOrigin = originFromUrl(assetFetch.response.url)
      if (assetOrigin !== canonicalOrigin) {
        return rejected(`asset ${assetPath} was served from a different origin (${assetOrigin ?? 'invalid'}) than requested (${canonicalOrigin})`)
      }
      const canonicalPath = canonicalAssetPath(assetFetch.response.url)
      if (canonicalPath === null) return rejected(`asset ${assetPath} resolved to a URL with no canonical path: ${assetFetch.response.url}`)

      bytesUsed += assetFetch.content.length
      entries.push({ path: canonicalPath, content: assetFetch.content })
    }

    let tree: BundleTree
    try {
      tree = await bundleTree(entries)
    } catch (error) {
      if (isOrivonErrorLike(error)) return rejected(error.message)
      throw error // a bug in this file or bundle-hash.ts, not an untrusted-input outcome -- never swallowed
    }

    const entryPath = entryCanonicalPath(canonicalOrigin, manifest.entry)
    if (entryPath === null || !tree.assets.some((asset) => asset.path === entryPath)) {
      return rejected(`bundle has no leaf at the manifest's declared entry point: ${manifest.entry}`)
    }

    return { ok: true, canonicalOrigin, manifest, tree, entries }
  } finally {
    clearTimeout(bundleTimer)
  }
}
