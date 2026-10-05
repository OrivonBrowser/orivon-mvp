import { describe, expect, it } from 'vitest'
import { checkImpactMap } from '../check-impact-map.mjs'

const SPECS = ['test/tabs/e2e-a.test.ts', 'test/sites/e2e-b.test.ts', 'test/qa/e2e-qa-adversarial.test.ts']
const TRACKED = ['src/broker/x.ts', 'src/main/history/a.ts', 'src/main/tab-groups/a.ts', 'test/tabs/e2e-a.test.ts', 'test/sites/e2e-b.test.ts', 'test/qa/e2e-qa-adversarial.test.ts', 'scripts/check-size.mjs']
const GOOD = {
  core: { areas: ['sites'], specs: ['test/qa/e2e-qa-adversarial.test.ts'] },
  rules: [
    { prefix: 'src/broker', run: ['@core'] },
    { prefix: 'src/main', run: ['@full'] },
    { prefix: 'src/main/history', run: ['sites'] },
    { prefix: 'src/main/tab-groups', run: ['tabs'] },
    { prefix: 'scripts/check-*', run: [] },
    { prefix: 'test/tabs', run: ['tabs'] },
    { prefix: 'test/sites', run: ['sites'] },
    { prefix: 'test/qa', run: ['qa'] }
  ]
}
const input = (map: unknown, over: Record<string, unknown> = {}) => ({ map, specs: SPECS, srcDirs: ['broker', 'main'], mainDirs: ['history', 'tab-groups'], tracked: TRACKED, ...over })

describe('checkImpactMap', () => {
  it('passes a map that covers every directory and area', () => {
    expect(checkImpactMap(input(GOOD) as never)).toEqual([])
  })

  it('fails a new directory under src/ or src/main/ that has no rule of its own', () => {
    const problems = checkImpactMap(input(GOOD, { srcDirs: ['broker', 'main', 'fresh'], mainDirs: ['history', 'tab-groups', 'newthing'] }) as never).join('\n')
    expect(problems).toContain('src/fresh/ has no rule')
    expect(problems).toContain('src/main/newthing/ has no rule')
  })

  it('fails an area folder with no rule for edits to its specs', () => {
    const rules = GOOD.rules.filter((rule) => rule.prefix !== 'test/sites')
    expect(checkImpactMap(input({ ...GOOD, rules }) as never).join('\n')).toContain('test/sites/ has no rule')
  })

  it('fails a token that names no area, a rule that matches no file, a duplicate and a malformed rule', () => {
    const rules = [...GOOD.rules, { prefix: 'src/broker', run: ['ghost'] }, { prefix: 'src/gone', run: [] }, { prefix: 'x' }]
    const problems = checkImpactMap(input({ ...GOOD, rules }) as never).join('\n')
    expect(problems).toContain('names `ghost`')
    expect(problems).toContain('matches no tracked file')
    expect(problems).toContain('two rules for `src/broker`')
    expect(problems).toContain('needs a string `prefix`')
  })

  it('fails a core that names a missing area or spec', () => {
    const problems = checkImpactMap(input({ ...GOOD, core: { areas: ['nowhere'], specs: ['test/no/e2e-x.test.ts'] } }) as never).join('\n')
    expect(problems).toContain('core.areas names `nowhere`')
    expect(problems).toContain('core.specs names test/no/e2e-x.test.ts')
  })

  it('reports a map without rules', () => {
    expect(checkImpactMap(input({}) as never)).toEqual(['test/impact-map.json has no `rules` array'])
  })
})
