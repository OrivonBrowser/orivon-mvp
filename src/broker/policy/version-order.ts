// Semver ordering for the version floor (T19) -- split out of update.ts
// (Rule 2); update.ts re-exports `compareVersions`, so every caller keeps
// importing it from there. Pure function, no I/O -- see ./README.md.

/**
 * Semver ordering: `-1` if `a` sorts before `b`, `0` if equal, `1` if after,
 * and **`null` when the two cannot be ordered at all** -- a non-numeric
 * release component (`1.x.0`), an empty or non-semver prerelease identifier.
 *
 * Exported because the broker must ALSO compute the new floor after a
 * successful install (`max(floor, version)`). A second, divergent comparator
 * written at that call site is exactly how a floor decays into decoration.
 *
 * Build metadata (`+sha.abc`) is stripped and ignored, per semver: it is
 * explicitly not part of the ordering, so `1.2.3+a` and `1.2.3+b` are the same
 * version and neither is a rollback of the other.
 */
export function compareVersions (a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null

  const width = Math.max(left.release.length, right.release.length)
  for (let i = 0; i < width; i += 1) {
    // Missing trailing components are zero, so `1.2` and `1.2.0` compare equal
    // rather than being unorderable.
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }

  return comparePrerelease(left.prerelease, right.prerelease)
}

interface ParsedVersion {
  readonly release: readonly number[]
  readonly prerelease: readonly string[]
}

const RELEASE_COMPONENT = /^[0-9]{1,9}$/
const PRERELEASE_IDENTIFIER = /^[0-9A-Za-z-]+$/

function parseVersion (raw: string): ParsedVersion | null {
  const text = raw.trim()
  if (text.length === 0) return null

  const withoutBuild = splitOnce(text, '+')[0]
  const [core, prereleaseText] = splitOnce(withoutBuild, '-')

  const components = core.split('.')
  // Bounded to 9 digits so a component stays an exact integer and a hostile
  // version string cannot exploit float rounding to compare equal to the
  // floor.
  if (!components.every((component) => RELEASE_COMPONENT.test(component))) return null
  const release = components.map((component) => Number(component))

  if (prereleaseText === undefined) return { release, prerelease: [] }
  const prerelease = prereleaseText.split('.')
  if (!prerelease.every((identifier) => PRERELEASE_IDENTIFIER.test(identifier))) return null
  return { release, prerelease }
}

/** Semver's sections 11.3-11.4: a prerelease sorts BELOW its release, numeric identifiers below alphanumeric. */
function comparePrerelease (a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const width = Math.max(a.length, b.length)
  for (let i = 0; i < width; i += 1) {
    const left = a[i]
    const right = b[i]
    // A shorter run of identifiers sorts lower when the shared prefix is equal.
    if (left === undefined) return -1
    if (right === undefined) return 1

    const leftIsNumeric = RELEASE_COMPONENT.test(left)
    const rightIsNumeric = RELEASE_COMPONENT.test(right)
    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }

  return 0
}

function splitOnce (text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator)
  if (at === -1) return [text, undefined]
  return [text.slice(0, at), text.slice(at + separator.length)]
}
