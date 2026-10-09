// What an app is served from between its person saying yes and its files being pinned: the same handler shape
// as a pinned app's (serve.ts), answering from the app's own host instead of the disk. Every same-origin request is
// resolved against the files the manifest lists, so the page can reach what a pinned app could and nothing more.
// For an app a verifier serves, the request names the leaf the app's declared tree gives the file and the verifier
// sends it only once it hashed to it. For an app on an ordinary host the handler fetches the file itself, from
// main and never through itself, holds it whole, hashes it with the same leaf function and delivers those very
// bytes, so the page runs exactly what was checked. A file that did not match, or content the verifier proved is
// not what its address names, is bad data: the request fails, nothing more of the origin is served, and the block
// is raised once. A failure to get a file is only a failed load. A file that is not the one the allowed tree names
// may be the next version of the app: the handler asks for the current manifest and tree, and bytes that match
// those are a new version, adopted, never bad data. Third-party requests go through the same reach gate as a
// pinned app's.

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

/** One version of an app: what the person was asked about and the tree its site declared for it. */
export interface LiveVersion {
  readonly manifest: Manifest
  /** `undefined` when the site declares no tree: its files are then let through on Orivon's own checks. */
  readonly declaration: DdocDeclaration | undefined
  /** The root the manifest was read from; every request to the verifier names it, so a name that moved is told apart from bad data. */
  readonly content: string | undefined
}

export interface LiveServeDeps extends LiveVersion {
  readonly origin: string
  /** One request to the verifier's server for this origin, which checks the leaf itself: set for an app a verifier serves. */
  readonly fetchVerified?: FetchUpstream | undefined
  /** One request to the app's own ordinary host, from main: set for an app on an ordinary site, whose files this handler checks itself. */
  readonly fetchNetwork?: FetchUpstream | undefined
  readonly onBadData: (found: BadData) => void
  /**
   * The version of the app that is current now, read afresh, or `undefined` when it is the one `since` names (the one being
   * served) or cannot be read. Asked when a name no longer leads to the root asked for, and when a file is not the one the tree names.
   */
  readonly fresh?: ((since: LiveVersion) => Promise<LiveVersion | undefined>) | undefined
  /** A newer version is about to be served: what must follow from it (its manifest registered, its consent kept) is done before this resolves. */
  readonly adopt?: ((version: LiveVersion) => Promise<void>) | undefined
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
export type LiveBundle = Pick<LiveServeDeps, 'origin' | 'manifest' | 'declaration' | 'content' | 'fetchNetwork' | 'onBadData' | 'fresh' | 'adopt' | 'onServed'>

/** What a caller says it wants to hear of an app served live. */
export type LiveHooks = Pick<LiveServeDeps, 'onBadData' | 'fresh' | 'adopt' | 'onServed'>

function denyResponse (reason: string, status = 404): Response {
  return new Response(`Orivon: ${reason}`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** What a version is served by: where its entry is, and the files its manifest lists with the leaves its tree gives them. */
function derive (origin: string, version: LiveVersion): { readonly entryPath: string | null, readonly leaves: ReadonlyMap<string, string>, readonly files: { readonly assets: ReadonlyArray<{ readonly path: string, readonly leaf: string }> } } {
  const entryPath = entryCanonicalPath(origin, version.manifest.entry)
  const leaves = new Map(version.declaration?.leaves.map(({ path, leaf }) => [path, leaf]))
  const listed = new Set<string>([MANIFEST_PATH])
  if (entryPath !== null) listed.add(entryPath)
  for (const asset of version.manifest.assets ?? []) {
    const path = entryCanonicalPath(origin, asset)
    if (path !== null) listed.add(path)
  }
  return { entryPath, leaves, files: { assets: [...listed].map((path) => ({ path, leaf: leaves.get(path) ?? '' })) } }
}

export function createLiveRequestHandler (deps: LiveServeDeps): AppRequestHandler {
  const { origin } = deps
  let version: LiveVersion = { manifest: deps.manifest, declaration: deps.declaration, content: deps.content }
  let state = derive(origin, version)
  const reachOptions: ReachOptions = { appOrigin: origin, redirects: createRedirectChains() }
  const held = new ByteReserve(HELD_BYTES)
  let ended = false
  let served = false
  let looking: Promise<LiveVersion | undefined> | undefined
  const adopting = new Map<LiveVersion, Promise<void>>()
  /** Versions the person was asked about and kept the current one: never served, never asked about again. */
  const declined = new Set<LiveVersion>()

  const block = (found: BadData): Response => {
    if (!ended) {
      ended = true
      deps.onBadData(found)
    }
    return Response.error()
  }

  /** The current version, read afresh once however many requests ask at the same time. */
  const current = async (): Promise<LiveVersion | undefined> => {
    looking ??= (deps.fresh?.(version) ?? Promise.resolve(undefined)).catch(() => undefined).finally(() => { looking = undefined })
    return await looking
  }

  /** Serves `next` from now on, once what must follow from it is done. */
  const adopt = async (next: LiveVersion): Promise<void> => {
    if (version === next) return
    let doing = adopting.get(next)
    if (doing === undefined) {
      doing = (async () => {
        await deps.adopt?.(next)
        version = next
        state = derive(origin, next)
      })()
      adopting.set(next, doing)
    }
    await doing
  }

  /** Whether `next` is served from now on: it is not when the person kept the current version, which is then a failed load, never bad data. */
  const follow = async (next: LiveVersion): Promise<boolean> => {
    if (declined.has(next)) return false
    try {
      await adopt(next)
      return true
    } catch {
      declined.add(next)
      return false
    }
  }

  /** The headers a pinned response carries, with the file's type taken from its path, never from the host. */
  const answerHeaders = async (path: string, manifest: Manifest): Promise<Record<string, string>> => {
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

  /** The bytes of a file answered, as the range asked for. */
  const answered = async (request: Request, path: string, manifest: Manifest, chunks: readonly Uint8Array[], total: number): Promise<Response> => {
    const range = parseRange(request.headers.get('range'), total)
    const headers = await answerHeaders(path, manifest)
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
  }

  /**
   * A file of the app's own host held whole, hashed, and only then delivered: those bytes, and no others, reach the page.
   * Bytes that are not the declared ones may be the next version's: they are bad data only if the current tree does not name them.
   */
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
      if (found === expected) return await answered(request, path, version.manifest, chunks, total)
      const next = await current()
      const nextState = next === undefined ? undefined : derive(origin, next)
      if (next === undefined || nextState === undefined || nextState.leaves.get(path) !== found || !nextState.files.assets.some((asset) => asset.path === path)) return block({ differing: [path] })
      if (!await follow(next)) return failedLoad()
      return await answered(request, path, next.manifest, chunks, total)
    } finally {
      held.give(reserved)
    }
  }

  /** A file passed on as it came, its bytes checked before they were sent (a verifier) or not checked at all (a site that declares no tree). */
  async function passedOn (fetchUpstream: FetchUpstream, request: Request, path: string, headers: Record<string, string>, verifier: boolean, started: LiveVersion, retry: () => Promise<Response>): Promise<Response> {
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
      if (upstream.status === 409) {
        // The name leads to another root than the one this version was read from: the app's next version, if it can be read.
        void upstream.body?.cancel().catch(() => {})
        const next = version !== started ? version : await current()
        if (next === undefined || !await follow(next)) return failedLoad()
        return await retry()
      }
    }
    // A host that is unwell, or a gateway that lied with no honest one to say so, is a failed load of this file.
    if (upstream.status >= 500) { void upstream.body?.cancel().catch(() => {}); return failedLoad() }
    if (upstream.status !== 200 && upstream.status !== 206) return refused(path, upstream)
    const out = await answerHeaders(path, started.manifest)
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers?.get(name) ?? null
      if (value !== null) out[name] = value
    }
    const length = Number(out['content-length'])
    delivered(Number.isFinite(length) ? length : undefined)
    return new Response(head ? null : upstream.body, { status: upstream.status, headers: out })
  }

