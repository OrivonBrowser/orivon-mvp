// What an app is served from between its person saying yes and its files being pinned: the same handler shape
// as a pinned app's (serve.ts), answering from the verifier instead of the disk. Every same-origin request is
// resolved against the files the manifest lists, so the page can reach what a pinned app could and nothing
// more, and is sent to the verifier naming the leaf the app's declared tree gives that file; the verifier
// sends the file only once it hashed to it. A file that did not, or content the verifier proved is not what its
// address names, is bad data: the request fails, nothing more of the origin is served, and the block is raised
// once. Third-party requests go through the same reach gate as a pinned app's.

import { MANIFEST_PATH } from '../../broker/policy/canonical-path.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { Manifest } from '../../contracts/index.js'
import type { DdocDeclaration } from '../ddoc-declaration.js'
import { entryCanonicalPath } from '../fetch/bundle.js'
import { CONTENT_ROOT_HEADER, DDOC_MISMATCH, EXPECT_LEAF_HEADER, FAILURE_HEADER } from '../fetch/content-root.js'
import { createRedirectChains } from '../reach/redirects.js'
import type { ReleaseReachSlot, ReserveReachSlot } from '../reach/guard.js'
import { policyHeaders } from './asset.js'
import { contentTypeFor } from './content-type.js'
import { isNavigationRequest, resolveRequestPath } from './path.js'
import { fetchThirdParty } from './serve.js'
import type { AppRequestHandler, AuthoriseReach, GrantedConnectPatterns, GrantedMediaSources, GrantedSecurePatterns, ReachDial, ReachOptions, RecordPinCoverage } from './serve.js'

/** What the block needs to name: the files that differ, or why the content could not be verified at all. */
export interface BadData {
  readonly differing: readonly string[]
  readonly invalid?: string
}

export interface LiveServeDeps {
  readonly origin: string
  readonly manifest: Manifest
  /** The tree the site declares, or `undefined` when it declares none: its files are then let through on Orivon's own checks. */
  readonly declaration: DdocDeclaration | undefined
  /** The root the manifest was read from; every request names it, so a name that moved fails rather than mixing two releases. */
  readonly content: string | undefined
  /** One request to the verifier's server for this origin. */
  readonly fetchVerified: (url: string, init: { readonly method: string, readonly headers: Record<string, string>, readonly signal: AbortSignal }) => Promise<Response>
  readonly onBadData: (found: BadData) => void
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
export type LiveBundle = Pick<LiveServeDeps, 'origin' | 'manifest' | 'declaration' | 'content' | 'onBadData'>

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
  let blocked = false

  const block = (found: BadData): Response => {
    if (!blocked) {
      blocked = true
      deps.onBadData(found)
    }
    return Response.error()
  }

  return async (request) => {
    if (originFromUrl(request.url) !== origin) {
      return await fetchThirdParty(request, deps.authoriseReach, deps.reachDial, deps.recordCoverage, deps.reserveReachSlot, deps.releaseReachSlot, reachOptions)
    }
    if (blocked) return denyResponse('this app was blocked: its files are not the ones it declared')
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

    const headers: Record<string, string> = {}
    if (deps.content !== undefined) headers[CONTENT_ROOT_HEADER] = deps.content
    if (expected !== undefined) headers[EXPECT_LEAF_HEADER] = expected
    const range = request.headers.get('range')
    if (range !== null) headers['range'] = range
    const head = request.method === 'HEAD'
    let upstream: Response
    try {
      upstream = await deps.fetchVerified(`${origin}${path}`, { method: head ? 'HEAD' : 'GET', headers, signal: request.signal })
    } catch (error) {
      deps.recordCoverage?.('denied')
      return denyResponse(`${path} could not be fetched: ${error instanceof Error ? error.message : String(error)}`, 502)
    }
    const failure = upstream.headers.get(FAILURE_HEADER)
    if (failure === DDOC_MISMATCH) {
      void upstream.body?.cancel().catch(() => {})
      return block({ differing: [path] })
    }
    if (failure === 'unverifiable') {
      void upstream.body?.cancel().catch(() => {})
      return block({ differing: [], invalid: `${path} is not what its address names` })
    }
    if (upstream.status !== 200 && upstream.status !== 206) {
      void upstream.body?.cancel().catch(() => {})
      deps.recordCoverage?.('denied')
      return denyResponse(`${path} was not served (${String(upstream.status)})`, upstream.status)
    }

    const [connectPatterns, securePatterns, media] = await Promise.all([
      deps.grantedConnectPatterns?.() ?? [],
      deps.grantedSecurePatterns?.() ?? [],
      deps.grantedMediaSources?.() ?? {}
    ])
    const out: Record<string, string> = {
      'content-type': contentTypeFor(path),
      'accept-ranges': 'bytes',
      ...policyHeaders(connectPatterns, securePatterns, manifest.crossOriginIsolated === true, media)
    }
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name)
      if (value !== null) out[name] = value
    }
    const length = Number(out['content-length'])
    deps.recordCoverage?.('pinned', Number.isFinite(length) ? length : undefined)
    return new Response(head ? null : upstream.body, { status: upstream.status, headers: out })
  }
}
