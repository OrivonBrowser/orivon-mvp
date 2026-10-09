// What an app is served from between its person saying yes and its files being pinned: the same handler shape
// as a pinned app's (serve.ts), answering from the app's own host instead of the disk. Every same-origin request is
// resolved against the files the manifest lists, so the page can reach what a pinned app could and nothing more.
// For an app a verifier serves, the request names the leaf the app's declared tree gives the file and the verifier
// sends it only once it hashed to it. For an app on an ordinary host the handler fetches the file itself, from
// main and never through itself, holds it whole, hashes it with the same leaf function and delivers those very
// bytes, so the page runs exactly what was checked. A file that did not match, or content the verifier proved is
// not what its address names, is bad data: the request fails, nothing more of the origin is served, and the block
// is raised once. A failure to get a file is only a failed load. Third-party requests go through the same reach
// gate as a pinned app's.

import { MAX_ASSET_BYTES } from '../../broker/policy/bundle-hash.js'
import { MANIFEST_PATH } from '../../broker/policy/canonical-path.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { Manifest } from '../../contracts/index.js'
import type { DdocDeclaration } from '../ddoc-declaration.js'
import { entryCanonicalPath } from '../fetch/bundle.js'
import { CONTENT_ROOT_HEADER, DDOC_MISMATCH, EXPECT_LEAF_HEADER, FAILURE_HEADER } from '../fetch/content-root.js'
import { leafOf } from '../leaf-hash.js'
import { createRedirectChains } from '../reach/redirects.js'
import type { ReleaseReachSlot, ReserveReachSlot } from '../reach/guard.js'
import { policyHeaders } from './asset.js'
import { contentTypeFor } from './content-type.js'
import { ByteReserve } from './byte-reserve.js'
import { isNavigationRequest, resolveRequestPath } from './path.js'
import { parseRange } from './range.js'
import { fetchThirdParty } from './serve.js'
import type { AppRequestHandler, AuthoriseReach, GrantedConnectPatterns, GrantedMediaSources, GrantedSecurePatterns, ReachDial, ReachOptions, RecordPinCoverage } from './serve.js'

/** What the block needs to name: the files that differ, or why the content could not be verified at all. */
export interface BadData {
  readonly differing: readonly string[]
  readonly invalid?: string
}

/** What a fetch of one file of the app's own host answers with: a `Response`, or what the loader's own `Fetch` returns. */
export interface UpstreamResponse {
  readonly status: number
  readonly headers?: { readonly get: (name: string) => string | null } | undefined
  readonly body: ReadableStream<Uint8Array> | null
}

export type FetchUpstream = (url: string, init: { readonly method: string, readonly headers: Record<string, string>, readonly signal: AbortSignal }) => Promise<UpstreamResponse>

/** How many bytes of files held whole, for a leaf to be computed over them, one handler has in flight at once. */
const HELD_BYTES = 96 * 1024 * 1024
/** How long a file waits for room in that, and so for the files beside it to be done. */
const HELD_WAIT_MS = 10_000

export interface LiveServeDeps {
  readonly origin: string
  readonly manifest: Manifest
  /** The tree the site declares, or `undefined` when it declares none: its files are then let through on Orivon's own checks. */
  readonly declaration: DdocDeclaration | undefined
  /** The root the manifest was read from; every request to the verifier names it, so a name that moved fails rather than mixing two releases. */
  readonly content: string | undefined
  /** One request to the verifier's server for this origin, which checks the leaf itself: set for an app a verifier serves. */
  readonly fetchVerified?: FetchUpstream | undefined
  /** One request to the app's own ordinary host, from main: set for an app on an ordinary site, whose files this handler checks itself. */
  readonly fetchNetwork?: FetchUpstream | undefined
  readonly onBadData: (found: BadData) => void
  /** The name this app is served at now leads somewhere else than the root it was allowed at: an update, not bad data. Called once. */
  readonly onMoved?: (() => void) | undefined
  /** The first file was delivered: the app is in use. Called once. */
  readonly onServed?: (() => void) | undefined
  readonly grantedConnectPatterns?: GrantedConnectPatterns | undefined
  readonly grantedSecurePatterns?: GrantedSecurePatterns | undefined
  readonly grantedMediaSources?: GrantedMediaSources | undefined
  readonly authoriseReach?: AuthoriseReach | undefined
  readonly reachDial?: ReachDial | undefined
  readonly recordCoverage?: RecordPinCoverage | undefined
  readonly reserveReachSlot?: ReserveReachSlot | undefined
  readonly releaseReachSlot?: ReleaseReachSlot | undefined
}

