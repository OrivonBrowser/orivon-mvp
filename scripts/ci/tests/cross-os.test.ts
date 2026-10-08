import { describe, expect, it } from 'vitest'
import { logHighlights, matrixFor, parseSystems, pickRun, smokeResult, summarize } from '../cross-os.mjs'

describe('parseSystems', () => {
  it('reads a comma or space list once each', () => {
    expect(parseSystems('windows, macos windows')).toEqual(['windows', 'macos'])
  })

  it('refuses an unknown system and an empty list, naming the ones it takes', () => {
    expect(() => parseSystems('windows,freebsd')).toThrow('unknown system freebsd: use windows, macos, linux')
    expect(() => parseSystems(' , ')).toThrow('no system named')
  })
})

describe('matrixFor', () => {
  it('maps each system to its hosted runner', () => {
    expect(matrixFor('macos,linux')).toEqual({ include: [{ system: 'macos', os: 'macos-latest' }, { system: 'linux', os: 'ubuntu-latest' }] })
  })
})

describe('pickRun', () => {
  const after = [{ databaseId: 9, headSha: 'other' }, { databaseId: 8, headSha: 'abc' }, { databaseId: 7, headSha: 'abc' }]

  it('takes the newest run on the commit that was not listed before the dispatch', () => {
    expect(pickRun([7], after, 'abc')?.databaseId).toBe(8)
  })

  it('finds nothing while the new run has not appeared', () => {
    expect(pickRun([7, 8], after, 'abc')).toBeUndefined()
  })
})

describe('smokeResult', () => {
  it('reads the JSON object out of the smoke output around it', () => {
    const stdout = 'built out/\n{\n  "checks": [\n    { "name": "a", "pass": true }\n  ],\n  "skipped": []\n}\r\n\nSmoke check passed.\n'
    expect(smokeResult(stdout)).toEqual({ checks: [{ name: 'a', pass: true }], skipped: [] })
  })

  it('is undefined when the smoke check crashed before it printed one', () => {
    expect(smokeResult('Smoke check crashed before it could report: Error')).toBeUndefined()
  })
})

describe('logHighlights', () => {
  it('keeps errors and failed specs with the timestamps stripped', () => {
    const log = [
      '2026-10-08T10:00:00.1234567Z Run npm ci',
      '2026-10-08T10:00:01.1234567Z ##[error]Process completed with exit code 1.',
      '2026-10-08T10:00:02.1234567Z  FAIL  test/qa/e2e-qa-visual.test.ts > states',
      '2026-10-08T10:00:03.1234567Z   - the tab strip rendered -- no tab found'
    ].join('\n')
    expect(logHighlights(log)).toEqual([
      '##[error]Process completed with exit code 1.',
      ' FAIL  test/qa/e2e-qa-visual.test.ts > states',
      '  - the tab strip rendered -- no tab found'
    ])
  })
})

describe('summarize', () => {
  it('names each failed step and smoke check, and where the evidence is', () => {
    const run = {
      url: 'https://github.com/o/r/actions/runs/1',
      conclusion: 'failure',
      jobs: [
        { name: 'plan', conclusion: 'success', steps: [] },
        { name: 'from source (windows)', conclusion: 'failure', steps: [{ name: 'Smoke', conclusion: 'failure' }, { name: 'e2e specs', conclusion: 'success' }] }
      ]
    }
    const text = summarize(run, {
      'from source (windows)': {
        smoke: { checks: [{ name: 'a', pass: true }, { name: 'b', pass: false, detail: 'no window' }], skipped: [] },
        screenshots: 12,
        inspect: 'qa-artifacts/cross-os/1/windows/qa-artifacts/latest/inspect.md',
        log: 'qa-artifacts/cross-os/1/windows/job.log'
      }
    })
    expect(text).toContain('FAIL  https://github.com/o/r/actions/runs/1')
    expect(text).toContain('failure: from source (windows)\n  failed steps: Smoke')
    expect(text).toContain('smoke: 1/2 checks pass\n    - b -- no window')
    expect(text).toContain('screenshots: 12, read qa-artifacts/cross-os/1/windows/qa-artifacts/latest/inspect.md')
    expect(text).toContain('pass: plan')
  })
})
