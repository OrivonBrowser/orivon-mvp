// One bundle leaf, hashed as its bytes stream past -- the loader's side of
// ADR-0009's construction. The byte layout is bundle-hash.ts's `leafPrefix`,
// never restated here; only the SHA-256 engine differs. node:crypto's
// incremental Hash keeps memory flat for an asset of any size, which
// WebCrypto's one-shot digest cannot (README.md, Design notes).

import { createHash } from 'node:crypto'
import { leafPrefix } from '../broker/policy/bundle-hash.js'

/**
 * The leaf digest (`sha256:<hex>`) for `byteLength` bytes of content at
 * canonical `path`, read from `chunks`. Throws if the chunks do not add up
 * to exactly `byteLength`: the length is hashed before the content, so a
 * file that changed size under the reader must never produce a digest.
 */
export async function leafOf (
  path: string,
  byteLength: number,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
): Promise<string> {
  const hash = createHash('sha256')
  hash.update(leafPrefix(path, byteLength))
  let seen = 0
  for await (const chunk of chunks) {
    seen += chunk.length
    if (seen > byteLength) break
    hash.update(chunk)
  }
  if (seen !== byteLength) throw new Error(`content length changed while hashing ${path}: expected ${String(byteLength)} bytes`)
  return `sha256:${hash.digest('hex')}`
}