/** What a caller hands over to have an origin served live: the rest of `LiveServeDeps` is the shell's. */
export type LiveBundle = Pick<LiveServeDeps, 'origin' | 'manifest' | 'declaration' | 'content' | 'fetchNetwork' | 'onBadData' | 'onMoved' | 'onServed'>

/** What a caller says it wants to hear of an app served live. */
export type LiveHooks = Pick<LiveServeDeps, 'onBadData' | 'onMoved' | 'onServed'>

function denyResponse (reason: string, status = 404): Response {
  return new Response(`Orivon: ${reason}`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export function createLiveRequestHandler (deps: LiveServeDeps): AppRequestHandler {
  const { origin, manifest, declaration } = deps
  const entryPath = entryCanonicalPath(origin, manifest.entry)
  const leaves = new Map(declaration?.leaves.map(({ path, leaf }) => [path, leaf]))
  const listed = new Set<string>([MANIFEST_PATH])
  if (entryPath !== null) listed.add(entryPath)
  for (const asset of manifest.assets ?? []) {
    const path = entryCanonicalPath(origin, asset)
    if (path !== null) listed.add(path)
  }
  const files = { assets: [...listed].map((path) => ({ path, leaf: leaves.get(path) ?? '' })) }
  const reachOptions: ReachOptions = { appOrigin: origin, redirects: createRedirectChains() }
  const held = new ByteReserve(HELD_BYTES)
  let ended = false
  let served = false

  const block = (found: BadData): Response => {
    if (!ended) {
      ended = true
      deps.onBadData(found)
    }
    return Response.error()
  }

  const moved = (): Response => {
    if (!ended) {
      ended = true
      deps.onMoved?.()
    }
    return Response.error()
  }

  /** The headers a pinned response carries, with the file's type taken from its path, never from the host. */
  const answerHeaders = async (path: string): Promise<Record<string, string>> => {
    const [connectPatterns, securePatterns, media] = await Promise.all([
      deps.grantedConnectPatterns?.() ?? [],
      deps.grantedSecurePatterns?.() ?? [],
      deps.grantedMediaSources?.() ?? {}
    ])
    return { 'content-type': contentTypeFor(path), 'accept-ranges': 'bytes', ...policyHeaders(connectPatterns, securePatterns, manifest.crossOriginIsolated === true, media) }
  }

  const delivered = (length: number | undefined): void => {
    deps.recordCoverage?.('pinned', length)
    if (!served) {
      served = true
      deps.onServed?.()
    }
  }

  /** A file of the app's own host held whole, hashed, and only then delivered: those bytes, and no others, reach the page. */
  async function checkedHere (fetchUpstream: FetchUpstream, request: Request, path: string, expected: string): Promise<Response> {
    let upstream: UpstreamResponse
    try {
      upstream = await fetchUpstream(`${origin}${path}`, { method: 'GET', headers: {}, signal: request.signal })
    } catch {
      return failedLoad()
    }
    if (upstream.status >= 500) { void upstream.body?.cancel().catch(() => {}); return failedLoad() }
    if (upstream.status !== 200) return refused(path, upstream)
    const declared = Number(upstream.headers?.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) { void upstream.body?.cancel().catch(() => {}); return block({ differing: [path] }) }
    const chunks: Uint8Array[] = []
    let total = 0
    let reserved = 0
    try {
      const reader = upstream.body?.getReader()
      for (;;) {
        const next = await reader?.read()
        if (next === undefined || next.done) break
        if (!await held.take(next.value.length, HELD_WAIT_MS)) { await reader?.cancel().catch(() => {}); return failedLoad() }
        reserved += next.value.length
        total += next.value.length
        // A file past what an app may carry cannot be the declared one.
        if (total > MAX_ASSET_BYTES) { await reader?.cancel().catch(() => {}); return block({ differing: [path] }) }
        chunks.push(next.value)
      }
    } catch {
      held.give(reserved)
      return failedLoad()
    }
    try {
      let found: string
      try {
        found = await leafOf(path, total, chunks)
      } catch {
        return block({ differing: [path] })
      }
      if (found !== expected) return block({ differing: [path] })
      const range = parseRange(request.headers.get('range'), total)
      const headers = await answerHeaders(path)
      if (range.kind === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${String(total)}` } })
      const { start, end } = range.kind === 'none' ? { start: 0, end: total - 1 } : range.range
      const body = new Uint8Array(Math.max(0, end - start + 1))
      let at = 0
      let from = 0
      for (const chunk of chunks) {
        const lo = Math.max(start - from, 0)
        const hi = Math.min(end + 1 - from, chunk.length)
        if (lo < hi) { body.set(chunk.subarray(lo, hi), at); at += hi - lo }
        from += chunk.length
      }
      delivered(body.length)
      const sent = { ...headers, 'content-length': String(body.length) }
      const head = request.method === 'HEAD'
      if (range.kind === 'none') return new Response(head ? null : body, { status: 200, headers: sent })
      return new Response(head ? null : body, { status: 206, headers: { ...sent, 'content-range': `bytes ${String(start)}-${String(end)}/${String(total)}` } })
    } finally {
      held.give(reserved)
    }
  }

  /** The host could not be reached or said it is unwell: the page sees a failed load, and nothing is judged. */
  const failedLoad = (): Response => {
    deps.recordCoverage?.('denied')
    return Response.error()
  }

  const refused = (path: string, upstream: UpstreamResponse): Response => {
    void upstream.body?.cancel().catch(() => {})
    deps.recordCoverage?.('denied')
    return denyResponse(`${path} was not served (${String(upstream.status)})`, upstream.status)
  }

  /** A file passed on as it came, its bytes checked before they were sent (a verifier) or not checked at all (a site that declares no tree). */
  async function passedOn (fetchUpstream: FetchUpstream, request: Request, path: string, headers: Record<string, string>, verifier: boolean): Promise<Response> {
    const range = request.headers.get('range')
    if (range !== null) headers['range'] = range
    const head = request.method === 'HEAD'
    let upstream: UpstreamResponse
    try {
      upstream = await fetchUpstream(`${origin}${path}`, { method: head ? 'HEAD' : 'GET', headers, signal: request.signal })
    } catch {
      return failedLoad()
    }
    if (verifier) {
      const failure = upstream.headers?.get(FAILURE_HEADER) ?? null
      if (failure === DDOC_MISMATCH) { void upstream.body?.cancel().catch(() => {}); return block({ differing: [path] }) }
      if (failure === 'unverifiable') { void upstream.body?.cancel().catch(() => {}); return block({ differing: [], invalid: `${path} is not what its address names` }) }
      if (upstream.status === 409) { void upstream.body?.cancel().catch(() => {}); return moved() }
    }
    // A host that is unwell, or a gateway that lied with no honest one to say so, is a failed load of this file.
    if (upstream.status >= 500) { void upstream.body?.cancel().catch(() => {}); return failedLoad() }
    if (upstream.status !== 200 && upstream.status !== 206) return refused(path, upstream)
    const out = await answerHeaders(path)
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers?.get(name) ?? null
      if (value !== null) out[name] = value
    }
    const length = Number(out['content-length'])
    delivered(Number.isFinite(length) ? length : undefined)
    return new Response(head ? null : upstream.body, { status: upstream.status, headers: out })
  }

  return async (request) => {
    if (originFromUrl(request.url) !== origin) {
      return await fetchThirdParty(request, deps.authoriseReach, deps.reachDial, deps.recordCoverage, deps.reserveReachSlot, deps.releaseReachSlot, reachOptions)
    }
    if (ended) return denyResponse('this app was stopped')
    const resolved = resolveRequestPath(entryPath, files, request.url, isNavigationRequest(request))
    if (!resolved.ok) {
      deps.recordCoverage?.('denied')
      return denyResponse(resolved.reason)
    }
    if ('redirectTo' in resolved) return new Response(null, { status: 302, headers: { location: resolved.redirectTo } })

    const path = resolved.canonicalPath
    const expected = leaves.get(path)
    // The manifest lists a file the declared tree does not: the tree describes other files than this app has.
    if (declaration !== undefined && expected === undefined) return block({ differing: [path] })

    if (deps.fetchNetwork !== undefined) {
      return expected === undefined
        ? await passedOn(deps.fetchNetwork, request, path, {}, false)
        : await checkedHere(deps.fetchNetwork, request, path, expected)
    }
    if (deps.fetchVerified === undefined) return denyResponse('this app has nowhere to be served from')
    const headers: Record<string, string> = {}
    if (deps.content !== undefined) headers[CONTENT_ROOT_HEADER] = deps.content
    if (expected !== undefined) headers[EXPECT_LEAF_HEADER] = expected
    return await passedOn(deps.fetchVerified, request, path, headers, true)
  }
}
