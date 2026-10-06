// Reads a download once: hashes it as it arrives, hands each piece on, stops it the moment it outgrows what the signed
// manifest says, and judges the whole at the end. Pure over an async iterable, so no network is needed to test it.
import { createHash } from 'node:crypto'
import type { ManifestFile } from './update-manifest.js'

export type DownloadVerdict = { readonly ok: true } | { readonly ok: false, readonly reason: string }

export const TOO_LARGE = 'The download is larger than the release says, so it was thrown away.'
export const WRONG_SIZE = 'The download is not the size the release says, so it was thrown away.'
export const WRONG_HASH = 'The download does not match the release\'s signed checksum, so it was thrown away.'

/**
 * `write` receives each piece in order; `progress` the bytes so far. A failing `write` rejects. Resolves with the
 * verdict: size and SHA-256 must both equal the manifest's entry.
 */
export async function consumeDownload (
  chunks: AsyncIterable<Uint8Array>,
  expected: Pick<ManifestFile, 'size' | 'sha256'>,
  write: (chunk: Uint8Array) => Promise<void>,
  progress: (received: number) => void = () => {}
): Promise<DownloadVerdict> {
  const hash = createHash('sha256')
  let received = 0
  for await (const chunk of chunks) {
    received += chunk.byteLength
    if (received > expected.size) return { ok: false, reason: TOO_LARGE }
    hash.update(chunk)
    await write(chunk)
    progress(received)
  }
  if (received !== expected.size) return { ok: false, reason: WRONG_SIZE }
  return hash.digest('hex') === expected.sha256 ? { ok: true } : { ok: false, reason: WRONG_HASH }
}
