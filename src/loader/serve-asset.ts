// One same-origin asset, streamed off disk into a Response -- split out of
// serve.ts (Rule 2). A request costs the bytes it sends: a Range request
// reads only its slice, and no asset is ever held whole in memory. See
// README.md's Design notes for the retained-file check and why its verdict
// is kept per file identity.

import type { Pattern } from '../contracts/index.js'
import { leafOf } from './leaf-hash.js'
import { contentTypeFor } from './serve-content-type.js'
import { cspHeaderValue } from './serve-csp.js'
import { parseRange } from './serve-range.js'
import type { LoaderStorage, OpenedAsset } from './storage.js'

/** Per-handler memo of retained-file checks: canonical path -> the file identity and pinned leaf checked, and the verdict. */
export type RetainedVerdicts = Map<string, { readonly key: string, readonly intact: Promise<boolean> }>

export type ServableAsset =
  | { readonly ok: true, readonly asset: OpenedAsset }
  | { readonly ok: false, readonly reason: string }

/**
 * A retained file is hashed once per identity; a rewrite changes its
 * identity and is checked again. The verdict is a shared promise, so
 * concurrent first requests hash it once between them.
 */
async function isRetainedIntact (asset: OpenedAsset, canonicalPath: string, leaf: string, verdicts: RetainedVerdicts): Promise<boolean> {
  const key = `${asset.identity}|${leaf}`
  const cached = verdicts.get(canonicalPath)
  if (cached?.key === key) return await cached.intact
  const intact = leafOf(canonicalPath, asset.byteLength, asset.read(0, asset.byteLength - 1))
    .then((found) => found === leaf, () => false)
  verdicts.set(canonicalPath, { key, intact })
  return await intact
}

/**
 * Opens `canonicalPath` for serving. A pinned path is trusted as the
 * handler's whole-tree check left it; `retainedLeaf`, set for a previous
 * version's file, must still match before a byte is served.
 */
export async function openServable (
  storage: LoaderStorage,
  origin: string,
  canonicalPath: string,
  retainedLeaf: string | undefined,
  verdicts: RetainedVerdicts
): Promise<ServableAsset> {
  const asset = await storage.openAsset(origin, canonicalPath)
  if (asset === undefined) {
    // The handler's whole-tree check read every pinned asset when it was
    // built, so the file was removed during this run.
    return { ok: false, reason: 'cached asset became unavailable after this app was loaded' }
  }
  if (retainedLeaf !== undefined && !await isRetainedIntact(asset, canonicalPath, retainedLeaf, verdicts)) {
    await asset.close()
    return { ok: false, reason: 'a previous version\'s file no longer matches what was pinned' }
  }
  return { ok: true, asset }
}

/** Bytes `start`..`end` of `asset` as a body; the asset is closed when the body ends, fails or is cancelled. */
function bodyOf (asset: OpenedAsset, start: number, end: number): ReadableStream<Uint8Array> {
  const chunks = asset.read(start, end)[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull (controller) {
      try {
        const next = await chunks.next()
        if (next.done === true) {
          controller.close()
          await asset.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        controller.error(error)
        await asset.close()
      }
    },
    async cancel () {
      await chunks.return?.()
      await asset.close()
    }
  })
}

/**
 * Turns `asset` into the actual `Response`, honouring a `Range` request, and
 * takes ownership of it: it is closed with the body, or at once when no body
 * is sent.
 *
 * CSP LIVES HERE, NOT IN `onHeadersReceived` -- A110 (docs/open-questions.md)
 * confirmed that listener never fires for a `protocol.handle`-served
 * response in this Electron version. The caller supplies fresh patterns on
 * every call rather than caching them across requests. Set on every served
 * asset, not only the entry document: a worker script served through this
 * same handler inherits its OWN response's CSP, never the document's.
 */
export async function buildResponse (
  asset: OpenedAsset,
  canonicalPath: string,
  rangeHeader: string | null,
  connectPatterns: readonly Pattern[],
  securePatterns: readonly Pattern[]
): Promise<Response> {
  const csp = cspHeaderValue(connectPatterns, securePatterns)
  const total = asset.byteLength
  const range = parseRange(rangeHeader, total)

  if (range.kind === 'unsatisfiable') {
    await asset.close()
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes', 'content-security-policy': csp } })
  }

  const contentType = contentTypeFor(canonicalPath)
  if (range.kind === 'none') {
    return new Response(bodyOf(asset, 0, total - 1), {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(total), 'accept-ranges': 'bytes', 'content-security-policy': csp }
    })
  }

  const { start, end } = range.range
  return new Response(bodyOf(asset, start, end), {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'content-security-policy': csp
    }
  })
}
