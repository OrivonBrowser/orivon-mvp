// A release that could not ship is refused before any runner builds: its tag must be v<semver> and its bundled
// checkpoint young enough, and both reasons are named together.
import { describe, expect, it } from 'vitest'
import { checkpointProblem, preflight, tagProblem } from '../release-preflight.mjs'

const NOW = 1_800_000_000
const DAY = 86_400
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-05\n\n### Added\n\n- A thing.\n'

describe('tagProblem', () => {
  it.each(['v0.1.0', 'v0.0.12', 'v1.20.3', 'v0.2.0-beta.1', 'v1.0.0-rc.2'])('accepts %s', (tag) => {
    expect(tagProblem(tag)).toBeNull()
  })

  it.each(['v0.1', 'v0.06', '0.1.0', 'v01.0.0', 'v0.1.0.0', 'pre-releases', 'v0.1.0-'])('refuses %s', (tag) => {
    expect(tagProblem(tag)).toContain(`The tag ${tag} is not v<major>.<minor>.<patch>`)
  })

  it('names the three-part tag a two-part one stands for, and guesses nothing else', () => {
    expect(tagProblem('v0.1')).toContain('Use v0.1.0.')
    expect(tagProblem('v0.06')).not.toContain('Use')
  })
})

describe('checkpointProblem', () => {
  it('accepts a checkpoint up to the limit', () => {
    expect(checkpointProblem({ timestamp: NOW - 7 * DAY }, NOW, 7)).toBeNull()
  })

  it('refuses an older one, with its age', () => {
    expect(checkpointProblem({ timestamp: NOW - 8 * DAY }, NOW, 7)).toContain('is 8.0 days old')
  })

  it('refuses one with no timestamp', () => {
    expect(checkpointProblem({}, NOW, 7)).toContain('has no timestamp')
  })
})

describe('preflight', () => {
  it('names a bad tag and a stale checkpoint together', () => {
    const { errors } = preflight({ tag: 'v0.1', checkpoint: { timestamp: NOW - 8 * DAY }, changelog: CHANGELOG, nowSeconds: NOW, maxDays: 7 })
    expect(errors).toHaveLength(2)
  })

  it('passes a good tag with a fresh checkpoint and its changelog section', () => {
    expect(preflight({ tag: 'v0.1.0', checkpoint: { timestamp: NOW - DAY }, changelog: CHANGELOG, nowSeconds: NOW, maxDays: 7 })).toEqual({
      errors: [],
      warnings: [],
    })
  })

  it('warns, without refusing, when the changelog has no section for the version', () => {
    const { errors, warnings } = preflight({ tag: 'v0.2.0', checkpoint: { timestamp: NOW - DAY }, changelog: CHANGELOG, nowSeconds: NOW, maxDays: 7 })
    expect(errors).toEqual([])
    expect(warnings[0]).toContain('no [0.2.0] section')
  })
})
