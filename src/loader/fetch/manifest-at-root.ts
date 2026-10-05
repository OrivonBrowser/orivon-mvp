// Reads one thing about the content a root CID names: its manifest, and nothing else. A
// judgement of content (src/trust/domain-binding.ts) needs the `domain` the manifest names;
// the bundle is not downloaded for it.

import type { Manifest } from '../../contracts/index.js'
import type { Resolver } from '../../broker/policy/connect.js'
import { MANIFEST_PATH } from '../../broker/policy/canonical-path.js'
import { MAX_MANIFEST_BYTES, parseManifest } from '../manifest/manifest.js'
import { ByteBudget, fetchWithBudget, joinChunks, raceAbort } from './budget.js'
import type { Fetch, FetchResponse } from './budget.js'
import { pinnedToRoot } from './content-root.js'
import { ensurePublicUnicastOrigin } from './install-origin.js'

/** A cold read through the verifier takes up to a minute; nothing here is worth a longer wait. */
export const MANIFEST_READ_TIMEOUT_MS = 2 * 60_000

const NOT_FOUND = 404

/**
 * `website`: the host answered 404, so the content has no manifest (the verifier answers 404
 * only for a path it proved absent). `unread`: anything else that stopped the read, which
 * proves nothing about the content.
 */
export type ManifestAtRoot =
  | { readonly kind: 'app', readonly manifest: Manifest, readonly bytes: Uint8Array }
  | { readonly kind: 'website' }
  | { readonly kind: 'unread', readonly reason: string }

export async function fetchManifestAtRoot (fetchFn: Fetch, resolveFn: Resolver, canonicalOrigin: string, cid: string): Promise<ManifestAtRoot> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, MANIFEST_READ_TIMEOUT_MS)
  try {
    const origin = await raceAbort(ensurePublicUnicastOrigin(canonicalOrigin, resolveFn), controller.signal, () => new Error('resolving the origin timed out'))
    if (!origin.ok) return { kind: 'unread', reason: origin.reason }

    let status: number | undefined
    const noting: Fetch = async (url, addresses, signal, headers): Promise<FetchResponse> => {
      const response = await fetchFn(url, addresses, signal, headers)
      status = response.status
      return response
    }
    const chunks: Uint8Array[] = []
    const fetched = await fetchWithBudget(
      pinnedToRoot(noting, cid), `${canonicalOrigin}${MANIFEST_PATH}`, origin.addresses, MAX_MANIFEST_BYTES,
      new ByteBudget(MAX_MANIFEST_BYTES), 'manifest', controller.signal, async (chunk) => { chunks.push(chunk) }
    )
    if ('ok' in fetched) return status === NOT_FOUND ? { kind: 'website' } : { kind: 'unread', reason: fetched.reason }

    const bytes = joinChunks(chunks, fetched.byteLength)
    const parsed = parseManifest(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
    return parsed.ok ? { kind: 'app', manifest: parsed.manifest, bytes } : { kind: 'unread', reason: parsed.reason }
  } catch (error) {
    return { kind: 'unread', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

const MAX_REMEMBERED = 64

/**
 * `fetchManifestAtRoot` asked once per (origin, CID): an answer that is an app or a website
 * is kept, a failed read is asked again. A call that arrives while the first is under way
 * shares it.
 */
export function rememberingManifestReader (fetchFn: Fetch, resolveFn: Resolver): (origin: string, cid: string) => Promise<ManifestAtRoot> {
  const asked = new Map<string, Promise<ManifestAtRoot>>()
  return async (origin, cid) => {
    const key = `${origin} ${cid}`
    const known = asked.get(key)
    if (known !== undefined) return await known
    const pending = fetchManifestAtRoot(fetchFn, resolveFn, origin, cid)
    asked.set(key, pending)
    if (asked.size > MAX_REMEMBERED) asked.delete(asked.keys().next().value as string)
    const answer = await pending
    if (answer.kind === 'unread') asked.delete(key)
    return answer
  }
}
