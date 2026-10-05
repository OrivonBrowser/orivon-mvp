import { describe, expect, it } from 'vitest'
import { areaOf, areasOf, decide, packShards, selectImpacted, tokensFor, weightOf } from '../select-e2e.mjs'

const SPECS = [
  'test/app-behaviours/e2e-app-broker-rules.test.ts',
  'test/app-loading/e2e-served-csp.test.ts',
  'test/capabilities/e2e-fetch-routing.test.ts',
  'test/library/e2e-history.test.ts',
  'test/library/e2e-downloads.test.ts',
  'test/node-runtime/e2e-sqlite.test.ts',
  'test/qa/e2e-qa-adversarial.test.ts',
  'test/qa/e2e-qa-visual.test.ts',
  'test/sites/e2e-site-info.test.ts',
  'test/support/launch-electron-teardown.test.ts',
  'test/tabs/e2e-tab-move.test.ts'
]
const MAP = {
  core: { areas: ['capabilities', 'app-loading', 'node-runtime'], specs: ['test/qa/e2e-qa-adversarial.test.ts'], catalogue: true },
  ignore: ['\\.md$', '^docs/', '^src/(?:.*/)?tests/'],
  fallback: ['@full'],
  rules: [
    { prefix: 'src/broker', run: ['@core'] },
    { prefix: 'src/main', run: ['@full'] },
    { prefix: 'src/main/history', run: ['library'] },
    { prefix: 'src/main/tab-groups', run: ['tabs'] },
    { prefix: 'scripts/check-*', run: [] },
    { prefix: 'scripts', run: ['@full'] },
    { prefix: 'test/library', run: ['library'] },
    { prefix: 'test/spec-weights.json', run: [] }
  ]
}
const CATALOGUE = ['test/sites/e2e-site-info.test.ts']
const base = { map: MAP, specs: SPECS, catalogue: CATALOGUE }

describe('areas', () => {
  it('reads the area folder of a spec, and nothing for one at the top of test/', () => {
    expect(areaOf('test/tabs/e2e-x.test.ts')).toBe('tabs')
    expect(areaOf('test/e2e-loose.test.ts')).toBe('')
    expect(areasOf(SPECS)).toContain('library')
  })
})

describe('tokensFor', () => {
  it('uses the most specific rule, ignores history and unit tests, and falls back to everything', () => {
    expect(tokensFor(MAP, 'src/main/history/store.ts')).toEqual(['library'])
    expect(tokensFor(MAP, 'src/main/index.ts')).toEqual(['@full'])
    expect(tokensFor(MAP, 'docs/development/testing.md')).toEqual([])
    expect(tokensFor(MAP, 'src/broker/tests/x.test.ts')).toEqual([])
    expect(tokensFor(MAP, 'scripts/check-size.mjs')).toEqual([])
    expect(tokensFor(MAP, 'scripts/build-e2e.mjs')).toEqual(['@full'])
    expect(tokensFor(MAP, 'package.json')).toEqual(['@full'])
  })
})

describe('selectImpacted', () => {
  it('runs the specs of the mapped areas', () => {
    expect(selectImpacted({ ...base, changed: ['src/main/history/store.ts'] })).toMatchObject({ mode: 'impacted', areas: ['library'], files: ['test/library/e2e-downloads.test.ts', 'test/library/e2e-history.test.ts'] })
  })

  it('maps the app core to the catalogue proofs, the core areas and the adversarial spec', () => {
    const { files } = selectImpacted({ ...base, changed: ['src/broker/capabilities/fs.ts'] })
    expect(files).toEqual([
      'test/app-loading/e2e-served-csp.test.ts',
      'test/capabilities/e2e-fetch-routing.test.ts',
      'test/node-runtime/e2e-sqlite.test.ts',
      'test/qa/e2e-qa-adversarial.test.ts',
      'test/sites/e2e-site-info.test.ts'
    ])
  })

  it('selects nothing for a docs-only change, and everything for an unknown file or a full trigger', () => {
    expect(selectImpacted({ ...base, changed: ['README.md', 'docs/a.md'] }).mode).toBe('none')
    expect(selectImpacted({ ...base, changed: [] }).mode).toBe('none')
    expect(selectImpacted({ ...base, changed: ['something/new.ts'] })).toMatchObject({ mode: 'full', files: SPECS })
    expect(selectImpacted({ ...base, changed: ['src/main/history/a.ts', 'src/main/index.ts'] }).mode).toBe('full')
  })
})

