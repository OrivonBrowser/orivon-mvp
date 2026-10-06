// Which of the repository's releases the update check offers: the newest stable one whose files are signed.
import { compareVersions, parseVersion } from './github-release-version.js'
import type { ParsedVersion } from './github-release-version.js'

/** The two files that make a release installable: its signed list of packages. */
export const MANIFEST_ASSET = 'orivon-update.json'
export const SIGNATURE_ASSET = 'orivon-update.json.sig'

/** A tag that is only a version, so every address built from it is a known shape. */
const PLAIN_TAG = /^v?\d+\.\d+\.\d+$/
const NIGHTLY = /nightly/i

export interface PickedRelease {
  /** The tag as published, e.g. `v1.2.0`. */
  readonly tag: string
  /** The tag without its `v`. */
  readonly version: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function assetNames (release: Record<string, unknown>): string[] {
  const assets = release['assets']
  if (!Array.isArray(assets)) return []
  return assets.flatMap((asset: unknown) => isRecord(asset) && typeof asset['name'] === 'string' ? [asset['name']] : [])
}

/**
 * The newest release that is not a draft, a prerelease or a nightly, has a plain version tag, and carries the
 * signed manifest. A release counts as ready only once it is signed: before that its packages may not all be
 * attached. `list` is the parsed answer of the releases endpoint, read as untrusted.
 */
export function pickRelease (list: unknown): PickedRelease | null {
  if (!Array.isArray(list)) return null
  let best: { release: PickedRelease, parsed: ParsedVersion } | null = null
  for (const entry of list as unknown[]) {
    if (!isRecord(entry)) continue
    const tag = entry['tag_name']
    if (typeof tag !== 'string' || !PLAIN_TAG.test(tag)) continue
    if (entry['draft'] === true || entry['prerelease'] === true) continue
    const name = entry['name']
    if (NIGHTLY.test(tag) || (typeof name === 'string' && NIGHTLY.test(name))) continue
    const parsed = parseVersion(tag)
    if (parsed === null || parsed.prerelease.length > 0) continue
    const names = assetNames(entry)
    if (!names.includes(MANIFEST_ASSET) || !names.includes(SIGNATURE_ASSET)) continue
    if (best === null || compareVersions(parsed, best.parsed) > 0) {
      best = { release: { tag, version: tag.replace(/^v/, '') }, parsed }
    }
  }
  return best?.release ?? null
}
