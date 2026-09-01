// Real favicons for the tab strip -- owner override, 2026-08-28 (chrome
// restyle round 2). v0 previously showed a generic globe for every tab
// (still the fallback here); src/renderer/README.md and icons.ts's
// globeIcon doc comment both said so and are now updated.
//
// DELIVERY IS MAIN-FETCHES-TO-data:, NOT RENDERER-FETCHES-DIRECTLY.
// AI-REC, not yet an owner decision -- flagged here rather than chosen
// silently. The chrome view's CSP (index.html) is a one-line, readable
// guarantee today that the one privileged view in this app makes zero
// outbound requests. Having the renderer <img src> an arbitrary,
// attacker-influenced https:// URL directly would need `img-src 'self'
// https:` and hands a hostile page a live request from the privileged,
// cookie-bearing chrome origin -- a new, silent tracking surface exactly
// where this codebase has been careful before (mvp-scope.md already
// flags DuckDuckGo search itself as a stated "known limitation" for far
// less: leaving the machine at all). Fetching here instead keeps that
// guarantee intact; the CSP only needs `img-src 'self' data:`.
//
// Structure mirrors update-check.ts/update-check-runner.ts: pure parts
// exported and tested (pickFaviconUrl, readCapped, toDataUrl), the one
// real network call (fetchFaviconDataUrl) thin and defensive around it.
// net.fetch (Electron's own, session-aware) rather than Node's global
// fetch, imported dynamically -- same reasoning as
// update-check-runner.ts's file header: outside a real Electron process
// (i.e. under vitest), `electron`'s entry point is a path STRING, and a
// top-level import would silently bind `undefined` rather than throw.

export const MAX_FAVICON_BYTES = 32 * 1024
export const FAVICON_TIMEOUT_MS = 5_000

/** SVG is deliberately excluded even though `<img>`-loaded SVGs cannot
 * execute scripts or fetch external resources in any current browser --
 * a real but narrower guarantee than "this is just a bitmap", and a
 * favicon is not worth relying on it for. Every mainstream favicon
 * format is still covered. */
const ALLOWED_FAVICON_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon'
])

/**
 * Picks the first http(s) URL out of `page-favicon-updated`'s candidate
 * list. Electron's own event should only ever hand back real page-
 * declared URLs, but every other URL this codebase touches goes through
 * an explicit scheme check (omnibox.ts) rather than trusting the
 * source -- defence in depth, not paranoia about this specific event.
 */
export function pickFaviconUrl (candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (/^https?:\/\//i.test(candidate)) return candidate
  }
  return null
}

/**
 * True if favicon state captured under `previousOrigin` should be
 * cleared before a page at `nextUrl` is shown. Lives here rather than in
 * tabs.ts, its only caller, so it stays reachable from a plain vitest
 * import -- tabs.ts has a VALUE import of `WebContentsView` from
 * 'electron', which this module never does (see the file header).
 *
 * `page-favicon-updated` only fires when Chromium's favicon SET
 * actually changes, so a same-origin navigation to a page with the
 * identical icon fires nothing -- clearing on every commit would leave
 * those stuck on the globe forever. Callers should wire this to
 * 'did-navigate' (top-level commits) only; a hash-only or pushState
 * change ('did-navigate-in-page') should never reach it, since it's
 * still logically the same page.
 */
export function shouldClearFavicon (previousOrigin: string | null, nextUrl: string): boolean {
  if (previousOrigin === null) return false
  try {
    // An opaque-origin URL (about:blank, the fallback every rejected
    // navigation lands on) does NOT throw here -- `.origin` resolves to
    // the literal string "null" per the URL spec, which then simply
    // compares unequal to any real captured origin below. The catch
    // below is for a string that isn't parseable as a URL at all, which
    // no current caller actually produces (tabs.ts only ever passes a
    // committed navigation's own URL) but is cheap to guard regardless.
    return new URL(nextUrl).origin !== previousOrigin
  } catch {
    return true
  }
}

/**
 * Reads a stream up to `cap` bytes, returning null the instant it would
 * be exceeded (cancelling the underlying stream rather than reading
 * further) -- never buffers more than the cap, so a favicon host that
 * lies about its size cannot be used to inflate memory.
 */
export async function readCapped (
  body: ReadableStream<Uint8Array> | null,
  cap: number
): Promise<Uint8Array | null> {
  if (body === null) return null

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > cap) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** null for anything not on the allowlist above, or with no/garbled
 * content-type -- a favicon this shell can't identify is treated the
 * same as one that failed to load. */
export function toDataUrl (bytes: Uint8Array, contentType: string | null): string | null {
  const type = contentType?.split(';')[0]?.trim().toLowerCase()
  if (type === undefined || !ALLOWED_FAVICON_TYPES.has(type)) return null
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * The one function here that touches the network. Returns null on any
 * failure (offline, timeout, oversized, wrong type) -- never throws by
 * contract, matching update-check-runner.ts's fetchLatestGithubRelease.
 */
export async function fetchFaviconDataUrl (url: string): Promise<string | null> {
  const { net } = await import('electron')

  let response: Awaited<ReturnType<typeof net.fetch>>
  try {
    response = await net.fetch(url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS)
    })
  } catch {
    return null // offline, DNS failure, timeout, refused connection
  }
  if (!response.ok) return null

  const bytes = await readCapped(response.body, MAX_FAVICON_BYTES)
  if (bytes === null) return null

  return toDataUrl(bytes, response.headers.get('content-type'))
}

/** In-memory only, unbounded for the process's lifetime -- acceptable
 * for a single browsing session (this codebase's existing "v0, revisit
 * later" tolerance; see e.g. update-check.ts's own scope notes). Only
 * successful fetches are cached, so a temporarily-down favicon host is
 * retried on the next visit rather than staying null forever. */
const faviconCache = new Map<string, string>()

export async function fetchFaviconDataUrlCached (url: string): Promise<string | null> {
  const cached = faviconCache.get(url)
  if (cached !== undefined) return cached

  const result = await fetchFaviconDataUrl(url)
  if (result !== null) faviconCache.set(url, result)
  return result
}
