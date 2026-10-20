// Which release of the repository the update check reports: the newest by version, pre-releases included.
import { compareVersions, parseVersion } from './github-release-version.js'
import type { ParsedVersion } from './github-release-version.js'

export interface NewestRelease {
  /** The tag as published, e.g. `v0.0.8`. */
  readonly tag: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * The release with the highest version in `list`, the parsed answer of GitHub's releases endpoint, read as untrusted.
 * A pre-release counts, because every release here is one; a draft does not, and neither does a tag that is not a
 * version (the repository also keeps a release on the tag `pre-releases`). The order of the list and the dates are
 * ignored: only the version decides.
 */
export function pickNewestRelease (list: unknown): NewestRelease | null {
  if (!Array.isArray(list)) return null
  let best: { tag: string, parsed: ParsedVersion } | null = null
  for (const entry of list as unknown[]) {
    if (!isRecord(entry) || entry['draft'] === true) continue
    const tag = entry['tag_name']
    if (typeof tag !== 'string') continue
    const parsed = parseVersion(tag)
    if (parsed === null) continue
    if (best === null || compareVersions(parsed, best.parsed) > 0) best = { tag, parsed }
  }
  return best === null ? null : { tag: best.tag }
}
