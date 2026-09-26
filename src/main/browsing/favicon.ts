// Real favicons for the tab strip -- see src/renderer/README.md for the
// feature, and README.md's Design notes here for why main fetches to
// data: rather than the renderer fetching directly, and for why this
// file's own fetch must clear T12 before it runs.
//
// Structure mirrors update-check.ts/update-check-runner.ts: pure parts
// exported and tested (faviconCandidates, isSafeFaviconUrl, readCapped,
// toDataUrl), the one real network call (fetchFaviconDataUrl) thin and
// defensive around it. net.request, not net.fetch -- redirects need
// per-hop T12 checks, the same reason loader/electron/fetch.ts's netFetch
// avoids net.fetch's own redirect handling -- imported dynamically -- same
// reasoning as update-check-runner.ts's file header: outside a real
// Electron process (i.e. under vitest), `electron`'s entry point is a path
// STRING, and a top-level import would silently bind `undefined` rather
// than throw.

import { Readable } from 'node:stream'
import { classifyAddress, isPublicUnicast } from '../../broker/policy/address.js'
import type { Resolver } from '../../broker/policy/connect.js'
import { isLoopbackHost } from '../../broker/policy/origin.js'
import { electronResolveHost } from '../../loader/electron/resolve.js'
import { decodeDataUrl, sniffImageType } from './favicon-format.js'

/** Generous enough for an SVG that embeds a raster image inline -- a real
 * shape (web3compass.net's own icons run 57 KiB doing exactly this), and
 * several times what any bitmap favicon format needs. */
export const MAX_FAVICON_BYTES = 128 * 1024
export const FAVICON_TIMEOUT_MS = 5_000
/** Real sites redirect a bare-domain icon URL to a `www` host, or move
 * `/favicon.ico` behind a CDN -- both cross-origin, both legitimate. Each
 * hop is re-checked by isSafeFaviconUrl, so this only bounds how long a
 * chain may run, the same role MAX_REDIRECTS plays in loader/electron/fetch.ts. */
export const MAX_FAVICON_REDIRECTS = 3
/** At most this many declared candidates are tried, in order, before giving
 * up -- `page-favicon-updated` can hand back several sizes/formats of the
 * same icon, and the first one to actually decode should win without an
 * unbounded number of fetches for one navigation. */
export const MAX_FAVICON_CANDIDATES = 4

/**
 * Every http(s) or `data:` URL out of `page-favicon-updated`'s candidate
 * list, in declared order, capped at MAX_FAVICON_CANDIDATES. Electron's own
 * event should only ever hand back real page-declared URLs, but every other
 * URL this codebase touches goes through an explicit scheme check
 * (omnibox.ts) rather than trusting the source -- defence in depth, not
 * paranoia about this specific event. A `data:` candidate carries no
 * network reach at all, so it needs no T12 gate downstream -- only decoding
 * and sniffing.
 */
