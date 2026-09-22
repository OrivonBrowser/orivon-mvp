// One fetch, with a byte cap and an idle deadline both enforced
// against bytes actually arriving -- a self-contained concern
// fetch-bundle.ts's own orchestration (manifest, then every declared asset,
// into a hashed BundleTree) does not need to know the inside of. Tested
// through fetch-bundle.test.ts's own suite, same as install-origin.ts.

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
   * The RESOLVED url, after any redirect -- per a real `fetch()` Response's
   * own contract. NOT what `fetchBundle()` actually trusts, though: measured
   * against real Electron (docs/open-questions.md A59/A141), this reads as
   * the empty string on every ordinary, non-redirected response, so
   * fetch-bundle.ts derives its origin/canonical-path checks from the url it
   * REQUESTED instead -- see `Fetch`'s own doc comment below for the
   * requirement that makes that safe. Kept in this structural type because a
   * real `fetch()` Response always carries it; not read by fetch-bundle.ts.
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
 * `pinnedAddresses` and `signal` both mirror src/broker/index.ts's `Dial`
 * (`(addresses, port, signal) => ...`): the caller resolves once
 * (install-origin.ts's `ensurePublicUnicastOrigin`) and hands the
 * validated literal(s) down, the same "dial the literal you checked, never
 * the name again" contract connect.ts's own header states -- see
 * fetch-bundle.ts's own comment on where `pinnedAddresses` comes from and why
 * it is the SAME array for every fetch across one install, never
 * re-resolved per request. A real implementation is expected to use it to
 * pin its actual connection as far as its underlying network stack allows;
 * see electron-fetch.ts's own comment for what that means concretely, and
 * its limits, against Electron's `net.fetch`.
 *
 * `signal` mirrors `Dial`'s own cancellation shape -- the same "the caller
 * owns cancellation, the callee just reacts to it" stance, so a real
 * implementation can wire it straight to the global `fetch`'s own `{ signal
 * }` option. fetchWithBudget below does not rely on a caller actually
 * honouring it, though: it races its own wait on top, so a `Fetch` that
 * ignores the signal still cannot hang the loader forever.
 *
 * MUST NEVER DELIVER A RESPONSE FROM ANOTHER ORIGIN (A141). fetch-bundle.ts's
 * same-origin and canonical-path checks trust the url they REQUESTED, never
 * `response.url` (see that field's own doc comment above for why), which is
 * safe only because a response whose bytes came from elsewhere can never
 * reach them. A same-origin redirect may be followed (static hosts answer
 * `/index.html` with a redirect to `/`); the bytes are then pinned under the
 * requested path, still on the origin being installed. An implementation that
 * follows a cross-origin hop silently defeats fetch-bundle.ts's origin
 * confinement, with nothing downstream to catch it. electron-fetch.ts's
 * `netFetch` checks every hop (`redirectRefusal`) before taking it, proven
 * against a real redirecting server in test/e2e-loader-adapter.test.ts.
 */
export type Fetch = (url: string, pinnedAddresses: readonly string[], signal: AbortSignal) => Promise<FetchResponse>

/**
 * How long one fetch may go without progress: no response yet, or no new
 * body bytes since the last chunk. An IDLE deadline, not a total one, so a
 * large asset on a slow but steady connection finishes, while a stalled or
 * slowloris peer is dropped. AI-recommended and uncalibrated, like the
 * other bounds here (docs/open-questions.md A15).
 */
export const FETCH_IDLE_TIMEOUT_MS = 20_000

/**
 * Bounds the WHOLE fetchBundle() operation -- the install-origin guard's own
 * resolution, the manifest fetch, and every asset -- with one wall-clock
 * deadline. FETCH_IDLE_TIMEOUT_MS stops one stuck request; this stops a
 * peer that trickles one byte just inside the idle deadline forever (the
 * T11b duration-axis DoS the streaming byte budget closes along the memory
 * axis). 30 minutes lets a full MAX_BUNDLE_BYTES (512 MiB) bundle arrive at
 * about 300 KB/s. AI-recommended and uncalibrated, same caveat as above.
 */
export const BUNDLE_TIMEOUT_MS = 30 * 60_000

/**
 * Why one fetch (or the install-origin guard's own resolution) did not
 * produce a usable result. Developer-facing, same stance as manifest.ts's
 * own ManifestRejected -- never shown to an end user as-is. Shared by this
 * file and fetch-bundle.ts's own `FetchBundleResult`: a single fetch's
 * rejection reason IS the whole bundle's rejection reason, unchanged, which
 * is why fetch-bundle.ts returns one of these directly rather than wrapping
 * it a second time.
 */
export interface FetchBundleRejected {
  readonly ok: false
  readonly reason: string
}

export function rejected (reason: string): FetchBundleRejected {
  return { ok: false, reason }
}

/**
 * The bundle's byte budget, shared by every asset fetch running at once:
 * each chunk is taken from it as it arrives, in one synchronous step, so
 * concurrent fetches can never together exceed MAX_BUNDLE_BYTES.
 */
export class ByteBudget {
  #remaining: number
  constructor (total: number) {
    this.#remaining = total
  }

  get remaining (): number {
    return this.#remaining
  }

  take (bytes: number): boolean {
    if (bytes > this.#remaining) return false
    this.#remaining -= bytes
    return true
  }
}

/**
 * Races `promise` against `signal` firing. Exists because a `Fetch` (or a
 * body stream's `read()`) is not guaranteed to honour an AbortSignal on its
 * own -- this makes the deadline real regardless of what the callee does
 * with it.
 *
 * What this does NOT do: force the ABANDONED `promise` to release whatever
 * it holds. A callee that ignores its `AbortSignal` keeps running, with
 * whatever socket or buffer backs it, until it settles on its own;
 * `AbortSignal` is cooperative by design. **The real `Fetch` implementation
 * must itself observe `signal` and promptly abort the underlying request.**
 * Recorded as docs/open-questions.md A52. Exported so fetch-bundle.ts races
 * the install-origin guard the same way (Rule 3).
 */
export async function raceAbort<T> (promise: Promise<T>, signal: AbortSignal, makeError: () => Error): Promise<T> {
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

/** `Content-Length`, if present and a valid non-negative integer. Never trusted alone -- see fetchWithBudget. */
function declaredLength (response: FetchResponse): number | undefined {
  const raw = response.headers?.get('content-length') ?? response.headers?.get('Content-Length')
  if (raw === null || raw === undefined) return undefined
  if (!/^[0-9]+$/.test(raw)) return undefined
  return Number(raw)
}

/** A timer that aborts `controller` after FETCH_IDLE_TIMEOUT_MS without a `touch()`. */
function idleWatch (controller: AbortController): { touch: () => void, pause: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pause = (): void => { if (timer !== undefined) clearTimeout(timer) }
  const touch = (): void => {
    pause()
    timer = setTimeout(() => { controller.abort() }, FETCH_IDLE_TIMEOUT_MS)
  }
  touch()
  return { touch, pause }
}

/** What one successful fetchWithBudget delivered: the response head, and how many body bytes went to `onChunk`. */
export interface FetchedBody {
  readonly response: FetchResponse
  readonly byteLength: number
}

/**
 * One fetch, streamed chunk by chunk into `onChunk` -- never buffered here
 * -- with the byte caps applied on both sides of the download: the DECLARED
 * length (Content-Length), when the server sent one, is checked BEFORE the
 * body is read, so an oversized response is refused without downloading
 * it; the ACTUAL length is checked as each chunk arrives, since a declared
 * length may be absent (chunked), wrong, or a lie (a decompression bomb).
 * Both checks are against this asset's own cap (`assetCap`) and what is
 * left of the bundle's shared `budget`.
 *
 * RESIDUAL LIMIT (A52): a chunk is refused only after `reader.read()` has
 * already allocated it, so the bound actually enforced is "one chunk", not
 * the cap -- a producer that hands back the whole body in one read still
 * allocates it first. Closing that needs a BYOB reader over a `type:
 * 'bytes'` stream, which this minimal structural `FetchResponse` does not
 * guarantee.
 *
 * Two deadlines, both abort the same in-flight fetch: FETCH_IDLE_TIMEOUT_MS
 * (this call's own, re-armed by every chunk and paused while `onChunk`
 * writes it) and `bundleSignal` (BUNDLE_TIMEOUT_MS, or a sibling asset's
 * failure, forwarded from fetchBundle).
 *
 * `onChunk` throwing (a failed local write) rejects this fetch with a
 * reason naming no host path; the error itself is logged.
 */
export async function fetchWithBudget (
  fetchFn: Fetch,
  url: string,
  pinnedAddresses: readonly string[],
  assetCap: number,
  budget: ByteBudget,
  label: string,
  bundleSignal: AbortSignal,
  onChunk: (chunk: Uint8Array) => Promise<void>
): Promise<FetchedBody | FetchBundleRejected> {
  const deadlineError = (): Error => new Error(`bundle install exceeded its overall deadline of ${String(BUNDLE_TIMEOUT_MS)}ms`)
  if (bundleSignal.aborted) return rejected(`could not fetch ${label} (${url}): ${deadlineError().message}`)

  const controller = new AbortController()
  const idle = idleWatch(controller)
  const forwardBundleAbort = (): void => { controller.abort() }
  bundleSignal.addEventListener('abort', forwardBundleAbort, { once: true })
  const abortError = (): Error => bundleSignal.aborted
    ? deadlineError()
    : new Error(`timed out: no progress for ${String(FETCH_IDLE_TIMEOUT_MS)}ms`)
  try {
    let response: FetchResponse
    try {
      response = await raceAbort(fetchFn(url, pinnedAddresses, controller.signal), controller.signal, abortError)
    } catch (error) {
      return rejected(`could not fetch ${label} (${url}): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) return rejected(`${label} fetch failed: HTTP ${String(response.status)} (${url})`)

    const declared = declaredLength(response)
    if (declared !== undefined) {
      if (declared > assetCap) return rejected(`${label} declares ${String(declared)} bytes, over its cap of ${String(assetCap)}: ${url}`)
      if (declared > budget.remaining) return rejected(`${label} declares ${String(declared)} bytes, more than fits in the bundle's remaining budget: ${url}`)
    }

    const body = response.body
    if (body === null) return { response, byteLength: 0 }
    const reader = body.getReader()
    let total = 0
    while (true) {
      idle.touch()
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await raceAbort(reader.read(), controller.signal, abortError)
      } catch (error) {
        reader.cancel().catch(() => {})
        return rejected(`reading ${label} failed (${url}): ${error instanceof Error ? error.message : String(error)}`)
      }
      if (step.done) break
      total += step.value.byteLength
      if (total > assetCap) {
        reader.cancel().catch(() => {})
        return rejected(`${label} exceeds its cap of ${String(assetCap)} bytes (MAX_ASSET_BYTES): ${url}`)
      }
      if (!budget.take(step.value.byteLength)) {
        reader.cancel().catch(() => {})
        return rejected(`${label} does not fit in the bundle's remaining byte budget (MAX_BUNDLE_BYTES): ${url}`)
      }
      idle.pause()
      try {
        await onChunk(step.value)
      } catch (error) {
        reader.cancel().catch(() => {})
        console.error('[loader] failed to stage a fetched asset locally', url, error)
        return rejected(`${label} could not be written to local storage: ${url}`)
      }
    }
    return { response, byteLength: total }
  } finally {
    idle.pause()
    bundleSignal.removeEventListener('abort', forwardBundleAbort)
  }
}
