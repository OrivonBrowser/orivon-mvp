import { describe, expect, it } from 'vitest'
import { resolveLog, rewriteLines } from '../ai/renumber-decisions.mjs'

const row = (id: string, what: string): string => `| \`${id}\` | 2026-10-20 | ${what} | x |\n`

describe('resolveLog', () => {
  it('keeps main\'s rows and renumbers the branch\'s after the highest id', () => {
    const text = row('d-0696', 'old') +
      '<<<<<<< HEAD\n' + row('d-0697', 'ours a') + row('d-0698', 'ours b') +
      '=======\n' + row('d-0697', 'theirs a') + row('d-0698', 'theirs b') + row('d-0699', 'theirs c') +
      '>>>>>>> origin/main\n'
    const { text: out, mapping } = resolveLog(text)
    expect(out).toBe(row('d-0696', 'old') + row('d-0697', 'theirs a') + row('d-0698', 'theirs b') + row('d-0699', 'theirs c') +
      row('d-0700', 'ours a') + row('d-0701', 'ours b'))
    expect([...mapping]).toEqual([['d-0697', 'd-0700'], ['d-0698', 'd-0701']])
  })

  it('keeps a row that holds $` or $\' as it is, and pastes nothing else in', () => {
    const odd = row('d-0700', 'reads `$EXEFILE`, `$`` and `$\'` literally')
    const text = row('d-0699', 'old') + '<<<<<<< HEAD\n' + odd + '=======\n' + row('d-0700', 'theirs') + '>>>>>>> origin/main\n' + 'tail\n'
    const { text: out } = resolveLog(text)
    expect(out).toBe(row('d-0699', 'old') + row('d-0700', 'theirs') + odd.replace('d-0700', 'd-0701') + 'tail\n')
  })

  it('refuses a conflict that holds more than rows', () => {
    const text = '<<<<<<< HEAD\n## A heading\n' + row('d-0001', 'a') + '=======\n' + row('d-0001', 'b') + '>>>>>>> origin/main\n'
    expect(() => resolveLog(text)).toThrow(/settle it by hand/)
  })

  it('drops a branch row main already holds under another number, and renumbers the rest', () => {
    const text = '<<<<<<< HEAD\n' + row('d-0700', 'merged earlier') + row('d-0701', 'new') +
      '=======\n' + row('d-0700', 'theirs') + row('d-0701', 'merged earlier') + '>>>>>>> origin/main\n'
    const { text: out, mapping } = resolveLog(text)
    expect(out).toBe(row('d-0700', 'theirs') + row('d-0701', 'merged earlier') + row('d-0702', 'new'))
    expect([...mapping]).toEqual([['d-0701', 'd-0702']])
  })

  it('leaves a log with no conflict as it is', () => {
    const text = row('d-0001', 'a')
    expect(resolveLog(text)).toEqual({ text, mapping: new Map() })
  })
})

describe('rewriteLines', () => {
  const mapping = new Map([['d-0698', 'd-0700'], ['d-0699', 'd-0701']])

  it('rewrites only the lines main lacks, without chaining one rewrite into the next', () => {
    const body = 'main cites d-0698 here\nbranch cites d-0698 and d-0699\n'
    const out = rewriteLines(body, new Set(['main cites d-0698 here']), mapping)
    expect(out).toBe('main cites d-0698 here\nbranch cites d-0700 and d-0701\n')
  })
})