  async function serve (request: Request, again: boolean): Promise<Response> {
    const started = version
    const { entryPath, leaves, files } = state
    const resolved = resolveRequestPath(entryPath, files, request.url, isNavigationRequest(request))
    if (!resolved.ok) {
      deps.recordCoverage?.('denied')
      return denyResponse(resolved.reason)
    }
    if ('redirectTo' in resolved) return new Response(null, { status: 302, headers: { location: resolved.redirectTo } })

    const path = resolved.canonicalPath
    const expected = leaves.get(path)
    // The manifest lists a file the declared tree does not: the tree describes other files than this app has.
    if (started.declaration !== undefined && expected === undefined) return block({ differing: [path] })

    if (deps.fetchNetwork !== undefined) {
      return expected === undefined
        ? await passedOn(deps.fetchNetwork, request, path, {}, false, started, async () => await serve(request, true))
        : await checkedHere(deps.fetchNetwork, request, path, expected)
    }
    if (deps.fetchVerified === undefined) return denyResponse('this app has nowhere to be served from')
    const headers: Record<string, string> = {}
    if (started.content !== undefined) headers[CONTENT_ROOT_HEADER] = started.content
    if (expected !== undefined) headers[EXPECT_LEAF_HEADER] = expected
    return await passedOn(deps.fetchVerified, request, path, headers, true, started, async () => again ? failedLoad() : await serve(request, true))
  }

  return async (request) => {
    if (originFromUrl(request.url) !== origin) {
      return await fetchThirdParty(request, deps.authoriseReach, deps.reachDial, deps.recordCoverage, deps.reserveReachSlot, deps.releaseReachSlot, reachOptions)
    }
    if (ended) return denyResponse('this app was stopped')
    return await serve(request, false)
  }
}