describe('decide', () => {
  const changed = ['src/main/tab-groups/a.ts']

  it('runs everything on main and on the nightly schedule', () => {
    expect(decide({ ...base, event: 'push', ref: 'main', changed: [] })).toMatchObject({ mode: 'full', files: SPECS })
    expect(decide({ ...base, event: 'push', ref: 'refs/heads/main', changed: [] }).mode).toBe('full')
    expect(decide({ ...base, event: 'schedule', changed: [] }).mode).toBe('full')
  })

  it('runs the impacted areas for a same-repo pull request', () => {
    expect(decide({ ...base, event: 'pull_request', changed })).toMatchObject({ mode: 'impacted', areas: ['tabs'] })
  })

  it('runs nothing for a fork pull request until a maintainer labels it, then treats it as any other', () => {
    expect(decide({ ...base, event: 'pull_request', fork: true, changed }).mode).toBe('none')
    expect(decide({ ...base, event: 'pull_request', fork: true, labels: ['ci:e2e'], changed })).toMatchObject({ mode: 'impacted', areas: ['tabs'] })
  })

  it('runs everything for the ci:e2e-full label, fork or not', () => {
    expect(decide({ ...base, event: 'pull_request', labels: ['ci:e2e-full'], changed }).mode).toBe('full')
    expect(decide({ ...base, event: 'pull_request', fork: true, labels: ['ci:e2e-full'], changed }).mode).toBe('full')
  })

  it('honours a dispatch: all, a list of areas, or the impacted set', () => {
    expect(decide({ ...base, event: 'workflow_dispatch', dispatchAreas: 'all', changed: [] }).mode).toBe('full')
    expect(decide({ ...base, event: 'workflow_dispatch', dispatchAreas: 'tabs, sites', changed: [] }).areas).toEqual(['sites', 'tabs'])
    expect(decide({ ...base, event: 'workflow_dispatch', dispatchAreas: 'nowhere', changed: [] }).mode).toBe('none')
    expect(decide({ ...base, event: 'workflow_dispatch', dispatchAreas: 'impacted', changed }).areas).toEqual(['tabs'])
  })

  it('says why', () => {
    expect(decide({ ...base, event: 'pull_request', changed: ['docs/a.md'] }).reason).toContain('no changed file reaches')
    expect(decide({ ...base, event: 'pull_request', changed })).toMatchObject({ reason: expect.stringContaining('tabs') })
  })
})

describe('shards', () => {
  const files = Array.from({ length: 30 }, (_, i) => `test/a/e2e-${String(i)}.test.ts`)

  it('weighs a recorded file by its seconds and an unknown one by the median', () => {
    expect(weightOf('a', { a: 10, b: 20, c: 30 })).toBe(10)
    expect(weightOf('z', { a: 10, b: 20, c: 30 })).toBe(20)
    expect(weightOf('z', {})).toBe(15)
  })

  it('makes no shard for no files and one for a short list', () => {
    expect(packShards([], {})).toEqual([])
    expect(packShards(files.slice(0, 2), { [files[0] as string]: 5, [files[1] as string]: 5 })).toHaveLength(1)
  })

  it('splits the full load into at most ten shards, each file once, evenly', () => {
    const weights = Object.fromEntries(files.map((file, i) => [file, 20 + (i % 7) * 10]))
    const shards = packShards(files, weights)
    expect(shards.length).toBeLessThanOrEqual(10)
    expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...files].sort())
    const seconds = shards.map((shard) => shard.seconds)
    expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThanOrEqual(70)
  })

  it('numbers the shards from 1 and sorts the files in each', () => {
    const shards = packShards(files, {})
    expect(shards.map((shard) => shard.shard)).toEqual(shards.map((_, i) => i + 1))
    for (const shard of shards) expect(shard.files).toEqual([...shard.files].sort())
  })
})
