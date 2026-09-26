// One same-origin asset, streamed off disk into a Response -- split out of
// serve.ts (Rule 2). A request costs the bytes it sends: a Range request
// reads only its slice, and no asset is ever held whole in memory. See
// README.md's Design notes for the retained-file check and why its verdict
// is kept per file identity.

import type { Pattern } from '../../contracts/index.js'
import { leafOf } from '../leaf-hash.js'
import { contentTypeFor } from './content-type.js'
import { cspHeaderValue } from './csp.js'
import { parseRange } from './range.js'
import type { LoaderStorage, OpenedAsset } from '../cache/storage.js'

/** Per-handler memo of retained-file checks: canonical path -> the file identity and pinned leaf checked, and the verdict. */
export type RetainedVerdicts = Map<string, { readonly key: string, readonly intact: Promise<boolean> }>

/**
 * A file checked and ready to serve. No handle is held: the body reopens it
 * when first read and fails if its identity changed meanwhile, so a response
 * that is never read, or is only a HEAD, keeps nothing open.
 */
export interface ServableFile {
  readonly canonicalPath: string
  readonly byteLength: number
  readonly identity: string
  reopen(): Promise<OpenedAsset | undefined>
}

export type Servable =
  | { readonly ok: true, readonly file: ServableFile }
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
 * Checks `canonicalPath` can be served. A pinned path is trusted as the
 * handler's whole-tree check left it; `retainedLeaf`, set for a previous
 * version's file, must still match before a byte is served.
 */
export async function openServable (
  storage: LoaderStorage,
  origin: string,
  canonicalPath: string,
  retainedLeaf: string | undefined,
  verdicts: RetainedVerdicts
): Promise<Servable> {
  const asset = await storage.openAsset(origin, canonicalPath)
  if (asset === undefined) {
    // The handler's whole-tree check read every pinned asset when it was
    // built, so the file was removed during this run.
    return { ok: false, reason: 'cached asset became unavailable after this app was loaded' }
  }
  try {
    if (retainedLeaf !== undefined && !await isRetainedIntact(asset, canonicalPath, retainedLeaf, verdicts)) {
      return { ok: false, reason: 'a previous version\'s file no longer matches what was pinned' }
    }
  } finally {
    await asset.close()
  }
  const { byteLength, identity } = asset
  return { ok: true, file: { canonicalPath, byteLength, identity, reopen: async () => await storage.openAsset(origin, canonicalPath) } }
}

/** Bytes `start`..`end` of `file` as a body, opened on the first read and closed when the body ends, fails or is cancelled. */
function bodyOf (file: ServableFile, start: number, end: number): ReadableStream<Uint8Array> {
  let asset: OpenedAsset | undefined
  let chunks: AsyncIterator<Uint8Array> | undefined
  const release = async (): Promise<void> => {
    await chunks?.return?.()
    await asset?.close()
  }
  return new ReadableStream<Uint8Array>({
    async pull (controller) {
      try {
        if (chunks === undefined) {
          asset = await file.reopen()
          if (asset?.identity !== file.identity) throw new Error(`${file.canonicalPath} changed on disk after its response was built`)
          chunks = asset.read(start, end)[Symbol.asyncIterator]()
        }
        const next = await chunks.next()
        if (next.done === true) {
          await release()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        await release()
        controller.error(error)
      }
    },
    cancel: release
  }, { highWaterMark: 0 }) // the default of 1 would pull, and so open the file, before anyone reads
}

/**
 * Turns `file` into the actual `Response`, honouring a `Range` request. A
 * HEAD request gets the headers alone.
 *
 * CSP LIVES HERE, NOT IN `onHeadersReceived` -- A110 (docs/open-questions.md)
 * confirmed that listener never fires for a `protocol.handle`-served
 * response in this Electron version. The caller supplies fresh patterns on
 * every call rather than caching them across requests. Set on every served
 * asset, not only the entry document: a worker script served through this
 * same handler inherits its OWN response's CSP, never the document's.
 */
export function buildResponse (
  file: ServableFile,
  request: Request,
  connectPatterns: readonly Pattern[],
  securePatterns: readonly Pattern[]
): Response {
  const csp = cspHeaderValue(connectPatterns, securePatterns)
  const total = file.byteLength
  const range = parseRange(request.headers.get('range'), total)

  if (range.kind === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes', 'content-security-policy': csp } })
  }

  const { start, end } = range.kind === 'none' ? { start: 0, end: total - 1 } : range.range
  const body = request.method === 'HEAD' ? null : bodyOf(file, start, end)
  const headers: Record<string, string> = {
    'content-type': contentTypeFor(file.canonicalPath),
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'content-security-policy': csp
  }
  if (range.kind === 'none') return new Response(body, { status: 200, headers })
  return new Response(body, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}` } })
}
