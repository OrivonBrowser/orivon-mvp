// Real favicons for the tab strip -- see src/renderer/README.md for the
// feature, and README.md's Design notes here for why main fetches to
// data: rather than the renderer fetching directly, and for why this
// file's own fetch must clear T12 before it runs.
//
// Structure mirrors update-check.ts/update-check-runner.ts: pure parts
// exported and tested (pickFaviconUrl, isSafeFaviconUrl, readCapped,
// toDataUrl), the one real network call (fetchFaviconDataUrl) thin and
// defensive around it. net.fetch (Electron's own, session-aware) rather
// than Node's global fetch, imported dynamically -- same reasoning as
// update-check-runner.ts's file header: outside a real Electron process
// (i.e. under vitest), `electron`'s entry point is a path STRING, and a
// top-level import would silently bind `undefined` rather than throw.

import { classifyAddress, isPublicUnicast } from '../../broker/policy/address.js'
import type { Resolver } from '../../broker/policy/connect.js'
import { isLocalhostName } from '../../broker/policy/origin.js'
import { electronResolveHost } from '../../loader/electron-resolve.js'

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

/** This machine: a loopback literal in any spelling classifyAddress
 * normalises, or a `localhost` name (which Chromium resolves to loopback
 * itself and never puts on the wire). */
function isLoopbackHost (host: string): boolean {
  return isLocalhostName(host) || classifyAddress(host) === 'loopback'
}

/** Whether the PAGE declaring a favicon is itself running on this machine.
 * `file:` and every other scheme is not -- only a real http(s) page on
 * loopback counts, so a local HTML file cannot be the lever either. */
function isLoopbackPage (pageUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return isLoopbackHost(parsed.hostname)
}

/**
 * T12 (security-model.md): true only if `url` is safe for the main
 * process to fetch unprompted -- no manifest, no grant, no app involved,
 * so a favicon candidate is held to the same "public unicast only" bar
 * as every other unprompted main-process reach. Reuses the exact
 * classification loader/install-origin.ts and loader/electron-fetch.ts
 * already apply (classifyAddress/isPublicUnicast/isLocalhostName) and
 * the same resolver they use for a live Electron net.fetch
 * (loader/electron-resolve.ts's electronResolveHost, Chromium's own --
 * the one net.fetch itself will consult) rather than a second
 * implementation of either (code-guidelines.md Rule 3).
 *
 * **Same origin with the page that declared it is safe without further
 * qualification.** The classification below exists to stop a page reaching
 * across origins -- a public page nominating loopback, or any page nominating
 * a host nothing vouched for. A candidate on the page's own origin invents no
 * such reach: its scripts, css and subresources load from that origin already,
 * and this fetch is credential-less. An app origin that is neither a localhost
 * name nor public unicast -- the session-scoped plain-http hosts a dev grant
 * steers at 127.0.0.1 by a name like `bisq.eth` -- would otherwise never show
 * its own icon.
 *
 * **Loopback is allowed, for a page that is itself on loopback** -- owner's
 * decision, 2026-09-16, replacing the blanket refusal this had before. A
 * local dev server is a real thing to browse here, and refusing its icon
 * bought nothing. `http` is allowed on that path too, because a local dev
 * server is almost never https and an https-only carve-out would refuse
 * exactly the case the carve-out exists for.
 *
 * What stays refused, and why it is not the thing being allowed: a PUBLIC
 * page declaring `<link rel=icon href="http://127.0.0.1:8080/...">`. The
 * page fully controls this URL, so without the `isLoopbackPage` condition
 * any site you visit could make the privileged main process issue blind,
 * credential-less GETs to every port on your machine -- a port scanner
 * with no origin and none of the Private Network Access rules the renderer
 * is held to. An icon belonging to a local page is what was asked for;
 * that is a public page reaching into your machine.
 *
 * `https` only off loopback: an http candidate would otherwise let a page
 * served over https force a plaintext request from the main process,
 * outside the renderer's own mixed-content rules.
 *
 * A LITERAL address (including every decimal/octal/hex/IPv4-mapped-IPv6
 * spelling classifyAddress already normalises) is judged directly. A
 * HOSTNAME is resolved, and EVERY returned address must be public -- a
 * name that resolves to a private address is DNS rebinding
 * (policy/connect.ts's own resolver handling is the worked example), not
 * merely a private literal spelled as a name.
 */