export function faviconCandidates (candidates: readonly string[]): string[] {
  const out: string[] = []
  for (const candidate of candidates) {
    if (/^(?:https?|data):/i.test(candidate)) out.push(candidate)
    if (out.length === MAX_FAVICON_CANDIDATES) break
  }
  return out
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

/** `null` for anything sniffImageType doesn't recognise -- a favicon this
 * shell can't identify is treated the same as one that failed to load. The
 * type comes from the BYTES (favicon-format.ts), never from a server's own
 * `content-type` header: a mislabelled `.ico` or an SVG served with any
 * label at all both decode correctly once the header is no longer trusted. */
export function toDataUrl (bytes: Uint8Array): string | null {
  const type = sniffImageType(bytes)
  if (type === null) return null
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
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
 * classification loader/fetch/install-origin.ts and loader/electron/fetch.ts
 * already apply (classifyAddress/isPublicUnicast/isLocalhostName) and
 * the same resolver they use for a live Electron net.fetch
 * (loader/electron/resolve.ts's electronResolveHost, Chromium's own --
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

/** One hop's outcome: a real body, a redirect naming where to, or a failure
 * -- offline, timeout, a non-2xx status, an over-cap body, or a
 * truncated/malformed one (a declared Content-Length the stream falls
 * short of, or broken chunked framing, errors the reader mid-read). An
 * over-cap body is `failed`, not its own case: nothing downstream ever
 * treated "too big" differently from any other way a hop can fail. */
type HopResult = { kind: 'ok', bytes: Uint8Array } | { kind: 'redirect', location: string } | { kind: 'failed' }

/**
 * Issues exactly one request, with `url` already cleared by the caller --
 * never a redirect target, which this never follows itself: `redirect:
 * 'manual'` only reports one, and `followRedirect()` "can only be called
 * during a 'redirect' event" (electron.d.ts), which an async
 * isSafeFaviconUrl call cannot honour. The caller re-requests a validated
 * location fresh instead (fetchUnchecked, below). Never throws -- an
 * attacker-controlled favicon host must not turn a visited page into an
 * unhandled rejection at the caller.
 */
async function requestOnce (url: string, signal: AbortSignal): Promise<HopResult> {
  const { net } = await import('electron')

  return await new Promise<HopResult>((resolve) => {
    let settled = false
    const onAbort = (): void => { request.abort(); settle({ kind: 'failed' }) }
    // Removed on every settlement path, not only when the abort signal
    // itself fires: a hop that settles normally (redirect/ok/failed) has no
    // further use for it, and a fetch with several redirect hops would
    // otherwise leave one stale listener behind per hop -- each still live
    // when the shared timeout finally fires, all calling .abort() on their
    // own long-finished requests at once.
    const settle = (value: HopResult): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const request = net.request({ url, method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual' })
    request.on('redirect', (_status, _method, redirectUrl) => {
      // settle() BEFORE abort(), not after: aborting a request that is
      // still in flight can itself emit 'error' synchronously (the same
      // way a real cancelled request does), and the settled guard means
      // whichever call runs first wins -- an abort-triggered 'failed' must
      // never race ahead of the redirect outcome it was only meant to stop.
      settle({ kind: 'redirect', location: redirectUrl })
      request.abort()
    })
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) { settle({ kind: 'failed' }); return }
      const body = Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>
      readCapped(body, MAX_FAVICON_BYTES).then(
        (bytes) => { settle(bytes === null ? { kind: 'failed' } : { kind: 'ok', bytes }) },
        () => { settle({ kind: 'failed' }) }
      )
    })
    request.on('error', () => { settle({ kind: 'failed' }) })
    if (signal.aborted) { settle({ kind: 'failed' }); return }
    signal.addEventListener('abort', onAbort, { once: true })
    request.end()
  })
}

/**
 * The one function here that touches the network. Returns null on any
 * failure (offline, timeout, oversized, wrong type, T12 refusal on the
 * first hop or on any redirect target) -- never throws by contract,
 * matching update-check-runner.ts's fetchLatestGithubRelease.
 */
export async function fetchFaviconDataUrl (url: string, pageUrl: string): Promise<string | null> {
  if (!(await isSafeFaviconUrl(url, pageUrl, electronResolveHost))) return null
  return await fetchUnchecked(url, pageUrl)
}

/** The fetch itself, with the T12 gate already cleared by the caller for
 * `url` (its first hop). Split out so the cached path can run that gate
 * exactly once per call instead of either skipping it on a cache hit or
 * resolving the same hostname twice. One timeout budget covers the whole
 * redirect chain, not each hop separately -- a chain of fast redirects to a
 * slow final host should not get MAX_FAVICON_REDIRECTS times the budget. */
async function fetchUnchecked (url: string, pageUrl: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, FAVICON_TIMEOUT_MS)
  try {
    let current = url
    for (let hop = 0; hop <= MAX_FAVICON_REDIRECTS; hop++) {
      const result = await requestOnce(current, controller.signal)
      if (result.kind === 'failed') return null
      if (result.kind === 'ok') return toDataUrl(result.bytes)
      if (hop === MAX_FAVICON_REDIRECTS) return null
      if (!(await isSafeFaviconUrl(result.location, pageUrl, electronResolveHost))) return null
      current = result.location
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** In-memory only, unbounded for the process's lifetime -- acceptable
 * for a single browsing session (this codebase's existing "v0, revisit
 * later" tolerance; see e.g. update-check.ts's own scope notes). Only
 * successful fetches are cached, so a temporarily-down favicon host is
 * retried on the next visit rather than staying null forever. Keyed by the
 * candidate URL that was actually asked for, before any redirect -- a page
 * whose icon moves to a new location on its host is picked up again the
 * next time `page-favicon-updated` fires with a changed candidate list. */
const faviconCache = new Map<string, string>()

export async function fetchFaviconDataUrlCached (url: string, pageUrl: string): Promise<string | null> {
  // The gate runs BEFORE the cache is consulted, not just on a miss: whether
  // a favicon may be fetched now depends on which page is asking (a loopback
  // icon is allowed for a loopback page and refused for a public one), so a
  // hit left ungated would be a way straight around that condition.
  if (!(await isSafeFaviconUrl(url, pageUrl, electronResolveHost))) return null

  const cached = faviconCache.get(url)
  if (cached !== undefined) return cached

  const result = await fetchUnchecked(url, pageUrl)
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

/** A `data:` candidate needs no network and so no T12 gate -- only decoding
 * and the same byte-sniff every fetched candidate goes through (toDataUrl),
 * so a mislabelled or garbled `data:` icon is refused exactly like a
 * mislabelled network one, rather than trusted because it already claimed
 * to be an image. */
function decodedDataUrlCandidate (candidate: string): string | null {
  const bytes = decodeDataUrl(candidate, MAX_FAVICON_BYTES)
  return bytes === null ? null : toDataUrl(bytes)
}

/** Tries each candidate from `page-favicon-updated`, in order, and stores
 * the first one that actually decodes to a recognised image, unless the
 * tab has since closed or a newer icon set has arrived.
 *
 * `pageUrl` is read exactly ONCE, at the start -- it names the document
 * that fired this very `page-favicon-updated` event, which is both what
 * decides whether a loopback candidate may be fetched at all
 * (isSafeFaviconUrl) and whose origin gets recorded on a hit
 * (`faviconOrigin`, below). Re-reading it later, after a same-tab
 * navigation that didn't itself change the icon set, would attribute the
 * icon to the wrong page.
 *
 * `isStillCurrent`, `target.pendingFaviconUrl` AND `pageUrl()` are all
 * re-checked AFTER every await, never before: that is the whole point of
 * them. A fetch resolving once the tab has closed, once a newer icon set
 * has arrived (pendingFaviconUrl then points at a later candidate this same
 * call never chose), or once the tab has navigated on to a different page
 * that never fired its own `page-favicon-updated` (Chromium only fires it
 * when the favicon SET changes, so a page with no icon at all, or the same
 * icon, leaves `pendingFaviconUrl` untouched) -- must not win. Sequentially
 * trying up to MAX_FAVICON_CANDIDATES, each with its own fetch timeout and
 * redirect chain, made this last case a real window rather than a
 * theoretical one: a still-running call from the PREVIOUS page must never
 * write a favicon attributed to that old page onto a tab now showing a new
 * one, so `pageUrl()` -- read fresh, not the `declaringPage` captured at
 * the start -- has to still match before every write.
 *
 * `faviconOrigin` records the DECLARING PAGE's origin, never the icon
 * resource's own origin (a CDN, commonly) -- shouldClearFavicon and its own
 * test suite are built on that assumption: a same-origin navigation must
 * not clear an icon whose bytes happen to live elsewhere.
 */
export async function captureFaviconInto (
  target: FaviconTarget,
  favicons: readonly string[],
  pageUrl: () => string,
  isStillCurrent: () => boolean,
  onUpdated: () => void
): Promise<void> {
  const candidates = faviconCandidates(favicons)
  if (candidates.length === 0) return

  const declaringPage = pageUrl()
  const stillTheSamePage = (): boolean => isStillCurrent() && pageUrl() === declaringPage

  for (const candidate of candidates) {
    if (!stillTheSamePage()) return
    target.pendingFaviconUrl = candidate

    // Case-insensitively too: faviconCandidates' own scheme filter is
    // case-insensitive (a page may spell it `DATA:`), and a candidate that
    // qualified there must be decoded the same way here, never silently
    // fall through to a network fetch that can only ever refuse it (a
    // `data:` URL has no hostname, so isSafeFaviconUrl never accepts one).
    const dataUrl = /^data:/i.test(candidate)
      ? decodedDataUrlCandidate(candidate)
      : await fetchFaviconDataUrlCached(candidate, declaringPage)

    if (!stillTheSamePage() || target.pendingFaviconUrl !== candidate) return
    if (dataUrl === null) continue

    target.favicon = dataUrl
    try {
      target.faviconOrigin = new URL(declaringPage).origin
    } catch {
      target.faviconOrigin = null
    }
    onUpdated()
    return
  }
}

