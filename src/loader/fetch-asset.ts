// One declared asset, fetched straight into the origin's staging area and
// hashed from there -- never held whole in memory -- plus the bounded pool
// fetch-bundle.ts runs every asset through. Split out of fetch-bundle.ts
// (Rule 2): that file owns the bundle, this one owns a single leaf.

import { canonicalAssetPath } from '../broker/policy/canonical-path.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { fetchWithBudget, rejected } from './fetch-budget.js'
import type { ByteBudget, Fetch, FetchBundleRejected } from './fetch-budget.js'
import { leafOf } from './leaf-hash.js'
import type { LoaderStorage } from './storage.js'

/** Assets fetched at once, sharing one byte budget and one deadline. AI-recommended: a browser's own per-host connection limit is six. */
export const FETCH_CONCURRENCY = 4

/**
 * One leaf of a fetched bundle, waiting in the origin's staging area:
 * `staged` names its bytes to `LoaderStorage.readStaged`/`commitStaged`.
 * The bytes themselves are never carried in memory.
 */
export interface StagedAsset {
  readonly path: string
  readonly byteLength: number
  readonly leaf: string
  readonly staged: string
}

/** Everything every asset fetch of one bundle shares. */
export interface AssetFetchContext {
  readonly fetchFn: Fetch
  readonly canonicalOrigin: string
  readonly pinnedAddresses: readonly string[]
  readonly storage: LoaderStorage
  readonly budget: ByteBudget
  readonly assetCap: number
  readonly bundleSignal: AbortSignal
}

/**
 * `new URL(path, base)`, guarded: the constructor throws on a malformed
 * `path`, and nothing here may let that escape -- every rejection must come
 * back as a result. Exported for fetch-bundle.ts's own use (Rule 3).
 */
export function resolveUrl (path: string, base: string): string | null {
  try {
    return new URL(path, base).href
  } catch {
    return null
  }
}

/**
 * Streams `bytes` (already in hand, e.g. the manifest) into a staged file
 * and returns it as a StagedAsset -- the one place a leaf digest is paired
 * with a staged file, whichever way its bytes arrived.
 */
export async function stageBytes (storage: LoaderStorage, origin: string, path: string, bytes: Uint8Array): Promise<StagedAsset> {
  const writer = await storage.openStaged(origin)
  await writer.write(bytes)
  await writer.close()
  return { path, byteLength: bytes.length, leaf: await leafOf(path, bytes.length, [bytes]), staged: writer.id }
}

/** Extensions no host may legitimately answer with an HTML document. */
const NEVER_HTML = /\.(?:m?js|cjs|css|wasm|json)$/i

/**
 * True when a script, style, wasm or JSON asset came back as an HTML page:
 * an SPA host answers a missing file with `200` and its `index.html`, which
 * would otherwise be pinned under the script's name and fail at run time
 * with an opaque syntax error. Judged on `Content-Type`, and on the body's
 * first bytes for a host that sends none.
 */
function servedAsHtml (path: string, contentType: string | null, head: Uint8Array | undefined): boolean {
  if (!NEVER_HTML.test(path)) return false
  if (contentType !== null && contentType.split(';')[0]?.trim().toLowerCase() === 'text/html') return true
  const start = new TextDecoder().decode(head ?? new Uint8Array(0)).replace(/^\uFEFF/, '').trimStart().toLowerCase()
  return start.startsWith('<!doctype html') || start.startsWith('<html')
}

/**
 * Fetches one declared asset into staging. The origin check runs BEFORE any
 * request: `new URL(assetPath, base)` honours an absolute or
 * protocol-relative path ("https://attacker.example/x"), so without it a
 * crafted entry would trigger a real outbound request first. The canonical
 * path is the REQUESTED url's, never `response.url` (A141: real Electron's
 * net.fetch reports it as '' on every response) -- safe only because a
 * `Fetch` must never deliver a response from another origin (fetch-budget.ts,
 * `Fetch`'s own doc).
 */
export async function fetchAssetToStaging (ctx: AssetFetchContext, assetPath: string): Promise<StagedAsset | FetchBundleRejected> {
  const assetUrl = resolveUrl(assetPath, `${ctx.canonicalOrigin}/`)
  if (assetUrl === null) return rejected(`asset path is not a valid URL: ${assetPath}`)
  const requestedOrigin = originFromUrl(assetUrl)
  if (requestedOrigin !== ctx.canonicalOrigin) {
    return rejected(`asset ${assetPath} resolves to a different origin (${requestedOrigin ?? 'invalid'}) than the app's (${ctx.canonicalOrigin})`)
  }
  const canonicalPath = canonicalAssetPath(assetUrl)
  if (canonicalPath === null) return rejected(`asset ${assetPath} resolved to a URL with no canonical path: ${assetUrl}`)

  let writer
  try {
    writer = await ctx.storage.openStaged(ctx.canonicalOrigin)
  } catch (error) {
    console.error('[loader] could not open a staging file', ctx.canonicalOrigin, error)
    return rejected(`asset ${assetPath} could not be written to local storage`)
  }
  const label = `asset ${assetPath}`
  let head: Uint8Array | undefined
  const fetched = await fetchWithBudget(ctx.fetchFn, assetUrl, ctx.pinnedAddresses, ctx.assetCap, ctx.budget, label, ctx.bundleSignal,
    async (chunk) => { head ??= chunk.slice(0, 64); await writer.write(chunk) })
  try {
    await writer.close()
  } catch (error) {
    console.error('[loader] could not close a staging file', ctx.canonicalOrigin, error)
    if (!('ok' in fetched)) return rejected(`${label} could not be written to local storage`)
  }
  if ('ok' in fetched) return fetched
  if (servedAsHtml(canonicalPath, fetched.response.headers?.get('content-type') ?? null, head)) {
    return rejected(`${label} came back as an HTML page, not the file it names -- the host answers a missing file with its index page; declare only files it really serves`)
  }

  const stream = await ctx.storage.readStaged(ctx.canonicalOrigin, writer.id)
  if (stream === undefined) return rejected(`${label} could not be read back from local storage`)
  try {
    return { path: canonicalPath, byteLength: fetched.byteLength, leaf: await leafOf(canonicalPath, fetched.byteLength, stream.chunks), staged: writer.id }
  } catch (error) {
    console.error('[loader] could not hash a staged asset', ctx.canonicalOrigin, error)
    return rejected(`${label} could not be read back from local storage`)
  }
}

/**
 * Runs `work` over `items`, at most `limit` at once, in input order of
 * starting. Stops starting new items after the first rejection, calls
 * `onFailure` once so the caller can abort what is still in flight, and
 * returns that first rejection.
 */
export async function forEachBounded<T, R> (
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R | FetchBundleRejected>,
  onFailure: () => void
): Promise<R[] | FetchBundleRejected> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  let failure: FetchBundleRejected | undefined
  const lane = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next
      next += 1
      const outcome = await work(items[index] as T)
      if (typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok === false) {
        if (failure === undefined) {
          failure = outcome
          onFailure()
        }
        return
      }
      results[index] = outcome as R
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return failure ?? results
}
