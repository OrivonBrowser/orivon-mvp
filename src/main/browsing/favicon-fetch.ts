// Fetching a tab's icon -- see src/renderer/README.md for the
// feature, and README.md's Design notes here for why main fetches to
// data: rather than the renderer fetching directly, and for why this
// file's own fetch must clear T12 before it runs.
//
// Structure mirrors update-check.ts/update-check-runner.ts: pure parts
// exported and tested (isSafeFaviconUrl, readCapped), and
// one network entry point, fetchFaviconDataUrlCached, thin and defensive
// around them. net.request, not net.fetch -- redirects need
// per-hop T12 checks, the same reason loader/electron/fetch.ts's netFetch
// avoids net.fetch's own redirect handling -- imported dynamically -- same
// reasoning as update-check-runner.ts's file header: outside a real
// Electron process (i.e. under vitest), `electron`'s entry point is a path
// STRING, and a top-level import would silently bind `undefined` rather
// than throw.

import { Readable } from 'node:stream'
import type { Session } from 'electron'
import { classifyAddress, isPublicUnicast } from '../../broker/policy/address.js'
import type { Resolver } from '../../broker/policy/connect.js'
import { isLoopbackHost } from '../../broker/policy/origin.js'
import { electronResolveHost } from '../../loader/electron/resolve.js'
import { FaviconCache } from './favicon-cache.js'
import { MAX_FAVICON_BYTES, toDataUrl } from './favicon-format.js'
import { faviconTimeoutMs } from './favicon-timeout.js'

/** Real sites redirect a bare-domain icon URL to a `www` host, or move
 * `/favicon.ico` behind a CDN -- both cross-origin, both legitimate. Each
 * hop is re-checked by isSafeFaviconUrl, so this only bounds how long a
 * chain may run, the same role MAX_REDIRECTS plays in loader/electron/fetch.ts. */
export const MAX_FAVICON_REDIRECTS = 3

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
 * **Loopback is allowed, for a page that is itself on loopback.** A local
 * dev server is a real thing to browse here, and refusing its icon buys
 * nothing. `http` is allowed on that path too, because a local dev
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
async function requestOnce (url: string, signal: AbortSignal, session: Session | undefined): Promise<HopResult> {
  const { net } = await import('electron')

  return await new Promise<HopResult>((resolve) => {
    let settled = false
    const onAbort = (): void => { endWith({ kind: 'failed' }) }
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
    const request = net.request({ url, method: 'GET', credentials: 'omit', useSessionCookies: false, redirect: 'manual', ...(session === undefined ? {} : { session }) })
    // settle() BEFORE abort(), not after: aborting a request that is still
    // in flight can itself emit 'error' synchronously (the same way a real
    // cancelled request does), and the settled guard means whichever call
    // runs first wins -- an abort-triggered 'failed' must never race ahead
    // of the outcome it was only meant to stop.
    const endWith = (value: HopResult): void => { settle(value); request.abort() }
    request.on('redirect', (_status, _method, redirectUrl) => {
      endWith({ kind: 'redirect', location: redirectUrl })
    })
    // Every failure aborts too: nobody reads a failed hop's body, and
    // Electron's loader stays alive until it completes or is cancelled.
    // abort() on a request that already completed does nothing.
    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) { endWith({ kind: 'failed' }); return }
      const body = Readable.toWeb(response as unknown as Readable) as ReadableStream<Uint8Array>
      readCapped(body, MAX_FAVICON_BYTES).then(
        (bytes) => { if (bytes === null) endWith({ kind: 'failed' }); else settle({ kind: 'ok', bytes }) },
        () => { endWith({ kind: 'failed' }) }
      )
    })
    request.on('error', () => { settle({ kind: 'failed' }) })
    if (signal.aborted) { settle({ kind: 'failed' }); return }
    signal.addEventListener('abort', onAbort, { once: true })
    request.end()
  })
}

/** The session a hop is asked through: the page's own for its own origin, which answers an installed app from its
 * pin, as it answers the page; the default one for any other host, whose request an app's session would refuse
 * unless the app holds a grant for it. */
function sessionForHop (url: string, pageUrl: string, pageSession: Session | undefined): Session | undefined {
  try {
    const origin = new URL(url).origin
    return origin !== 'null' && origin === new URL(pageUrl).origin ? pageSession : undefined
  } catch {
    return undefined
  }
}

/** The fetch itself, with the T12 gate already cleared by the caller for
 * `url` (its first hop), so the cached path runs that gate exactly once
 * per call instead of either skipping it on a cache hit or resolving the
 * same hostname twice. One timeout budget covers the whole
 * redirect chain, not each hop separately -- a chain of fast redirects to a
 * slow final host should not get MAX_FAVICON_REDIRECTS times the budget. */
async function fetchUnchecked (url: string, pageUrl: string, pageSession: Session | undefined): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, faviconTimeoutMs(url))
  try {
    let current = url
    for (let hop = 0; hop <= MAX_FAVICON_REDIRECTS; hop++) {
      const result = await requestOnce(current, controller.signal, sessionForHop(current, pageUrl, pageSession))
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

/** faviconCache's bounds, provisional: room for a few hundred sites' icons,
 * not measured against real browsing. */
const MAX_CACHED_FAVICONS = 256
const MAX_CACHED_FAVICON_CHARS = 16 * 1024 * 1024

/** In memory only. Only successful fetches are cached, so a temporarily-down
 * favicon host is retried on the next visit rather than staying null. Keyed
 * by the candidate URL that was actually asked for, before any redirect -- a
 * page whose icon moves on its host is picked up again the next time
 * `page-favicon-updated` fires with a changed candidate list. */
const faviconCache = new FaviconCache(MAX_CACHED_FAVICONS, MAX_CACHED_FAVICON_CHARS)

/** The one exported function that reaches the network, answered from
 * faviconCache when it can be. Returns null on any failure (offline,
 * timeout, oversized, wrong type, T12 refusal on the first hop or on any
 * redirect target) -- never throws by contract, matching
 * update-check-runner.ts's fetchLatestGithubRelease. A result is cached only
 * if `stillWanted()` holds when it lands: a capture that has already been
 * dropped must not fill the cache. */
export async function fetchFaviconDataUrlCached (url: string, pageUrl: string, stillWanted: () => boolean, pageSession?: Session): Promise<string | null> {
  // The gate runs BEFORE the cache is consulted, not just on a miss: whether
  // a favicon may be fetched now depends on which page is asking (a loopback
  // icon is allowed for a loopback page and refused for a public one), so a
  // hit left ungated would be a way straight around that condition.
  if (!(await isSafeFaviconUrl(url, pageUrl, electronResolveHost))) return null

  const cached = faviconCache.get(url)
  if (cached !== undefined) return cached

  const result = await fetchUnchecked(url, pageUrl, pageSession)
  if (result !== null && stillWanted()) faviconCache.set(url, result)
  return result
}
