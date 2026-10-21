// The per-file check of an app's declared tree (the DDOC leaf table), run where the bytes are: the caller names the
// leaf it expects of the file a request asks for, and the server sends that file only after it hashed to it. The
// leaf function is the loader's own, so the leaves match what `orivon-port hash` prints for the same files.

import type { IncomingHttpHeaders } from 'node:http'
import { BUNDLE_HASH_PATTERN } from '../../../broker/policy/pin.js'
import { canonicalAssetPath } from '../../../broker/policy/canonical-path.js'
import { EXPECT_LEAF_HEADER } from '../../../loader/fetch/content-root.js'
import { leafOf } from '../../../loader/leaf-hash.js'

/** `undefined` when the request names no leaf; `'invalid'` when it names something that is none. */
export function expectedLeafOf (headers: IncomingHttpHeaders): string | undefined | 'invalid' {
  const named = headers[EXPECT_LEAF_HEADER]
  if (named === undefined) return undefined
  return typeof named === 'string' && BUNDLE_HASH_PATTERN.test(named) ? named : 'invalid'
}

export type LeafVerdict =
  | { readonly ok: true }
  | { readonly ok: false, readonly path: string }

/**
 * Whether `chunks`, the whole of the file the request `target` names, hash to `expected` under the canonical path
 * of that target. A file of another length than the one served, or a target no leaf can be derived for, is a
 * mismatch like any other: nothing is sent.
 */
export async function checkLeaf (host: string, target: string, size: number, chunks: readonly Uint8Array[], expected: string): Promise<LeafVerdict> {
  const path = canonicalAssetPath(`https://${host}${target}`)
  if (path === null) return { ok: false, path: target.split(/[?#]/, 1)[0] ?? target }
  try {
    return await leafOf(path, size, chunks) === expected ? { ok: true } : { ok: false, path }
  } catch {
    return { ok: false, path }
  }
}

/** Bytes `start`..`end` (inclusive) of the file `chunks` make up, as views into them. */
export function sliceChunks (chunks: readonly Uint8Array[], start: number, end: number): Uint8Array[] {
  const out: Uint8Array[] = []
  let at = 0
  for (const chunk of chunks) {
    const from = Math.max(start - at, 0)
    const to = Math.min(end + 1 - at, chunk.length)
    if (from < to) out.push(chunk.subarray(from, to))
    at += chunk.length
    if (at > end) break
  }
  return out
}
