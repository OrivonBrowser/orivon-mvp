import { describe, expect, it } from 'vitest'
import { expandSpecs, jobLabel, logHighlights, matrixFor, parseShards, parseSystems, pickRun, smokeResult, summarize } from '../cross-os.mjs'

describe('parseSystems', () => {
  it('reads a comma or space list once each', () => {
    expect(parseSystems('windows, macos windows')).toEqual(['windows', 'macos'])
  })

  it('refuses an unknown system and an empty list, naming the ones it takes', () => {
    expect(() => parseSystems('windows,freebsd')).toThrow('unknown system freebsd: use windows, macos, linux')
    expect(() => parseSystems(' , ')).toThrow('no system named')
  })
})

describe('parseShards', () => {
  it('takes a whole number of runners and refuses anything else', () => {
    expect(parseShards('6')).toBe(6)
    for (const bad of ['0', '2.5', 'six', '21']) expect(() => parseShards(bad)).toThrow('--shards takes a whole number from 1 to 20')
  })
})

describe('expandSpecs', () => {
  const specs = ['test/tabs/e2e-a.test.ts', 'test/tabs/e2e-b.test.ts', 'test/tabsx/e2e-c.test.ts', 'test/qa/e2e-d.test.ts']

  it('stands a folder for every spec under it, once each and in order, and keeps a file as named', () => {
    expect(expandSpecs('./test/tabs/ test/qa/e2e-d.test.ts test/tabs/e2e-a.test.ts', specs))
      .toEqual(['test/tabs/e2e-a.test.ts', 'test/tabs/e2e-b.test.ts', 'test/qa/e2e-d.test.ts'])
  })

  it('keeps a name it cannot find, so the caller can say it is missing', () => {
    expect(expandSpecs('test/nothing', specs)).toEqual(['test/nothing'])
  })
})

describe('matrixFor', () => {
  it('maps each system to its hosted runner', () => {
    expect(matrixFor('macos,linux')).toEqual({ include: [{ system: 'macos', os: 'macos-latest' }, { system: 'linux', os: 'ubuntu-latest' }] })
  })

  it('gives each system one runner for its specs, named as the nightly run names it', () => {
    expect(matrixFor('windows', { specs: 'none', shards: 4 })).toEqual({ include: [{ system: 'windows', os: 'windows-latest', name: 'from source (windows)', artifact: 'cross-os-windows', specs: 'none' }] })
  })

  it('splits the specs across shards per system by their recorded seconds', () => {
    const { include } = matrixFor('windows,macos', { specs: 'a b c', shards: 2, weights: { a: 30, b: 20, c: 15 } })
    expect(include.map((entry) => [entry.name, entry.artifact, entry.specs])).toEqual([
      ['from source (windows) 1 of 2', 'cross-os-windows-1', 'a'],
      ['from source (windows) 2 of 2', 'cross-os-windows-2', 'b c'],
      ['from source (macos) 1 of 2', 'cross-os-macos-1', 'a'],
      ['from source (macos) 2 of 2', 'cross-os-macos-2', 'b c']
    ])
  })
})

describe('jobLabel', () => {
  it('names the artifact of a job, a shard included, and nothing for a job that runs no system', () => {
    expect(jobLabel('from source (windows)')).toBe('windows')
    expect(jobLabel('from source (macos) 3 of 9')).toBe('macos-3')
    expect(jobLabel('package (linux)')).toBe('linux')
    expect(jobLabel('plan')).toBeUndefined()
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

  it('tells two new runs on one commit apart by a part of their name', () => {
    const two = [{ databaseId: 11, headSha: 'abc', displayTitle: 'Live session on macos, token 22' }, { databaseId: 10, headSha: 'abc', displayTitle: 'Live session on windows, token 11' }]
    expect(pickRun([], two, 'abc', 'token 11')?.databaseId).toBe(10)
    expect(pickRun([], two, 'abc', 'token 33')).toBeUndefined()
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
  it('keeps errors and failed specs with the timestamps and colours stripped', () => {
    const log = [
      '2026-10-08T10:00:00.1234567Z Run npm ci',
      '2026-10-08T10:00:01.1234567Z ##[error]Process completed with exit code 1.',
      '2026-10-08T10:00:02.1234567Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m test/qa/e2e-qa-visual.test.ts > states',
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

  it('says a run was cancelled rather than failed', () => {
    expect(summarize({ url: 'u', conclusion: 'cancelled', jobs: [] }, {})).toBe('CANCELLED  u')
  })
})