export async function isSafeFaviconUrl (url: string, pageUrl: string, resolveHost: Resolver): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // Two opaque origins are distinct per the URL spec even for identical
  // URLs, so the literal "null" must never compare equal to itself here --
  // a file: candidate must not ride a file: page's opaque origin through.
  // An unparseable pageUrl cannot vouch for anything either, so both fall
  // through to the origin-blind gates below.
  try {
    if (parsed.origin !== 'null' && parsed.origin === new URL(pageUrl).origin) return true
  } catch {
    // fall through
  }

  const host = parsed.hostname
  if (isLoopbackHost(host)) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackPage(pageUrl)
  }

  if (parsed.protocol !== 'https:') return false
  if (classifyAddress(host) !== 'unparseable') return isPublicUnicast(host)

  let answers: readonly string[]
  try {
    answers = await resolveHost(host)
  } catch {
    return false // could not resolve -- fails closed, same as a fetch failure
  }
  if (answers.length === 0) return false
  return answers.every((answer) => isPublicUnicast(answer))
}

/**
 * The one function here that touches the network. Returns null on any
 * failure (offline, timeout, oversized, wrong type, or T12 refusal) --
 * never throws by contract, matching update-check-runner.ts's
 * fetchLatestGithubRelease.
 */
export async function fetchFaviconDataUrl (url: string, pageUrl: string): Promise<string | null> {
  if (!(await isSafeFaviconUrl(url, pageUrl, electronResolveHost))) return null
  return await fetchUnchecked(url)
}

/** The fetch itself, with the T12 gate already cleared by the caller. Split
 * out so the cached path can run that gate exactly once per call instead of
 * either skipping it on a cache hit or resolving the same hostname twice. */
async function fetchUnchecked (url: string): Promise<string | null> {
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

  // A truncated body against a declared Content-Length, or malformed
  // chunked framing, errors the stream mid-read: reader.read() rejects,
  // which readCapped propagates. Caught here so this function's own "never
  // throws" contract (above) actually holds -- without this, an attacker-
  // controlled favicon host could turn a visited page into an unhandled
  // rejection at the caller.
  try {
    const bytes = await readCapped(response.body, MAX_FAVICON_BYTES)
    if (bytes === null) return null

    return toDataUrl(bytes, response.headers.get('content-type'))
  } catch {
    return null
  }
}

/** In-memory only, unbounded for the process's lifetime -- acceptable
 * for a single browsing session (this codebase's existing "v0, revisit
 * later" tolerance; see e.g. update-check.ts's own scope notes). Only
 * successful fetches are cached, so a temporarily-down favicon host is
 * retried on the next visit rather than staying null forever. */
const faviconCache = new Map<string, string>()

export async function fetchFaviconDataUrlCached (url: string, pageUrl: string): Promise<string | null> {
  // The gate runs BEFORE the cache is consulted, not just on a miss: whether
  // a favicon may be fetched now depends on which page is asking (a loopback
  // icon is allowed for a loopback page and refused for a public one), so a
  // hit left ungated would be a way straight around that condition.
  if (!(await isSafeFaviconUrl(url, pageUrl, electronResolveHost))) return null

  const cached = faviconCache.get(url)
  if (cached !== undefined) return cached

  const result = await fetchUnchecked(url)
  if (result !== null) faviconCache.set(url, result)
  return result
}

/** The mutable favicon slice of a tab record. `TabRecord` (tab-types.ts)
 * satisfies this structurally, so nothing has to adapt it. */
export interface FaviconTarget {
  favicon: string | null
  faviconOrigin: string | null
  pendingFaviconUrl: string | null
}

/** Fetches the favicon for the first http(s) candidate in `favicons` and
 * stores it on `target`, unless the tab has since closed or moved on to a
 * different icon.
 *
 * `isStillCurrent` is evaluated AFTER the await, never before: that is the
 * whole point of it. A fetch resolving once the tab has closed, or once a
 * newer icon was requested, must not win. `pageUrl` is read at call time for
 * the same reason -- 'page-favicon-updated' fires for the document currently
 * committed in the view, and that document is what decides whether a
 * loopback candidate may be fetched at all (isSafeFaviconUrl).
 */
export async function captureFaviconInto (
  target: FaviconTarget,
  favicons: readonly string[],
  pageUrl: () => string,
  isStillCurrent: () => boolean,
  onUpdated: () => void
): Promise<void> {
  const sourceUrl = pickFaviconUrl(favicons)
  if (sourceUrl === null) return

  target.pendingFaviconUrl = sourceUrl
  const dataUrl = await fetchFaviconDataUrlCached(sourceUrl, pageUrl())

  if (!isStillCurrent() || target.pendingFaviconUrl !== sourceUrl) return
  if (dataUrl === null) return

  target.favicon = dataUrl
  try {
    target.faviconOrigin = new URL(sourceUrl).origin
  } catch {
    target.faviconOrigin = null
  }
  onUpdated()
}

