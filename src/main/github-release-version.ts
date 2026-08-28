// Semver 2.0.0 parsing and comparison, for GitHub release tags. Split out of
// ./update-check.ts (Rule 2, docs/development/code-guidelines.md).
//
// DO NOT MERGE WITH src/broker/policy/update.ts's comparator. That module has
// its own, deliberately DIFFERENT semver grammar for the manifest version
// floor (security-model.md T19): it accepts partial versions (`1.2`) and
// rejects a leading "v", where this file requires exactly three components
// and accepts "v1.2.3" as the prevailing GitHub tag convention. One is a
// security floor, the other a UX throttle for a notification -- aligning
// their tolerance would either widen the floor's grammar for a cosmetic
// reason or make this file reject every real GitHub tag.

export interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: ReadonlyArray<string | number>
}

// The official semver 2.0.0 grammar
// (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string),
// with one relaxation: an optional leading "v"/"V", because that is the
// prevailing GitHub release-tag convention (`git tag v1.2.3`) and rejecting
// it would make every real tag "malformed". Build metadata is captured but
// deliberately never used below -- semver spec item 10 excludes it from
// precedence entirely.
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/i

/** Malformed input (anything not matching the grammar above) returns null -- never throws. */
export function parseVersion (raw: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(raw.trim())
  if (match === null) return null

  const majorStr = match[1]
  const minorStr = match[2]
  const patchStr = match[3]
  const prereleaseStr = match[4]
  // The three numeric groups are mandatory in the pattern (never inside a
  // `?` quantifier), so a successful match always populates them. This
  // check exists for noUncheckedIndexedAccess, not a real runtime case.
  if (majorStr === undefined || minorStr === undefined || patchStr === undefined) return null

  const prerelease = prereleaseStr === undefined || prereleaseStr === ''
    ? []
    : prereleaseStr.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))

  return { major: Number(majorStr), minor: Number(minorStr), patch: Number(patchStr), prerelease }
}

/**
 * Semver 2.0.0 precedence (https://semver.org/#spec-item-11).
 * Returns <0, 0 or >0 like Array#sort's comparator.
 */
export function compareVersions (a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch

  const aHasPre = a.prerelease.length > 0
  const bHasPre = b.prerelease.length > 0
  if (aHasPre !== bHasPre) return aHasPre ? -1 : 1
  if (!aHasPre) return 0

  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1 // fewer fields sorts lower
    if (y === undefined) return 1
    if (x === y) continue
    const xIsNum = typeof x === 'number'
    const yIsNum = typeof y === 'number'
    if (xIsNum && yIsNum) return x - y
    if (xIsNum !== yIsNum) return xIsNum ? -1 : 1 // numeric < alphanumeric
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}
