import { describe, expect, it } from 'vitest'
import { compareVersions, parseVersion } from './github-release-version.js'

// Direct tests for the semver subset in ./github-release-version.ts.
//
// Previously exercised only indirectly, through update-check.test.ts's
// decideUpdateNotice cases -- real coverage of the outcome, but none of it
// pinned parseVersion/compareVersions in isolation, and none of it named the
// one place this file's grammar deliberately diverges from
// src/broker/policy/update.ts's: a leading "v" is accepted here (the GitHub
// tag convention) and rejected there, and this file requires exactly three
// numeric components where that one accepts a partial version. See
// ./github-release-version.ts's header for why the two must not be merged.

describe('parseVersion', () => {
  it('parses a plain release version', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('parses a prerelease, split on "."', () => {
    expect(parseVersion('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] })
  })

  it('captures build metadata but the parsed value carries nothing of it', () => {
    // Spec item 10: build metadata is not part of precedence, so a parse that
    // kept it around would invite comparing on it by accident.
    expect(parseVersion('1.2.3+build.99')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.2.3-rc.1+build.99')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] })
  })

  it('trims surrounding whitespace', () => {
    expect(parseVersion('  1.2.3  ')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  // THE GRAMMAR DIFFERENCE FROM policy/update.ts, stated as a test. A leading
  // "v"/"V" is the prevailing GitHub release-tag convention (`git tag
  // v1.2.3`); policy/update.ts's manifest-version-floor comparator rejects it.
  it.each(['v1.2.3', 'V1.2.3'])('accepts a leading %s -- the GitHub tag convention', (tagged) => {
    expect(parseVersion(tagged)).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  // THE OTHER GRAMMAR DIFFERENCE. policy/update.ts accepts a partial version
  // ('1.2' defaults its missing patch to 0); this file requires exactly three
  // components, because a GitHub release tag that omits one is malformed, not
  // shorthand.
  it.each(['1.2', '1', '1.2.3.4'])('rejects %s -- not exactly three components', (partial) => {
    expect(parseVersion(partial)).toBeNull()
  })

  it.each([
    ['leading zero in major', '01.2.3'],
    ['leading zero in minor', '1.02.3'],
    ['leading zero in patch', '1.2.03'],
    ['non-numeric core', 'a.b.c'],
    ['empty string', ''],
    ['whitespace inside', '1.2 .3'],
    ['not version-shaped', 'banana'],
    ['negative component', '1.-2.3']
  ])('rejects %s (%s)', (_label, malformed) => {
    expect(parseVersion(malformed)).toBeNull()
  })

  it('never throws on malformed input', () => {
    for (const junk of ['', 'v', 'v.v.v', '...', '1.2.3-', '1.2.3+', 'x'.repeat(200)]) {
      expect(() => parseVersion(junk)).not.toThrow()
    }
  })
})

describe('compareVersions', () => {
  function cmp (a: string, b: string): number {
    const left = parseVersion(a)
    const right = parseVersion(b)
    if (left === null || right === null) throw new Error(`test fixture: ${a} or ${b} did not parse`)
    return compareVersions(left, right)
  }

  it('orders by major, then minor, then patch', () => {
    expect(cmp('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(cmp('1.2.0', '1.1.9')).toBeGreaterThan(0)
    expect(cmp('1.1.2', '1.1.1')).toBeGreaterThan(0)
    expect(cmp('1.2.3', '1.2.3')).toBe(0)
  })

  it('a release outranks any prerelease of the same major.minor.patch', () => {
    expect(cmp('1.2.3', '1.2.3-rc.1')).toBeGreaterThan(0)
    expect(cmp('1.2.3-rc.1', '1.2.3')).toBeLessThan(0)
  })

  it('numeric prerelease identifiers compare numerically, not lexically', () => {
    // Lexical comparison would put '10' before '9'.
    expect(cmp('1.0.0-9', '1.0.0-10')).toBeLessThan(0)
  })

  it('numeric identifiers always sort below alphanumeric ones', () => {
    expect(cmp('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
  })

  it('alphanumeric prerelease identifiers compare lexically', () => {
    expect(cmp('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })

  it('fewer prerelease fields sorts lower when the shared prefix is equal', () => {
    expect(cmp('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
  })

  it('build metadata is never part of the ordering', () => {
    expect(cmp('1.2.3+build.1', '1.2.3+build.2')).toBe(0)
    expect(cmp('1.2.3-rc.1+a', '1.2.3-rc.1+b')).toBe(0)
  })

  it('a leading "v" does not change the ordering', () => {
    expect(cmp('v1.2.3', '1.2.3')).toBe(0)
    expect(cmp('v2.0.0', '1.9.9')).toBeGreaterThan(0)
  })

  it('returns <0, 0 or >0 like Array#sort\'s comparator, not just a sign', () => {
    const values = ['3.0.0', '1.0.0', '2.0.0'].map((v) => parseVersion(v))
    expect(values.every((v) => v !== null)).toBe(true)
    const sorted = [...values].sort((a, b) => compareVersions(a!, b!)).map((v) => `${v!.major}.${v!.minor}.${v!.patch}`)
    expect(sorted).toEqual(['1.0.0', '2.0.0', '3.0.0'])
  })
})
