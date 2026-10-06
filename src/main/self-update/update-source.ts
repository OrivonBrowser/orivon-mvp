// Where the check reads releases from: the newest stable, signed release and its verified manifest. Takes `fetch`, so a
// test serves it from memory and the browser gives it `net.fetch`. No address is ever taken from an answer: each is
// built from the constants in ./release-url.ts and a tag that is only a version.
import type { FetchLike } from './download-update.js'
import { GITHUB_OWNER, GITHUB_REPO, releaseUrl } from './release-url.js'
import type { ReleaseInfo } from './update-check.js'
import { MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES, verifyManifest } from './update-manifest.js'
import { MANIFEST_ASSET, pickRelease, SIGNATURE_ASSET } from './release-pick.js'

export interface UpdateEndpoints {
  /** The list of releases, newest first. */
  readonly list: string
  /** The address of one file of a release. `tag` is a plain version tag; `name` is one of the constants of ./release-pick.ts or a name the signed manifest lists. */
  readonly asset: (tag: string, name: string) => string
}

export const GITHUB_ENDPOINTS: UpdateEndpoints = {
  // The list, not `/releases/latest`: a nightly published as a full release would hide the stable one there.
  list: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=20`,
  asset: (tag, name) => `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

const FETCH_TIMEOUT_MS = 10_000

/** The body of `response` if it is at most `max` bytes, read without going past it; rejects otherwise. */
export async function readCapped (response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > max) throw new Error('an answer was larger than allowed')
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    size += step.value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new Error('an answer was larger than allowed')
    }
    parts.push(step.value)
  }
  return Buffer.concat(parts)
}

export interface ReleaseSourceDeps {
  readonly fetch: FetchLike
  readonly endpoints: UpdateEndpoints
  readonly trustedKeys: readonly string[]
  readonly log?: (message: string) => void
}

/** Answers null when there is nothing to offer (no release, one unsigned, one whose signature fails); rejects when the source could not be reached. */
export function createReleaseSource (deps: ReleaseSourceDeps): () => Promise<ReleaseInfo | null> {
  const get = async (url: string): Promise<Response> => {
    const response = await deps.fetch(url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/vnd.github+json', 'user-agent': `${GITHUB_REPO}-update-check` }
    })
    return response
  }
  return async () => {
    const listed = await get(deps.endpoints.list)
    // A repository with no releases yet 404s: nothing to report. Any other refusal (a rate limit, a server error) is not an answer.
    if (listed.status === 404) return null
    if (!listed.ok) throw new Error(`the release source answered ${String(listed.status)}`)
    let list: unknown
    try {
      list = await listed.json()
    } catch {
      return null
    }
    const picked = pickRelease(list)
    if (picked === null) return null

    const [manifest, signature] = await Promise.all([
      get(deps.endpoints.asset(picked.tag, MANIFEST_ASSET)),
      get(deps.endpoints.asset(picked.tag, SIGNATURE_ASSET))
    ])
    if (!manifest.ok || !signature.ok) throw new Error('the signed manifest could not be read')
    const [bytes, signatureBytes] = await Promise.all([readCapped(manifest, MAX_MANIFEST_BYTES), readCapped(signature, MAX_SIGNATURE_BYTES)])
    const verified = verifyManifest(bytes, new TextDecoder().decode(signatureBytes), picked.tag, deps.trustedKeys)
    if (!verified.ok) {
      deps.log?.(`release ${picked.tag} is not offered: ${verified.reason}`)
      return null
    }
    return { version: picked.tag, url: releaseUrl(picked.tag), manifest: verified.manifest }
  }
}
